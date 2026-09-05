import {
  defineCredential,
  defineOAuth,
  defineWorkflow,
  HttpError,
  poll,
  redact,
  type Ctx,
} from "../../src/core/define.ts";

/**
 * The Mantra — Threads — Founder's Contents poster.
 *
 * Takes rows in the Notion Threads database that are **Approved** and whose
 * **Post Date** has arrived, turns each page's body into an ordered chain of
 * Threads posts, publishes the chain, and writes the outcome back to the row.
 *
 * A port of three n8n graphs, merged into one:
 *
 *   "The Mantra - Threads - Checker"                    (every 4 min →
 *                                                        Notion getAll →
 *                                                        execute workflow)
 *   "The Mantra - Notion (Threads) - Founder's
 *    Contents"                                          (loop → lock → blocks →
 *                                                        code → code → update →
 *                                                        IF → telegram)
 *   "The Mantra - Notion (Threads) - Founder's
 *    Contents - Error Handler"                          (error trigger →
 *                                                        telegram)
 *
 * **Why one workflow and not three.** All three splits were n8n mechanics, and
 * none of them survives the move:
 *
 * - The checker existed so the poster's execution list stayed readable — n8n
 *   saves a run for every trigger, and 360 empty runs a day buries the list.
 *   `poll()` is that idea built in: its `fetch` runs *outside* a run, and a
 *   tick that finds nothing due creates no run record at all. The "do the
 *   Notion query exactly once" property the checker's sticky note was proud of
 *   is now structural rather than a convention two graphs have to honour.
 * - The error handler was n8n's `errorTrigger`, which has no equivalent here
 *   because it does not need one: `onFailure` is a property of the workflow
 *   that failed, so it cannot be wired to the wrong graph or silently left
 *   unwired in Settings.
 *
 * Eight things the n8n version got wrong or left implicit, fixed here:
 *
 * 1. **A backlog no longer becomes one enormous run.** n8n handed over every
 *    due row and the poster worked the lot in a single execution — thirty
 *    overdue threads is well over half an hour of sleeps inside one process
 *    with one timeout. The query is capped at MAX_PER_POLL oldest-first, so a
 *    backlog drains a few rows per tick instead. The cap lives in the *query*,
 *    not in a slice afterwards, because poll marks everything it emitted as
 *    seen and a row trimmed after emission would never be offered again.
 * 2. **Running it by hand is safe.** n8n's poster threw "no pages were passed
 *    in" if you pressed play, because its rows came from the caller. Here the
 *    trigger owns the query, so there is nothing to press play on — and a
 *    *resume* from the dashboard, which carries no input, does nothing rather
 *    than re-posting (see the guard in `run`).
 * 3. **The token is never in the run record.** n8n kept it in a data table and
 *    passed it downstream as item data, so it sat in plain text in every
 *    execution. `defineOAuth` hands it over inside the process only, and it is
 *    registered with the redactor, so the `access_token` query parameter is
 *    scrubbed out of every captured Threads call.
 * 4. **A failed row makes the run red.** n8n's Code node caught everything and
 *    returned a status string, so the execution went green and only Telegram
 *    knew. The dashboard is a worse place to hide a failure than an inbox is.
 * 5. **A 200 with no id is treated as ambiguous, not retried.** n8n retried it,
 *    which is the one thing you must not do to a publish call — a publish that
 *    answered 200 has almost certainly published.
 * 6. **The title property is found, not assumed to be "Name".** n8n read
 *    `properties.Name.title[0]`, so renaming the column in Notion would have
 *    quietly turned every alert into "Untitled".
 * 7. **The Telegram alert cannot take the batch down.** n8n needed
 *    `onError: continueRegularOutput` on that node for the same reason; here
 *    it is a try/catch with the failure logged, so a Telegram outage costs you
 *    the message and not the other rows in the batch.
 * 8. **Retries are off, deliberately.** See `retries` below.
 */

/* ------------------------------------------------------------ credentials */

