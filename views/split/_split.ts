/**
 * The bill-split maths: reading a split someone typed on a phone, dividing a
 * bill into whole cents, and turning balances into the fewest payments.
 *
 * Pure functions over plain values — no `ctx`, no tables — so the view is the
 * only thing that reads the database and this file can be reasoned about (and
 * tried in a REPL) on its own.
 *
 * ## What a split may say
 *
 * Blank, or `equal`, splits evenly among the group's members. Otherwise:
 *
 *   60/40               proportions, in the members' order (2/1 works too)
 *   Huzaifah 70%, Zahidah 30%
 *   Huzaifah 25, Zahidah 15.50      amounts in RM — must add up to the bill
 *   Huzaifah 2x, Zahidah 1x         shares
 *   Zahidah             the whole bill is hers
 *   Huzaifah, Ali       evenly between just these two
 *   Ali 30, Huzaifah, Zahidah       Ali 30, the rest evenly between the others
 *   Ali 50%, Huzaifah, Zahidah      the same with a percentage
 *
 * A name without a number beside numbered ones takes "the rest, evenly" (or
 * one share). Names are matched case-insensitively against `split_people`,
 * and anyone there may be named, member of the group or not — the friend who
 * joined one dinner on the household's tab.
 *
 * Anything else is an error with a sentence saying what is wrong. The view
 * leaves that expense out of every balance and lists it at the top until it
 * is fixed; a split that is guessed at is a debt nobody agreed to.
 */

export type SplitResult =
  | { ok: true; shares: Map<string, number> }
  | { ok: false; error: string };

