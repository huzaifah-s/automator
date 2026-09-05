import { cron, defineCredential, defineWorkflow, type Ctx } from "../../src/core/define.ts";

/**
 * The Mantra — Cross-post — Stale Content Alert.
 *
 * Tells you about content that **will never cross-post and would otherwise say
 * nothing about it**. Two kinds, which look different in Notion and have the
 * same ending:
 *
 * 1. **Aged out.** `cross-poster.ts` only picks up rows whose TikTok post date
 *    is between MIN_AGE_DAYS and MAX_AGE_DAYS old. A row that passes the
 *    ceiling — because the runner was down for a week, because it sat on
 *    `Posting`, because it was ticked back and forth — drops out of the query
 *    forever. Nothing retries it and nothing complains.
 * 2. **Stuck on Posting.** `Posting` is the cross-poster's lock, and it is what
 *    takes a row out of the query so two ticks cannot work it at once. A run
 *    that dies after locking leaves the row there, and a row on `Posting` is
 *    never picked up again. The cross-poster's `onFailure` says so and asks a
 *    human to go and look; this is that look, done daily.
 *
 * **This has no n8n ancestor.** n8n had the same 3–10 day window and the same
 * lock, and simply lost this content silently — the gap was inherited with the
 * rest of the port and left open deliberately, because widening the window on
 * day one would have back-posted a pile of old content. This closes it the
 * other way: the window stays exactly as it was, and the rows it drops are now
 * reported instead of forgotten.
 *
 * **Why a separate workflow rather than part of the cross-poster.** The
 * cross-poster polls every five minutes. Answering this question there would be
 * a second Notion query 288 times a day to report something that changes once a
 * day, and the natural place to put it — the poll's `fetch` — is the one place
 * that cannot alert, because it runs outside a run.
 *
 * **It does not nag.** A list of rows nobody has dealt with, re-sent every
 * morning, is how an alert stops being read — and an unread alert is the same
 * silence this exists to break. So: a message when something new turns up, then
 * quiet, then one reminder a week while anything is still outstanding.
 */

/* ------------------------------------------------------------ credentials */

/**
 * The same two slots every other The Mantra workflow uses. Read-only access is
 * enough here — this reports, it never fixes.
 */
const notion = defineCredential("notion", "the-mantra-contents");
const telegram = defineCredential("telegram", "the-mantra");

/* ---------------------------------------------------------- configuration */

const TZ = "Asia/Kuala_Lumpur";

/** The Contents database. Same one the cross-poster reads. */
const CONTENTS_DB = "39903cbd-c49e-805d-8a15-e991fc30b12e";

/** Pinned rather than floating: a schema change should not arrive unannounced. */
const NOTION_VERSION = "2022-06-28";

/**
 * Verified against the live database, like the cross-poster's copy. A Notion
 * *filter* matches the name exactly with no loose fallback, so a typo here is
 * a query that silently returns nothing — which for this workflow means an
 * all-clear that is a lie.
 */
const PROPS = {
  status: "Status",
  postDateTikTok: "Post date (TikTok)",
  postedTikTok: "Posted (Tiktok)",
  postedOthers: "Posted (others)",
  lastEdited: "Last edited time",
} as const;

/**
 * The cross-poster's ceiling, duplicated rather than imported.
 *
 * Importing it would run that file's `defineCredential` and `defineOAuth` calls
 * while the loader believes it is loading *this* file, which attributes its
 * credentials to this workflow and leaves the cross-poster recorded as needing
 * nothing — an unconnected credential would then stop blocking it. Same reason
 * the Threads poster copies its OAuth declaration; see AGENTS.md.
 *
 * If you change the window in `cross-poster.ts`, change it here too. The
 * alert going quiet is what a mismatch looks like, so it will not announce
 * itself.
 */
const MAX_AGE_DAYS = 10;

/**
 * How long a row may sit on `Posting` before it counts as stuck.
 *
 * The cross-poster's `timeoutMs` is twenty minutes, so an hour is comfortably
 * past anything a healthy run could still be doing. The clock is the row's own
 * last-edited time, which the lock write sets — so this measures "untouched
 * since it was claimed", not "claimed long ago".
 */
const STUCK_AFTER_HOURS = 1;

/** One reminder a week while anything is still outstanding. */
const RENAG_DAYS = 7;

/** Rows listed in the message before it turns into a count. Telegram caps at 4096. */
const MAX_LISTED = 12;

