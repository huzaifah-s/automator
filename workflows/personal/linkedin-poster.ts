import {
  defineCredential,
  defineWorkflow,
  HttpError,
  poll,
  redact,
  type Ctx,
} from "../../src/core/define.ts";

/**
 * Personal — LinkedIn poster.
 *
 * The LinkedIn twin of `workflows/the-mantra/threads-poster.ts`, and built the
 * same way on purpose: rows in the Notion **LinkedIn** database that are
 * **Approved** and whose **Post Date** has arrived are claimed (Posting),
 * published to Huzaifah's own profile through the official Posts API, and
 * written back as Posted (with the post's URL) or Failed (with the reason).
 * The Content repo's Claude writes the rows; nobody edits them by hand.
 *
 * What differs from Threads, and why:
 *
 * - **One post, not a chain.** LinkedIn has no reply-chain format, so the
 *   whole page body is one post: every paragraph in order, a blank line
 *   between, headings ignored (so a `### #1` left in by habit is harmless).
 *   3000 characters is LinkedIn's cap.
 * - **Images are uploaded, not linked.** Threads fetches an image URL itself;
 *   LinkedIn wants the bytes. Each Notion image is downloaded and PUT to an
 *   upload slot from the Images API, then referenced by URN. One image is an
 *   image post, 2–20 a multi-image post.
 * - **The text is escaped.** The Posts API reads `commentary` as "little
 *   text", where `( ) [ ] { } < > @ # * _ ~ | \` are markup. Unescaped, a
 *   bracket can silently cut the rest of the post off. Everything is escaped,
 *   so hashtags go out as plain text rather than links.
 * - **The token cannot refresh.** Self-serve apps get a 60-day token and no
 *   refresh token. `linkedin-token-alert` nags before it dies; a 401 here
 *   says so in the Log rather than as a bare status.
 *
 * Kept from Threads unchanged: the row is locked before anything publishes (a
 * row on Posting is never picked up again, which is the no-double-post
 * guarantee); a publish that may have gone through is never retried; a failed
 * row turns the run red and sends one Telegram message per row.
 */

/* ------------------------------------------------------------ credentials */

/**
 * The integration that already sees the Founder's Contents databases. The
 * LinkedIn database sits beside Threads under the same page, so it inherits
 * the share — no second integration to connect.
 */
const notion = defineCredential("notion", "the-mantra-contents");

/** The same bot and chat as the Threads poster's alerts. */
const telegram = defineCredential("telegram", "the-mantra");

/** Huzaifah's member token. See the `linkedin` provider for how it is made. */
const linkedin = defineCredential("linkedin", "huzaifah");

/* ---------------------------------------------------------- configuration */

const TZ = "Asia/Kuala_Lumpur";

/** The Notion LinkedIn database (one data source). */
const LINKEDIN_DB = "41803cbd-c49e-812f-8962-ffa8f1874ef7";
const NOTION_VERSION = "2022-06-28";

const REST = "https://api.linkedin.com/rest";
/**
 * Versioned API month. LinkedIn supports each version for at least a year,
 * then answers 426 for it. When that happens the Log says so — bump this to a
 * recent YYYYMM from learn.microsoft.com/linkedin/marketing/versioning.
 */
const LINKEDIN_VERSION = "202608";

/** Rows per tick. A personal account posts once or twice a day at most. */
const MAX_PER_POLL = 3;
const MAX_BLOCK_PAGES = 5;

const TEXT_MAX = 3000;
const IMAGES_MAX = 20;

const IMAGE_POLL_EVERY_MS = 3_000;
const IMAGE_POLL_MAX_MS = 60_000;

/** Notion's rich_text caps a single fragment at 2000 characters. */
const LOG_MAX = 1900;

/* ------------------------------------------------------------------ notion */

interface NotionTitleFragment {
  plain_text?: string;
}

interface NotionPage {
  id: string;
  url?: string;
  properties?: Record<string, { type?: string; title?: NotionTitleFragment[] }>;
}

interface DuePage {
  id: string;
  title: string;
  url: string;
}

function notionHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${notion.token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

/** Found by type, not by the name "Name" — see the Threads poster. */
function titleOf(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type !== "title") continue;
    const text = (prop.title ?? []).map((t) => t.plain_text ?? "").join("").trim();
    if (text) return text;
  }
  return "Untitled";
}

function toDuePage(page: NotionPage): DuePage {
  return {
    id: page.id,
    title: titleOf(page),
    url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
  };
}

interface NotionBlock {
  type?: string;
  [key: string]: unknown;
}

interface Post {
  text: string;
  images: string[];
}

const TEXTUAL = new Set(["paragraph", "quote"]);

/**
 * The page body as one post. Paragraphs joined by a blank line, empty ones
 * dropped, a soft break inside a paragraph kept as a tight line. Headings,
 * toggles, callouts, dividers and nested blocks are ignored, exactly as the
 * Threads poster ignores them.
 */
