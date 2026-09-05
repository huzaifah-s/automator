import { cron, defineCredential, defineWorkflow } from "../../src/core/define.ts";

/**
 * The Mantra — Threads — Content Runway Alert.
 *
 * Watches the **Approved** buffer in the Threads database and pings Telegram
 * when there is not enough dated, approved content left to keep posting. A
 * port of the n8n graph "The Mantra - Threads - Content Runway Alert"
 * (schedule → Notion getAll → Code → IF → Telegram).
 *
 * Fires at 07:00 (a heartbeat, sent whatever the number is) and 15:00 (a
 * safety net, sent only when the buffer is below a comfortable two days) KL.
 * The zone is pinned on the trigger *and* every reading of the clock below
 * goes through Asia/Kuala_Lumpur, so the server's own zone never matters.
 *
 * Three differences from the n8n version, all deliberate:
 *
 * 1. **A manual run always sends.** n8n's sticky note claimed this, but its
 *    code read the flag off a "Time gate" node that did not exist in the
 *    graph — the lookup threw, was swallowed, and `manual` was permanently
 *    false. Here it is `ctx.triggeredBy`, which is not a guess.
 * 2. **A row dated today with no time counts as still due.** n8n compared it
 *    against midnight, so it was always in the past and never counted.
 * 3. **No `alwaysOutputData` hack.** n8n injected one empty item when nothing
 *    matched, and the Code node had to filter it back out to avoid reporting
 *    a buffer of 1 when it was 0. An empty array is just an empty array.
 */

/**
 * The Notion internal integration this alert reads with, connected on the
 * Credentials tab rather than declared as an environment variable.
 *
 * "mantra" is a slot, not a value. Revoking the integration in Notion and
 * pasting a new token into the same credential leaves this line alone — which
 * is the whole reason the reference is a name you chose and not an id the
 * database made up. Deleting the credential and creating another called
 * "mantra" also works.
 *
 * The cost, and it is the deliberate one: this alert no longer stops the boot
 * when the token is missing. It is marked blocked on the dashboard and refuses
 * to run instead — see AGENTS.md.
 */
const notion = defineCredential("notion", "mantra");

/* ---------------------------------------------------------- configuration */

/** Posts wanted per day, across the 08:00–23:00 KL posting window. */
const TARGET = 15;
/** Days of ready content to keep on hand. */
const BUFFER_DAYS = 2;
/** Comfortable. Below this the afternoon run starts pinging. */
const HEALTHY = TARGET * BUFFER_DAYS;
/** Under a day left. */
const LOW = TARGET;

const TZ = "Asia/Kuala_Lumpur";

/** The Threads database. Configuration of this one alert, not a credential. */
const THREADS_DB = "39903cbd-c49e-807d-b83d-ed68a2ced55c";
const THREADS_URL =
  "https://app.notion.com/p/division-ai/Founder-s-Contents-39903cbdc49e800c8e5be098117a92f3";

/** Pinned rather than floating: a schema change should not arrive unannounced. */
const NOTION_VERSION = "2022-06-28";
/** 100 rows a page. Past this the buffer is not the problem. */
const MAX_PAGES = 20;

/* ------------------------------------------------------------------ notion */

interface NotionPage {
  id: string;
  properties?: Record<string, { type?: string; date?: { start?: string } | null }>;
}

