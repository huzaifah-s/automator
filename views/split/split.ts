import {
  bars,
  defineView,
  formatMoney,
  rows,
  stats,
  type EntryChange,
  type Panel,
  type ViewCtx,
  type ViewLinkInfo,
} from "../../src/core/define.ts";
import { listOf, resolveName, settleUp, splitBill, type Transfer } from "./_split.ts";

/**
 * Split bills — Splitwise, on the runner.
 *
 * ## Who uses it, and how
 *
 * Everyone in a split gets their own share link, and **a link is a person**:
 * make one labelled "Ali" and Ali is somebody a group can be made with, before
 * he has ever opened it. The first time a link opens, the app adds its holder
 * to `split_people` (named after the label), or — when there are people
 * nobody's link opens as yet, as with links made before this rule — asks once
 * which of them they are and writes the label onto that person's `link`. From
 * then on it opens as them: "Paid by" starts on them, and "You owe…" is them.
 * `whoIsWho` is the one place that decides which person a link is.
 *
 * **A link sees only its holder's groups** — the ones they are a member of or
 * have money in — and the bills, payments and balances inside them. A friend
 * given a link for one trip does not see the household's groceries. That is
 * enforced twice: `app.data()` leaves the rest out, and `canWrite` refuses a
 * write to a group that is not theirs, so it does not rest on the page's
 * script behaving. The dashboard, which has no link, sees everything.
 *
 * ## The model
 *
 * A **group** (Home, Bali 2026) has members and a usual split. An **expense**
 * is one bill in a group: who paid, how much, and — only when it differs from
 * the usual — how this one is split. A **payment** is money handed over to
 * settle up. Everyone's balance in a group is what they paid, minus their
 * share of every bill, plus what they paid others, minus what they were paid;
 * `settleUp` turns those balances into the fewest payments.
 *
 * Balances are always all-time — a debt does not expire with a date filter.
 * The period control narrows only the expense list and the category chart.
 *
 * ## What it refuses to guess
 *
 * A split that cannot be read, a member nobody added, an expense in a group
 * that has gone: each is listed under "Needs fixing" with a reason, and left
 * out of every balance until it is fixed.
 */

const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
};

const rm = (cents: number) => formatMoney(cents, "RM");
/** Amounts inside a sentence or a list, without the currency repeated. */
const plain = (cents: number) => formatMoney(cents, "");

const CATEGORY: Record<string, string> = {
  food: "Food & drink",
  groceries: "Groceries",
  transport: "Transport",
  stay: "Stay",
  bills: "Bills",
  shopping: "Shopping",
  fun: "Fun",
  other: "Other",
};

interface Group {
  id: string;
  name: string;
  /** The members box as typed — blank means everyone. */
  membersText: string | null;
  note: string | null;
  members: string[];
  split: string | null;
  createdAt: number;
  /** What each person is owed (+) or owes (−) in this group, in cents. */
  net: Map<string, number>;
  spent: number;
  lastActivity: number;
}

interface Expense {
  id: string;
  note: string | null;
  written_by: string | null;
  spent_on: string;
  item: string;
  amount_cents: number;
  group_name: string;
  paid_by: string;
  split: string | null;
  category: string;
  created_at: number;
}

interface Payment {
  id: string;
  written_by: string | null;
  paid_on: string;
  group_name: string;
  paid_by: string;
  paid_to: string;
  amount_cents: number;
  note: string | null;
  created_at: number;
}

const add = (m: Map<string, number>, who: string, cents: number) => m.set(who, (m.get(who) ?? 0) + cents);

const sentence = (t: Transfer) => `${t.from} pays ${t.to} ${rm(t.cents)}`;

/** How a name or a link label is compared: case and spacing ignored. */
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** A name a split can say without being misread — the same rule the app types against. */
export const usableName = (s: string) => !!s.trim() && !/[,;&+\d%]|\band\b/i.test(s);

interface PersonRow {
  id: string;
  name: string;
  link: string | null;
  created_at: number;
}