function toPost(blocks: NotionBlock[]): Post {
  const lines: string[] = [];
  const images: string[] = [];

  for (const block of blocks) {
    const type = block.type;
    if (!type) continue;

    if (TEXTUAL.has(type)) {
      const holder = block[type] as { rich_text?: NotionTitleFragment[] } | undefined;
      const text = (holder?.rich_text ?? []).map((t) => t.plain_text ?? "").join("");
      if (text.trim()) lines.push(text);
      continue;
    }

    if (type === "image") {
      const image = block.image as { file?: { url?: string }; external?: { url?: string } } | undefined;
      const url = image?.file?.url ?? image?.external?.url;
      if (url) images.push(url);
    }
  }

  return { text: lines.join("\n\n").trim(), images };
}

/* --------------------------------------------------------------- linkedin */

type PosterCtx = Ctx<DuePage[]>;

/** Little-text markup characters. Each is sent backslash-escaped. */
const RESERVED = /[\\|{}@[\]()<>#*_~]/g;

function littleText(text: string): string {
  return text.replace(RESERVED, (c) => `\\${c}`);
}

function restHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

/** A publish that may have gone through. Never retried. */
class AmbiguousFailure extends Error {
  readonly name = "AmbiguousFailure";
}

/** The clearest sentence available about a failed LinkedIn call. */
function explain(status: number, body: string, what: string): string {
  let message = body.trim().slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { message?: string; code?: string };
    if (parsed?.message) message = parsed.code ? `${parsed.message} [${parsed.code}]` : parsed.message;
  } catch {
    // Not JSON — the truncated body is the best there is.
  }
  const hint =
    status === 401
      ? " — the token has expired or was revoked: make a new one in the LinkedIn token generator and paste it into Credentials › linkedin › huzaifah"
      : status === 426
        ? ` — LinkedIn no longer serves API version ${LINKEDIN_VERSION}; bump LINKEDIN_VERSION in workflows/personal/linkedin-poster.ts`
        : "";
  return `${what}: HTTP ${status}${message ? ` ${message}` : ""}${hint}`;
}

