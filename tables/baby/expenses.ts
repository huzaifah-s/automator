import { date, defineTable, enumOf, money, text } from "../../src/core/define.ts";
import { BABY_EXPENSE_CATEGORIES, PAYERS } from "./_shared.ts";

/**
 * Money spent on the baby, and which parent paid.
 *
 * Kept apart from `expenses` (personal-finance) on purpose: that ledger is one
 * person's own spending, and a tin of formula Zahidah paid for is not part of it.
 */
export default defineTable({
  name: "baby_expenses",
  description:
    "Money spent on the baby: one row per purchase, with what it was, the amount, and " +
    "which parent paid (huzaifah or zahidah).",

  columns: {
    spent_on: date({ label: "Date" }),
    item: text({ label: "What", help: "e.g. Formula 900g, diapers M size, clinic visit." }),
    amount_cents: money({ label: "Amount (RM)" }),
    category: enumOf(BABY_EXPENSE_CATEGORIES, { default: "other", label: "Category" }),
    paid_by: enumOf(PAYERS, { label: "Paid by" }),
    note: text({ nullable: true, label: "Note" }),
  },

  order: { column: "spent_on", direction: "desc" },
});
