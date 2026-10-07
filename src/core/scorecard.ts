/**
 * The assistant's scorecard — whether Maria is getting better, in numbers.
 *
 * "She feels dumb" cannot be fixed if nobody can tell whether a change
 * helped. Every number here is already in the personal-assistant tables;
 * this is the one place they are added up, so the dashboard view
 * (`views/personal-assistant/maria-scorecard.ts`), the twice-weekly card
 * (`personal-assistant-lessons-review`) and her own `scorecard` tool can
 * never disagree.
 *
 * ## Half-weeks
 *
 * The card goes out Wednesday and Sunday at 20:00, so the period is the
 * half-week that ended at the last of those — Sunday to Wednesday (three
 * days) or Wednesday to Sunday (four). It is compared with the *same* half a
 * week earlier rather than with the half just before: the two then have the
 * same length and the same weekdays, so every count can carry an arrow and a
 * quiet weekend does not read as a trend. `current` is the half still in
 * progress, against the same stretch of last week.
 *
 * ## The headlines
 *
 * One number per area, each with a target. The worst is the headline
 * furthest from its target — counted here, not chosen by a model — and it
 * is what she writes her one `scorecard` lesson about (`now` reminds her
 * once a card is out). A headline with nothing to measure is `null` and is
 * never the worst: "no drafts this half" is not a 0% send rate.
 *
 * `unlearned` is a snapshot, not a period: outcomes still waiting for
 * `learn` right now. Lessons retired in a period are read from `updated_at`,
 * the last change to a retired row, which is close enough for a count.
 */

import { table, type Row } from "./tables.ts";

const TZ = process.env.ASSISTANT_TZ ?? "Asia/Kuala_Lumpur";
const DAY_MS = 24 * 3_600_000;
const WEEK_MS = 7 * DAY_MS;

/** Wednesday and Sunday at 20:00, local — the card's cron, and where each period ends. */
export const SCORECARD_CRON = "0 20 * * 0,3";
const SLOT_DAYS = new Set(["Sun", "Wed"]);
const SLOT_HOUR = 20;

export type ScorecardWhich = "last" | "current";

export interface ScorecardSpan {
  from: number;
  to: number;
  label: string;
}

export interface Headline {
  key: "sent_as_written" | "questions_per_day" | "tasks_kept" | "reply_minutes" | "unlearned" | "sorting_kept";
  label: string;
  /** null: nothing to measure in this period. */
  value: number | null;
  before: number | null;
  better: "up" | "down";
  target: number;
  unit: "%" | "/day" | "min" | "";
  /** "64%", "2.3/day", "—". */
  display: string;
  beforeDisplay: string;
  /** ↑ ↓ → or "" when either side is missing. */
  arrow: string;
  /** Whether the change is an improvement — null when there is no change to judge. */
  improved: boolean | null;
  onTarget: boolean | null;
  /** How far off target, as a share of it — what ranks the worst. 0 when on target. */
  miss: number;
}

export interface CountLine {
  label: string;
  now: number;
  before: number | null;
}

export interface Area {
  title: string;
  counts: CountLine[];
}

export interface Scorecard {
  which: ScorecardWhich;
  period: ScorecardSpan;
  compare: ScorecardSpan;
  days: number;
  headlines: Headline[];
  areas: Area[];
  /** The headline furthest from its target, or null when every one is on target. */
  worst: Headline | null;
  /** Her `scorecard` lesson written since this period ended, if any. */
  lesson: Row | null;
}

/* ------------------------------------------------------------------ time */

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

function local(ms: number) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    min: Number(p.minute),
    s: Number(p.second),
    weekday: String(p.weekday),
  };
}

/** The instant that is `hour`:00 local on the local day containing `ms`. */
function localHour(ms: number, hour: number): number {
  const l = local(ms);
  const offset = Date.UTC(l.y, l.m - 1, l.d, l.h, l.min, l.s) - Math.floor(ms / 1000) * 1000;
  return Date.UTC(l.y, l.m - 1, l.d, hour) - offset;
}

/** The last `n` card times at or before `now`, newest first. */
export function scorecardSlots(now = Date.now(), n = 2): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < n && i < 7 * n + 7; i++) {
    const day = now - i * DAY_MS;
    if (!SLOT_DAYS.has(local(day).weekday)) continue;
    const at = localHour(day, SLOT_HOUR);
    if (at <= now && !out.includes(at)) out.push(at);
  }
  return out;
}

const spanFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const dayLabel = (ms: number) => spanFmt.format(new Date(ms)).replace(",", "");

function span(from: number, to: number, open = false): ScorecardSpan {
  return { from, to, label: `${dayLabel(from)} → ${open ? "now" : dayLabel(to)}` };
}