interface NotionQuery {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

/** What one Approved row reduces to. Everything else is weight on the run page. */
interface Row {
  id: string;
  /** The ISO string Notion holds — a date, or a date and a time. */
  postDate: string | null;
}

function postDateOf(page: NotionPage): string | null {
  const prop = page.properties?.["Post Date"];
  // Only a real date property. A formula or rollup named the same thing is a
  // different shape, and silently reading nothing out of it would show up as
  // "Approved but no Post Date" rather than as the misconfiguration it is.
  if (prop?.type !== "date") return null;
  return prop.date?.start ?? null;
}

/* ------------------------------------------------------------------- clock */

/** The KL wall clock at an instant: `2026-09-05` and the hour 0–23. */
function klParts(at: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/**
 * Is this row still waiting to fire today?
 *
 * A date-only value has no time to have passed, so a row dated today counts
 * as still due all day — which is the honest answer, since nothing in Notion
 * says when it would go out.
 */
function dueLaterToday(iso: string, now: Date, today: string): boolean {
  if (iso.length === 10) return iso === today;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return false;
  return klParts(at).date === today && at.getTime() >= now.getTime();
}

/* ---------------------------------------------------------------- workflow */

const LEVELS = {
  EMPTY: "\u{1F534}",
  LOW: "\u{1F7E0}",
  "GETTING LOW": "\u{1F7E1}",
  HEALTHY: "\u{1F7E2}",
} as const;

type Level = keyof typeof LEVELS;

interface Assessment {
  shouldSend: boolean;
  level: Level;
  buffer: number;
  runway: number;
  todayLeft: number;
  undated: number;
  text: string;
}

export default defineWorkflow({
  name: "the-mantra-threads-content-runway-alert",
  description: "Pings Telegram when the Approved thread buffer runs low",
  // One expression covers both of n8n's two schedule rules.
  trigger: cron("0 7,15 * * *", { tz: TZ }),
  retries: 2,
  timeoutMs: 120_000,
  // The whole value of this run is that its reading is current. An hour-old
  // checkpoint is worth reusing across a retry; a day-old one, resumed by
  // hand from the dashboard, would report yesterday's buffer as today's.
  checkpointTtlHours: 1,

  async run(ctx) {
    const rows = await ctx.step<Row[]>(
      "read approved buffer",
      async () => {
        const found: Row[] = [];
        let cursor: string | undefined;

        for (let page = 1; page <= MAX_PAGES; page++) {
          const res = await ctx.http.post<NotionQuery>(
            `https://api.notion.com/v1/databases/${THREADS_DB}/query`,
            {
              filter: { property: "Status", status: { equals: "Approved" } },
              page_size: 100,
              start_cursor: cursor,
            },
            {
              headers: {
                authorization: `Bearer ${notion.token}`,
                "Notion-Version": NOTION_VERSION,
              },
            },
          );

          // Reduced here rather than after the loop: whole Notion pages are a
          // few KB each, and the step result is what gets checkpointed.
          for (const p of res.results) found.push({ id: p.id, postDate: postDateOf(p) });

          if (!res.has_more || !res.next_cursor) return found;
          cursor = res.next_cursor;
        }

        // A short answer that looks complete would under-report the buffer and
        // send a nudge that is not warranted, so this throws instead.
        throw new Error(
          `Threads has more than ${MAX_PAGES * 100} Approved rows — raise MAX_PAGES`,
        );
      },
      { input: { database: THREADS_DB, status: "Approved" } },
    );

    const assessment = await ctx.step<Assessment>("assess runway", async () => {
      const now = new Date();
      const { date: today, hour } = klParts(now);

      const buffer = rows.length;
      const runway = Math.round((buffer / TARGET) * 10) / 10;

      const dated = rows.filter((r) => r.postDate !== null);
      const todayLeft = dated.filter((r) => dueLaterToday(r.postDate!, now, today)).length;
      const undated = buffer - dated.length;

      const level: Level =
        buffer === 0
          ? "EMPTY"
          : buffer < LOW
            ? "LOW"
            : buffer < HEALTHY
              ? "GETTING LOW"
              : "HEALTHY";

      // Morning is a heartbeat and always goes out. The afternoon run only
      // interrupts when the buffer is actually short — and a run somebody
      // started by hand always sends, which is how you test this.
      const shouldSend = ctx.triggeredBy !== "cron" || hour < 12 || buffer < HEALTHY;

      const lines = [
        `${LEVELS[level]} <b>Content runway — ${level}</b>`,
        "",
        `Ready to post (Approved): <b>${buffer}</b>`,
        `Runway: about ${runway} day(s) at ${TARGET}/day`,
      ];
      if (dated.length) lines.push(`Still due to post today: ${todayLeft}`);
      if (undated) {
        lines.push(`Approved but no Post Date: ${undated} (these will not post until dated)`);
      }
      lines.push("");
      if (buffer === 0) {
        lines.push(
          "Nothing is queued. <b>Nothing will post</b> until you approve and date new threads.",
          `Aim for ${HEALTHY} to hold a ${BUFFER_DAYS}-day buffer.`,
        );
      } else if (buffer < HEALTHY) {
        lines.push(
          `Write about <b>${HEALTHY - buffer}</b> more to rebuild a ${BUFFER_DAYS}-day buffer.`,
          "Got drafts sitting unapproved? Approve and date them so they count.",
        );
      } else {
        lines.push("You are covered. Nice.");
      }
      lines.push("", THREADS_URL);

      return { shouldSend, level, buffer, runway, todayLeft, undated, text: lines.join("\n") };
    });

    if (!assessment.shouldSend) {
      ctx.log.info("Buffer is comfortable and it is not the morning run — staying quiet", {
        buffer: assessment.buffer,
        level: assessment.level,
      });
      return { sent: false, ...assessment, text: undefined };
    }

    await ctx.step("nudge me", () =>
      ctx.telegram.send(assessment.text, {
        // Configuration, not a secret: declaring it would blank the chat id
        // out of every run page. Unset, TELEGRAM_CHAT_ID is used.
        chatId: process.env.MANTRA_TELEGRAM_CHAT_ID,
        parseMode: "HTML",
      }),
    );

    return { sent: true, ...assessment, text: undefined };
  },
});
