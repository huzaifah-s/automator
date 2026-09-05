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
 * The Mantra — Cross-post to Instagram, Facebook and Threads.
 *
 * Takes rows in the Notion Contents database that already went out on TikTok,
 * waited out the stagger, and have not been cross-posted yet; pushes their
 * media and caption to the three Meta platforms; and ticks each one off in the
 * page's own **Postings** checklist as it lands.
 *
 * A port of three n8n graphs, merged into one:
 *
 *   "The Mantra - Cross-post Checker"        (every 5 min → Notion getAll →
 *                                             slim rows → execute workflow)
 *   "The Mantra - Cross-post (IG, FB &
 *    Threads)"                               (trigger → claim → loop → blocks →
 *                                             parse → drive → R2 → 3 × publish →
 *                                             merge → evaluate → cleanup → notify)
 *   "The Mantra - Cross-post Error Handler"  (error trigger → find stuck rows →
 *                                             telegram)
 *
 * **Why one workflow and not three.** The same three reasons the Threads
 * poster collapsed, and they are not repeated here — see the header of
 * `threads-poster.ts`. In short: the checker existed because n8n files a run
 * for every tick and `poll()` does not, and the error handler was n8n's
 * `errorTrigger`, which `onFailure` replaces as a property of the workflow
 * that actually failed.
 *
 * **What the Postings checklist buys, and why it is kept.** It is the best
 * idea in the n8n version. Publishing to three platforms is three chances to
 * fail independently, and a row that got as far as Instagram must not start
 * over from Instagram. Each platform is ticked in Notion the moment it lands,
 * the row is released back to `Posted` if anything failed, and the next tick
 * picks it up and posts only what is still unticked. Ported as-is.
 *
 * Seven things the n8n version got wrong or left implicit, fixed here:
 *
 * 1. **The Facebook page token is no longer in the workflow.** It was pasted
 *    literally into two HTTP nodes, which put it in the n8n database, in every
 *    execution record, and in the exported JSON. It is now a credential: in the
 *    encrypted store, registered with the redactor, and scrubbed out of every
 *    captured Graph call. The token that was in those nodes must be treated as
 *    compromised and rotated — this file cannot do that for you.
 * 2. **A failed row makes the run red.** n8n's code caught everything and
 *    returned a status string, so the execution went green and only Telegram
 *    knew. It also means the poll does not mark the row seen, so it is retried.
 * 3. **A partial Facebook carousel no longer crashes the batch.** n8n's
 *    "Collect FB Photo IDs" threw when fewer photos came back than went up,
 *    which escaped as an unhandled error and took the remaining rows with it.
 *    Here it is a platform failure like any other: the row is released and the
 *    other rows in the batch still run.
 * 4. **A publish that answered ambiguously is never retried.** Same rule as
 *    the Threads poster, for the same reason: a 5xx after the request left is
 *    a post that may well be live, and retrying duplicates it.
 * 5. **The title is found by property type**, not by assuming "Name".
 * 6. **A backlog drains a few rows per tick** rather than becoming one
 *    enormous run. The cap is in the query, not a slice after it, because the
 *    poll marks everything it emits as seen.
 * 7. **Media is deleted from R2 whatever happens**, including on the paths
 *    where n8n's linear graph would simply not have reached the delete node.
 *
 * **One trap deliberately kept.** The window below only looks at rows whose
 * TikTok post date is between MIN_AGE_DAYS and MAX_AGE_DAYS ago. A row that
 * ages past MAX_AGE_DAYS — because the runner was down for a week, or the row
 * sat in `Posting` — is never cross-posted and nothing says so. That is n8n's
 * behaviour and changing it here would silently back-post a pile of old
 * content on the first deploy. It is a known gap, not an oversight: the fix is
 * an alert for rows that fell out of the window, which nothing has asked for
 * yet.
 */

/* ------------------------------------------------------------ credentials */

/**
 * The same Notion slot the Threads poster, the runway alert and the Contents
 * notifier use. It needs **write** access here: this sets Status, ticks the
 * Postings to-dos, and appends the checklist to pages that predate it.
 */
const notion = defineCredential("notion", "the-mantra-contents");

/** The Mantra's own bot, so a cross-post failure lands beside the others. */
const telegram = defineCredential("telegram", "the-mantra");

/**
 * Instagram and Facebook, which share one Graph token when the IG account is a
 * Business account linked to the Page — which The Mantra's is.
 *
 * The two ids on this credential are `secret: false` and that is deliberate:
 * they are in the path of every Graph URL, so redacting them would blank out
 * the run page while protecting nothing.
 */
const meta = defineCredential("meta", "the-mantra");

/**
 * Object storage, purely as a place Meta can fetch media from. Declared as a
 * credential rather than left to environment variables so an unconnected
 * bucket blocks this workflow with a clear message instead of failing halfway
 * through a row, after the media has already been downloaded.
 */
const bucket = defineCredential("r2", "the-mantra");

/**
 * The Mantra's *brand* Threads account — a different account from the
 * founder's, so a different credential and a different stored token. They must
 * never share one: a token issued to one account posts to that account, and
 * nothing in the error would say so.
 *
 * Declared exactly as `threads-token-auto-refresh.ts` declares it, which is
 * what makes the two share a stored token. See the note in `threads-poster.ts`
 * on why this is a copy rather than an import.
 */
const threads = defineOAuth("threads-the-mantra", {
  tokenUrl: "https://graph.threads.net/refresh_access_token",
  flow: "self",
  grantType: "th_refresh_token",
  defaultTtlSeconds: 60 * 24 * 60 * 60,
});

/* ---------------------------------------------------------- configuration */

const TZ = "Asia/Kuala_Lumpur";

/** The Contents database — the one the notifier and the bot commands read. */
const CONTENTS_DB = "39903cbd-c49e-805d-8a15-e991fc30b12e";

/** Pinned rather than floating: a schema change should not arrive unannounced. */
const NOTION_VERSION = "2022-06-28";

/**
 * Property names, verified against the live database rather than copied from
 * the n8n filter or from the constants in `notion-contents-telegram-commands.ts`
 * — those two disagree, and one of them is wrong. A Notion *filter* matches the
 * name exactly, with no loose fallback available, so a typo here is a query
 * that silently returns nothing forever.
 */
const PROPS = {
  status: "Status",
  type: "Type",
  postDateTikTok: "Post date (TikTok)",
  postedTikTok: "Posted (Tiktok)",
  postedOthers: "Posted (others)",
} as const;