/** 100 rows a page. Past this, the alert is not the problem. */
const MAX_PAGES = 5;

/** Where the last report is remembered, so an unchanged one stays quiet. */
const STATE_KEY = "cross-post:stale-reported";

/* ------------------------------------------------------------------ notion */

interface NotionProperty {
  type?: string;
  title?: { plain_text?: string }[];
  date?: { start?: string } | null;
  last_edited_time?: string;
}

interface NotionPage {
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, NotionProperty>;
}

interface NotionQuery {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

/** One row worth telling somebody about. */
interface StaleRow {
  id: string;
  title: string;
  url: string;
  /** The ISO instant the row's clock is measured from. Null if it has none. */
  since: string | null;
}

function notionHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${notion.token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

/** The row's title, found by property type rather than by the name "Name". */
function titleOf(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type !== "title") continue;
    const text = (prop.title ?? []).map((t) => t.plain_text ?? "").join("").trim();
    if (text) return text;
  }
  return "Untitled";
}

function postDateOf(page: NotionPage): string | null {
  const prop = page.properties?.[PROPS.postDateTikTok];
  // Only a real date property. A formula or rollup named the same thing is a
  // different shape, and reading nothing out of it would quietly show "unknown"
  // rather than the misconfiguration it is.
  if (prop?.type !== "date") return null;
  return prop.date?.start ?? null;
}

function toStaleRow(page: NotionPage, since: string | null): StaleRow {
  return {
    id: page.id,
    title: titleOf(page),
    url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
    since,
  };
}

/** Days ago, as an ISO instant — what the date filters compare against. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** Every page of a Notion query, reduced as it goes. */
async function queryAll(
  ctx: Ctx,
  filter: unknown,
  label: string,
): Promise<NotionPage[]> {
  const found: NotionPage[] = [];
  let cursor: string | undefined;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ctx.http.post<NotionQuery>(
      `https://api.notion.com/v1/databases/${CONTENTS_DB}/query`,
      { filter, page_size: 100, start_cursor: cursor },
      { headers: notionHeaders() },
    );

    found.push(...res.results);
    if (!res.has_more || !res.next_cursor) return found;
    cursor = res.next_cursor;
  }

  // A short answer that looks complete would under-report and send an
  // all-clear that is wrong, so this throws instead.
  throw new Error(`More than ${MAX_PAGES * 100} ${label} rows — raise MAX_PAGES`);
}

/* -------------------------------------------------------------------- dates */

/** "12 Aug 2026", in KL, for a human reading a phone. */
function klDate(iso: string | null): string {
  if (!iso) return "no date";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "no date";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(at);
}

/** "5 Sep, 14:02" in KL — for a row stuck minutes ago, where the date alone says nothing. */
function klDateTime(iso: string | null): string {
  if (!iso) return "an unknown time";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "an unknown time";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** "1 row" / "2 rows" — the (s) form reads like a form letter. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return Math.floor((Date.now() - at.getTime()) / 86_400_000);
}

/* ------------------------------------------------------------------ telegram */

/** Telegram's HTML mode. Only these three, and the titles here are arbitrary. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function listOf(rows: StaleRow[], describe: (row: StaleRow) => string): string[] {
  const lines: string[] = [];
  for (const row of rows.slice(0, MAX_LISTED)) {
    lines.push(`• ${escapeHtml(row.title)} — ${describe(row)}`);
    lines.push(`  ${escapeHtml(row.url)}`);
  }
  if (rows.length > MAX_LISTED) {
    lines.push(`…and ${rows.length - MAX_LISTED} more.`);
  }
  return lines;
}

function buildMessage(agedOut: StaleRow[], stuck: StaleRow[], reminder: boolean): string {
  const lines = [
    reminder
      ? "\u{1F553} <b>Still not cross-posted</b> (weekly reminder)"
      : "\u{1F573}\u{FE0F} <b>Content that will never cross-post</b>",
    "",
  ];

  if (agedOut.length) {
    lines.push(
      `<b>${plural(agedOut.length, "row")} aged past the ${MAX_AGE_DAYS}-day window:</b>`,
      ...listOf(agedOut, (row) => {
        const days = daysSince(row.since);
        const age = days === null ? "" : ` (${plural(days, "day")} ago)`;
        return `TikTok ${klDate(row.since)}${age}`;
      }),
      "",
    );
  }

  if (stuck.length) {
    lines.push(
      `<b>${plural(stuck.length, "row")} stuck on "Posting":</b>`,
      ...listOf(stuck, (row) => `untouched since ${klDateTime(row.since)}`),
      "",
    );
  }

  lines.push("<b>What to do</b>");
  if (agedOut.length) {
    lines.push(
      "• <i>Aged out</i> — to still send it, change <b>Post date (TikTok)</b> to a date " +
        `inside the last ${MAX_AGE_DAYS} days. To let it go, tick <b>Posted (others)</b> ` +
        "and it stops being counted.",
    );
  }
  if (stuck.length) {
    lines.push(
      "• <i>Stuck</i> — set <b>Status</b> back to <b>Posted</b> and leave " +
        "<b>Posted (others)</b> unticked. The next tick retries only the platforms still " +
        "unticked in that page's Postings list, so nothing is posted twice.",
    );
  }

  return lines.join("\n");
}

/* ---------------------------------------------------------------- workflow */

