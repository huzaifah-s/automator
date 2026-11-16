import { bars, defineView, formatMoney, rows, stats, type Panel, type ViewCtx } from "../../src/core/define.ts";
import { listOf, resolveName, settleUp, splitBill, type Transfer } from "./_split.ts";

/**
 * Split bills — Splitwise, on the runner.
 *
 * ## Who uses it, and how
 *
 * Everyone in a split gets their own share link, labelled with their name as
 * it is spelled on the Person tab ("Huzaifah", "Zahidah"). `entry` turns the
 * link into the place expenses, settle-up payments, groups and people are
 * added, and "Paid by" / "From" open on whoever is holding the link.
 *
 * A link shows every group. That is right for a household; a friend given a
 * link for one trip would also see the household's groceries, so for now a
 * trip with friends is better shown from the dashboard than shared.
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

/**
 * Everything the page knows, worked out once: groups with their members and
 * balances, every expense's shares (or why it has none), payments, and what
 * needs fixing. `load()` turns it into panels for the dashboard; `app.data()`
 * hands it to the phone page as JSON. One copy of the maths, so the two never
 * disagree about who owes what.
 */
function ledger(ctx: ViewCtx) {
  const personRows = ctx.sql<{ id: string; name: string }>(
    `SELECT id, name FROM ${ctx.from("split_people")} WHERE deleted_at IS NULL ORDER BY created_at ASC`,
  );
  const people = personRows.map((p) => p.name);

  /** Things to fix. Every entry here except a group's member list is left out of the balances. */
  const problems: { what: string; problem: string; table?: string; id?: string }[] = [];

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
          problem: `"${typed}" is not on the Person tab — still counted as a member; add them there, or take them out of the group`,
        });
        members.push(typed);
      } else if (!members.includes(who)) members.push(who);
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
        problem: `the group "${p.group_name}" no longer exists — pick another`,
      });
      continue;
    }
    if (p.paid_by === p.paid_to) {
      problems.push({ what: label, table: "split_payments", id: p.id, problem: "from and to are the same person" });
      continue;
    }
    add(g.net, p.paid_by, p.amount_cents);
    add(g.net, p.paid_to, -p.amount_cents);
    g.lastActivity = Math.max(g.lastActivity, p.created_at);
  }

  return { people, personRows, known, groups, expenses, shares, payments, problems };
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
      const { personRows, known, groups, expenses, shares, payments, problems } = ledger(ctx);
      // The usual split as percentages per member, so the expense form can
      // show what "usual" comes to without parsing the text again in a browser.
      const usual = (g: Group) => {
        if (!g.split?.trim()) return null;
        const r = splitBill(10_000, g.split, g.members, known);
        return r.ok ? Object.fromEntries([...r.shares].map(([n, c]) => [n, c / 100])) : null;
      };
      const obj = (m: Map<string, number>) => Object.fromEntries([...m].filter(([, c]) => c !== 0));
      const overall = new Map<string, number>();
      for (const g of groups.values()) for (const [who, c] of g.net) add(overall, who, c);
      return {
        people: personRows,
        categories: Object.entries(CATEGORY).map(([value, label]) => ({ value, label })),
        groups: [...groups.values()]
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
        expenses: expenses.map((e) => {
          const s = shares.get(e.id);
          return {
            ...e,
            shares: s instanceof Map ? Object.fromEntries(s) : null,
            error: typeof s === "string" ? s : null,
          };
        }),
        payments,
        overall: { net: obj(overall), transfers: settleUp(overall) },
        problems,
      };
    },
  },

  load(ctx) {
    const filter = ctx.control("group").trim().toLowerCase();
    const period = ctx.period("period");

    const { people, groups, expenses, shares, payments, problems } = ledger(ctx);

    /* ------------------------------------------------------------- scope */

    const inScope = (name: string) => !filter || name.toLowerCase().includes(filter);
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

    if (problems.length) {
      panels.push(
        rows({
          title: `Needs fixing · ${problems.length}`,
          note:
            "An expense or payment listed here counts in no balance until it's fixed — edit it on its tab above.",
          columns: [
            { key: "what", label: "Entry" },
            { key: "problem", label: "Problem" },
          ],
          data: problems,
        }),
      );
    }

    // One tile per person who has ever been in play here, newest money first.
    const everyone = [...new Set([...people, ...overall.keys()])].filter(
      (who) => overall.has(who) || paidTotal.has(who) || people.includes(who),
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