/** Splits a list typed into one text box: commas, semicolons, new lines, "&", "and". */
export function listOf(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\s*(?:,|;|\n|&|\+|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The canonical spelling of `name` among `known`, ignoring case and spacing. */
export function resolveName(name: string, known: readonly string[]): string | null {
  const want = name.replace(/\s+/g, " ").trim().toLowerCase();
  return known.find((k) => k.replace(/\s+/g, " ").trim().toLowerCase() === want) ?? null;
}

const rm = (cents: number) =>
  `RM ${(cents / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Divides `amount` cents by `weights`, in whole cents that add up exactly.
 *
 * Largest remainder: everyone gets the floor of their exact share, and the
 * cents left over go one each to the biggest fractions, ties to whoever comes
 * first. RM 10.00 three ways is 3.34 / 3.33 / 3.33, never 3.33 × 3 with a
 * cent that belongs to nobody. A negative bill (a refund) is divided as its
 * size and handed back negative.
 */
export function allocate(amount: number, weights: [string, number][]): Map<string, number> {
  const out = new Map<string, number>();
  const total = weights.reduce((n, [, w]) => n + w, 0);
  const sign = amount < 0 ? -1 : 1;
  const size = Math.abs(amount);
  const exact = weights.map(([name, w], i) => ({ name, i, raw: total > 0 ? (size * w) / total : 0 }));
  let left = size;
  for (const e of exact) {
    const whole = Math.floor(e.raw + 1e-9);
    out.set(e.name, whole);
    left -= whole;
  }
  const byFraction = [...exact].sort((a, b) => b.raw - Math.floor(b.raw + 1e-9) - (a.raw - Math.floor(a.raw + 1e-9)) || a.i - b.i);
  for (let k = 0; left > 0 && byFraction.length > 0; k = (k + 1) % byFraction.length, left--) {
    const name = byFraction[k]!.name;
    out.set(name, out.get(name)! + 1);
  }
  if (sign < 0) for (const [k, v] of out) out.set(k, -v);
  return out;
}

const NUMBER = String.raw`\d+(?:\.\d+)?`;
/** "60/40", "50 / 30 / 20", "2:1" — proportions in the members' order. */
const RATIO = new RegExp(String.raw`^${NUMBER}%?(?:\s*[/:]\s*${NUMBER}%?)+$`);
/**
 * One item: a name, then a separator, then an amount, a percentage or a share
 * count. The separator is required so "Max 2" is Max with 2, not "Ma" with x2.
 */
const ITEM = new RegExp(
  String.raw`^(.*?\S)[\s:=-]+(?:(?:rm\s*)?(${NUMBER})\s*(%|x|shares?)?|x\s*(${NUMBER}))$`,
  "i",
);

type Item = { name: string; kind: "bare" | "amount" | "percent" | "shares"; value: number };

/**
 * Who owes what of one bill.
 *
 * `members` is the group, in its own order (it decides what "60/40" means);
 * `known` is everyone in `split_people`, so a split may name someone outside
 * the group.
 */
export function splitBill(
  amount: number,
  text: string | null | undefined,
  members: readonly string[],
  known: readonly string[],
): SplitResult {
  const typed = (text ?? "").trim();

  if (typed === "" || /^(?:split\s+)?(?:equal|equally|even|evenly)$/i.test(typed)) {
    if (members.length === 0) return { ok: false, error: "the group has nobody in it to split between" };
    return { ok: true, shares: allocate(amount, members.map((m) => [m, 1])) };
  }

  if (RATIO.test(typed)) {
    const parts = typed.split(/[/:]/).map((p) => Number(p.replace("%", "").trim()));
    if (parts.length !== members.length) {
      return {
        ok: false,
        error:
          `"${typed}" has ${parts.length} parts but the group has ${members.length} ` +
          `member${members.length === 1 ? "" : "s"} (${members.join(", ") || "none"}) — ` +
          `write names instead, e.g. ${members[0] ?? "Name"} 60%`,
      };
    }
    if (parts.every((p) => p === 0)) return { ok: false, error: `"${typed}" gives everybody nothing` };
    return { ok: true, shares: allocate(amount, members.map((m, i) => [m, parts[i]!])) };
  }

  const lookup = [...new Set([...members, ...known])];
  const items: Item[] = [];
  for (const piece of listOf(typed)) {
    const m = ITEM.exec(piece);
    const rawName = (m?.[1] ?? piece).trim();
    const number = m?.[2] ?? m?.[4];
    if (!rawName) return { ok: false, error: `"${piece}" has no name in it` };
    const name = resolveName(rawName, lookup);
    if (!name) {
      return { ok: false, error: `nobody called "${rawName}" — add them on the Person tab, or fix the spelling` };
    }
    if (items.some((it) => it.name === name)) return { ok: false, error: `${name} is named twice` };
    if (number === undefined) {
      items.push({ name, kind: "bare", value: 0 });
      continue;
    }
    const unit = (m?.[3] ?? (m?.[4] ? "x" : "")).toLowerCase();
    items.push({
      name,
      kind: unit === "%" ? "percent" : unit === "" ? "amount" : "shares",
      value: Number(number),
    });
  }
  if (items.length === 0) return { ok: false, error: `could not read "${typed}"` };

  const numbered = items.filter((it) => it.kind !== "bare");
  const bare = items.filter((it) => it.kind === "bare");
  const kinds = new Set(numbered.map((it) => it.kind));
  if (kinds.size > 1) {
    return { ok: false, error: "mixes amounts, percentages and shares — use one kind per bill" };
  }
  const kind = [...kinds][0];

  if (!kind) return { ok: true, shares: allocate(amount, items.map((it) => [it.name, 1])) };

  if (kind === "shares") {
    if (numbered.every((it) => it.value === 0) && bare.length === 0) {
      return { ok: false, error: "every share is zero" };
    }
    return { ok: true, shares: allocate(amount, items.map((it) => [it.name, it.kind === "bare" ? 1 : it.value])) };
  }

  if (kind === "percent") {
    const sum = numbered.reduce((n, it) => n + it.value, 0);
    if (sum > 100.0001) return { ok: false, error: `the percentages add up to ${round(sum)}%` };
    if (bare.length === 0 && Math.abs(sum - 100) > 0.0001) {
      return { ok: false, error: `the percentages add up to ${round(sum)}%, not 100%` };
    }
    const rest = bare.length ? (100 - sum) / bare.length : 0;
    return {
      ok: true,
      shares: allocate(amount, items.map((it) => [it.name, it.kind === "bare" ? rest : it.value])),
    };
  }

  // Amounts, in RM as typed, to whole cents.
  const fixed = numbered.map((it) => [it.name, Math.round(it.value * 100)] as [string, number]);
  const sum = fixed.reduce((n, [, c]) => n + c, 0);
  const size = Math.abs(amount);
  if (sum > size) return { ok: false, error: `the amounts add up to ${rm(sum)}, more than the bill's ${rm(size)}` };
  if (bare.length === 0 && sum !== size) {
    return { ok: false, error: `the amounts add up to ${rm(sum)}, but the bill is ${rm(size)}` };
  }
  const shares = new Map<string, number>();
  const restShares = allocate(size - sum, bare.map((it) => [it.name, 1]));
  const sign = amount < 0 ? -1 : 1;
  for (const it of items) {
    const cents = it.kind === "bare" ? restShares.get(it.name)! : fixed.find(([n]) => n === it.name)![1];
    shares.set(it.name, sign * cents);
  }
  return { ok: true, shares };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A payment that settles part of the balances: `from` pays `to`. */
export interface Transfer {
  from: string;
  to: string;
  cents: number;
}

/**
 * The fewest payments that bring every balance to zero — Splitwise's
 * "simplify debts". `net` is what each person is owed (positive) or owes
 * (negative); the biggest debtor pays the biggest creditor until one of them
 * is square, and again. Not always the theoretical minimum, never more than
 * one fewer than the number of people.
 */
export function settleUp(net: Map<string, number>): Transfer[] {
  const owed = [...net].filter(([, c]) => c > 0).map(([name, c]) => ({ name, c }));
  const owes = [...net].filter(([, c]) => c < 0).map(([name, c]) => ({ name, c: -c }));
  const out: Transfer[] = [];
  for (;;) {
    owed.sort((a, b) => b.c - a.c);
    owes.sort((a, b) => b.c - a.c);
    const to = owed[0];
    const from = owes[0];
    if (!to || !from || to.c === 0 || from.c === 0) break;
    const cents = Math.min(to.c, from.c);
    out.push({ from: from.name, to: to.name, cents });
    to.c -= cents;
    from.c -= cents;
    if (to.c === 0) owed.shift();
    if (from.c === 0) owes.shift();
  }
  return out;
}
