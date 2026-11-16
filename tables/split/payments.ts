import { date, defineTable, money, oneOf, text } from "../../src/core/define.ts";

/**
 * Money handed over to settle up — Splitwise's "record a payment". It moves
 * the balance and is not an expense: nobody's spending changes.
 */
export default defineTable({
  name: "split_payments",
  description:
    "Settle-up payments in the bill split: paid_by gave paid_to amount_cents within a group. " +
    "Moves the balance; not an expense.",

  columns: {
    paid_on: date({ label: "Date" }),
    group_name: oneOf("split_groups", { label: "Group" }),
    paid_by: oneOf("split_people", { label: "From", linkDefault: true }),
    paid_to: oneOf("split_people", { label: "To" }),
    amount_cents: money({ label: "Amount (RM)" }),
    note: text({ nullable: true, label: "Note", help: "e.g. DuitNow, cash." }),
  },

  order: { column: "paid_on", direction: "desc" },
});