/**
 * The same Notion slot the runway alert and the Contents notifier use — one
 * integration, several databases. Connect it once on the Credentials tab.
 *
 * The integration must be able to *see* the Threads database and to *edit* it:
 * this workflow writes Status, Log and Thread URL. A read-only share shows up
 * as a 404 on the update rather than on the query, which is a confusing place
 * to learn it.
 */
const notion = defineCredential("notion", "the-mantra-contents");

/** The Mantra's own bot, so the failure lands next to the runway nudge. */
const telegram = defineCredential("telegram", "the-mantra");

/**
 * The Threads token, declared exactly as
 * `workflows/the-mantra/threads-token-auto-refresh.ts` declares it — same
 * name, same token URL, same flow, same assumed TTL — and therefore sharing
 * one stored token. `defineOAuth` supports that on purpose and refuses two
 * declarations that disagree about the token URL, which is the drift that
 * would actually hurt.
 *
 * **It is a copy rather than an import, and that is not laziness.** A shared
 * module cannot live under `workflows/` — the loader imports every `.ts` there
 * and fails one with no `defineWorkflow` default export — and importing the
 * refresher's module from here would run its `defineCredential` calls while
 * the loader thinks it is loading *this* file, which attributes its Telegram
 * credential to this workflow and leaves the refresher recorded as needing
 * nothing. An unconnected credential would then stop blocking it.
 *
 * This workflow never calls `refresh()`. It reads the stored token, which the
 * weekly refresher keeps alive; sixty days is never inside the refresh skew,
 * so nothing here renews one on the way past.
 */
const threads = defineOAuth("threads-huzaifah", {
  tokenUrl: "https://graph.threads.net/refresh_access_token",
  flow: "self",
  grantType: "th_refresh_token",
  defaultTtlSeconds: 60 * 24 * 60 * 60,
});

/* ---------------------------------------------------------- configuration */

const TZ = "Asia/Kuala_Lumpur";

/** The Threads database — the same id the runway alert counts rows in. */
const THREADS_DB = "39903cbd-c49e-807d-b83d-ed68a2ced55c";

/** Pinned rather than floating: a schema change should not arrive unannounced. */
const NOTION_VERSION = "2022-06-28";

/** The public Threads account these post from. */
const THREADS_USER_ID = "37014715251504968";
const GRAPH = "https://graph.threads.net/v1.0";

/**
 * Rows taken per tick, oldest Post Date first. At a tick every four minutes
 * this drains a backlog at 75 threads an hour, which is five times the 15/day
 * the runway alert sizes the buffer against — fast enough that a backlog is
 * gone within the hour, small enough that one run stays inside `timeoutMs`.
 */
const MAX_PER_POLL = 5;

/** Blocks in one page body. Past this it is not a thread, it is an essay. */
const MAX_BLOCK_PAGES = 5;

/* --- Threads' own limits, and the waits its API needs but does not document */

const TEXT_MAX = 500;
const CAROUSEL_MAX = 20;
/** A one-item carousel is rejected; one image is an IMAGE post. */
const CAROUSEL_MIN = 2;

const MEDIA_POLL_EVERY_MS = 3_000;
/** Give up waiting on a media container that never finishes processing. */
const MEDIA_POLL_MAX_MS = 90_000;
/** Container → publish. Threads needs a beat even for a TEXT container. */
const PUBLISH_WAIT_MS = 5_000;
/** Publish → next container. The parent must become replyable first. */
const SETTLE_MS = 10_000;
/** Whole container+publish cycle, per post. */
const ATTEMPTS = 3;

/* ------------------------------------------------------------------ notion */

interface NotionTitleFragment {
  plain_text?: string;
}

interface NotionProperty {
  type?: string;
  title?: NotionTitleFragment[];
}

interface NotionPage {
  id: string;
  url?: string;
  properties?: Record<string, NotionProperty>;
}

interface NotionQuery {
  results: NotionPage[];
}

/** One due row, reduced to what the run actually needs. */
interface DuePage {
  id: string;
  /** The row's title, for the alert. Never a credential, so it is captured. */
  title: string;
  /** The page in Notion, so the alert links to the thing to fix. */
  url: string;
}

function notionHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${notion.token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

/**
 * The row's title. Found by property *type* rather than by the name "Name",
 * because a Notion database's title column can be called anything and renaming
 * it is a one-click accident.
 */
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
    // Notion sends `url` on every query result; the fallback is for the day it
    // does not, and is the same shape Notion itself would have given.
    url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
  };
}

/* -------------------------------------------------- notion page → posts */

interface NotionBlock {
  type?: string;
  [key: string]: unknown;
}

interface RichTextHolder {
  rich_text?: NotionTitleFragment[];
  text?: NotionTitleFragment[];
}

interface ImageBlock {
  file?: { url?: string };
  external?: { url?: string };
}

/** One post in the chain. */
interface Post {
  text: string;
  images: string[];
}

const HEADINGS = new Set(["heading_1", "heading_2", "heading_3"]);
/** `quote` still counts, so pages written before the template changed work. */
const TEXTUAL = new Set(["paragraph", "quote"]);

function plainText(block: NotionBlock, type: string): string {
  const holder = block[type] as RichTextHolder | undefined;
  const rich = holder?.rich_text ?? holder?.text ?? [];
  // plain_text keeps a soft break (shift+enter) as a bare \n, which is exactly
  // the tight line the author meant.
  return rich.map((t) => t.plain_text ?? "").join("");
}

/**
 * Reads a page top to bottom and cuts it into posts.
 *
 * **A heading starts a new post.** Everything under it until the next heading
 * belongs to that post, so hitting return on mobile does not split a post in
 * two. Separate paragraph blocks are joined with a blank line; a soft break
 * inside one block stays a tight line. Empty paragraphs are dropped, so stray
 * blank blocks cannot stack into four blank lines on Threads.
 *
 * Everything else — the heading's own text, toggles, callouts, dividers, code
 * — is ignored, and nested blocks are never fetched. That is what keeps the
 * instruction toggle and the placeholder boxes in the Notion template from
 * being posted, and it is load-bearing rather than an omission.
 */
function toPosts(blocks: NotionBlock[]): Post[] {
  const drafts: { lines: string[]; images: string[] }[] = [];
  let current: { lines: string[]; images: string[] } | null = null;

  const start = () => {
    current = { lines: [], images: [] };
    drafts.push(current);
    return current;
  };

  for (const block of blocks) {
    const type = block.type;
    if (!type) continue;

    if (HEADINGS.has(type)) {
      start();
      continue;
    }

    if (TEXTUAL.has(type)) {
      // Text before any heading opens a post of its own rather than vanishing.
      (current ?? start()).lines.push(plainText(block, type));
      continue;
    }

    if (type === "image") {
      const image = block.image as ImageBlock | undefined;
      // A Notion-hosted file is a presigned S3 URL that expires in about an
      // hour. That is fine: Threads fetches it seconds after we hand it over.
      const url = image?.file?.url ?? image?.external?.url;
      if (url) (current ?? start()).images.push(url);
    }
  }

  return drafts
    .map((d) => ({
      text: d.lines.filter((l) => l.trim()).join("\n\n").trim(),
      images: d.images,
    }))
    // A structural heading like "# Contents" opens a post with nothing under
    // it; that one disappears here rather than being published empty.
    .filter((p) => p.text !== "" || p.images.length > 0);
}

/* ----------------------------------------------------------- threads api */

type Http = Ctx["http"];

/**
 * A failure that may or may not have taken effect. Only publish raises it, and
 * it is the one error in this file that must never be retried: a Threads
 * publish that died after the request left is a post that is quite possibly
 * live, and a second attempt would duplicate it.
 */
class AmbiguousFailure extends Error {
  readonly name = "AmbiguousFailure";
}

interface MetaErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/**
 * The clearest sentence we can manage about a failed Graph call.
 *
 * Meta's message is worth far more than "HTTP 400", and its `fbtrace_id` is
 * the only handle it gives you on an error whose body says nothing — so both
 * are dug out and put in the Log, which is where somebody debugging this will
 * actually be looking.
 */