/** The period a scorecard covers, and the same stretch one week earlier. */
export function scorecardPeriod(which: ScorecardWhich = "last", now = Date.now()) {
  const [last, previous] = scorecardSlots(now, 2) as [number, number];
  const period = which === "current" ? span(last, now, true) : span(previous, last);
  const compare = span(period.from - WEEK_MS, period.to - WEEK_MS);
  return { period, compare };
}

/* --------------------------------------------------------------- reading */

const within = (r: Row, s: ScorecardSpan, at: unknown = r.created_at) => {
  const t = Number(at);
  return t >= s.from && t < s.to;
};

/** Rows created since `from`, newest first — the tables are small, but a query is capped at 1000. */
const since = (name: string, from: number) =>
  table(name).query({ where: [{ column: "created_at", op: ">=", value: from }], limit: 1000 });

const kindOf = (q: Row) => String(q.kind ?? "question");

interface Measured {
  drafts: { made: number; asWritten: number; afterComment: number; skipped: number; withdrawn: number; open: number };
  questions: { asked: number; answered: number; expired: number; ignore: number };
  tasks: { created: number; changed: number; trashed: number; done: number };
  replies: { notes: number; answered: number; minutes: number[] };
  lessons: { added: number; retired: number; fromScorecard: number };
  sorting: { sorted: number; changed: number };
  runs: number;
}

function measure(s: ScorecardSpan, data: Record<string, Row[]>): Measured {
  // A reply is its first version and every revision after it: how the chain
  // ended is the draft's outcome, and "as written" means the first version
  // was the one sent.
  const nextOf = new Map<string, Row>();
  for (const d of data.drafts!) if (d.revision_of) nextOf.set(String(d.revision_of), d);
  const drafts = { made: 0, asWritten: 0, afterComment: 0, skipped: 0, withdrawn: 0, open: 0 };
  for (const first of data.drafts!.filter((d) => !d.revision_of && within(d, s))) {
    drafts.made++;
    let last = first;
    let hops = 0;
    while (nextOf.has(String(last.id)) && hops < 20) {
      last = nextOf.get(String(last.id))!;
      hops++;
    }
    const status = String(last.status);
    if (status === "sent") hops === 0 ? drafts.asWritten++ : drafts.afterComment++;
    else if (status === "skipped") drafts.skipped++;
    else if (status === "withdrawn") drafts.withdrawn++;
    else drafts.open++;
  }

  const asked = data.questions!.filter((q) => kindOf(q) === "question" && within(q, s));
  const questions = {
    asked: asked.length,
    answered: asked.filter((q) => q.answer != null && q.answer !== "").length,
    expired: asked.filter((q) => q.expired_at != null).length,
    ignore: asked.filter((q) => String(q.answer ?? "").trim().toLowerCase() === "ignore").length,
  };

  const made = data.task_work!.filter((w) => w.kind === "created" && within(w, s));
  const tasks = {
    created: made.length,
    changed: made.filter((w) => w.outcome === "changed").length,
    trashed: made.filter((w) => w.outcome === "deleted").length,
    done: made.filter((w) => w.outcome === "done").length,
  };

  // His note, then the first update threaded under it.
  const firstReply = new Map<string, number>();
  for (const u of data.questions!) {
    if (kindOf(u) !== "update" || !u.reply_to) continue;
    const key = String(u.reply_to);
    const at = Number(u.created_at);
    if (!firstReply.has(key) || at < firstReply.get(key)!) firstReply.set(key, at);
  }
  const notes = data.questions!.filter((q) => kindOf(q) === "note" && within(q, s));
  const minutes = notes
    .filter((n) => firstReply.has(String(n.id)))
    .map((n) => (firstReply.get(String(n.id))! - Number(n.created_at)) / 60_000);
  const replies = { notes: notes.length, answered: minutes.length, minutes };

  const lessons = {
    added: data.lessons!.filter((l) => within(l, s)).length,
    retired: data.lessonsAll!.filter((l) => l.retired && within(l, s, l.updated_at)).length,
    fromScorecard: data.lessons!.filter((l) => l.source === "scorecard" && within(l, s)).length,
  };

  const sorted = data.sorting!.filter((r) => within(r, s));
  const sorting = {
    sorted: sorted.length,
    changed: sorted.filter((r) => r.answer && r.answer !== r.choice).length,
  };

  return { drafts, questions, tasks, replies, lessons, sorting, runs: data.run_log!.filter((r) => within(r, s)).length };
}