/**
 * Which person each share link is.
 *
 * A link opens as the person whose `link` names its label; failing that, the
 * person whose name is spelled like it. Neither, and it is a link nobody is
 * yet — `unmatched` — whose holder the app adds or asks. `claimable` is who
 * such a holder may say they are: people no live link opens as, so one link
 * can never take over somebody else's.
 */
function whoIsWho(ctx: ViewCtx, people: PersonRow[]) {
  const explicit = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const p of people) {
    if (p.link?.trim() && !explicit.has(norm(p.link))) explicit.set(norm(p.link), p.name);
    if (!byName.has(norm(p.name))) byName.set(norm(p.name), p.name);
  }
  const whoIs = (label: string): string | null => explicit.get(norm(label)) ?? byName.get(norm(label)) ?? null;

  const links = ctx.shareLinks();
  /** Each person's live links, by label. */
  const linksOf = new Map<string, ViewLinkInfo[]>();
  const unmatched: ViewLinkInfo[] = [];
  for (const l of links) {
    const who = whoIs(l.label);
    if (who) linksOf.set(who, [...(linksOf.get(who) ?? []), l]);
    else if (!unmatched.some((u) => norm(u.label) === norm(l.label))) unmatched.push(l);
  }
  const claimable = people.filter((p) => !linksOf.has(p.name)).map((p) => p.name);
  const viewer = ctx.link?.label ?? null;
  return { whoIs, linksOf, unmatched, claimable, viewer, me: viewer === null ? null : whoIs(viewer) };
}

/**
 * Everything the page knows, worked out once: groups with their members and
 * balances, every expense's shares (or why it has none), payments, and what
 * needs fixing. `load()` turns it into panels for the dashboard; `app.data()`
 * hands it to the phone page as JSON. One copy of the maths, so the two never
 * disagree about who owes what.
 */
