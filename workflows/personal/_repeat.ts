/**
 * The calendar arithmetic behind todo-repeat, kept apart from the Notion calls
 * so it can be checked on its own. Pure: no clock, no network.
 */

export interface Rule {
  unit: "day" | "week" | "month" | "year";
  every: number;
}

const WORDS: Record<string, Rule> = {
  daily: { unit: "day", every: 1 },
  weekly: { unit: "week", every: 1 },
  fortnightly: { unit: "week", every: 2 },
  biweekly: { unit: "week", every: 2 },
  monthly: { unit: "month", every: 1 },
  quarterly: { unit: "month", every: 3 },
  yearly: { unit: "year", every: 1 },
  annually: { unit: "year", every: 1 },
};

/**
 * What a Repeat cell says, as a rule. `null` for anything it cannot read —
 * the caller logs that rather than guessing, because a guessed interval is a
 * task on the wrong day that nobody notices until it is late.
 *
 *   "Monthly"  "Every 2 weeks"  "every 3 months"  "Every other week"  "Quarterly"
 */
export function parseRepeat(text: string): Rule | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (WORDS[t]) return WORDS[t]!;
  const m = /^every (other |\d+ )?(day|week|month|year)s?$/.exec(t);
  if (!m) return null;
  const n = m[1] === "other " ? 2 : m[1] ? Number(m[1]) : 1;
  if (!Number.isInteger(n) || n < 1 || n > 366) return null;
  return { unit: m[2] as Rule["unit"], every: n };
}

/**
 * The occurrence after `scheduled`, which is the date the task was *meant*
 * for — not the Due Date it ended up with after being pushed back, and not the
 * day it was ticked off. That is what keeps a task set for the 24th on the
 * 24th however late any one month's copy is done.
 *
 * `day` is the series' day of the month, carried separately so a short month
 * does not drag it: 31 Jan → 28 Feb → 31 Mar, not → 28 Mar. Notion's date
 * strings are passed through: a time and offset after the date are kept as
 * they were.
 */
export function nextOccurrence(scheduled: string, rule: Rule, day?: number): string {
  const p = split(scheduled);
  let y = p.y;
  let m = p.m;
  let d = p.d;

  if (rule.unit === "day" || rule.unit === "week") {
    const step = rule.every * (rule.unit === "week" ? 7 : 1);
    const next = new Date(Date.UTC(y, m - 1, d + step));
    return join(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), p.rest);
  }

  const months = rule.every * (rule.unit === "year" ? 12 : 1);
  const index = y * 12 + (m - 1) + months;
  y = Math.floor(index / 12);
  m = (index % 12) + 1;
  d = Math.min(day ?? p.d, daysIn(y, m));
  return join(y, m, d, p.rest);
}

/** The day-of-month a series starting on `date` keeps. */
export function dayOf(date: string): number {
  return split(date).d;
}

/** Whole days from `a` to `b`, dates only — for moving a range's end with its start. */
export function daysBetween(a: string, b: string): number {
  const x = split(a);
  const y = split(b);
  return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86_400_000);
}

/** `date` moved by `days`, keeping any time part. */
export function shiftDays(date: string, days: number): string {
  const p = split(date);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return join(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), p.rest);
}

function split(date: string): { y: number; m: number; d: number; rest: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(date);
  if (!m) throw new Error(`not a Notion date: ${JSON.stringify(date)}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), rest: m[4]! };
}

function join(y: number, m: number, d: number, rest: string): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}${rest}`;
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