/** Outcomes still waiting for `learn` — the same three lists `outcomes` shows. */
function unlearnedNow(): number {
  const ended = new Set(["sent", "skipped", "replaced", "withdrawn"]);
  return (
    table("drafts").query({ limit: 1000 }).filter((d) => ended.has(String(d.status)) && !d.learned).length +
    table("task_work").query({ limit: 1000 }).filter((w) => w.outcome && !w.learned).length +
    table("sorting").query({ limit: 1000 }).filter((r) => r.answer && r.answer !== r.choice && !r.learned).length
  );
}

/* -------------------------------------------------------------- headlines */

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function show(value: number | null, unit: Headline["unit"]): string {
  if (value === null) return "—";
  if (unit === "%") return `${value}%`;
  if (unit === "/day") return `${value.toFixed(1)}/day`;
  if (unit === "min") return value < 10 ? `${value.toFixed(1)} min` : `${Math.round(value)} min`;
  return String(value);
}

function headline(
  key: Headline["key"],
  label: string,
  value: number | null,
  before: number | null,
  better: Headline["better"],
  target: number,
  unit: Headline["unit"],
): Headline {
  const changed = value !== null && before !== null && value !== before;
  const improved = changed ? (better === "up" ? value! > before! : value! < before!) : null;
  const onTarget = value === null ? null : better === "up" ? value >= target : value <= target;
  // Relative to the target, so a percentage and a rate compare; a count
  // whose target is 0 counts five as one whole target missed.
  const miss = value === null || onTarget ? 0 : Math.abs(value - target) / (target || 5);
  return {
    key,
    label,
    value,
    before,
    better,
    target,
    unit,
    display: show(value, unit),
    beforeDisplay: show(before, unit),
    arrow: value === null || before === null ? "" : value > before ? "↑" : value < before ? "↓" : "→",
    improved,
    onTarget,
    miss,
  };
}

/**
 * The scorecard for the last finished half-week (or the one in progress),
 * against the same stretch a week before.
 */
export function scorecard(which: ScorecardWhich = "last", now = Date.now()): Scorecard {
  const { period, compare } = scorecardPeriod(which, now);
  const from = compare.from;
  const questions = since("questions", from - 2 * DAY_MS);
  const data: Record<string, Row[]> = {
    // A chain's later versions can land after its period, so all drafts since then.
    drafts: since("drafts", from),
    questions,
    task_work: since("task_work", from),
    lessons: since("lessons", from),
    lessonsAll: table("lessons").query({ where: [{ column: "updated_at", op: ">=", value: from }], limit: 1000 }),
    sorting: since("sorting", from),
    run_log: since("run_log", from),
  };
  const a = measure(period, data);
  const b = measure(compare, data);
  const days = (period.to - period.from) / DAY_MS;
  const perDay = (n: number) => Math.round((n / days) * 10) / 10;
  const ended = (m: Measured) => m.drafts.asWritten + m.drafts.afterComment + m.drafts.skipped + m.drafts.withdrawn;
  const kept = (m: Measured) => m.tasks.created - m.tasks.changed - m.tasks.trashed;
  const replyMin = (m: Measured) => {
    const v = median(m.replies.minutes);
    return v === null ? null : Math.round(v * 10) / 10;
  };

  const headlines = [
    headline("sent_as_written", "Drafts sent as written", pct(a.drafts.asWritten, ended(a)), pct(b.drafts.asWritten, ended(b)), "up", 70, "%"),
    headline("questions_per_day", "Questions per day", perDay(a.questions.asked), perDay(b.questions.asked), "down", 2, "/day"),
    headline("tasks_kept", "Tasks kept as made", pct(kept(a), a.tasks.created), pct(kept(b), b.tasks.created), "up", 80, "%"),
    headline("reply_minutes", "Reply to his note", replyMin(a), replyMin(b), "down", 5, "min"),
    // A snapshot: what is waiting for `learn` as this is read, whatever the period.
    headline("unlearned", "Outcomes not learned yet", unlearnedNow(), null, "down", 0, ""),
    headline("sorting_kept", "Her sorting kept", pct(a.sorting.sorted - a.sorting.changed, a.sorting.sorted), pct(b.sorting.sorted - b.sorting.changed, b.sorting.sorted), "up", 85, "%"),
  ];
  const worst = headlines
    .filter((h) => h.value !== null && h.onTarget === false)
    .sort((x, y) => y.miss - x.miss)[0] ?? null;

  const areas: Area[] = [
    {
      title: "Drafts",
      counts: [
        { label: "Replies drafted", now: a.drafts.made, before: b.drafts.made },
        { label: "Sent as written", now: a.drafts.asWritten, before: b.drafts.asWritten },
        { label: "Sent after a comment", now: a.drafts.afterComment, before: b.drafts.afterComment },
        { label: "Skipped", now: a.drafts.skipped, before: b.drafts.skipped },
        { label: "Withdrawn", now: a.drafts.withdrawn, before: b.drafts.withdrawn },
        { label: "Still open", now: a.drafts.open, before: b.drafts.open },
      ],
    },
    {
      title: "Questions",
      counts: [
        { label: "Asked", now: a.questions.asked, before: b.questions.asked },
        { label: "Answered", now: a.questions.answered, before: b.questions.answered },
        { label: "Expired unanswered", now: a.questions.expired, before: b.questions.expired },
        { label: "Answered “ignore” (a wasted tap)", now: a.questions.ignore, before: b.questions.ignore },
      ],
    },
    {
      title: "Tasks she made",
      counts: [
        { label: "Created", now: a.tasks.created, before: b.tasks.created },
        { label: "Category or date changed by him", now: a.tasks.changed, before: b.tasks.changed },
        { label: "Trashed", now: a.tasks.trashed, before: b.tasks.trashed },
        { label: "Done", now: a.tasks.done, before: b.tasks.done },
      ],
    },
    {
      title: "Replies to him",
      counts: [
        { label: "Notes he sent", now: a.replies.notes, before: b.replies.notes },
        { label: "Answered", now: a.replies.answered, before: b.replies.answered },
      ],
    },
    {
      title: "Learning",
      counts: [
        { label: "Lessons added", now: a.lessons.added, before: b.lessons.added },
        { label: "Lessons retired", now: a.lessons.retired, before: b.lessons.retired },
        { label: "Her own, from a scorecard", now: a.lessons.fromScorecard, before: b.lessons.fromScorecard },
      ],
    },
    {
      title: "Sorting",
      counts: [
        { label: "Chats she sorted", now: a.sorting.sorted, before: b.sorting.sorted },
        { label: "Changed by him", now: a.sorting.changed, before: b.sorting.changed },
      ],
    },
    { title: "Runs", counts: [{ label: "Runs logged", now: a.runs, before: b.runs }] },
  ];

  const lesson =
    table("lessons")
      .query({ where: [{ column: "created_at", op: ">=", value: period.to }], limit: 200 })
      .find((l) => l.source === "scorecard" && !l.retired) ?? null;

  return { which, period, compare, days, headlines, areas, worst, lesson: which === "last" ? lesson : null };
}