function ledger(ctx: ViewCtx) {
  const personRows = ctx.sql<PersonRow>(
    `SELECT id, name, link, created_at FROM ${ctx.from("split_people")} WHERE deleted_at IS NULL ORDER BY created_at ASC`,
  );
  const people = personRows.map((p) => p.name);
  const ids = whoIsWho(ctx, personRows);

  /**
   * Things to fix. Every entry here except a group's member list is left out
   * of the balances. `group` is the group it belongs to, so a link is shown
   * only its own; for one whose group is gone, `involves` and `by` (who wrote
   * it) say whose it is.
   */
  const problems: {
    what: string;
    problem: string;
    table?: string;
    id?: string;
    group?: string;
    involves?: string[];
    by?: string | null;
  }[] = [];

  /* ------------------------------------------------------------ groups */

  const groups = new Map<string, Group>();
  for (const g of ctx.sql<{
    id: string;
    name: string;
    members: string | null;
    split: string | null;
    note: string | null;
    created_at: number;
  }>(
    `SELECT id, name, members, split, note, created_at FROM ${ctx.from("split_groups")}
      WHERE deleted_at IS NULL ORDER BY created_at ASC`,
  )) {
    // A member missing from the Person tab is kept, not dropped: dropping
    // them would quietly re-split every bill the group ever had. Removing
    // someone from a group is an edit to the group, never a side effect.
    const members: string[] = [];
    for (const typed of listOf(g.members)) {
      const who = resolveName(typed, [...people, ...members]);
      if (!who) {
        problems.push({
          what: `Group ${g.name}`,
          table: "split_groups",
          id: g.id,
          group: g.name,
          problem: `"${typed}" is not on the Person tab — still counted as a member; add them there, or take them out of the group`,
        });
        members.push(typed);
      } else if (!members.includes(who)) members.push(who);
    }
    if (!listOf(g.members).length) {
      problems.push({
        what: `Group ${g.name}`,
        table: "split_groups",
        id: g.id,
        group: g.name,
        problem:
          "nobody is ticked, so it counts everyone — including every friend given a link, now and later. " +
          "Tick who's in it",
      });
    }
    groups.set(g.name, {
      id: g.id,
      name: g.name,
      membersText: g.members,
      note: g.note,
      members: listOf(g.members).length ? members : [...people],
      split: g.split,
      createdAt: g.created_at,
      net: new Map(),
      spent: 0,
      lastActivity: g.created_at,
    });
  }
  // Everyone a split may name: the Person tab, plus anybody a group still
  // counts as a member after leaving it.
  const known = [...new Set([...people, ...[...groups.values()].flatMap((g) => g.members)])];

  for (const g of groups.values()) {
    if (!g.split) continue;
    const check = splitBill(10_000, g.split, g.members, known);
    if (!check.ok) {
      problems.push({
        what: `Group ${g.name}`,
        table: "split_groups",
        id: g.id,
        group: g.name,
        problem: `usual split "${g.split}": ${check.error}`,
      });
    }
  }

  /* ---------------------------------------------------------- expenses */

  const expenses = ctx.sql<Expense>(
    `SELECT id, spent_on, item, amount_cents, group_name, paid_by, split, category, note, written_by, created_at
       FROM ${ctx.from("split_expenses")}
      WHERE deleted_at IS NULL ORDER BY spent_on DESC, created_at DESC`,
  );
  /** Each expense's shares, or why it has none — for the list as well as the balances. */
  const shares = new Map<string, Map<string, number> | string>();

  for (const e of expenses) {
    const label = `${day(e.spent_on)} · ${e.item} (${rm(e.amount_cents)})`;
    const g = groups.get(e.group_name);
    if (!g) {
      shares.set(e.id, `group "${e.group_name}" is gone`);
      problems.push({
        what: label,
        table: "split_expenses",
        id: e.id,
        involves: [e.paid_by],
        by: e.written_by,
        problem: `the group "${e.group_name}" no longer exists — pick another`,
      });
      continue;
    }
    const text = e.split?.trim() ? e.split : g.split;
    const result = splitBill(e.amount_cents, text, g.members, known);
    if (!result.ok) {
      shares.set(e.id, result.error);
      problems.push({
        what: label,
        table: "split_expenses",
        id: e.id,
        group: g.name,
        problem: e.split?.trim() ? `split "${e.split}": ${result.error}` : `group's usual split: ${result.error}`,
      });
      continue;
    }
    shares.set(e.id, result.shares);
    add(g.net, e.paid_by, e.amount_cents);
    for (const [who, cents] of result.shares) add(g.net, who, -cents);
    g.spent += e.amount_cents;
    g.lastActivity = Math.max(g.lastActivity, e.created_at);
  }

  /* ---------------------------------------------------------- payments */

  const payments = ctx.sql<Payment>(
    `SELECT id, paid_on, group_name, paid_by, paid_to, amount_cents, note, written_by, created_at
       FROM ${ctx.from("split_payments")}
      WHERE deleted_at IS NULL ORDER BY paid_on DESC, created_at DESC`,
  );
  for (const p of payments) {
    const label = `${day(p.paid_on)} · ${p.paid_by} → ${p.paid_to} (${rm(p.amount_cents)})`;
    const g = groups.get(p.group_name);
    if (!g) {
      problems.push({
        what: label,
        table: "split_payments",
        id: p.id,
        involves: [p.paid_by, p.paid_to],
        by: p.written_by,
        problem: `the group "${p.group_name}" no longer exists — pick another`,
      });
      continue;
    }
    if (p.paid_by === p.paid_to) {
      problems.push({ what: label, table: "split_payments", id: p.id, group: g.name, problem: "from and to are the same person" });
      continue;
    }
    add(g.net, p.paid_by, p.amount_cents);
    add(g.net, p.paid_to, -p.amount_cents);
    g.lastActivity = Math.max(g.lastActivity, p.created_at);
  }

  /**
   * Whether the link viewing this may see a group: its holder is a member or
   * has money in it. Everything on the dashboard (no link) is visible; a link
   * nobody is yet sees nothing until its holder says who they are.
   */
  const canSee = (groupName: string): boolean => {
    if (ids.viewer === null) return true;
    const g = groups.get(groupName);
    return !!ids.me && !!g && (g.members.includes(ids.me) || g.net.has(ids.me));
  };

  return { people, personRows, ids, known, groups, expenses, shares, payments, problems, canSee };
}