/** What was reported last time, so an unchanged list stays quiet. */
interface Reported {
  ids: string[];
  /** ISO instant of the last message actually sent. */
  lastSentAt: string;
}

interface Assessment {
  agedOut: StaleRow[];
  stuck: StaleRow[];
  total: number;
  shouldSend: boolean;
  reminder: boolean;
  reason: string;
}

export default defineWorkflow({
  name: "the-mantra-cross-post-stale-alert",
  description: "Reports content that will never cross-post — aged out, or stuck on Posting",

  /**
   * Daily, at 09:00 KL — after the content runway nudge at 07:00, so the two
   * do not arrive together and get read as one.
   */
  trigger: cron("0 9 * * *", { tz: TZ }),
  retries: 2,
  timeoutMs: 120_000,

  /**
   * The whole value of this run is that its reading is current. An hour-old
   * checkpoint is worth reusing across a retry; a day-old one, resumed by hand
   * from the dashboard, would report yesterday's rows as today's.
   */
  checkpointTtlHours: 1,

  async run(ctx) {
    const found = await ctx.step<{ agedOut: StaleRow[]; stuck: StaleRow[] }>(
      "find content nothing will pick up",
      async () => {
        /*
         * Rows that went out on TikTok, were never cross-posted, and are now
         * older than the cross-poster's ceiling. The same three property
         * filters the cross-poster uses, with its floor (`on_or_after`)
         * replaced by the exact complement (`before`).
         *
         * That complement is the point, and it is why this is not simply "old
         * rows": the two queries partition the same set cleanly, so a row is
         * either still due or reported here, never both and never neither.
         * Any looser filter would start reporting rows that are merely waiting
         * out the three-day stagger, and an alert that cries wolf about
         * healthy content is worse than the silence it replaced.
         */
        const aged = await queryAll(
          ctx,
          {
            and: [
              { property: PROPS.status, status: { equals: "Posted" } },
              { property: PROPS.postedTikTok, checkbox: { equals: true } },
              { property: PROPS.postedOthers, checkbox: { equals: false } },
              { property: PROPS.postDateTikTok, date: { before: daysAgo(MAX_AGE_DAYS) } },
            ],
          },
          "aged-out",
        );

        // Rows holding the lock with nothing running. The clock is the row's
        // own last-edited time, which the cross-poster's lock write sets.
        const stuckPages = await queryAll(
          ctx,
          {
            and: [
              { property: PROPS.status, status: { equals: "Posting" } },
              {
                property: PROPS.lastEdited,
                last_edited_time: { before: hoursAgo(STUCK_AFTER_HOURS) },
              },
            ],
          },
          "stuck-on-Posting",
        );

        return {
          agedOut: aged.map((p) => toStaleRow(p, postDateOf(p))),
          // last_edited_time is on the page itself, not in properties.
          stuck: stuckPages.map((p) => toStaleRow(p, p.last_edited_time ?? null)),
        };
      },
      { input: { database: CONTENTS_DB, olderThanDays: MAX_AGE_DAYS } },
    );

    const assessment = await ctx.step<Assessment>("decide whether to speak", async () => {
      const ids = [...found.agedOut, ...found.stuck].map((r) => r.id).sort();
      const previous = await ctx.state.get<Reported>(STATE_KEY);

      // A run somebody started by hand always sends. That is how you test this
      // without waiting for something to break — the same property the content
      // runway alert has, and for the same reason.
      const verdict = decide(ids, previous, ctx.triggeredBy !== "cron", Date.now());

      return { ...found, total: ids.length, ...verdict };
    });

    if (!assessment.shouldSend) {
      ctx.log.info(`Staying quiet — ${assessment.reason}`, {
        agedOut: assessment.agedOut.length,
        stuck: assessment.stuck.length,
      });
      // The remembered list is still refreshed, so a row somebody *fixed* stops
      // counting as already-reported. Without this, a row that goes stale,
      // gets fixed, and goes stale again would never be mentioned a second time.
      await rememberQuietly(ctx, assessment);
      return { sent: false, ...counts(assessment) };
    }

    await ctx.step("nudge me", () =>
      ctx.telegram.send(
        buildMessage(assessment.agedOut, assessment.stuck, assessment.reminder),
        {
          token: telegram.token,
          // Configuration, not a secret: declaring the chat id with
          // defineSecrets would blank it out of every run page. Shared with the
          // runway alert and the cross-poster, because all three go to the same
          // person. Unset, it falls back to this credential's own chat id,
          // never to another brand's default.
          chatId: process.env.TELEGRAM_CHAT_ID_HUZAIFAH ?? telegram.chat_id,
          parseMode: "HTML",
        },
      ),
    );

    // Written only after the message is actually out. A Telegram failure here
    // fails the run and leaves the old memory in place, so the retry — or
    // tomorrow's run — still treats these rows as unreported.
    await ctx.step("remember what was reported", async () => {
      const ids = [...assessment.agedOut, ...assessment.stuck].map((r) => r.id).sort();
      await ctx.state.set<Reported>(STATE_KEY, {
        ids,
        lastSentAt: new Date().toISOString(),
      });
      return { remembered: ids.length };
    });

    return { sent: true, ...counts(assessment) };
  },
});