/** The Threads account these post from. Not the founder's. */
const THREADS_USER_ID = "27171039782592332";

const GRAPH_FB = "https://graph.facebook.com/v21.0";
const GRAPH_TH = "https://graph.threads.net/v1.0";
const RUPLOAD = "https://rupload.facebook.com/video-upload/v21.0";

/**
 * The stagger: cross-post no sooner than three days after TikTok, and give up
 * after ten. See the header — the ceiling is a known trap kept on purpose.
 */
const MIN_AGE_DAYS = 3;
const MAX_AGE_DAYS = 10;

/**
 * Rows per tick. Lower than the Threads poster's five because every row here
 * moves real media twice — down from Drive, up to R2 — and three platforms
 * then fetch it. Three rows is roughly the most that fits comfortably inside
 * `timeoutMs` with a video in each.
 */
const MAX_PER_POLL = 3;

/** Blocks in one page body. The template is nowhere near this. */
const MAX_BLOCK_PAGES = 3;

/** Carousel caps. Instagram's ten is the binding one, so it is the limit. */
const CAROUSEL_MAX = 10;
const CAROUSEL_MIN = 2;

/** Threads truncates past this; the others are far more generous. */
const THREADS_TEXT_MAX = 500;

/** One Drive file. Comfortably over a reel, well under anything alarming. */
const MAX_FILE_BYTES = 300 * 1024 * 1024;

/* --- waits the Graph APIs need but do not document */

const MEDIA_POLL_EVERY_MS = 4_000;
/** Give up on a container that never finishes processing. A reel is slow. */
const MEDIA_POLL_MAX_MS = 300_000;
/** Container → publish. Meta needs a beat even once a container says FINISHED. */
const PUBLISH_WAIT_MS = 3_000;

/* ------------------------------------------------------------------ notion */

interface NotionTextFragment {
  plain_text?: string;
  href?: string | null;
  text?: { link?: { url?: string } | null };
}

interface NotionProperty {
  type?: string;
  title?: NotionTextFragment[];
  select?: { name?: string };
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
  /** "Video" | "Image" | "Text" — what the author said this is. */
  contentType: string;
}

function notionHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${notion.token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

/**
 * The row's title, found by property *type* rather than by the name "Name",
 * because a Notion database's title column can be renamed in one click and
 * every alert would quietly become "Untitled".
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
  const type = page.properties?.[PROPS.type];
  return {
    id: page.id,
    title: titleOf(page),
    url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
    contentType: type?.select?.name ?? "Video",
  };
}

/** Days ago, as an ISO instant — what the date filter below compares against. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/* -------------------------------------------------- notion page → content */

interface NotionBlock {
  id?: string;
  type?: string;
  [key: string]: unknown;
}

interface RichTextHolder {
  rich_text?: NotionTextFragment[];
  text?: NotionTextFragment[];
}

/** One platform's checkbox in the page's Postings list. */
interface Todo {
  id: string;
  checked: boolean;
}

type Platform = "instagram" | "facebook" | "threads";
const PLATFORMS: Platform[] = ["instagram", "facebook", "threads"];

interface ParsedPage {
  caption: string;
  /** Google Drive file ids, in the order they appear under File(s). */
  driveIds: string[];
  todos: Partial<Record<Platform, Todo>>;
  /** True when the page has no usable Postings block and one must be added. */
  needsPostings: boolean;
}

/** Blocks that can carry a link under the File(s) heading. */
const LINK_BEARING = new Set([
  "bulleted_list_item",
  "numbered_list_item",
  "paragraph",
  "to_do",
]);

const HEADINGS = new Set(["heading_1", "heading_2", "heading_3"]);

function richTextOf(block: NotionBlock, type: string): NotionTextFragment[] {
  const holder = block[type] as RichTextHolder | undefined;
  return holder?.rich_text ?? holder?.text ?? [];
}

function plainText(block: NotionBlock, type: string): string {
  return richTextOf(block, type).map((t) => t.plain_text ?? "").join("");
}

/** Section headings, compared with case and spacing taken out. */
function sectionKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * Reads a page top to bottom and pulls out the three things a cross-post
 * needs: the caption, the media, and the Postings checklist.
 *
 * Section-scoped throughout, exactly like the n8n Code node it replaces —
 * which is load-bearing rather than incidental. The template also has Hook,
 * Script and Image Prompt(s) sections and an instructional callout inside
 * File(s), and none of that may reach a caption or be mistaken for media.
 */
function parsePage(blocks: NotionBlock[]): ParsedPage {
  let section: string | null = null;
  let sawPostings = false;

  const captionParts: string[] = [];
  const driveIds: string[] = [];
  const seenDrive = new Set<string>();
  const todos: Partial<Record<Platform, Todo>> = {};

  for (const block of blocks) {
    const type = block.type;
    if (!type) continue;

    if (HEADINGS.has(type)) {
      section = sectionKey(plainText(block, type));
      if (section === "postings") sawPostings = true;
      continue;
    }

    if (section === "caption" && type === "quote") {
      const text = plainText(block, type).trim();
      if (text) captionParts.push(text);
      continue;
    }

    if (section === "file(s)" && LINK_BEARING.has(type)) {
      for (const fragment of richTextOf(block, type)) {
        // The link may be a real Notion link (href) or plain pasted text.
        const candidate = (
          fragment.href ??
          fragment.text?.link?.url ??
          fragment.plain_text ??
          ""
        ).trim();
        if (!candidate.includes("drive.google.com")) continue;

        const id = driveFileId(candidate);
        if (!id) {
          // A folder link is the single most common mistake here, and "could
          // not parse an id" would send somebody looking at the id.
          throw new Error(
            candidate.includes("/folders/")
              ? `File(s) contains a FOLDER link — link directly to each file: ${candidate}`
              : `File(s) contains a Drive link with no file id in it: ${candidate}`,
          );
        }
        // Deduplicated: the same file listed twice is a slip, not a request
        // for a two-item carousel of one picture.
        if (seenDrive.has(id)) continue;
        seenDrive.add(id);
        driveIds.push(id);
      }
      continue;
    }

    if (section === "postings" && type === "to_do") {
      const label = plainText(block, type).trim().toLowerCase();
      const platform = PLATFORMS.find((p) => p === label);
      if (platform && block.id) {
        todos[platform] = {
          id: block.id,
          checked: Boolean((block.to_do as { checked?: boolean } | undefined)?.checked),
        };
      }
    }
  }

  return {
    caption: captionParts.join("\n\n").trim(),
    driveIds,
    todos,
    // TikTok and X are in the template too, and are none of this workflow's
    // business — only the three it posts to have to be present.
    needsPostings: !sawPostings || PLATFORMS.some((p) => !todos[p]),
  };
}

/**
 * A Drive file id out of any of the URL shapes people paste. Null for a folder
 * link, which the caller reports as its own mistake.
 */
function driveFileId(url: string): string | null {
  if (url.includes("/folders/")) return null;
  const match =
    url.match(/\/file\/d\/([A-Za-z0-9_-]+)/) ??
    url.match(/[?&]id=([A-Za-z0-9_-]+)/) ??
    url.match(/\/d\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

/** What a page must have before anything is published from it. */
function validate(page: DuePage, parsed: ParsedPage): void {
  if (!parsed.caption) {
    throw new Error(`Caption section is empty — put the caption in the quote block under it`);
  }
  if (parsed.driveIds.length === 0) {
    throw new Error(`No Google Drive links found under the File(s) heading`);
  }
  if (page.contentType === "Video" && parsed.driveIds.length > 1) {
    throw new Error(
      `Type is Video but File(s) lists ${parsed.driveIds.length} files — Video takes exactly one`,
    );
  }
  if (parsed.driveIds.length > CAROUSEL_MAX) {
    throw new Error(`${parsed.driveIds.length} files listed — carousels cap at ${CAROUSEL_MAX}`);
  }
}

/* -------------------------------------------------------------- the media */

/** One file, already public. */
interface Media {
  /** The R2 key, so it can be deleted again. */
  key: string;
  /** The public URL handed to Meta. */
  url: string;
  isImage: boolean;
}

interface MediaSet {
  items: Media[];
  isImage: boolean;
  keys: string[];
  urls: string[];
}

/**
 * Moves every file from Drive to R2 and returns the public URLs.
 *
 * The bytes never leave this function and are never returned from a step:
 * a step result is checkpointed to disk, and a 200MB video is not something to
 * put through a 256KB ceiling. What comes back is keys and URLs.
 */
async function stage(
  ctx: Ctx<DuePage[]>,
  page: DuePage,
  driveIds: string[],
  /** Appended to as each object lands, so the caller can clean up a partial run. */
  staged: string[],
): Promise<MediaSet> {
  // One stamp for the whole row, so every key from one attempt sorts together
  // in the bucket if anything is ever left behind.
  const stamp = Date.now();
  const items: Media[] = [];

  for (const [index, driveId] of driveIds.entries()) {
    const file = await ctx.drive.download(driveId, { maxBytes: MAX_FILE_BYTES });

    const isImage = file.mimeType.startsWith("image/");
    const isVideo = file.mimeType.startsWith("video/");
    if (!isImage && !isVideo) {
      throw new Error(
        `"${file.name}" is ${file.mimeType}, which is neither an image nor a video`,
      );
    }

    // The extension matters: Meta content-sniffs, but a URL that ends in
    // something plausible is what makes a failure debuggable by eye.
    const ext =
      file.name.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? (isImage ? "jpg" : "mp4");
    const key = `crosspost-${page.id.replace(/-/g, "")}-${stamp}-${index}.${ext}`;

    const url = await ctx.s3.put(key, file.bytes, { contentType: file.mimeType });
    staged.push(key);
    items.push({ key, url, isImage });
  }

  // A row that mixes a photo and a video has no meaning on any of the three
  // platforms, and finding out at the third publish is far too late.
  const isImage = items.every((m) => m.isImage);
  if (items.some((m) => m.isImage) !== isImage) {
    throw new Error(`File(s) mixes images and video — pick one`);
  }

  return { items, isImage, keys: items.map((m) => m.key), urls: items.map((m) => m.url) };
}

/* ------------------------------------------------------------ graph plumbing */

type Http = Ctx["http"];

/**
 * A failure that may or may not have taken effect. Only a publish raises it,
 * and it is the one error here that must never be retried: a publish that died
 * after the request left is a post that is quite possibly live.
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
 * The clearest sentence we can manage about a failed Graph call. Meta's own
 * message is worth far more than "HTTP 400", and `fbtrace_id` is the only
 * handle it gives you on an error whose body says nothing.
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

type Params = Record<string, string | number | boolean | undefined>;

/**
 * What each API calls the two things we need off a media container.
 *
 * They are not the same, and that is the whole reason this is a table rather
 * than one string. Instagram reports `status_code` and explains itself in
 * `status`; Threads reports `status` and explains itself in `error_message`.
 * Asking either one for the other's field fails the entire request rather than
 * returning null for the field it does not know.
 */
interface ContainerFields {
  /** Carries FINISHED / IN_PROGRESS / ERROR / EXPIRED / PUBLISHED. */
  status: string;
  /** Carries the human explanation, and only read once status says ERROR. */
  detail: string;
}

const IG_FIELDS: ContainerFields = { status: "status_code", detail: "status" };
const TH_FIELDS: ContainerFields = { status: "status", detail: "error_message" };

/**
 * Waits for a media container to finish processing.
 *
 * Instagram and Threads both answer with a status field, under different
 * names, which is the only reason `field` is a parameter. A container that is
 * still IN_PROGRESS when you publish it fails with an error about the *post*,
 * not about the media, so this is worth the wait.
 */
async function awaitContainer(
  http: Http,
  signal: AbortSignal,
  base: string,
  id: string,
  token: string,
  fields: ContainerFields,
  what: string,
): Promise<void> {
  const deadline = Date.now() + MEDIA_POLL_MAX_MS;

  while (Date.now() < deadline) {
    await sleep(MEDIA_POLL_EVERY_MS, signal);

    let state: Record<string, string | undefined>;
    try {
      // Only the status field. Asking for the detail field alongside it is
      // what broke this the first time: Instagram has no `error_message`, and
      // Graph answers a request for one unknown field by failing the WHOLE
      // call with "(#100) Tried accessing nonexisting field" — so a healthy,
      // finished container looked like a hard error and the post never went
      // out. The detail is fetched below, only once something has gone wrong.
      state = await http.get<Record<string, string | undefined>>(`${base}/${id}`, {
        query: { fields: fields.status, access_token: token },
      });
    } catch (err) {
      throw new Error(explain(err, `${what} status check`));
    }

    const status = state?.[fields.status];
    if (status === "FINISHED") return;
    // PUBLISHED means somebody got there first, which is a success we should
    // not then try to publish again.
    if (status === "PUBLISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      const detail = await describeFailure(http, base, id, token, fields);
      throw new Error(`${what}: media ${String(status).toLowerCase()} — ${detail}`);
    }
  }

  throw new Error(`${what}: media still processing after ${MEDIA_POLL_MAX_MS / 1000}s`);
}

/**
 * Why a container failed, best effort.
 *
 * A separate call, and one that never throws: we are already reporting a
 * failure, and losing the *reason* to a second failure — an unsupported field,
 * a token that just expired — would replace a useful message with a confusing
 * one. "no detail given" is a worse answer than Meta's own words and a much
 * better one than a different error.
 */
async function describeFailure(
  http: Http,
  base: string,
  id: string,
  token: string,
  fields: ContainerFields,
): Promise<string> {
  try {
    const state = await http.get<Record<string, string | undefined>>(`${base}/${id}`, {
      query: { fields: fields.detail, access_token: token },
    });
    const detail = state?.[fields.detail];
    return detail && detail.trim() ? detail : "no detail given";
  } catch {
    return "no detail given";
  }
}

/** Creates a container and returns its id. Every parameter goes on the query. */
async function createContainer(
  http: Http,
  base: string,
  owner: string,
  token: string,
  params: Params,
  what: string,
): Promise<string> {
  const path = base === GRAPH_TH ? "threads" : "media";
  let created: { id?: string };
  try {
    created = await http.post<{ id?: string }>(`${base}/${owner}/${path}`, undefined, {
      query: { ...params, access_token: token },
    });
  } catch (err) {
    throw new Error(explain(err, `${what} container`));
  }
  if (!created?.id) throw new Error(`${what} container: answered with no id`);
  return created.id;
}

/**
 * Publishes a container and returns the published id.
 *
 * `retries: 0` overrides the http client's default and is the whole point of
 * this function. A 5xx or a dropped connection does not mean the post failed;
 * it means we never found out, and retrying that risks a duplicate. A 4xx is
 * safe — it definitively did not publish — and the caller may retry it.
 */
async function publishContainer(
  http: Http,
  base: string,
  owner: string,
  token: string,
  creationId: string,
  what: string,
): Promise<string> {
  const path = base === GRAPH_TH ? "threads_publish" : "media_publish";
  let published: { id?: string };
  try {
    published = await http.post<{ id?: string }>(`${base}/${owner}/${path}`, undefined, {
      query: { creation_id: creationId, access_token: token },
      retries: 0,
    });
  } catch (err) {
    const message = explain(err, `${what} publish`);
    const definitive = err instanceof HttpError && err.status < 500;
    if (definitive) throw new Error(message);
    throw new AmbiguousFailure(
      `${message} — AMBIGUOUS, not retried: the post MAY be live, check the account`,
    );
  }

  if (!published?.id) {
    throw new AmbiguousFailure(
      `${what} publish: answered 200 with no id — AMBIGUOUS, not retried: ` +
        `the post is probably live, check the account`,
    );
  }
  return published.id;
}

/* ----------------------------------------------------------- instagram */

/**
 * A reel, a photo, or a carousel — decided by what is in File(s), not by a
 * setting, because the media is the only thing that actually constrains it.
 *
 * `thumb_offset: 0` takes the first frame as the cover. The Notion template
 * tells the author to bake their CapCut cover in as the opening frame, so zero
 * is that cover. Do not raise it without re-reading that callout.
 */
async function publishInstagram(
  ctx: Ctx<DuePage[]>,
  token: string,
  igUserId: string,
  media: MediaSet,
  caption: string,
): Promise<string> {
  const what = "instagram";
  let creationId: string;

  if (!media.isImage) {
    creationId = await createContainer(ctx.http, GRAPH_FB, igUserId, token, {
      media_type: "REELS",
      video_url: media.urls[0],
      caption,
      share_to_feed: true,
      thumb_offset: 0,
    }, what);
    await awaitContainer(ctx.http, ctx.signal, GRAPH_FB, creationId, token, IG_FIELDS, what);
  } else if (media.urls.length < CAROUSEL_MIN) {
    creationId = await createContainer(ctx.http, GRAPH_FB, igUserId, token, {
      image_url: media.urls[0],
      caption,
    }, what);
    await awaitContainer(ctx.http, ctx.signal, GRAPH_FB, creationId, token, IG_FIELDS, what);
  } else {
    // Carousel children carry no caption — that lives on the parent.
    const children: string[] = [];
    for (const [index, url] of media.urls.entries()) {
      const child = await createContainer(ctx.http, GRAPH_FB, igUserId, token, {
        image_url: url,
        is_carousel_item: true,
      }, `${what} image ${index + 1}`);
      await awaitContainer(
        ctx.http, ctx.signal, GRAPH_FB, child, token, IG_FIELDS,
        `${what} image ${index + 1}`,
      );
      children.push(child);
    }
    creationId = await createContainer(ctx.http, GRAPH_FB, igUserId, token, {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption,
    }, what);
    await awaitContainer(ctx.http, ctx.signal, GRAPH_FB, creationId, token, IG_FIELDS, what);
  }

  await sleep(PUBLISH_WAIT_MS, ctx.signal);
  return publishContainer(ctx.http, GRAPH_FB, igUserId, token, creationId, what);
}

/* ------------------------------------------------------------ facebook */

/**
 * A reel, a photo, or a multi-photo feed post.
 *
 * The multi-photo path is raw Graph on purpose and was in n8n too: there is no
 * single "post a carousel" call. Each photo is uploaded *unpublished*, and the
 * returned ids are attached to one feed post. n8n threw when fewer ids came
 * back than went up, and that throw escaped and killed the batch; here it is
 * an ordinary platform failure.
 */
async function publishFacebook(
  ctx: Ctx<DuePage[]>,
  token: string,
  pageId: string,
  media: MediaSet,
  caption: string,
): Promise<string> {
  if (!media.isImage) return publishFacebookReel(ctx, token, pageId, media.urls[0]!, caption);

  if (media.urls.length < CAROUSEL_MIN) {
    try {
      const photo = await ctx.http.post<{ id?: string; post_id?: string }>(
        `${GRAPH_FB}/${pageId}/photos`,
        undefined,
        { query: { url: media.urls[0], caption, access_token: token }, retries: 0 },
      );
      const id = photo?.post_id ?? photo?.id;
      if (!id) throw new AmbiguousFailure("facebook photo: answered 200 with no id");
      return id;
    } catch (err) {
      if (err instanceof AmbiguousFailure) throw err;
      const definitive = err instanceof HttpError && err.status < 500;
      const message = explain(err, "facebook photo");
      if (definitive) throw new Error(message);
      throw new AmbiguousFailure(`${message} — AMBIGUOUS, not retried: the photo MAY be live`);
    }
  }

  // Unpublished uploads are safe to retry — nothing is visible until the feed
  // post below attaches them — so these keep the http client's default retries.
  const attached: { media_fbid: string }[] = [];
  for (const [index, url] of media.urls.entries()) {
    let photo: { id?: string };
    try {
      photo = await ctx.http.post<{ id?: string }>(`${GRAPH_FB}/${pageId}/photos`, undefined, {
        query: { url, published: false, access_token: token },
      });
    } catch (err) {
      throw new Error(explain(err, `facebook photo ${index + 1} of ${media.urls.length}`));
    }
    if (!photo?.id) {
      throw new Error(`facebook photo ${index + 1}: uploaded but answered with no id`);
    }
    attached.push({ media_fbid: photo.id });
  }

  try {
    const post = await ctx.http.post<{ id?: string }>(`${GRAPH_FB}/${pageId}/feed`, undefined, {
      query: {
        message: caption,
        attached_media: JSON.stringify(attached),
        access_token: token,
      },
      retries: 0,
    });
    if (!post?.id) throw new AmbiguousFailure("facebook feed: answered 200 with no id");
    return post.id;
  } catch (err) {
    if (err instanceof AmbiguousFailure) throw err;
    const definitive = err instanceof HttpError && err.status < 500;
    const message = explain(err, "facebook feed");
    if (definitive) throw new Error(message);
    throw new AmbiguousFailure(`${message} — AMBIGUOUS, not retried: the post MAY be live`);
  }
}

/**
 * Facebook Reels, which is a three-phase upload and not a container like
 * everything else here: start reserves a video id and an upload session, the
 * rupload host is told where to fetch the file from, and finish publishes it.
 *
 * The `file_url` header on the rupload call is what lets Facebook pull the
 * video from R2 rather than us streaming the bytes a second time.
 */
async function publishFacebookReel(
  ctx: Ctx<DuePage[]>,
  token: string,
  pageId: string,
  videoUrl: string,
  caption: string,
): Promise<string> {
  let started: { video_id?: string };
  try {
    started = await ctx.http.post<{ video_id?: string }>(
      `${GRAPH_FB}/${pageId}/video_reels`,
      undefined,
      { query: { upload_phase: "start", access_token: token } },
    );
  } catch (err) {
    throw new Error(explain(err, "facebook reel start"));
  }
  const videoId = started?.video_id;
  if (!videoId) throw new Error("facebook reel start: answered with no video_id");

  try {
    await ctx.http.post(`${RUPLOAD}/${videoId}`, undefined, {
      headers: {
        // OAuth, not Bearer. Graph accepts both; rupload does not.
        authorization: `OAuth ${token}`,
        file_url: videoUrl,
      },
    });
  } catch (err) {
    throw new Error(explain(err, "facebook reel upload"));
  }

  try {
    const finished = await ctx.http.post<{ success?: boolean }>(
      `${GRAPH_FB}/${pageId}/video_reels`,
      undefined,
      {
        query: {
          video_id: videoId,
          upload_phase: "finish",
          video_state: "PUBLISHED",
          description: caption,
          access_token: token,
        },
        retries: 0,
      },
    );
    if (finished?.success === false) throw new Error("facebook reel finish: answered success=false");
    return videoId;
  } catch (err) {
    const definitive = err instanceof HttpError && err.status < 500;
    const message = explain(err, "facebook reel finish");
    if (definitive) throw new Error(message);
    throw new AmbiguousFailure(`${message} — AMBIGUOUS, not retried: the reel MAY be live`);
  }
}

/* ------------------------------------------------------------- threads */

async function publishThreads(
  ctx: Ctx<DuePage[]>,
  token: string,
  media: MediaSet,
  caption: string,
): Promise<string> {
  const what = "threads";
  // Threads is the only one of the three with a hard text cap, and it rejects
  // rather than truncates.
  const text = caption.slice(0, THREADS_TEXT_MAX);
  let creationId: string;

  if (!media.isImage) {
    creationId = await createContainer(ctx.http, GRAPH_TH, THREADS_USER_ID, token, {
      media_type: "VIDEO",
      video_url: media.urls[0],
      text,
    }, what);
    await awaitContainer(ctx.http, ctx.signal, GRAPH_TH, creationId, token, TH_FIELDS, what);
  } else if (media.urls.length < CAROUSEL_MIN) {
    creationId = await createContainer(ctx.http, GRAPH_TH, THREADS_USER_ID, token, {
      media_type: "IMAGE",
      image_url: media.urls[0],
      text,
    }, what);
    await awaitContainer(ctx.http, ctx.signal, GRAPH_TH, creationId, token, TH_FIELDS, what);
  } else {
    const children: string[] = [];
    for (const [index, url] of media.urls.entries()) {
      const child = await createContainer(ctx.http, GRAPH_TH, THREADS_USER_ID, token, {
        media_type: "IMAGE",
        image_url: url,
        is_carousel_item: true,
      }, `${what} image ${index + 1}`);
      await awaitContainer(
        ctx.http, ctx.signal, GRAPH_TH, child, token, TH_FIELDS,
        `${what} image ${index + 1}`,
      );
      children.push(child);
    }
    creationId = await createContainer(ctx.http, GRAPH_TH, THREADS_USER_ID, token, {
      media_type: "CAROUSEL",
      children: children.join(","),
      text,
    }, what);
    await awaitContainer(ctx.http, ctx.signal, GRAPH_TH, creationId, token, TH_FIELDS, what);
  }

  await sleep(PUBLISH_WAIT_MS, ctx.signal);
  return publishContainer(ctx.http, GRAPH_TH, THREADS_USER_ID, token, creationId, what);
}

/* ------------------------------------------------------------- the outcome */

interface PlatformResult {
  platform: Platform;
  ok: boolean;
  skipped: boolean;
  postId: string | null;
  error: string | null;
  /** True when the post may be live despite the failure. */
  ambiguous: boolean;
}

interface Outcome {
  pageId: string;
  pageName: string;
  pageUrl: string;
  allOk: boolean;
  posted: Platform[];
  failed: Platform[];
  /** What goes into the Telegram message. Empty when everything worked. */
  detail: string;
  ambiguous: boolean;
}

/* ------------------------------------------------------------------ telegram */

/** Telegram's HTML mode. Only these three, and the text here is arbitrary. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function alertFor(outcome: Outcome): string {
  const lines = [
    "\u{26A0}\u{FE0F} <b>Cross-post failed</b>",
    "",
    escapeHtml(outcome.pageName),
    "",
    `Posted OK: ${outcome.posted.join(", ") || "none"}`,
    `Failed: ${outcome.failed.join(", ")}`,
    "",
    escapeHtml(outcome.detail),
  ];

  if (outcome.ambiguous) {
    lines.push(
      "",
      "\u{1F6A8} One of those may have published anyway — CHECK THE ACCOUNT before " +
        "the next tick retries it.",
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
  name: "the-mantra-cross-poster",
  description: "Cross-posts TikTok'd Notion content to Instagram, Facebook and Threads",

  /**
   * n8n's "Every 5 Minutes" checker, minus the second workflow. A tick that
   * finds nothing due creates no run, so the dashboard shows the times this
   * actually posted something.
   *
   * `firstRun: "emit"` overrides the default. Baselining would mark every row
   * currently inside the window as seen without posting it, and those rows
   * would then age out of the window entirely — which is the one failure this
   * workflow cannot recover from on its own.
   */
  trigger: poll<DuePage>("*/5 * * * *", {
    tz: TZ,
    id: (page) => page.id,
    firstRun: "emit",
    async fetch(ctx) {
      /*
       * Every credential this workflow needs, checked before the query.
       *
       * Notion is here because without it the fetch would 401 every five
       * minutes and file a failed poll each time. The other three are here for
       * a different reason, and it is the one that makes a deploy safe: the
       * runner refuses a run whose credentials are unconnected, but only
       * *after* the poll has emitted rows — so a deploy that lands before
       * anyone has opened the Credentials tab would find due rows, start a run,
       * and go red every five minutes until someone finished the setup.
       *
       * Returning nothing instead means the workflow sits quietly and starts
       * working the moment the last credential is connected, with no restart
       * and nothing lost: no row is marked seen, because no run happened.
       */
      const missing = [
        !notion.token && "Notion",
        !meta.access_token && "Meta",
        !bucket.endpoint && "S3/R2",
        !telegram.token && "Telegram",
      ].filter((name): name is string => typeof name === "string");

      if (missing.length > 0) {
        ctx.log.warn(
          `Not looking for due rows — ${missing.join(", ")} ` +
            `${missing.length === 1 ? "is" : "are"} not connected (Credentials tab)`,
        );
        return [];
      }

      const res = await ctx.http.post<NotionQuery>(
        `https://api.notion.com/v1/databases/${CONTENTS_DB}/query`,
        {
          filter: {
            and: [
              // Only rows that finished their TikTok life. "Posting" is this
              // workflow's own lock and is deliberately excluded, which is what
              // stops two ticks working the same row.
              { property: PROPS.status, status: { equals: "Posted" } },
              { property: PROPS.postedTikTok, checkbox: { equals: true } },
              { property: PROPS.postedOthers, checkbox: { equals: false } },
              { property: PROPS.postDateTikTok, date: { on_or_before: daysAgo(MIN_AGE_DAYS) } },
              { property: PROPS.postDateTikTok, date: { on_or_after: daysAgo(MAX_AGE_DAYS) } },
            ],
          },
          // Oldest first, so a backlog drains in the order it was meant to go
          // out rather than in whatever order Notion feels like.
          sorts: [{ property: PROPS.postDateTikTok, direction: "ascending" }],
          page_size: MAX_PER_POLL,
        },
        { headers: notionHeaders() },
      );

      return res.results.map(toDuePage);
    },
  }),

  /**
   * **No retries, on purpose.** Everything worth retrying is retried closer to
   * the failure: the http client retries a 429 or a 5xx, and a row this run
   * could not finish is released back to `Posted` and comes back in five
   * minutes with only its unticked platforms left to do. What is left is a run
   * that published to one platform of three — and re-running that from the top
   * is the one outcome nobody wants.
   */
  retries: 0,

  /**
   * Three rows, each moving up to ten files through Drive and R2 and then
   * waiting on Meta to process them — a reel can legitimately take minutes.
   * Twenty is generous for the ordinary case and still bounded, and the signal
   * it aborts with unwinds the sleeps rather than being ignored.
   */
  timeoutMs: 1_200_000,

  /**
   * A checkpoint outliving the run is dangerous rather than merely stale: the
   * staged media is deleted from R2 at the end of every row, so a resume
   * tomorrow would replay publish steps against URLs that 404. Within the hour
   * it does the one thing worth doing — a resumed run does not re-post a
   * platform that already went out.
   */
  checkpointTtlHours: 1,

  async run(ctx) {
    // Read outside a step, deliberately: a step result is checkpointed to
    // disk, and these are live credentials. Nothing in this file puts one in a
    // step result, a log line, or a returned value. They reach the run page
    // only as the `access_token` query parameter of captured Graph calls,
    // where the redactor scrubs them.
    const threadsToken = await threads.accessToken();
    const metaToken = meta.access_token;
    const pageId = meta.page_id;

    // The provider marks this optional because a Meta credential is perfectly
    // usable for a Page alone — but *this* workflow posts to Instagram, so a
    // blank one is a misconfiguration. Refused here, before the row is locked
    // and long before anything is published, rather than discovered as a
    // "/media not found" two platforms in.
    const igUserId = meta.ig_user_id;
    if (!igUserId) {
      throw new Error(
        'The Meta credential "the-mantra" has no Instagram user ID. Add it on the ' +
          "Credentials tab — this workflow cannot cross-post without one.",
      );
    }

    /*
     * `ctx.s3` reads S3_* from the environment, and a credential only fills
     * those names when it is marked **primary** — see `syncPrimaryEnv`. So an
     * R2 credential that is connected but not primary passes every check the
     * runner makes and then fails, three Drive downloads later, with
     * "S3_ENDPOINT is not set" — which names an environment variable nobody
     * set, about a credential that looks fine on the dashboard.
     *
     * Checked here, before the row is locked, and phrased as the one action
     * that fixes it.
     */
    if (bucket.endpoint && !process.env.S3_ENDPOINT) {
      throw new Error(
        'The S3 credential "the-mantra" is connected but not marked primary, so ' +
          "ctx.s3 cannot see it. Tick \"use this for the built-in client\" on the " +
          "Credentials tab — without it there is nowhere to stage media.",
      );
    }

    /*
     * The trigger owns the query, so the rows arrive as input. Two ways to get
     * here with none, and doing nothing is the right answer to both:
     *
     *   "Run now" on the dashboard — there is no query to run, because the
     *   poll is what decides what is due. Making a row due in Notion is how you
     *   force a post; this button cannot be it.
     *
     *   A resume — resume carries the checkpoint key and nothing else, so
     *   ctx.input is {} the second time through.
     *
     * Re-deriving the due rows here would serve the first case and break the
     * second, badly: a resumed run would post whatever is due *now* against a
     * checkpoint key belonging to different rows, skipping steps by name and
     * mixing two sets of pages. And the two cannot be told apart — the resume
     * route calls the runner with trigger: "manual", exactly as the button
     * does. So neither posts.
     */
    const pages = Array.isArray(ctx.input) ? ctx.input : [];
    if (pages.length === 0) {
      ctx.log.info(
        "Nothing to do: this run was given no rows. Only the 5-minute poll finds due " +
          "rows — \"Run now\" and Resume both arrive with none, by design. To force a " +
          "post, make a row due in Notion (Status Posted, Posted (Tiktok) ticked, " +
          "Posted (others) unticked, TikTok date 3-10 days old) and the next tick takes it.",
      );
      return { pages: 0, posted: 0, failed: 0 };
    }

    const outcomes: Outcome[] = [];

    for (const page of pages) {
      /*
       * Claim the row *before* anything is published.
       *
       * The poll's filter is `Status = Posted`, so flipping the row to
       * `Posting` is what takes it out of the query. A run that dies after
       * publishing leaves the row on `Posting`, and a row on `Posting` is
       * never picked up again — that is the whole no-double-post guarantee,
       * and it is why this Notion write happens before any work.
       */
      await ctx.step(
        `lock ${page.id}`,
        () => setStatus(ctx, page.id, "Posting"),
        { input: { page: page.title } },
      );

      const outcome = await ctx.step<Outcome>(
        `cross-post ${page.id}`,
        () => crossPost(ctx, page, { threadsToken, metaToken, igUserId, pageId }),
        { input: { page: page.title, type: page.contentType, url: page.url } },
      );

      outcomes.push(outcome);

      await ctx.step(
        `record ${page.id}`,
        async () => {
          await ctx.http.patch(
            `https://api.notion.com/v1/pages/${page.id}`,
            {
              properties: {
                // Released back to Posted either way. Only the checkbox says
                // whether this is finished — and while it stays false the poll
                // picks the row up again, with the ticked platforms skipped.
                [PROPS.status]: { status: { name: "Posted" } },
                ...(outcome.allOk
                  ? { [PROPS.postedOthers]: { checkbox: true } }
                  : {}),
              },
            },
            { headers: notionHeaders() },
          );
          return { allOk: outcome.allOk, posted: outcome.posted };
        },
        { input: { page: page.title, allOk: outcome.allOk } },
      );

      if (!outcome.allOk) {
        await ctx.step(`alert ${page.id}`, async () => {
          // Swallowed on purpose, and the only swallowed error in this file.
          // The outcome is already in Notion and on the run page; a Telegram
          // outage should cost this message, not the rows still to post.
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

    const failed = outcomes.filter((o) => !o.allOk);
    const summary = {
      pages: outcomes.length,
      posted: outcomes.length - failed.length,
      failed: failed.length,
      needsChecking: failed.filter((o) => o.ambiguous).map((o) => o.pageName),
    };

    if (failed.length > 0) {
      // The run goes red, and — because a poll marks its items seen only after
      // a *successful* run — the failed rows are offered again next tick. n8n's
      // execution went green and left the whole story in a Telegram message.
      const error: AlertedError = new Error(
        `${failed.length} of ${outcomes.length} row(s) failed: ` +
          failed.map((o) => `${o.pageName} — ${o.detail}`).join(" | "),
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
   * the block fetch, the Notion write, or a token. A row that merely failed to
   * post has already been alerted, row by row, with far more detail.
   *
   * The stuck-row hunt n8n did here is deliberately not repeated: n8n queried
   * Notion for everything on `Posting` because its error trigger had no idea
   * which row died. This one does, and says so.
   */
  async onFailure(ctx, error) {
    if ((error as AlertedError).alerted) {
      ctx.log.info("Per-row alerts already went out — not sending a batch message");
      return;
    }

    const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
    const lines = [
      "\u{1F525} <b>Cross-poster CRASHED</b>",
      "",
      // Composed here and sent *out*, so it misses every redaction the runner
      // does on the way to disk — and the Meta tokens travel in the URL.
      escapeHtml(redact(error.message)),
      "",
      "\u{26A0}\u{FE0F} A row may be stuck on <b>Posting</b> in Notion. Check it — set it " +
        "back to <b>Posted</b> and leave <b>Posted (others)</b> unticked, and the next " +
        "tick will retry only the platforms that are still unticked in its Postings " +
        "list. A row left on Posting is never picked up again.",
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

interface Tokens {
  threadsToken: string;
  metaToken: string;
  igUserId: string;
  pageId: string;
}

/**
 * One row, start to finish: read it, stage its media, publish whatever is
 * still pending, tick what landed, and take the media back down.
 *
 * **What throws and what comes back as a failure is the whole contract here.**
 * Anything wrong with the *row* — an empty caption, a folder link under
 * File(s), a Drive file nobody shared, a platform that refused the post — comes
 * back as an Outcome, because the caller then releases the row to `Posted`,
 * alerts, and the next tick retries only what is still unticked. Only a failure
 * to *read Notion at all* throws, and that one deliberately leaves the row on
 * `Posting` — a state onFailure explains and a human clears.
 *
 * Getting that boundary wrong is not cosmetic: a thrown content error would
 * strand the row on `Posting`, where nothing ever picks it up again, for the
 * most ordinary mistake an author can make.
 */
async function crossPost(
  ctx: Ctx<DuePage[]>,
  page: DuePage,
  tokens: Tokens,
): Promise<Outcome> {
  const base = {
    pageId: page.id,
    pageName: page.title,
    pageUrl: page.url,
  };
  const done = (extra: Partial<Outcome>): Outcome => ({
    ...base,
    allOk: true,
    posted: [],
    failed: [],
    detail: "",
    ambiguous: false,
    ...extra,
  });

  /*
   * Read outside the catch below, deliberately. Everything after this point is
   * a problem with the *row* — an empty caption, a folder link, a file nobody
   * shared — and those must come back as a failed outcome so the caller
   * releases the row to `Posted` and it can be fixed and retried. A Notion
   * read that fails is a problem with Notion, and that one is allowed to throw:
   * it leaves the row on `Posting`, which is exactly what onFailure warns about.
   */
  const blocks = await ctx.http
    .paginate<NotionBlock>(`https://api.notion.com/v1/blocks/${page.id}/children`, {
      headers: notionHeaders(),
      query: { page_size: 100 },
      items: "results",
      next: { cursor: "next_cursor", param: "start_cursor" },
      maxPages: MAX_BLOCK_PAGES,
    })
    .all();

  const results: PlatformResult[] = [];

  /*
   * Keys are collected as they are created rather than after staging returns,
   * because the cleanup below has to cover a *failed* stage too: a row whose
   * fourth Drive file 404s has already put three objects in a public bucket,
   * and an early return would strand them there for good.
   */
  const staged: string[] = [];

  try {
    let parsed = parsePage(blocks);

    // Pages created before the template grew a Postings section, or edited to
    // remove it. Adding it is cheaper than refusing the row.
    if (parsed.needsPostings) {
      parsed = await appendPostings(ctx, page, parsed);
    }

    const pending = PLATFORMS.filter((p) => !parsed.todos[p]?.checked);
    if (pending.length === 0) {
      // Everything is already ticked — the row just never had its checkbox set.
      return done({});
    }

    // Checked only once there is something left to post. A row whose three
    // platforms are already ticked is finished, and failing it over an empty
    // Caption it no longer needs would be a false alarm nobody can clear.
    validate(page, parsed);

    const media = await stage(ctx, page, parsed.driveIds, staged);

    for (const platform of PLATFORMS) {
      if (!pending.includes(platform)) {
        results.push({
          platform, ok: true, skipped: true, postId: null, error: null, ambiguous: false,
        });
        continue;
      }

      try {
        const postId = await publishTo(ctx, platform, tokens, media, parsed.caption);
        // Ticked immediately, before the next platform is attempted: if that
        // one dies, this one must not be repeated on the retry.
        await tickTodo(ctx, parsed.todos[platform]!.id);
        results.push({
          platform, ok: true, skipped: false, postId, error: null, ambiguous: false,
        });
      } catch (err) {
        results.push({
          platform,
          ok: false,
          skipped: false,
          postId: null,
          error: err instanceof Error ? err.message : String(err),
          ambiguous: err instanceof AmbiguousFailure,
        });
      }
    }
  } catch (err) {
    // A problem with the row itself. Reported as a failure of everything that
    // was still pending, so the alert names the row and the caller releases it
    // rather than leaving it stuck on `Posting` for a human to unpick.
    const posted = results.filter((r) => r.ok && !r.skipped).map((r) => r.platform);
    return {
      ...base,
      allOk: false,
      posted,
      failed: PLATFORMS.filter((p) => !posted.includes(p)),
      detail: err instanceof Error ? err.message : String(err),
      ambiguous: err instanceof AmbiguousFailure,
    };
  } finally {
    // Always, on every path — a failed download, a throw from tickTodo, an
    // abort. n8n's linear graph could simply not reach its delete node on
    // several of these. Failures are logged, never raised: a stranded object
    // costs pennies, and losing the outcome to a cleanup error costs the alert.
    for (const key of staged) {
      await ctx.s3.delete(key).catch((err) => {
        ctx.log.warn(`Could not delete ${key} from R2: ${redact(String(err))}`);
      });
    }
  }

  const failedResults = results.filter((r) => !r.ok);
  return {
    ...base,
    allOk: failedResults.length === 0,
    posted: results.filter((r) => r.ok && !r.skipped).map((r) => r.platform),
    failed: failedResults.map((r) => r.platform),
    detail: failedResults.map((r) => `${r.platform}: ${r.error}`).join("\n"),
    ambiguous: failedResults.some((r) => r.ambiguous),
  };
}

function publishTo(
  ctx: Ctx<DuePage[]>,
  platform: Platform,
  tokens: Tokens,
  media: MediaSet,
  caption: string,
): Promise<string> {
  if (platform === "instagram") {
    return publishInstagram(ctx, tokens.metaToken, tokens.igUserId, media, caption);
  }
  if (platform === "facebook") {
    return publishFacebook(ctx, tokens.metaToken, tokens.pageId, media, caption);
  }
  return publishThreads(ctx, tokens.threadsToken, media, caption);
}

/** Ticks one Postings checkbox in Notion. */
async function tickTodo(ctx: Ctx<DuePage[]>, blockId: string): Promise<void> {
  await ctx.http.patch(
    `https://api.notion.com/v1/blocks/${blockId}`,
    { to_do: { checked: true } },
    { headers: notionHeaders() },
  );
}

/**
 * Appends a Postings checklist to a page that has none, and re-reads it so the
 * block ids are the real ones Notion just minted rather than a guess.
 *
 * All five labels are written, TikTok and X included, so the page matches the
 * template a human will read — even though this workflow only ever ticks three.
 */
async function appendPostings(
  ctx: Ctx<DuePage[]>,
  page: DuePage,
  parsed: ParsedPage,
): Promise<ParsedPage> {
  const labels = ["Tiktok", "Instagram", "Facebook", "Threads", "X"];

  const created = await ctx.http.patch<{ results?: NotionBlock[] }>(
    `https://api.notion.com/v1/blocks/${page.id}/children`,
    {
      children: [
        { object: "block", type: "divider", divider: {} },
        {
          object: "block",
          type: "heading_1",
          heading_1: { rich_text: [{ type: "text", text: { content: "Postings" } }] },
        },
        ...labels.map((label) => ({
          object: "block",
          type: "to_do",
          to_do: { rich_text: [{ type: "text", text: { content: label } }], checked: false },
        })),
      ],
    },
    { headers: notionHeaders() },
  );

  const todos: Partial<Record<Platform, Todo>> = {};
  for (const block of created?.results ?? []) {
    if (block.type !== "to_do" || !block.id) continue;
    const label = plainText(block, "to_do").trim().toLowerCase();
    const platform = PLATFORMS.find((p) => p === label);
    if (platform) todos[platform] = { id: block.id, checked: false };
  }

  const missing = PLATFORMS.filter((p) => !todos[p]);
  if (missing.length > 0) {
    throw new Error(`Could not create the Postings checklist (missing ${missing.join(", ")})`);
  }

  return { ...parsed, todos, needsPostings: false };
}

/** The one Notion write that happens before anything is published. */
async function setStatus(
  ctx: Ctx<DuePage[]>,
  pageId: string,
  status: "Posting",
): Promise<{ status: string }> {
  await ctx.http.patch(
    `https://api.notion.com/v1/pages/${pageId}`,
    { properties: { [PROPS.status]: { status: { name: status } } } },
    { headers: notionHeaders() },
  );
  return { status };
}