/**
 * What a share link may write, on top of `entry` — see "A link sees only its
 * holder's groups" above. Each refusal is a sentence the holder reads.
 */
function refuse(ctx: ViewCtx, change: EntryChange): string | null {
  const { people, ids, groups, canSee } = ledger(ctx);
  const label = ids.viewer ?? "";
  const v = change.values ?? {};
  const r = (change.row ?? {}) as Record<string, any>;
  const str = (x: unknown) => (typeof x === "string" ? x : x == null ? "" : String(x));

  if (change.table === "split_people") {
    if (change.op === "insert") {
      if (str(v.link) && norm(str(v.link)) !== norm(label)) return "Only a person's own link can be set as theirs.";
      return null;
    }
    if (change.op === "update") {
      if ("name" in v && str(v.name) !== r.name) return "Rename people on the dashboard — every bill names them by name.";
      if ("link" in v && norm(str(v.link)) !== norm(r.link)) {
        // Saying "this is me" from a link that is nobody yet, about somebody
        // no live link already opens as. Nothing else moves a link.
        if (norm(str(v.link)) !== norm(label)) return "Only a person's own link can be set as theirs.";
        if (ids.me) return `This link is already ${ids.me}.`;
        if (!ids.claimable.includes(r.name)) return `${r.name} already has a link of their own.`;
      }
      return null;
    }
    if (r.name && r.name === ids.me) return "You can't remove yourself.";
    const elsewhere = [...groups.values()].find((g) => g.members.includes(r.name) && !canSee(g.name));
    return elsewhere ? `${r.name} is in a group you're not in, so they stay — the dashboard can remove them.` : null;
  }

  if (!ids.me) return "Say who you are first — reopen your link.";

  if (change.table === "split_groups") {
    if (change.op !== "insert" && !canSee(r.name)) return "That group isn't one of yours.";
    if (change.op === "delete") return null;
    const typed = listOf(str("members" in v ? v.members : r.members));
    const members = typed.map((n) => resolveName(n, people) ?? n);
    if (!members.length) return "Tick who's in the group.";
    if (!members.includes(ids.me)) return "Keep yourself in the group — your link only shows the groups you're in.";
    return null;
  }

  // Expenses and payments: the row's group (unless it is gone, which only its
  // own people ever see) and the group it is moving to must both be theirs.
  if (change.op !== "insert" && groups.has(r.group_name) && !canSee(r.group_name)) return "That isn't in one of your groups.";
  if (change.op !== "delete") {
    const target = str("group_name" in v ? v.group_name : r.group_name);
    if (groups.has(target) && !canSee(target)) return "Pick one of your groups.";
  }
  return null;
}