function explain(err: unknown, what: string): string {
  if (err instanceof HttpError) {
    let body: MetaErrorBody | undefined;
    try {
      body = JSON.parse(err.body) as MetaErrorBody;
    } catch {
      body = undefined;
    }
    const meta = body?.error;
    if (meta?.message) {
      const sub = meta.error_subcode === undefined ? "" : `/${meta.error_subcode}`;
      const code = meta.code === undefined ? "" : ` [code ${meta.code}${sub}]`;
      const trace = meta.fbtrace_id ? ` (trace ${meta.fbtrace_id})` : "";
      return `${what}: ${meta.message}${code}${trace}`;
    }
    return `${what}: HTTP ${err.status} ${err.body.slice(0, 300)}`;
  }
  return `${what}: ${err instanceof Error ? err.message : String(err)}`;
}

/** Sleeps, but gives up the moment the run is cancelled or times out. */
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

type ContainerParams = Record<string, string | number | boolean | undefined>;

/**
 * Creates a media container and waits until Threads has finished processing
 * it. Polling rather than a fixed sleep, because text is instant and an image
 * is not.
 *
 * Every parameter goes on the **query string**. A JSON body earns a bare 400
 * with no explanation of what it disliked.
 */
async function createContainer(
  http: Http,
  signal: AbortSignal,
  token: string,
  params: ContainerParams,
  what: string,
): Promise<string> {
  let created: { id?: string };
  try {
    created = await http.post<{ id?: string }>(
      `${GRAPH}/${THREADS_USER_ID}/threads`,
      undefined,
      { query: { ...params, access_token: token } },
    );
  } catch (err) {
    throw new Error(explain(err, `${what} container`));
  }
  if (!created?.id) throw new Error(`${what} container: Threads answered with no id`);
  const id = created.id;

  // Nothing to process, and polling a TEXT container just wastes three seconds.
  if (params.media_type === "TEXT") return id;

  const deadline = Date.now() + MEDIA_POLL_MAX_MS;
  while (Date.now() < deadline) {
    await sleep(MEDIA_POLL_EVERY_MS, signal);

    let state: { status?: string; error_message?: string };
    try {
      state = await http.get<{ status?: string; error_message?: string }>(`${GRAPH}/${id}`, {
        query: { fields: "status,error_message", access_token: token },
      });
    } catch (err) {
      throw new Error(explain(err, `${what} status check`));
    }

    if (state?.status === "FINISHED") return id;
    if (state?.status === "ERROR" || state?.status === "EXPIRED") {
      throw new Error(
        `${what}: media ${String(state.status).toLowerCase()} — ` +
          `${state.error_message ?? "no detail given"}`,
      );
    }
  }
  throw new Error(`${what}: media still processing after ${MEDIA_POLL_MAX_MS / 1000}s`);
}

/**
 * Publishes a container and returns the **published** id — not the container
 * id, which is what the permalink lookup below would otherwise ask about.
 *
 * `retries: 0` overrides the http client's default, and it is the whole point
 * of this function. A 5xx or a dropped connection here does not mean the post
 * failed; it means we never found out. Retrying that risks two identical posts
 * in the chain, so it is raised as an `AmbiguousFailure` and a human is told
 * to look. A 4xx is safe — it definitively did not publish — and the caller's
 * attempt loop retries it with a fresh container.
 */
async function publishContainer(
  http: Http,
  token: string,
  creationId: string,
  what: string,
): Promise<string> {
  let published: { id?: string };
  try {
    published = await http.post<{ id?: string }>(
      `${GRAPH}/${THREADS_USER_ID}/threads_publish`,
      undefined,
      { query: { creation_id: creationId, access_token: token }, retries: 0 },
    );
  } catch (err) {
    const message = explain(err, `${what} publish`);
    // An HttpError carries a status, so a 4xx is knowably safe. Anything else
    // is a network failure or an abort — we never saw an answer at all.
    const definitive = err instanceof HttpError && err.status < 500;
    if (definitive) throw new Error(message);
    throw new AmbiguousFailure(
      `${message} — AMBIGUOUS, not retried: the post MAY be live, ` +
        `check the account before re-approving`,
    );
  }

  if (!published?.id) {
    // n8n retried this case. It should not have: Threads answered 200, so it
    // almost certainly published and merely failed to tell us the id.
    throw new AmbiguousFailure(
      `${what} publish: Threads answered 200 with no id — AMBIGUOUS, not retried: ` +
        `the post is probably live, check the account before re-approving`,
    );
  }
  return published.id;
}

