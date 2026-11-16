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
 * ## A share link is a person
 *
 * Each person who logs bills themselves has a share link of the split view,
 * and the link opens as them. Which person a link is: the one whose `link`
 * names its label, or else the one whose `name` is spelled like the label
 * (any case). A link that is neither — one made before this column existed,
 * labelled "Sayang" for Zahidah — asks its holder once who they are and
 * writes the label into `link`, so a link label never has to be a name.
 *
 * Nobody has to add link holders here by hand: the app adds a person for a
 * link the first time it opens (or when they're ticked into a group), named
 * after the label.
 */
export default defineTable({
  name: "split_people",
  description:
    "People in the bill split — one row per person who pays or owes. Their name is how every " +
    "other split table refers to them. link: the label of the split share link that opens as " +
    "them, when it is not spelled like their name.",

  columns: {
    name: text({ label: "Name", help: "First name is enough — it's what the dropdowns show." }),
    link: text({
      nullable: true,
      label: "Share link",
      help: "The label of their share link, if it isn't spelled like their name. Blank = the link labelled with their name.",
    }),
    note: text({ nullable: true, label: "Note" }),
  },

  dedupe: "name",
  order: { column: "created_at", direction: "asc" },
});