function explainError(err: unknown, what: string): string {
  if (err instanceof HttpError) return explain(err.status, err.body, what);
  return `${what}: ${err instanceof Error ? err.message : String(err)}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The member's person URN, from OpenID userinfo. Needs the openid scope. */
async function authorUrn(ctx: PosterCtx, token: string): Promise<string> {
  let me: { sub?: string };
  try {
    me = await ctx.http.get<{ sub?: string }>("https://api.linkedin.com/v2/userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new Error(explainError(err, "who am I"));
  }
  if (!me?.sub) throw new Error("who am I: LinkedIn gave no member id — the token needs the openid scope");
  return `urn:li:person:${me.sub}`;
}

/**
 * One Notion image → one LinkedIn image URN, ready to attach. Nothing is
 * published here, so every failure is definitive and safe to report as
 * "nothing went out".
 */
async function uploadImage(
  ctx: PosterCtx,
  token: string,
  author: string,
  sourceUrl: string,
  what: string,
): Promise<string> {
  let slot: { value?: { uploadUrl?: string; image?: string } };
  try {
    slot = await ctx.http.post(
      `${REST}/images?action=initializeUpload`,
      { initializeUploadRequest: { owner: author } },
      { headers: restHeaders(token) },
    );
  } catch (err) {
    throw new Error(explainError(err, `${what} upload slot`));
  }
  const uploadUrl = slot?.value?.uploadUrl;
  const urn = slot?.value?.image;
  if (!uploadUrl || !urn) throw new Error(`${what} upload slot: LinkedIn gave no upload URL`);

  // A Notion file URL is presigned and lives about an hour — fetched seconds
  // after the block read, so that is plenty.
  let bytes: ArrayBuffer;
  try {
    bytes = await ctx.http.get<ArrayBuffer>(sourceUrl, { as: "buffer", private: true, timeoutMs: 60_000 });
  } catch (err) {
    throw new Error(explainError(err, `${what} download from Notion`));
  }

  const put = await ctx.http.raw(uploadUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: bytes,
    timeoutMs: 120_000,
  });
  if (!put.ok) throw new Error(explain(put.status, await put.text(), `${what} upload`));

  // Posting before the image is AVAILABLE is refused, so wait for it.
  const deadline = Date.now() + IMAGE_POLL_MAX_MS;
  while (Date.now() < deadline) {
    let state: { status?: string };
    try {
      state = await ctx.http.get(`${REST}/images/${encodeURIComponent(urn)}`, {
        headers: restHeaders(token),
      });
    } catch (err) {
      throw new Error(explainError(err, `${what} status check`));
    }
    if (state?.status === "AVAILABLE") return urn;
    if (state?.status === "PROCESSING_FAILED") throw new Error(`${what}: LinkedIn failed to process the image`);
    await sleep(IMAGE_POLL_EVERY_MS, ctx.signal);
  }
  throw new Error(`${what}: still processing after ${IMAGE_POLL_MAX_MS / 1000}s`);
}

/**
 * Publishes the post and returns its URN (or null if LinkedIn created it but
 * did not say what it is called). Through `raw` because the URN only comes
 * back in the `x-restli-id` header, and because this call must not be retried
 * by the client: a 5xx or a dropped connection after the request left may
 * well be a live post.
 */
async function publish(
  ctx: PosterCtx,
  token: string,
  author: string,
  post: Post,
  imageUrns: string[],
): Promise<string | null> {
  const body: Record<string, unknown> = {
    author,
    commentary: littleText(post.text),
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (imageUrns.length === 1) body.content = { media: { id: imageUrns[0] } };
  if (imageUrns.length > 1) body.content = { multiImage: { images: imageUrns.map((id) => ({ id })) } };

  let res: Response;
  try {
    res = await ctx.http.raw(`${REST}/posts`, {
      method: "POST",
      headers: { ...restHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    });
  } catch (err) {
    throw new AmbiguousFailure(
      `publish: ${err instanceof Error ? err.message : String(err)} — AMBIGUOUS, not retried: ` +
        `the post MAY be live, check the profile before re-approving`,
    );
  }

  if (!res.ok) {
    const message = explain(res.status, await res.text(), "publish");
    if (res.status < 500) throw new Error(message);
    throw new AmbiguousFailure(
      `${message} — AMBIGUOUS, not retried: the post MAY be live, check the profile before re-approving`,
    );
  }

  return res.headers.get("x-restli-id");
}

/* ------------------------------------------------------------- the outcome */

interface Outcome {
  pageId: string;
  pageName: string;
  pageUrl: string;
  status: "Posted" | "Failed";
  log: string;
  postUrl: string | null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function alertFor(outcome: Outcome): string {
  return [
    "\u{1F6A8} <b>LinkedIn post failed</b>",
    "",
    escapeHtml(outcome.pageName),
    "",
    escapeHtml(outcome.log),
    "",
    escapeHtml(outcome.pageUrl),
  ].join("\n");
}

interface AlertedError extends Error {
  alerted?: boolean;
}

/* ---------------------------------------------------------------- workflow */

export default defineWorkflow<DuePage[]>({
  name: "linkedin-poster",
  description: "Posts due Approved rows from the Notion LinkedIn database to Huzaifah's LinkedIn",

  /**
   * Same shape as the Threads poster: a tick that finds nothing creates no
   * run, and `firstRun: "emit"` so rows already overdue at first boot post
   * rather than being baselined away.
   */
  trigger: poll<DuePage>("*/4 * * * *", {
    tz: TZ,
    id: (page) => page.id,
    firstRun: "emit",
    async fetch(ctx) {
      // Both checked here, not only Notion: poll marks whatever it emits as
      // seen, so emitting rows the runner then refuses (LinkedIn not
      // connected yet) would strand them until they aged out.
      if (!notion.token || !linkedin.access_token) {
        ctx.log.warn("Notion or LinkedIn credential is not connected — not looking for due rows");
        return [];
      }

      const res = await ctx.http.post<{ results: NotionPage[] }>(
        `https://api.notion.com/v1/databases/${LINKEDIN_DB}/query`,
        {
          filter: {
            and: [
              { property: "Status", status: { equals: "Approved" } },
              { property: "Post Date", date: { on_or_before: new Date().toISOString() } },
            ],
          },
          sorts: [{ property: "Post Date", direction: "ascending" }],
          page_size: MAX_PER_POLL,
        },
        { headers: notionHeaders() },
      );

      return res.results.map(toDuePage);
    },
  }),

  /** No retries — see the Threads poster. A red run is the alert. */
  retries: 0,
  timeoutMs: 600_000,
  checkpointTtlHours: 1,

  async run(ctx) {
    const pages = Array.isArray(ctx.input) ? ctx.input : [];
    if (pages.length === 0) {
      ctx.log.info(
        "No pages in the input — only the poll finds due rows, so Run now has nothing to post. " +
          "To finish a run that died halfway, use Resume on that run.",
      );
      return { pages: 0, posted: 0, failed: 0 };
    }

    // Read outside a step so it is never checkpointed. The credential is
    // registered with the redactor; it only ever travels in a header.
    const token = linkedin.access_token!;

    const outcomes: Outcome[] = [];

    for (const page of pages) {
      // Claim first: flipping to Posting takes the row out of the poll's
      // query, so a run that dies after publishing can never post it twice.
      await ctx.step(
        `lock ${page.id}`,
        async () => {
          await ctx.http.patch(
            `https://api.notion.com/v1/pages/${page.id}`,
            { properties: { Status: { status: { name: "Posting" } } } },
            { headers: notionHeaders() },
          );
          return { status: "Posting" };
        },
        { input: { page: page.title } },
      );

      const outcome = await ctx.step<Outcome>(
        `post ${page.id}`,
        async () => {
          const stamp = new Date().toISOString();
          const fail = (message: string): Outcome => ({
            pageId: page.id,
            pageName: page.title,
            pageUrl: page.url,
            status: "Failed",
            log: `${stamp} FAILED: ${message}`.slice(0, LOG_MAX),
            postUrl: null,
          });

          try {
            const blocks = await ctx.http
              .paginate<NotionBlock>(`https://api.notion.com/v1/blocks/${page.id}/children`, {
                headers: notionHeaders(),
                query: { page_size: 100 },
                items: "results",
                next: { cursor: "next_cursor", param: "start_cursor" },
                maxPages: MAX_BLOCK_PAGES,
              })
              .all();

            const post = toPost(blocks);
            if (!post.text && post.images.length === 0) {
              return fail("nothing to post — the page body has no paragraphs or images");
            }
            if (post.text.length > TEXT_MAX) {
              return fail(`text is ${post.text.length} chars, LinkedIn caps posts at ${TEXT_MAX}. Nothing was published.`);
            }
            if (post.images.length > IMAGES_MAX) {
              return fail(`${post.images.length} images, LinkedIn caps a post at ${IMAGES_MAX}. Nothing was published.`);
            }

            const author = await authorUrn(ctx, token);

            const urns: string[] = [];
            for (let i = 0; i < post.images.length; i++) {
              urns.push(await uploadImage(ctx, token, author, post.images[i]!, `image ${i + 1}`));
            }

            const urn = await publish(ctx, token, author, post, urns);
            const postUrl = urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
            return {
              pageId: page.id,
              pageName: page.title,
              pageUrl: page.url,
              status: "Posted",
              log: urn
                ? `${stamp} OK — ${urn}`
                : `${stamp} OK — LinkedIn created the post but returned no id; find it on the profile`,
              postUrl,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (err instanceof AmbiguousFailure) return fail(message);
            return fail(`${message}. Nothing was published.`);
          }
        },
        { input: { page: page.title, url: page.url } },
      );

      outcomes.push(outcome);

      await ctx.step(
        `record ${page.id}`,
        async () => {
          await ctx.http.patch(
            `https://api.notion.com/v1/pages/${page.id}`,
            {
              properties: {
                Status: { status: { name: outcome.status } },
                Log: { rich_text: [{ text: { content: outcome.log } }] },
                "Post URL": { url: outcome.postUrl },
              },
            },
            { headers: notionHeaders() },
          );
          return { status: outcome.status };
        },
        { input: { page: page.title, status: outcome.status } },
      );

      if (outcome.status === "Failed") {
        await ctx.step(`alert ${page.id}`, async () => {
          // Swallowed: the outcome is already in Notion and on the run page.
          try {
            await ctx.telegram.send(alertFor(outcome), {
              token: telegram.token,
              chatId: process.env.TELEGRAM_CHAT_ID_HUZAIFAH ?? telegram.chat_id,
              parseMode: "HTML",
            });
            return { sent: true };
          } catch (err) {
            ctx.log.error(`Telegram alert failed: ${redact(String(err))}`);
            return { sent: false };
          }
        });
      }
    }

    const failed = outcomes.filter((o) => o.status === "Failed");
    if (failed.length > 0) {
      const error: AlertedError = new Error(
        `${failed.length} of ${outcomes.length} LinkedIn post(s) failed: ` +
          failed.map((o) => `${o.pageName} — ${o.log}`).join(" | "),
      );
      error.alerted = true;
      throw error;
    }

    return { pages: outcomes.length, posted: outcomes.length, failed: 0 };
  },

  /** Only for a crash — a row that failed to post was already alerted. */
  async onFailure(ctx, error) {
    if ((error as AlertedError).alerted) return;

    const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
    const lines = [
      "\u{1F525} <b>LinkedIn poster CRASHED</b>",
      "",
      escapeHtml(redact(error.message)),
      "",
      "\u{26A0}\u{FE0F} A row may be stuck on <b>Posting</b> in Notion. If the post did NOT go " +
        "out, set it back to <b>Approved</b>. If it did, set it to <b>Posted</b>.",
    ];
    if (base) lines.push("", `${base}/runs/${ctx.runId}`);

    await ctx.telegram.send(lines.join("\n"), {
      token: telegram.token,
      chatId: process.env.TELEGRAM_CHAT_ID_HUZAIFAH ?? telegram.chat_id,
      parseMode: "HTML",
    });
  },
});
