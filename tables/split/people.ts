import { defineTable, text } from "../../src/core/define.ts";

/**
 * Everyone who can pay or owe in a bill split — the household and anyone who
 * joins a trip.
 *
 * A row rather than a closed list in code (the way the baby tables name their
 * payers) because a friend joining a dinner is something the people using the
 * page do themselves, from the phone, and should not wait on a commit.
 * `split_groups.members`, `split_expenses.paid_by` and the payment columns all
 * name people by this `name`, so a name is the identity: renaming one leaves
 * older rows naming the old spelling, which the split view points out.
 *
 * Name a person the way their share link is labelled ("Huzaifah", "Zahidah")
 * and "Paid by" opens on them when they log from their own link.
 */
export default defineTable({
  name: "split_people",
  description:
    "People in the bill split — one row per person who pays or owes. Their name is how every " +
    "other split table refers to them.",

  columns: {
    name: text({ label: "Name", help: "First name is enough — it's what the dropdowns show." }),
    note: text({ nullable: true, label: "Note" }),
  },

  dedupe: "name",
  order: { column: "created_at", direction: "asc" },
});
