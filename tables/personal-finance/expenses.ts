import {
  bool,
  date,
  defineTable,
  enumOf,
  money,
  text,
} from "../../src/core/define.ts";
import { ACCOUNTS, EXPENSE_CATEGORIES, HELP, PAID_FOR, SOURCES } from "./_shared.ts";

/**
 * Money out — one row per *purchase*, however it was captured.
 *
 * Written from three directions and deliberately identical from all of them:
 * by hand on the Tables tab, by an agent over the MCP endpoint after reading a
 * receipt, and by a workflow if one is ever pointed at a statement. Nothing in
 * here knows or cares which.
 *
 * ## One row per purchase, not per payment
 *
 * The distinction that keeps this table honest: **a row is something you
 * bought, never the settling of a debt for something you already bought.**
 *
 *   - RM300 of shoes on Atome, paid over three months, is **one** RM300 row on
 *     the day you bought them. The three RM100 instalments are not rows.
 *   - A RM50 lunch on the RHB card is a RM50 row. The RM3000 card bill at the
 *     end of the month is not a row.
 *   - Moving money from the bank into ShopeePay is not a row at all.
 *
 * Logging both sides double-counts everything, and it is the mistake that
 * makes a ledger stop being worth reading. `account` says which card or wallet
 * carried the purchase, and that is the whole of what this table knows about
 * how it was paid — how the balance on that card is later cleared is the
 * card's business, not the ledger's.
 *
 * ## Money you fronted for somebody else
 *
 * Stays one row, with `paid_for` set and the payback recorded here as
 * `reimbursed_cents` — never as a row in `income`. See `PAID_FOR` in
 * `_shared.ts` for why both halves of that matter.
 */
export default defineTable({
  name: "expenses",
  // This string is what an agent reads before it writes a row — the file's own
  // comments never reach it. So the two mistakes that quietly ruin the data are
  // stated here rather than only above.
  description:
    "Money out — one row per purchase, on the day you bought it. NEVER log a credit-card " +
    "bill payment, a BNPL/Atome instalment, or a transfer between your own accounts: those " +
    "settle a purchase already recorded here, and logging both double-counts. Money you " +
    "fronted for someone else is still one row — set paid_for and put the payback in " +
    "reimbursed_cents on that same row, never as income.",

  columns: {
    occurred_on: date({ label: "Date", help: HELP.occurredOn }),
    merchant: text({ label: "Merchant", help: "Who was paid, as printed." }),
    amount_cents: money({ label: "Amount", help: HELP.amount }),
    currency: text({ default: "MYR", help: "ISO code. MYR unless it was spent abroad." }),
    category: enumOf(EXPENSE_CATEGORIES, { label: "Category" }),
    account: enumOf(ACCOUNTS, { label: "Paid with", help: HELP.account }),
    paid_for: enumOf(PAID_FOR, { default: "me", label: "For", help: HELP.paidFor }),
    reimbursed_cents: money({ default: 0, label: "Paid back", help: HELP.reimbursed }),
    reimbursed_on: date({ nullable: true, label: "Paid back on", help: HELP.reimbursedOn }),
    note: text({ nullable: true, help: "Anything worth remembering about it." }),
    source: enumOf(SOURCES, { default: "manual", help: "How the row arrived." }),
    receipt_ref: text({
      nullable: true,
      label: "Receipt",
      help: "Where the original lives — a Drive link, or the photo's date and time.",
    }),
    needs_review: bool({ default: false, label: "Review?", help: HELP.needsReview }),
    entry_key: text({ nullable: true, label: "Key", help: HELP.entryKey }),
  },

  // Null opts out, so only rows that carry a key are deduped — which is what
  // makes a retried write safe without making two identical RM 5 coffees on
  // the same day collide.
  dedupe: "entry_key",

  // Newest spending first: the question this table is opened with is almost
  // always about the recent end of it.
  order: { column: "occurred_on", direction: "desc" },
});
