import {
  bars,
  defineView,
  note,
  rows,
  series,
  stats,
} from "../../src/core/define.ts";
import { account, bounds, monthLabel, pretty, ringgit, rm } from "./_money.ts";

/**
 * The personal-finance dashboard — what came in, what went out, whose money it
 * was, and where it went.
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
 * "Still owed" reads `my_treat` as well as `paid_for`, because the first is
 * the only thing that says whether the money is coming back. Dropping it turns
 * every meal you ever bought somebody into a debt they do not know about.
 *
 * ## The two pockets
 *
 * `paid_by` splits spending into money that left *you* and money the company
 * paid directly. They are not interchangeable and the page never adds them
 * into a single headline: **Net is income minus your own spending only**,
 * because a bill the company settled never touched your balance and cannot
 * change what is left of it. The company figure sits beside it rather than
 * inside it — visible, because it is your company and you wanted to see it;
 * separate, because pretending it came out of your account would make Net a
 * number you could not reconcile against a bank statement.
 *
 * ## What the tickboxes do and do not reach
 *
 * They filter every *spending* panel. Two things deliberately escape them and
 * say so on the panel itself:
 *
 *   - **Income.** The income table has neither column — money arriving has no
 *     "whose money was it" — so no combination of ticks can change it.
 *   - **"Still owed to you" is always `paid_by: me`.** Not a filter that was
 *     forgotten: a debt *to you* can only arise from your own money, so
 *     unticking "me" cannot make company-paid rows into debts. It does still
 *     honour the "For" row, because "what does my wife owe me" is a real
 *     question that row can ask.
 *
 * ## Why the totals are SQL and not `aggregate()`
 *
 * `aggregate()` sums a column. Every figure on this page is a sum of an
 * *expression* — `amount_cents - reimbursed_cents`, and now a `CASE` over
 * `paid_by` on top of it — and month grouping is a `substr` of a date, which
 * is not a column either. So this view uses `ctx.sql`, with the table names
 * resolved through `ctx.from()` and every value bound as a parameter. Nothing
 * from the querystring is ever spliced into a query string here, and nothing
 * in this file should start — see `marks()` below for the one place that gets
 * close and why it is not.
 *
 * ## Sharing
 *
 * `shareable: true` means a link *may* be minted for this page from the
 * dashboard — not that one exists. Take the flag out and every link that was
 * ever minted stops resolving on the next request.
 */

/**
 * `n` bound-parameter placeholders for an `IN (…)` list.
 *
 * The one thing on this page that builds SQL from a value, and it is worth
 * being precise about why it is safe: what reaches the query string is a run
 * of `?` derived from an array's *length*, and never a character from the
 * array's contents. The values themselves are bound. A caller still has to
 * pass exactly `n` of them in the same order, which is why every use below
 * keeps the list and its parameters next to each other.
 */
const marks = (n: number): string => new Array(n).fill("?").join(", ");

/*
 * The tickbox rows, declared up here because the page needs their *lengths*
 * as well as their contents: "is this filter narrowed" is the difference
 * between what is ticked and everything there is to tick, and a literal 5 in
 * that comparison silently stops being true the day somebody adds an option.
 *
 * The values are the enum members from `tables/personal-finance/_shared.ts`,
 * spelled out here rather than imported: a view reaching across into a table's
 * `_shared.ts` would make an edit there stop *view* reloading, and these are
 * display labels for a closed set that changes about once a year. The labels
 * differ from the stored values on purpose — "My company" reads better on a
 * tickbox than the bare `company` the ledger stores.
 */
const PAID_BY_OPTIONS = [
  { value: "me", label: "Mine" },
  { value: "company", label: "My company" },
] as const;

const PAID_FOR_OPTIONS = [
  { value: "me", label: "Me" },
  { value: "wife", label: "Wife" },
  { value: "family", label: "Family" },
  { value: "company", label: "Company" },
  { value: "other", label: "Other" },
] as const;