export default defineView({
  name: "split",
  title: "Split bills",
  description: "Shared expenses, who owes who, and settling up — Splitwise-style, logged from your phone.",

  shareable: true,
  entry: [
    { table: "split_expenses", label: "Expense" },
    { table: "split_payments", label: "Settle up" },
    { table: "split_groups", label: "Group" },
    { table: "split_people", label: "Person" },
  ],

  canWrite: refuse,

  refresh: 120,

  controls: {
    group: { kind: "search", label: "Group", placeholder: "All groups" },
    period: { kind: "period", label: "Expenses from", default: "all" },
  },

  // The share links open this instead of the panels and generic forms: an
  // app with a page per group and an expense form that splits by ticking
  // people. The dashboard keeps the panels below.
  app: {
    script: "./app.mjs",
    data(ctx) {
      const { personRows, ids, known, groups, expenses, shares, payments, problems, canSee } = ledger(ctx);

      // Who this link is, and who else has one: a link is a person, so a
      // link nobody is yet is offered in "Who's in it" as if it were one.
      const people = personRows.map((p) => ({
        id: p.id,
        name: p.name,
        hasLink: ids.linksOf.has(p.name),
        opened: (ids.linksOf.get(p.name) ?? []).some((l) => l.lastUsedAt !== null),
      }));
      // `pickable`: offered in "Who's in it" as a person before they open it.
      // Only while everyone on People has a link — otherwise a link nobody is
      // yet may be one of those people ("Abang" for Huzaifah, made before a
      // link was a person), and offering both would split bills with one
      // person twice. It becomes them, or someone new, when its holder opens it.
      const linkOnly = ids.unmatched
        .filter((l) => norm(l.label) !== norm(ids.viewer))
        .map((l) => ({ label: l.label, pickable: usableName(l.label) && !ids.claimable.length }));
      const who = { label: ids.viewer, me: ids.me, claimable: ids.me ? [] : ids.claimable, usable: usableName(ids.viewer ?? "") };

      // A link nobody is yet gets the names to choose from and nothing else.
      if (ids.viewer !== null && !ids.me) {
        return {
          who,
          people,
          linkOnly,
          categories: [],
          groups: [],
          expenses: [],
          payments: [],
          overall: { net: {}, transfers: [] },
          problems: [],
        };
      }

      const mine = (p: (typeof problems)[number]) =>
        p.group !== undefined
          ? canSee(p.group)
          : ids.viewer === null || (!!ids.me && (p.involves?.includes(ids.me) || p.by === `link:${ids.viewer}`));
      const seen = [...groups.values()].filter((g) => canSee(g.name));
      const seenNames = new Set(seen.map((g) => g.name));
      // An expense whose group is gone is shown to whoever it names or wrote it, so it can be fixed.
      const orphanMine = (groupName: string, involves: string[], by: string | null) =>
        !groups.has(groupName) && (ids.viewer === null || (!!ids.me && (involves.includes(ids.me) || by === `link:${ids.viewer}`)));
      // The usual split as percentages per member, so the expense form can
      // show what "usual" comes to without parsing the text again in a browser.
      const usual = (g: Group) => {
        if (!g.split?.trim()) return null;
        const r = splitBill(10_000, g.split, g.members, known);
        return r.ok ? Object.fromEntries([...r.shares].map(([n, c]) => [n, c / 100])) : null;
      };
      const obj = (m: Map<string, number>) => Object.fromEntries([...m].filter(([, c]) => c !== 0));
      const overall = new Map<string, number>();
      for (const g of seen) for (const [who, c] of g.net) add(overall, who, c);
      return {
        who,
        people,
        linkOnly,
        categories: Object.entries(CATEGORY).map(([value, label]) => ({ value, label })),
        groups: seen
          .sort((a, b) => b.lastActivity - a.lastActivity)
          .map((g) => ({
            id: g.id,
            name: g.name,
            members: g.members,
            membersText: g.membersText,
            split: g.split,
            usual: usual(g),
            note: g.note,
            spent: g.spent,
            net: obj(g.net),
            transfers: settleUp(g.net),
            lastActivity: g.lastActivity,
          })),
        expenses: expenses
          .filter((e) => seenNames.has(e.group_name) || orphanMine(e.group_name, [e.paid_by], e.written_by))
          .map((e) => {
          const s = shares.get(e.id);
          return {
            ...e,
            shares: s instanceof Map ? Object.fromEntries(s) : null,
            error: typeof s === "string" ? s : null,
          };
        }),
        payments: payments.filter(
          (p) => seenNames.has(p.group_name) || orphanMine(p.group_name, [p.paid_by, p.paid_to], p.written_by),
        ),
        overall: { net: obj(overall), transfers: settleUp(overall) },
        problems: problems.filter(mine).map(({ involves, by, ...p }) => p),
      };
    },
  },

  load(ctx) {
    const filter = ctx.control("group").trim().toLowerCase();
    const period = ctx.period("period");

    const { people, ids, groups, expenses, shares, payments, problems, canSee } = ledger(ctx);

    /* ------------------------------------------------------------- scope */

    // The server never draws these panels for a link of a view with an app,
    // but if it ever did, they would show the holder only their own groups —
    // the same rule as app.data().
    const inScope = (name: string) => canSee(name) && (!filter || name.toLowerCase().includes(filter));
    const scoped = [...groups.values()].filter((g) => inScope(g.name));

    const overall = new Map<string, number>();
    const paidTotal = new Map<string, number>();
    const shareTotal = new Map<string, number>();
    for (const g of scoped) for (const [who, c] of g.net) add(overall, who, c);
    for (const e of expenses) {
      const s = shares.get(e.id);
      if (!inScope(e.group_name) || !(s instanceof Map)) continue;
      add(paidTotal, e.paid_by, e.amount_cents);
      for (const [who, c] of s) add(shareTotal, who, c);
    }

    /* ------------------------------------------------------------ panels */

    const panels: Panel[] = [];

    const shown = problems.filter((p) => (p.group !== undefined ? canSee(p.group) : ids.viewer === null));
    if (shown.length) {
      panels.push(
        rows({
          title: `Needs fixing · ${shown.length}`,
          note:
            "An expense or payment listed here counts in no balance until it's fixed — edit it on its tab above.",
          columns: [
            { key: "what", label: "Entry" },
            { key: "problem", label: "Problem" },
          ],
          data: shown.map((p) => ({ what: p.what, problem: p.problem })),
        }),
      );
    }

    // Which person each link opens as — the one place a link that is nobody
    // yet, or one that will ask "Who are you?", shows up on the dashboard.
    const links = ctx.link ? [] : ctx.shareLinks();
    if (links.length) {
      const when = (ms: number | null) =>
        ms === null ? "never" : new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
      panels.push(
        rows({
          title: "Share links",
          note:
            "Each link opens as one person and shows only the groups they're in. A link that isn't anyone yet " +
            "adds its holder on first open, or asks who they are when someone on People has no link of their own.",
          columns: [
            { key: "link", label: "Link" },
            { key: "as", label: "Opens as" },
            { key: "used", label: "Last opened" },
          ],
          data: links.map((l) => ({
            link: l.label,
            as:
              ids.whoIs(l.label) ??
              (ids.claimable.length
                ? `nobody yet — will ask: ${ids.claimable.join(", ")} or someone new`
                : usableName(l.label)
                  ? `nobody yet — becomes "${l.label}" on first open`
                  : "nobody yet — will ask for a name"),
            used: when(l.lastUsedAt),
          })),
        }),
      );
    }

    // One tile per person who has ever been in play here, newest money first.
    const everyone = [...new Set([...people, ...overall.keys()])].filter(
      (who) => overall.has(who) || paidTotal.has(who) || (ids.viewer === null && people.includes(who)),
    );
    if (everyone.length) {
      panels.push(
        stats(
          everyone.map((who) => {
            const n = overall.get(who) ?? 0;
            return {
              label: n > 0 ? `${who} gets back` : n < 0 ? `${who} owes` : who,
              value: n === 0 ? "All square" : rm(Math.abs(n)),
              sub: `paid ${rm(paidTotal.get(who) ?? 0)} · share ${rm(shareTotal.get(who) ?? 0)}`,
              tone: n > 0 ? "good" : n < 0 ? "warn" : "plain",
            };
          }),
        ),
      );
    }

    const transfers = scoped.flatMap((g) => settleUp(g.net).map((t) => ({ ...t, group: g.name })));
    const across = settleUp(overall);
    panels.push(
      rows({
        title: "Settle up",
        note:
          transfers.length > across.length && across.length > 0
            ? `Across all groups that's just: ${across.map(sentence).join("; ")}. ` +
              "Record each payment on the Settle up tab, in the group it's for."
            : "Record a payment on the Settle up tab once the money has moved.",
        // Three narrow columns, so a phone shows all of it without scrolling sideways.
        columns: [
          { key: "who", label: "Who pays who" },
          { key: "amount", label: "Amount", align: "right", mono: true },
          { key: "group", label: "Group" },
        ],
        data: transfers.map((t) => ({ who: `${t.from} → ${t.to}`, amount: rm(t.cents), group: t.group })),
        empty: groups.size === 0 ? "Add a group on the Group tab to start." : "Everyone's square.",
      }),
    );

    const ordered = [...scoped].sort((a, b) => {
      const owingA = [...a.net.values()].some((c) => c !== 0) ? 1 : 0;
      const owingB = [...b.net.values()].some((c) => c !== 0) ? 1 : 0;
      return owingB - owingA || b.lastActivity - a.lastActivity;
    });
    panels.push(
      rows({
        title: "Groups",
        // Balance next to the name: on a phone the right-hand columns are a sideways scroll away.
        columns: [
          { key: "group", label: "Group" },
          { key: "balance", label: "Balance" },
          { key: "spent", label: "Spent", align: "right", mono: true },
          { key: "members", label: "Members" },
          { key: "split", label: "Usual split" },
        ],
        data: ordered.map((g) => {
          const t = settleUp(g.net);
          return {
            group: g.name,
            members: g.members.join(", ") || "—",
            split: g.split?.trim() || "equal",
            spent: rm(g.spent),
            balance: t.length ? t.map(sentence).join("; ") : "Settled up",
          };
        }),
        empty: filter ? `No group matches "${ctx.control("group")}".` : "No groups yet — add one on the Group tab.",
      }),
    );

    const from = period.from ?? "0000-01-01";
    const listed = expenses.filter((e) => inScope(e.group_name) && e.spent_on >= from && e.spent_on <= period.to);
    const LIMIT = 60;
    panels.push(
      rows({
        title: `Expenses · ${period.label.toLowerCase()}`,
        note:
          `${listed.length} expense${listed.length === 1 ? "" : "s"}, ${rm(listed.reduce((n, e) => n + e.amount_cents, 0))}` +
          (listed.length > LIMIT ? ` — the newest ${LIMIT} shown.` : "."),
        columns: [
          { key: "on", label: "Date", mono: true },
          { key: "item", label: "What" },
          { key: "amount", label: "Amount", align: "right", mono: true },
          { key: "paid", label: "Paid by" },
          { key: "split", label: "Split" },
          { key: "group", label: "Group" },
        ],
        data: listed.slice(0, LIMIT).map((e) => {
          const s = shares.get(e.id);
          return {
            on: day(e.spent_on),
            item: e.item,
            group: e.group_name,
            paid: e.paid_by,
            amount: rm(e.amount_cents),
            split:
              s instanceof Map
                ? [...s].filter(([, c]) => c !== 0).map(([who, c]) => `${who} ${plain(c)}`).join(" · ")
                : `⚠ ${s ?? "not split"}`,
          };
        }),
        empty: "No expenses in this period.",
      }),
    );

    const paidListed = payments.filter((p) => inScope(p.group_name) && p.paid_on >= from && p.paid_on <= period.to);
    if (paidListed.length) {
      panels.push(
        rows({
          title: "Payments",
          columns: [
            { key: "on", label: "Date", mono: true },
            { key: "who", label: "Who paid who" },
            { key: "amount", label: "Amount", align: "right", mono: true },
            { key: "group", label: "Group" },
            { key: "note", label: "Note" },
          ],
          data: paidListed.slice(0, 30).map((p) => ({
            on: day(p.paid_on),
            who: `${p.paid_by} → ${p.paid_to}`,
            amount: rm(p.amount_cents),
            group: p.group_name,
            note: p.note ?? "",
          })),
        }),
      );
    }

    const byCategory = new Map<string, number>();
    for (const e of listed) add(byCategory, e.category, e.amount_cents);
    panels.push(
      bars({
        title: "By category",
        note: `What was spent, ${period.label.toLowerCase()}.`,
        rows: [...byCategory]
          .sort((a, b) => b[1] - a[1])
          .map(([k, c]) => ({ label: CATEGORY[k] ?? k, value: c / 100, display: rm(c) })),
        empty: "No expenses in this period.",
      }),
    );

    return panels;
  },
});
