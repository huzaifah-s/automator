import { defineTable, text } from "../../src/core/define.ts";

/**
 * What an expense is split within: the household, a trip, a shared gift.
 *
 * `members` and `split` are free text that `views/split/_split.ts` reads,
 * rather than one row per member: a group is typed on a phone, and "Huzaifah,
 * Zahidah" with "60/40" is one form instead of four. The view flags a name it
 * does not know or a split it cannot read, and leaves that group's balance
 * out until it is fixed, instead of guessing.
 *
 * `members` decides who sees the group: a share link shows only the groups
 * its holder is in. A blank list still means everyone on `split_people`, but
 * since every share link adds its holder there, that is every friend ever
 * given a link — the view flags a blank list so it gets filled in.
 */
export default defineTable({
  name: "split_groups",
  description:
    "Bill-split groups (household, a trip, …). members: comma-separated split_people names — a " +
    "share link only sees the groups its holder is in. split: the group's usual split, e.g. '60/40' in member order or " +
    "'Huzaifah 60%, Zahidah 40%'; blank splits equally.",

  columns: {
    name: text({ label: "Name", help: "e.g. Home, Bali 2026, Mum's birthday." }),
    members: text({
      nullable: true,
      label: "Members",
      help: "Names separated by commas, e.g. Huzaifah, Zahidah, Ali. Only they see the group on their links.",
    }),
    split: text({
      nullable: true,
      label: "Usual split",
      help: "Blank = equally. Or 60/40 (in the members' order), or Huzaifah 60%, Zahidah 40%.",
    }),
    note: text({ nullable: true, label: "Note" }),
  },

  dedupe: "name",
  // Newest first, so a new trip is at the top of every "Group" dropdown.
  order: { column: "created_at", direction: "desc" },
});
