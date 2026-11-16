import { date, defineTable, enumOf, money, oneOf, text } from "../../src/core/define.ts";

/**
 * One shared expense: who paid, how much, and how it is divided.
 *
 * `split` is blank most of the time — the group's usual split applies. Filled
 * in, it overrides that for this one bill, in any of the forms
 * `views/split/_split.ts` reads: 50/50, names with percentages, names with
 * amounts, or just the names of the people it was for.
 */
export default defineTable({
  name: "split_expenses",
  description:
    "Shared expenses in the bill split. paid_by paid amount_cents for everyone; split (blank = the " +
    "group's usual split) says who owes what, e.g. '50/50', 'Huzaifah 70%, Zahidah 30%', " +
    "'Huzaifah 25, Zahidah 15.50' (RM amounts), 'Zahidah' (all hers), 'equal'.",

  columns: {
    spent_on: date({ label: "Date" }),
    item: text({ label: "What", help: "e.g. Groceries, Grab to airport, hotel 2 nights." }),
    amount_cents: money({ label: "Amount (RM)" }),
    group_name: oneOf("split_groups", { label: "Group" }),
    paid_by: oneOf("split_people", { label: "Paid by", linkDefault: true }),
    split: text({
      nullable: true,
      label: "Split",
      help:
        "Blank = the group's usual split. Or: 50/50 · Huzaifah 70%, Zahidah 30% · " +
        "Huzaifah 25, Zahidah 15.50 · Zahidah (all hers) · equal",
    }),
    category: enumOf(
      ["food", "groceries", "transport", "stay", "bills", "shopping", "fun", "other"],
      { default: "other", label: "Category" },
    ),
    note: text({ nullable: true, label: "Note" }),
  },

  order: { column: "spent_on", direction: "desc" },
});