interface ChainResult {
  /** Ids confirmed PUBLISHED, in order. */
  live: string[];
  failure: { index: number; message: string } | null;
}

/**
 * Publishes an ordered list of posts as one connected chain: post 1 stands
 * alone, and every post after it replies to the one before.
 *
 * **There is no rollback, by design.** The token has no `threads_delete`
 * scope, so if the chain breaks half way through, whatever is already live
 * stays live. The alternative — asking for delete scope so an automation can
 * remove published posts unattended — is a much larger blast radius than a
 * half thread somebody deletes by hand.
 *
 * Never throws. It always returns what got out and what went wrong, because
 * the caller's job is to write that into Notion.
 */
async function publishChain(
  ctx: Ctx<DuePage[]>,
  token: string,
  posts: Post[],
): Promise<ChainResult> {
  const live: string[] = [];
  let previousId: string | null = null;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]!;
    const what = `post ${i + 1}`;

    try {
      // Fail on what Threads would reject anyway, with a sentence that says
      // which limit and by how much.
      if (post.text.length > TEXT_MAX) {
        throw new Error(
          `${what}: text is ${post.text.length} chars, Threads caps posts at ${TEXT_MAX}`,
        );
      }
      if (post.images.length > CAROUSEL_MAX) {
        throw new Error(
          `${what}: ${post.images.length} images attached, ` +
            `Threads caps carousels at ${CAROUSEL_MAX}`,
        );
      }

      // Container and publish retry together, as one unit. Publishing a reply
      // fails with "resource does not exist" while its parent is not yet
      // replyable, and building a fresh container on the next attempt is the
      // fix that actually works — a container we abandon expires on its own.
      let publishedId: string | undefined;
      let lastError: unknown;

      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        // Image-only sections have no text, and an empty `text` parameter is
        // not the same as an absent one.
        const caption = post.text ? { text: post.text } : {};
        const reply = previousId ? { reply_to_id: previousId } : {};

        try {
          let creationId: string;
          if (post.images.length === 0) {
            creationId = await createContainer(
              ctx.http,
              ctx.signal,
              token,
              { media_type: "TEXT", text: post.text, ...reply },
              what,
            );
          } else if (post.images.length < CAROUSEL_MIN) {
            creationId = await createContainer(
              ctx.http,
              ctx.signal,
              token,
              { media_type: "IMAGE", image_url: post.images[0]!, ...caption, ...reply },
              what,
            );
          } else {
            // Carousel children carry no caption and no reply_to_id — both of
            // those live on the parent container.
            const children: string[] = [];
            for (const url of post.images) {
              children.push(
                await createContainer(
                  ctx.http,
                  ctx.signal,
                  token,
                  { media_type: "IMAGE", image_url: url, is_carousel_item: true },
                  `${what} image`,
                ),
              );
            }
            creationId = await createContainer(
              ctx.http,
              ctx.signal,
              token,
              { media_type: "CAROUSEL", children: children.join(","), ...caption, ...reply },
              what,
            );
          }

          await sleep(PUBLISH_WAIT_MS, ctx.signal);
          publishedId = await publishContainer(ctx.http, token, creationId, what);
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          // Duplicate risk. Stop and let a human decide.
          if (err instanceof AmbiguousFailure) break;
          if (attempt < ATTEMPTS) await sleep(SETTLE_MS * attempt, ctx.signal);
        }
      }
      if (lastError) throw lastError;

      previousId = publishedId!;
      live.push(publishedId!);

      // Let the post become a valid reply target before the next one asks to
      // reply to it.
      if (i < posts.length - 1) await sleep(SETTLE_MS, ctx.signal);
    } catch (err) {
      // Stop the chain. Never keep posting past a gap — the reader would get a
      // thread whose middle is missing and whose ending contradicts it.
      return {
        live,
        failure: { index: i, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  return { live, failure: null };
}

/* ------------------------------------------------------------- the outcome */

interface Outcome {
  pageId: string;
  pageName: string;
  pageUrl: string;
  status: "Posted" | "Failed";
  /** What goes in the row's Log property, and into the Telegram message. */
  log: string;
  threadUrl: string | null;
  postIds: string[];
  /** True when posts were left live on the account and must be deleted by hand. */
  needsCleanup: boolean;
}

/** Notion's rich_text caps a single fragment at 2000 characters. */
const LOG_MAX = 1900;

/* ------------------------------------------------------------------ telegram */

/** Telegram's HTML mode. Only these three, and the text here is arbitrary. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * `parse_mode` is HTML and every dynamic field above is escaped. There is no
 * way to turn parsing off — Telegram parses whatever mode you pick — and
 * Markdown was worse: a permalink with an underscore in it took the whole
 * message down once already.
 */
function alertFor(outcome: Outcome): string {
  const lines = [
    "\u{1F6A8} <b>Thread failed to post</b>",
    "",
    escapeHtml(outcome.pageName),
    "",
    escapeHtml(outcome.log),
  ];

  if (outcome.needsCleanup) {
    lines.push(
      "",
      `\u{26A0}\u{FE0F} NOT rolled back — ${outcome.postIds.length} post(s) are STILL LIVE. ` +
        `Delete them by hand:`,
      escapeHtml(outcome.threadUrl ?? `ids: ${outcome.postIds.join(", ")}`),
    );
  }

  lines.push("", escapeHtml(outcome.pageUrl));
  return lines.join("\n");
}

/* ---------------------------------------------------------------- workflow */

/** Marks the error thrown at the end of a batch whose failures were alerted. */
interface AlertedError extends Error {
  alerted?: boolean;
}

export default defineWorkflow<DuePage[]>({
  name: "the-mantra-threads-poster",
  description: "Posts due Approved threads from Notion to Threads",

  /**
   * n8n's "Every 4 min" checker, minus the second workflow. A tick that finds
   * nothing due does not create a run, so the dashboard shows the times this
   * actually posted something.
   *
   * `firstRun: "emit"` overrides the default. Baselining would mark every row
   * that is already Approved and overdue as seen without posting it, and those
   * rows would then sit there — until they aged out of the remembered window
   * hours later and posted all at once, which is worse than either outcome.
   */
  trigger: poll<DuePage>("*/4 * * * *", {
    tz: TZ,
    id: (page) => page.id,
    firstRun: "emit",
    async fetch(ctx) {
      // Without this the fetch would 401 every four minutes and file a failed
      // run each time. The runner already refuses the run itself; a poll's
      // fetch runs before the runner is ever reached.
      if (!notion.token) {
        ctx.log.warn("Notion credential is not connected — not looking for due rows");
        return [];
      }

      const res = await ctx.http.post<NotionQuery>(
        `https://api.notion.com/v1/databases/${THREADS_DB}/query`,
        {
          filter: {
            and: [
              { property: "Status", status: { equals: "Approved" } },
              // A row with no Post Date matches no date filter at all, so it
              // never posts. That is n8n's behaviour and it is the right one —
              // the runway alert is what tells you those rows exist.
              { property: "Post Date", date: { on_or_before: new Date().toISOString() } },
            ],
          },
          // Oldest first, so a backlog drains in the order it was meant to go
          // out rather than in whatever order Notion feels like.
          sorts: [{ property: "Post Date", direction: "ascending" }],
          page_size: MAX_PER_POLL,
        },
        { headers: notionHeaders() },
      );

      return res.results.map(toDuePage);
    },
  }),

  /**
   * **No retries, on purpose.** Everything worth retrying is already retried
   * closer to the failure: the http client retries a 429 or a 5xx, the chain
   * retries a container three times, and a row this run could not claim is
   * still Approved and comes back in four minutes. What is left is a run that
   * posted part of a thread — and re-running that is the one outcome nobody
   * wants. The run going red is the alert, not the trigger for another go.
   */
  retries: 0,

  /**
   * Five rows, each a chain of a few posts with a ten-second settle between
   * them, and up to ninety seconds of image processing per post. Fifteen
   * minutes is generous for the ordinary case and still bounded, and the
   * signal it aborts with unwinds the sleeps rather than being ignored.
   */
  timeoutMs: 900_000,

  /**
   * A checkpoint outliving the run is dangerous here rather than merely stale:
   * resuming tomorrow would replay a chain against a row somebody has since
   * edited. Within the hour it does the one thing worth doing — a resumed run
   * does not re-post a page that already went out.
   */
  checkpointTtlHours: 1,

  async run(ctx) {
    // Read outside a step, deliberately: a step result is checkpointed to
    // disk, and this is a live credential. Nothing in this file ever puts it
    // in a step result, a log line, or a returned value. It reaches the run
    // page only as the `access_token` query parameter of the captured Threads
    // calls, where the redactor scrubs it.
    const token = await threads.accessToken();

    // A *resume* from the dashboard carries no input — only a replay does — so
    // this is what a resumed run sees, and doing nothing is the right answer.
    // Re-deriving the due rows here instead would turn "resume the run that
    // half-posted" into "post whatever is due now", against a checkpoint key
    // that would then skip steps belonging to different rows entirely.
    const pages = Array.isArray(ctx.input) ? ctx.input : [];
    if (pages.length === 0) {
      ctx.log.info(
        "No pages in the input — a resumed run carries none. Nothing to post; the " +
          "poll will pick up whatever is due on its next tick.",
      );
      return { pages: 0, posted: 0, failed: 0 };
    }

    const outcomes: Outcome[] = [];

    for (const page of pages) {
      /*
       * Claim the row *before* anything is published.
       *
       * In n8n this was the only thing preventing a double post, because two
       * executions could overlap freely. Here `onOverlap: "skip"` and the
       * poll's seen-set already make that nearly impossible — but this is
       * still load-bearing, and for a better reason: the poll's filter is
       * `Status = Approved`, so flipping the row to Posting is what takes it
       * out of the query. A run that dies after publishing leaves the row on
       * Posting, and a row on Posting is never picked up again. That is the
       * whole no-double-post guarantee, and it is why the Notion write happens
       * first even though it costs a round trip before any work.
       */
      await ctx.step(
        `lock ${page.id}`,
        () => setStatus(ctx, page.id, "Posting"),
        { input: { page: page.title } },
      );

      const outcome = await ctx.step<Outcome>(
        `post ${page.id}`,
        async () => {
          const blocks = await ctx.http
            .paginate<NotionBlock>(`https://api.notion.com/v1/blocks/${page.id}/children`, {
              headers: notionHeaders(),
              query: { page_size: 100 },
              items: "results",
              next: { cursor: "next_cursor", param: "start_cursor" },
              maxPages: MAX_BLOCK_PAGES,
            })
            .all();

          const posts = toPosts(blocks);
          const stamp = new Date().toISOString();

          if (posts.length === 0) {
            return {
              pageId: page.id,
              pageName: page.title,
              pageUrl: page.url,
              status: "Failed",
              log: `${stamp} FAILED: nothing to post — add a heading (### #1) with text under it`,
              threadUrl: null,
              postIds: [],
              needsCleanup: false,
            };
          }

          const { live, failure } = await publishChain(ctx, token, posts);

          // Fetched even on failure, so the alert links straight to the half
          // thread that needs deleting. Never worth failing the row over.
          let threadUrl: string | null = null;
          if (live.length > 0) {
            const permalink = await ctx.http
              .get<{ permalink?: string }>(`${GRAPH}/${live[0]}`, {
                query: { fields: "permalink", access_token: token },
              })
              .catch(() => null);
            threadUrl = permalink?.permalink ?? null;
          }

          const needsCleanup = failure !== null && live.length > 0;
          const log = failure
            ? `${stamp} FAILED on post ${failure.index + 1}/${posts.length}: ${failure.message}.` +
              (needsCleanup
                ? ` ${live.length} post(s) ARE STILL LIVE and were NOT deleted — ` +
                  `remove by hand: ${live.join(", ")}.`
                : " Nothing was published.")
            : `${stamp} OK — posted ${live.length}/${posts.length}. ids: ${live.join(", ")}`;

          return {
            pageId: page.id,
            pageName: page.title,
            pageUrl: page.url,
            status: failure ? "Failed" : "Posted",
            log: log.slice(0, LOG_MAX),
            threadUrl,
            postIds: live,
            needsCleanup,
          };
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
                // null, not "" — Notion's url property rejects an empty string.
                "Thread URL": { url: outcome.threadUrl },
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
          // Swallowed on purpose, and the only swallowed error in this file.
          // The outcome is already in Notion and on the run page; a Telegram
          // outage should cost this message, not the rows still to post.
          try {
            await ctx.telegram.send(alertFor(outcome), {
              token: telegram.token,
              // Configuration rather than a secret, so it stays readable on
              // the run page. Shared with the runway alert and the token
              // refresh — all three go to the same person. Unset, it falls
              // back to this credential's own chat id, never to another
              // brand's default.
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
    const summary = {
      pages: outcomes.length,
      posted: outcomes.length - failed.length,
      failed: failed.length,
      needsCleanup: failed.filter((o) => o.needsCleanup).map((o) => o.pageName),
    };

    if (failed.length > 0) {
      // The run goes red. n8n's went green and left the whole story in a
      // Telegram message, which is a worse place to keep it than the dashboard
      // that exists to show exactly this.
      const error: AlertedError = new Error(
        `${failed.length} of ${outcomes.length} thread(s) failed: ` +
          failed.map((o) => `${o.pageName} — ${o.log}`).join(" | "),
      );
      // onFailure has already sent one message per failed row; this stops it
      // sending a second, less useful one about the batch.
      error.alerted = true;
      throw error;
    }

    return summary;
  },

  /**
   * The n8n "Error Handler" graph, as a property of the workflow that fails
   * rather than a separate graph wired up in Settings.
   *
   * It only ever speaks about a *crash* — an unexpected failure in the lock,
   * the block fetch, the Notion write, or the token. A row that simply failed
   * to post has already been alerted, row by row, with far more detail than
   * this could give.
   */
  async onFailure(ctx, error) {
    if ((error as AlertedError).alerted) {
      ctx.log.info("Per-row alerts already went out — not sending a batch message");
      return;
    }

    const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
    const lines = [
      "\u{1F525} <b>Threads poster CRASHED</b>",
      "",
      // Composed here and sent *out*, so it misses every redaction the runner
      // does on the way to disk — and the Threads token travels in the URL.
      escapeHtml(redact(error.message)),
      "",
      "\u{26A0}\u{FE0F} A row may be stuck on <b>Posting</b> in Notion. Check it — if the " +
        "thread did NOT go out, set it back to <b>Approved</b>. If it did, set it to " +
        "<b>Posted</b>. A row left on Posting is never picked up again.",
    ];
    if (base) lines.push("", `${base}/runs/${ctx.runId}`);

    await ctx.telegram.send(lines.join("\n"), {
      token: telegram.token,
      chatId: process.env.TELEGRAM_CHAT_ID_HUZAIFAH ?? telegram.chat_id,
      parseMode: "HTML",
    });
  },
});

/* ------------------------------------------------------------------ helpers */

/** The one Notion write that happens before anything is published. */
async function setStatus(
  ctx: Ctx<DuePage[]>,
  pageId: string,
  status: "Posting",
): Promise<{ status: string }> {
  await ctx.http.patch(
    `https://api.notion.com/v1/pages/${pageId}`,
    { properties: { Status: { status: { name: status } } } },
    { headers: notionHeaders() },
  );
  return { status };
}
