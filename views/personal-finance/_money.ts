/**
 * Shared helpers for the personal-finance views.
 *
 * Underscore-prefixed, so the loader treats it as code rather than as a view —
 * the same rule `workflows/` and `tables/` follow. Note the cost that comes
 * with it: a change to this file cannot be hot-reloaded (the cache-busting
 * query does not reach a relative import), so editing it switches view
 * reloading off until the next restart. Keep what lives here to things that
 * genuinely belong to more than one view in this folder.
 */

import { formatMoney, type Period } from "../../src/core/define.ts";

/** Whole sen as ringgit, for a chart axis. Charts plot display units. */
export const ringgit = (cents: number): number => Math.round(Number(cents ?? 0)) / 100;

/** `RM 1,234.50` from whole sen. */
export const rm = (cents: number | null | undefined): string => formatMoney(cents, "RM");

/**
 * The two ends of a period as SQL-comparable date strings.
 *
 * `from` is null for "all time", and the date columns in these tables are
 * `YYYY-MM-DD` text, so the open end becomes a string that sorts below every
 * real date rather than a branch in every query.
 */
export const bounds = (period: Period): [string, string] => [period.from ?? "0000-01-01", period.to];

/** `2026-09` → `Sep 26`, which is what fits under a column. */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const name = names[Number(m) - 1] ?? month;
  return `${name} ${(year ?? "").slice(2)}`;
}

/** `groceries` → `Groceries`, `phone_internet` → `Phone internet`. */
export function pretty(value: string): string {
  const spaced = String(value ?? "").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * `credit_rhb` → `credit rhb`. Accounts only.
 *
 * They are the one column `pretty()` gets wrong: sentence case turns
 * `credit_rhb` into "Credit rhb" and `tng` into "Tng", which read as
 * misspellings of names rather than as the identifiers they are. Lowercase
 * everywhere is what the Tables tab already shows and what you type into the
 * form, so the view matches it instead of inventing a second spelling.
 */
export const account = (value: string): string => String(value ?? "").replace(/_/g, " ");