/* ------------------------------------------------------------------ helpers */

/**
 * Whether this run says anything, given what is stale now and what was last
 * reported. Pure, and separated from `run` because it is the only part of this
 * workflow with branches worth being sure about — the alternative is finding
 * out it never fires, which is indistinguishable from having nothing to say.
 *
 * The rules, in order: nothing stale is always silence; a hand-started run
 * always speaks; a row nobody has been told about speaks; and past RENAG_DAYS
 * since the last message, anything still outstanding speaks once more.
 */
export function decide(
  ids: string[],
  previous: Reported | undefined,
  manual: boolean,
  now: number,
): { shouldSend: boolean; reminder: boolean; reason: string } {
  if (ids.length === 0) return { shouldSend: false, reminder: false, reason: "nothing stale" };

  const seen = new Set(previous?.ids ?? []);
  const fresh = ids.filter((id) => !seen.has(id));

  // No previous message at all means everything here is news, which is what
  // Infinity gets us on the first ever run without a special case.
  const sinceLast = previous?.lastSentAt
    ? now - new Date(previous.lastSentAt).getTime()
    : Infinity;
  const dueForReminder = sinceLast >= RENAG_DAYS * 86_400_000;

  if (manual) return { shouldSend: true, reminder: false, reason: "manual run" };
  if (fresh.length > 0) {
    return { shouldSend: true, reminder: false, reason: `${fresh.length} new` };
  }
  if (dueForReminder) {
    // A reminder is a re-send of a list you have already been told about.
    return { shouldSend: true, reminder: true, reason: "weekly reminder" };
  }
  return { shouldSend: false, reminder: false, reason: "already reported" };
}

function counts(assessment: Assessment) {
  return {
    agedOut: assessment.agedOut.length,
    stuck: assessment.stuck.length,
    total: assessment.total,
    reason: assessment.reason,
  };
}

/**
 * Updates the remembered ids without touching `lastSentAt`.
 *
 * Keeping the timestamp is what makes the weekly reminder measure "how long
 * since I last told you", rather than resetting every quiet morning and
 * therefore never firing.
 */
async function rememberQuietly(ctx: Ctx, assessment: Assessment): Promise<void> {
  const ids = [...assessment.agedOut, ...assessment.stuck].map((r) => r.id).sort();
  const previous = await ctx.state.get<Reported>(STATE_KEY);
  await ctx.state.set<Reported>(STATE_KEY, {
    ids,
    lastSentAt: previous?.lastSentAt ?? new Date(0).toISOString(),
  });
}