export default defineView({
  name: "personal-finance",
  title: "Personal Finance",
  description:
    "Money in and out by month, whose money it was, where it went, and what is " +
    "still owed. Spending is net of anything paid back.",

  shareable: true,

  // A view is a live read of SQLite and costs a handful of aggregate queries,
  // so a slow refresh is affordable. Long enough that a page left open on a
  // second screen is current, short enough not to be a poll.
  refresh: 120,

  controls: {
    period: {
      kind: "period",
      label: "Period",
      // The month you are in, because that is the question the page is opened
      // with — how am I doing *now*. The month-by-month chart is then a single
      // column, which is the honest picture of one month; the longer views are
      // one click away, and a share link carries whichever one you sent.
      default: "this-month",
      // "Today" and "Last 7 days" are here for the other half of the usage:
      // checking what was logged after a day of spending, while you still
      // remember what the receipts were.
      options: ["today", "7d", "this-month", "last-month", "3m", "6m", "12m", "ytd", "all"],
    },

    /*
     * Both rows open with everything ticked, which is the whole picture and
     * the right first thing to see: the split is already visible in the tiles
     * and the chart, so nothing is hidden behind a control you have to
     * discover. Narrowing is then a subtraction you performed and can see the
     * state of, rather than a default you have to reverse-engineer.
     */
    paid_by: { kind: "multi", label: "Whose money", options: PAID_BY_OPTIONS },
    paid_for: { kind: "multi", label: "For", options: PAID_FOR_OPTIONS },
  },

  async load(ctx) {
    const period = ctx.period("period");
    const [from, to] = bounds(period);
    const paidBy = ctx.multi("paid_by");
    const paidFor = ctx.multi("paid_for");
    const expenses = ctx.from("expenses");
    const income = ctx.from("income");

    /*
     * An empty tick row means an empty page, and it has to be handled before
     * the first query rather than inside it: `IN ()` is not valid SQL, so the
     * alternative to this branch is not a quieter page, it is a stack trace.
     * Answering with the reason is also the only thing that distinguishes
     * "you filtered everything out" from "your ledger is empty" — which are
     * the same blank page otherwise.
     */
    if (paidBy.length === 0 || paidFor.length === 0) {
      return [
        note({
          title: "Nothing is ticked",
          body:
            `You have unticked every box under "${paidBy.length === 0 ? "Whose money" : "For"}", ` +
            "so there is nothing left to add up. Tick at least one and press Apply.",
        }),
      ];
    }

    /*
     * The filter both tick rows compile to, kept beside the parameters it
     * needs so the two cannot drift apart.
     *
     * `COALESCE` on both columns, and not only on the new one. `paid_by` needs
     * it for the documented reason — a column added to an existing data table
     * is NULL on every row written before it, and a bare `=` would silently
     * drop every pre-existing row from every panel on this page. `paid_for`
     * gets it as a belt: it has a `default` in the table definition, but a
     * default applies to writes and not to rows already on disk, and a single
     * null there would make a row invisible everywhere rather than loudly
     * wrong. Both columns default to `me`, which is what the ledger meant back
     * when it could not say anything else.
     */
    const who =
      `AND COALESCE(paid_by, 'me') IN (${marks(paidBy.length)}) ` +
      `AND COALESCE(paid_for, 'me') IN (${marks(paidFor.length)})`;
    const whoArgs = [...paidBy, ...paidFor];

    /** Net spend, counted only when the row came out of the named pocket. */
    const pocket = (which: "me" | "company") =>
      `CASE WHEN COALESCE(paid_by, 'me') = '${which}' THEN amount_cents - reimbursed_cents ELSE 0 END`;

    const showMine = paidBy.includes("me");
    const showCompany = paidBy.includes("company");
    const narrowed =
      paidBy.length < PAID_BY_OPTIONS.length || paidFor.length < PAID_FOR_OPTIONS.length;

    /*
     * Whether "Net" means anything on this render.
     *
     * Net is income minus your spending, and income cannot be filtered — so
     * the moment the *spending* side is a slice, the subtraction is between
     * two things that are not comparable. Ticking only "Wife" was producing a
     * Net of nearly a whole salary and reading as "you are up RM 8,870", when
     * all it actually said was that nothing much was spent on one person. A
     * figure that invites exactly one reading, and that reading is false, is
     * worse than no figure — so the tile and its column come out rather than
     * carrying a caveat somebody has to notice.
     */
    const netIsMeaningful = showMine && paidFor.length === PAID_FOR_OPTIONS.length;

    /* ------------------------------------------------------------ totals */

    const [out] = ctx.sql<{ mine: number; company: number; back: number }>(
      `SELECT COALESCE(SUM(${pocket("me")}), 0)      AS mine,
              COALESCE(SUM(${pocket("company")}), 0) AS company,
              COALESCE(SUM(reimbursed_cents), 0)     AS back
         FROM ${expenses}
        WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ? ${who}`,
      from,
      to,
      ...whoArgs,
    );

    const [inbound] = ctx.sql<{ income: number }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS income
         FROM ${income}
        WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?`,
      from,
      to,
    );

    const mine = out?.mine ?? 0;
    const company = out?.company ?? 0;
    const earned = inbound?.income ?? 0;
    // Your own spending only. See "The two pockets" at the top of this file.
    const net = earned - mine;

    /* ------------------------------------------------------- by month */

    const monthly = ctx.sql<{ month: string; income: number; mine: number; company: number }>(
      `SELECT month,
              COALESCE(SUM(income_cents), 0)  AS income,
              COALESCE(SUM(mine_cents), 0)    AS mine,
              COALESCE(SUM(company_cents), 0) AS company
         FROM (
           SELECT substr(occurred_on, 1, 7) AS month,
                  0 AS income_cents,
                  ${pocket("me")} AS mine_cents,
                  ${pocket("company")} AS company_cents
             FROM ${expenses}
            WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ? ${who}
           UNION ALL
           SELECT substr(occurred_on, 1, 7) AS month, amount_cents, 0, 0
             FROM ${income}
            WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
         )
        GROUP BY month
        ORDER BY month`,
      from,
      to,
      ...whoArgs,
      from,
      to,
    );

    /* ---------------------------------------------------- where it went */

    /*
     * `by` is an expression and not a column name, because `paid_for` has to
     * be grouped through the same COALESCE the filter uses. Grouped bare, a
     * row written before the column existed lands in its own NULL bucket and
     * draws a bar with no label at all — the filter counts it as `me`, the
     * chart calls it nothing, and the two disagree on the same page.
     */
    const breakdown = (by: string) =>
      ctx.sql<{ label: string; spent: number; n: number }>(
        `SELECT ${by} AS label,
                SUM(amount_cents - reimbursed_cents) AS spent,
                COUNT(*) AS n
           FROM ${expenses}
          WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ? ${who}
          GROUP BY ${by}
         HAVING SUM(amount_cents - reimbursed_cents) > 0
          ORDER BY spent DESC`,
        from,
        to,
        ...whoArgs,
      );

    const byCategory = breakdown("category");
    const byAccount = breakdown("account");
    const byPerson = breakdown("COALESCE(paid_for, 'me')");

    /* ------------------------------------------------------- still owed */

    /*
     * Deliberately not bounded by the period. Money somebody owes you is
     * outstanding until it is paid, and a company claim routinely sits for
     * months — filtering it to "this month" would quietly report the debt as
     * settled the moment the calendar turned over.
     *
     * `paid_by` is pinned to `me` rather than taken from the tick row, because
     * this panel asks who owes *you*, and only money out of your own pocket
     * can put anybody in that position. The "For" row does apply.
     *
     * `my_treat` is what separates "I paid for my family" from "my family owes
     * me"; `paid_for` alone never said the second thing. COALESCE on all three
     * for the same reason as `who` above — a column added after these rows
     * were written holds NULL, and compared bare every one of them would drop
     * off this panel, which is the opposite of the bug being fixed.
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
          AND COALESCE(paid_by, 'me') = 'me'
          AND COALESCE(paid_for, 'me') != 'me'
          AND COALESCE(paid_for, 'me') IN (${marks(paidFor.length)})
          AND COALESCE(my_treat, 0) = 0
          AND amount_cents > reimbursed_cents
        ORDER BY occurred_on DESC
        LIMIT 100`,
      ...paidFor,
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

    /*
     * Newest first means *newest*, and `occurred_on` is a date with no clock on
     * it — so on the day you log four receipts every one of them ties, and the
     * old tiebreak (the merchant's name) put them in alphabetical order. The
     * row you just wrote landed wherever the alphabet left it, which is the one
     * place you look for it.
     *
     * `created_at` is when the row was written, in epoch milliseconds, and it
     * breaks the tie the way you would expect. It stays the *second* key:
     * sorted by it alone, back-dating last week's receipt today would push it
     * above this morning's coffee, and a panel with a Date column sorted by
     * something other than that date is unreadable.
     */
    const recent = ctx.sql<{
      occurred_on: string;
      what: string;
      category: string;
      account: string;
      paid_by: string | null;
      amount_cents: number;
      kind: string;
    }>(
      `SELECT occurred_on, created_at, merchant AS what, category, account,
              COALESCE(paid_by, 'me') AS paid_by,
              amount_cents - reimbursed_cents AS amount_cents, 'out' AS kind
         FROM ${expenses}
        WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ? ${who}
       UNION ALL
       SELECT occurred_on, created_at, payer AS what, category, account,
              NULL AS paid_by, amount_cents, 'in'
         FROM ${income}
        WHERE deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
       ORDER BY occurred_on DESC, created_at DESC
       LIMIT 25`,
      from,
      to,
      ...whoArgs,
      from,
      to,
    );

    /* ------------------------------------------------------------ panels */

    return [
      stats([
        {
          label: `Money in · ${period.label.toLowerCase()}`,
          value: rm(earned),
          // Said only when it could mislead — with everything ticked there is
          // no filter for the reader to wonder about.
          sub: narrowed ? "the tickboxes do not apply to income" : undefined,
        },
        ...(showMine
          ? [
              {
                label: "Out of my pocket",
                value: rm(mine),
                // A stat tile's sub is one line and clips rather than wraps,
                // so this stays short enough to survive at the tile's width.
                sub: out?.back ? `${rm(out.back)} paid back` : undefined,
              },
            ]
          : []),
        ...(showCompany
          ? [
              {
                label: "Paid by company",
                value: rm(company),
                // Only when there are two figures to add. With nothing from
                // the company in view this would restate the tile beside it.
                sub: showMine && company > 0 ? `${rm(mine + company)} out in total` : undefined,
              },
            ]
          : []),
        ...(netIsMeaningful
          ? [
              {
                label: "Net",
                value: rm(net),
                // The one place a status colour is right on this page: whether
                // you are up or down is a state, not a category.
                tone: net >= 0 ? ("good" as const) : ("bad" as const),
                sub: showCompany ? "company money is not in this" : undefined,
              },
            ]
          : []),
        {
          label: "Still owed to you",
          value: rm(owedTotal),
          tone: owedTotal > 0 ? ("warn" as const) : ("plain" as const),
          sub: owed.length ? `${owed.length} row(s), all time` : undefined,
        },
      ]),

      series({
        title: "By month",
        note: showCompany
          ? "Money the company paid is its own column rather than part of the other one — " +
            "it never went through your accounts."
          : undefined,
        /*
         * The legend is built from what is ticked, so a pocket you filtered
         * out is absent rather than drawn as a row of zero-height columns —
         * which reads as "nothing was spent" instead of "you are not looking
         * at it". Three slots at most, which is also all the renderer's
         * palette will accept.
         */
        legend: [
          "In",
          ...(showMine ? ["Out · mine"] : []),
          ...(showCompany ? ["Out · company"] : []),
        ],
        unit: "RM",
        points: monthly.map((m) => ({
          label: monthLabel(m.month),
          values: [
            ringgit(m.income),
            ...(showMine ? [ringgit(m.mine)] : []),
            ...(showCompany ? [ringgit(m.company)] : []),
          ],
          displays: [
            rm(m.income),
            ...(showMine ? [rm(m.mine)] : []),
            ...(showCompany ? [rm(m.company)] : []),
          ],
        })),
        empty: "No rows in this period.",
      }),

      rows({
        title: "Month by month",
        note:
          "Spending is already net of anything paid back to you, and money the company " +
          "paid is shown but never folded into Net." +
          (netIsMeaningful
            ? " Net is income minus your own spending."
            : " Net is not shown while the spending columns are filtered — income is not, " +
              "so subtracting one from the other would not be a comparison."),
        columns: [
          { key: "month", label: "Month", mono: true },
          { key: "in", label: "In", align: "right", mono: true },
          ...(showMine
            ? [{ key: "mine", label: "Out · mine", align: "right" as const, mono: true }]
            : []),
          ...(showCompany
            ? [{ key: "company", label: "Out · company", align: "right" as const, mono: true }]
            : []),
          ...(netIsMeaningful
            ? [{ key: "net", label: "Net", align: "right" as const, mono: true }]
            : []),
        ],
        data: monthly
          .slice()
          .reverse()
          .map((m) => ({
            month: m.month,
            in: rm(m.income),
            mine: rm(m.mine),
            company: rm(m.company),
            net: rm(m.income - m.mine),
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
        title: "Who it was for",
        note:
          "Who got the benefit — not whose money it was, and not that they owe you for it. " +
          "A row marked as your treat is in here like any other, because it was still spent on them.",
        rows: byPerson.map((r) => ({
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
          "A credit-card bill or an Atome instalment is never a row in the ledger. " +
          "The company's own accounts are named here too, so they read as separate instruments.",
        rows: byAccount.map((r) => ({
          label: account(r.label),
          value: ringgit(r.spent),
          display: rm(r.spent),
          sub: `${r.n} row${r.n === 1 ? "" : "s"}`,
        })),
        empty: "Nothing spent in this period.",
      }),

      rows({
        title: "Still owed to you",
        note:
          "Money you fronted out of your own pocket for somebody else and have not been " +
          "fully paid back for. Not limited to the selected period — a debt does not settle " +
          "because the month ended — and always your own money, whatever is ticked under " +
          "Whose money: something the company paid for was never yours to be owed for. " +
          "A row marked as your treat is not a debt and is not here, whoever it was for.",
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
          "Neither the period nor the tickboxes narrow this one — a row you cannot trust yet " +
          "should not be able to hide behind a filter. Clear the flag on the Tables tab once " +
          "you have checked them.",
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
        note: "Newest first. Rows sharing a date are in the order they were entered.",
        columns: [
          { key: "date", label: "Date", mono: true },
          { key: "what", label: "What" },
          { key: "category", label: "Category" },
          { key: "account", label: "Account" },
          // Only worth a column when there is something to tell apart. With one
          // pocket ticked every cell would read the same, which is a column of
          // the filter you already set rather than a column of the data.
          ...(showMine && showCompany
            ? [{ key: "by", label: "Paid by" }]
            : []),
          { key: "amount", label: "Amount", align: "right", mono: true },
        ],
        data: recent.map((r) => ({
          date: r.occurred_on,
          what: r.what,
          category: pretty(r.category),
          account: account(r.account),
          // Income has no `paid_by` — money arriving has no pocket it left.
          by: r.paid_by === null ? "—" : r.paid_by === "company" ? "Company" : "Me",
          amount: `${r.kind === "in" ? "+" : "−"}${rm(r.amount_cents)}`,
        })),
        empty: "No rows in this period.",
      }),

      note({
        body:
          "One row per purchase, on the day it was bought. Credit-card bill payments, " +
          "BNPL instalments and transfers between your own accounts are not rows — they " +
          "settle something already recorded, and logging both would double-count it. " +
          "Three separate questions hang off each row: which instrument carried it " +
          "(Account), whose money left (Paid by), and who benefited (For).",
      }),
    ];
  },
});
