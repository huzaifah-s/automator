import {
  bars,
  defineView,
  note,
  rows,
  series,
  stats,
} from "../../src/core/define.ts";
import { bounds, monthLabel, pretty, ringgit, rm } from "./_money.ts";

/**
 * The personal-finance dashboard — what came in, what went out, and where it
 * went.
 *
 * ## What the numbers here mean
 *
 * Spending is **net of reimbursements** everywhere on this page:
 * `amount_cents - reimbursed_cents`, which is the number `tables/personal-
 * finance/expenses.ts` says is what you actually spent. Using the gross amount
 * would count money somebody handed back to you as your own spending, and
 * would disagree with the "still owed" panel at the bottom, which is built
 * from the difference between the two.
 *
 * ## Why the totals are one SQL query and the breakdowns are not
 *
 * `aggregate()` sums a column. Every figure on this page is a sum of an
 * *expression* — `amount_cents - reimbursed_cents` — and month grouping is a
 * `substr` of a date, which is not a column either. So this view uses
 * `ctx.sql`, with the table names resolved through `ctx.from()` and every
 * value bound as a parameter. Nothing from the querystring is ever spliced
 * into a query string here, and nothing in this file should start.
 *
 * ## Sharing
 *
 * `shareable: true` means a link *may* be minted for this page from the
 * dashboard — not that one exists. Take the flag out and every link that was
 * ever minted stops resolving on the next request.
 */