/* -------------------------------------------------------------- printing */

const arrowed = (h: Headline) => (h.arrow ? ` ${h.arrow} from ${h.beforeDisplay}` : "");

/**
 * The headlines in the bot's phone marks (`# heading`, `- bullet`, *bold*,
 * _italic_) — for `rich()` in `_bot.ts`, which every Telegram message goes
 * through.
 */
export function scorecardMarks(card: Scorecard): string {
  const lines = card.headlines.map((h) => {
    const mark = h.onTarget === null ? "" : h.onTarget ? "✅ " : "⚠️ ";
    return `- ${mark}${h.label}: *${h.display}*${arrowed(h)}`;
  });
  const worst = card.worst
    ? `_Worst: ${card.worst.label.toLowerCase()} (${card.worst.display}, target ${show(card.worst.target, card.worst.unit)}). ` +
      "Maria writes one lesson to fix it._"
    : "_Every number with data is on target._";
  return [
    `# 📊 Maria's scorecard`,
    `_${card.period.label}, against the same days last week_`,
    lines.join("\n"),
    worst,
  ].join("\n\n");
}

/** The whole card as a compact text table — the `scorecard` tool's answer. */
export function scorecardText(card: Scorecard): string {
  const head = card.headlines.map(
    (h) =>
      `- ${h.key}: ${h.display}${h.before !== null ? ` (same days last week ${h.beforeDisplay}${h.improved === null ? "" : h.improved ? ", better" : ", worse"})` : ""}` +
      `, target ${h.better === "up" ? "≥" : "≤"} ${show(h.target, h.unit)}${h.onTarget === false ? " — MISSED" : ""}`,
  );
  const counts = card.areas.map(
    (a) => `${a.title}: ${a.counts.map((c) => `${c.label.toLowerCase()} ${c.now}${c.before !== null ? ` (was ${c.before})` : ""}`).join(", ")}`,
  );
  return [
    `Scorecard ${card.period.label} (${card.which === "current" ? "in progress" : "finished"}), against ${card.compare.label}.`,
    "",
    "Headlines:",
    ...head,
    "",
    ...counts,
    "",
    card.worst ? `Worst: ${card.worst.key} (${card.worst.display}).` : "Worst: none — every headline with data is on target.",
  ].join("\n");
}