export default defineView({
  name: "personal-finance",
  title: "Personal Finance",
  description:
    "Money in and out by month, where it went, and what is still owed. " +
    "Spending is net of anything paid back.",

  shareable: true,

  // A view is a live read of SQLite and costs a handful of aggregate queries,
  // so a slow refresh is affordable. Long enough that a page left open on a
  // second screen is current, short enough not to be a poll.
  refresh: 120,

  controls: {
    period: {
      kind: "period",
      label: "Period",
      // Twelve months by default because the month-by-month chart is the point
      // of the page; "This month" is one click away when the question is
      // narrower.
      default: "12m",
      options: ["this-month", "last-month", "3m", "6m", "12m", "ytd", "all"],
    },
  },

  async load(ctx) {
    const period = ctx.period("period");
    const [from, to] = bounds(period);
    const expenses = ctx.from("expenses");
    const income = ctx.from("income");

    /* ------------------------------------------------------------ totals */

    const [totals] = ctx.sql<{ income: number; spend: number; gross: number; back: number }>(
      `SELECT
         COALESCE(SUM(income_cents), 0) AS income,
         COALESCE(SUM(spend_cents), 0)  AS spend,
         COALESCE(SUM(gross_cents), 0)  AS gross,
         COALESCE(SUM(back_cents), 0)   AS back
       FROM (
         SELECT 0 AS income_cents,
                amount_cents - reimbursed_cents AS spend_cents,
                amount_cents AS gross_cents,
                reimbursed_cents AS back_cents
           FROM ${expenses}
          WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
         UNION ALL
         SELECT amount_cents AS income_cents, 0, 0, 0
           FROM ${income}
          WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
       )`,
      from,
      to,
      from,
      to,
    );

    const net = (totals?.income ?? 0) - (totals?.spend ?? 0);

    /* ------------------------------------------------------- by month */

    const monthly = ctx.sql<{ month: string; income: number; spend: number }>(
      `SELECT month,
              COALESCE(SUM(income_cents), 0) AS income,
              COALESCE(SUM(spend_cents), 0)  AS spend
         FROM (
           SELECT substr(occurred_on, 1, 7) AS month,
                  0 AS income_cents,
                  amount_cents - reimbursed_cents AS spend_cents
             FROM ${expenses}
            WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
           UNION ALL
           SELECT substr(occurred_on, 1, 7) AS month, amount_cents, 0
             FROM ${income}
            WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
         )
        GROUP BY month
        ORDER BY month`,
      from,
      to,
      from,
      to,
    );

    /* ---------------------------------------------------- where it went */

    const byCategory = ctx.sql<{ label: string; spent: number; n: number }>(
      `SELECT category AS label,
              SUM(amount_cents - reimbursed_cents) AS spent,
              COUNT(*) AS n
         FROM ${expenses}
        WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
        GROUP BY category
        HAVING SUM(amount_cents - reimbursed_cents) > 0
        ORDER BY spent DESC`,
      from,
      to,
    );

    const byAccount = ctx.sql<{ label: string; spent: number; n: number }>(
      `SELECT account AS label,
              SUM(amount_cents - reimbursed_cents) AS spent,
              COUNT(*) AS n
         FROM ${expenses}
        WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
        GROUP BY account
        HAVING SUM(amount_cents - reimbursed_cents) > 0
        ORDER BY spent DESC`,
      from,
      to,
    );

    /* ------------------------------------------------------- still owed */

    /*
     * Deliberately not bounded by the period. Money somebody owes you is
     * outstanding until it is paid, and a company claim routinely sits for
     * months — filtering it to "this month" would quietly report the debt as
     * settled the moment the calendar turned over.
     */
    const owed = ctx.sql<{
      id: string;
      occurred_on: string;
      merchant: string;
      paid_for: string;
      outstanding: number;
      amount_cents: number;
    }>(
      `SELECT id, occurred_on, merchant, paid_for,
              amount_cents - reimbursed_cents AS outstanding,
              amount_cents
         FROM ${expenses}
        WHERE deleted_at IS NULL
          AND paid_for != 'me'
          AND amount_cents > reimbursed_cents
        ORDER BY occurred_on DESC
        LIMIT 100`,
    );
    const owedTotal = owed.reduce((sum, r) => sum + r.outstanding, 0);

    /* ----------------------------------------------------- needs review */

    const review = ctx.sql<{
      occurred_on: string;
      what: string;
      amount_cents: number;
      kind: string;
      source: string;
    }>(
      `SELECT occurred_on, merchant AS what, amount_cents, 'out' AS kind, source
         FROM ${expenses} WHERE deleted_at IS NULL AND needs_review = 1
       UNION ALL
       SELECT occurred_on, payer AS what, amount_cents, 'in' AS kind, source
         FROM ${income} WHERE deleted_at IS NULL AND needs_review = 1
       ORDER BY occurred_on DESC
       LIMIT 50`,
    );

    /* ------------------------------------------------------------ recent */

    const recent = ctx.sql<{
      occurred_on: string;
      what: string;
      category: string;
      account: string;
      amount_cents: number;
      kind: string;
    }>(
      `SELECT occurred_on, merchant AS what, category, account,
              amount_cents - reimbursed_cents AS amount_cents, 'out' AS kind
         FROM ${expenses}
        WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
       UNION ALL
       SELECT occurred_on, payer AS what, category, account, amount_cents, 'in'
         FROM ${income}
        WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
       ORDER BY occurred_on DESC, what
       LIMIT 25`,
      from,
      to,
      from,
      to,
    );

    /* ------------------------------------------------------------ panels */

    return [
      stats([
        { label: `Money in · ${period.label.toLowerCase()}`, value: rm(totals?.income ?? 0) },
        { label: "Money out", value: rm(totals?.spend ?? 0) },
        {
          label: "Net",
          value: rm(net),
          // The one place a status colour is right on this page: whether you
          // are up or down is a state, not a category.
          tone: net >= 0 ? "good" : "bad",
          sub: totals?.back ? `after ${rm(totals.back)} paid back to you` : undefined,
        },
        {
          label: "Still owed to you",
          value: rm(owedTotal),
          tone: owedTotal > 0 ? "warn" : "plain",
          sub: owed.length ? `${owed.length} row(s), all time` : undefined,
        },
      ]),

      series({
        title: "By month",
        legend: ["In", "Out"],
        unit: "RM",
        points: monthly.map((m) => ({
          label: monthLabel(m.month),
          values: [ringgit(m.income), ringgit(m.spend)],
          displays: [rm(m.income), rm(m.spend)],
        })),
        empty: "No rows in this period.",
      }),

      rows({
        title: "Month by month",
        note: "Net is income minus spending. Spending is already net of anything paid back to you.",
        columns: [
          { key: "month", label: "Month", mono: true },
          { key: "in", label: "In", align: "right", mono: true },
          { key: "out", label: "Out", align: "right", mono: true },
          { key: "net", label: "Net", align: "right", mono: true },
        ],
        data: monthly
          .slice()
          .reverse()
          .map((m) => ({
            month: m.month,
            in: rm(m.income),
            out: rm(m.spend),
            net: rm(m.income - m.spend),
          })),
        empty: "No rows in this period.",
      }),

      bars({
        title: "Spending by category",
        rows: byCategory.map((r) => ({
          label: pretty(r.label),
          value: ringgit(r.spent),
          display: rm(r.spent),
          sub: `${r.n} row${r.n === 1 ? "" : "s"}`,
        })),
        empty: "Nothing spent in this period.",
      }),

      bars({
        title: "Spending by account",
        note:
          "Which card or wallet carried the purchase — not how that card was later paid off. " +
          "A credit-card bill or an Atome instalment is never a row in the ledger.",
        rows: byAccount.map((r) => ({
          label: pretty(r.label),
          value: ringgit(r.spent),
          display: rm(r.spent),
          sub: `${r.n} row${r.n === 1 ? "" : "s"}`,
        })),
        empty: "Nothing spent in this period.",
      }),

      rows({
        title: "Still owed to you",
        note:
          "Money you fronted for somebody else and have not been fully paid back for. " +
          "Not limited to the selected period — a debt does not settle because the month ended.",
        columns: [
          { key: "date", label: "Date", mono: true },
          { key: "merchant", label: "Merchant" },
          { key: "who", label: "For" },
          { key: "outstanding", label: "Outstanding", align: "right", mono: true },
          { key: "of", label: "Of", align: "right", mono: true },
        ],
        data: owed.map((r) => ({
          date: r.occurred_on,
          merchant: r.merchant,
          who: pretty(r.paid_for),
          outstanding: rm(r.outstanding),
          of: rm(r.amount_cents),
        })),
        empty: "Nobody owes you anything.",
      }),

      rows({
        title: "Needs a second look",
        note:
          "Rows flagged when their figures were read from an image or a PDF rather than typed. " +
          "Clear the flag on the Tables tab once you have checked them.",
        columns: [
          { key: "date", label: "Date", mono: true },
          { key: "what", label: "What" },
          { key: "dir", label: "Direction" },
          { key: "source", label: "Read from" },
          { key: "amount", label: "Amount", align: "right", mono: true },
        ],
        data: review.map((r) => ({
          date: r.occurred_on,
          what: r.what,
          dir: r.kind === "in" ? "In" : "Out",
          source: pretty(r.source),
          amount: rm(r.amount_cents),
        })),
        empty: "Nothing is waiting to be checked.",
      }),

      rows({
        title: "Latest rows",
        columns: [
          { key: "date", label: "Date", mono: true },
          { key: "what", label: "What" },
          { key: "category", label: "Category" },
          { key: "account", label: "Account" },
          { key: "amount", label: "Amount", align: "right", mono: true },
        ],
        data: recent.map((r) => ({
          date: r.occurred_on,
          what: r.what,
          category: pretty(r.category),
          account: pretty(r.account),
          amount: `${r.kind === "in" ? "+" : "−"}${rm(r.amount_cents)}`,
        })),
        empty: "No rows in this period.",
      }),

      note({
        body:
          "One row per purchase, on the day it was bought. Credit-card bill payments, " +
          "BNPL instalments and transfers between your own accounts are not rows — they " +
          "settle something already recorded, and logging both would double-count it.",
      }),
    ];
  },
});
