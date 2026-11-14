import { datetime, defineTable, enumOf, text } from "../../src/core/define.ts";
import { NAPPY_KINDS } from "./_shared.ts";

/** One nappy change, and what was in it. */
export default defineTable({
  name: "baby_nappies",
  description: "Nappy changes: the time, and whether it was a poop, a wee or both.",

  columns: {
    changed_at: datetime({ label: "Time", help: "When the nappy was changed." }),
    kind: enumOf(NAPPY_KINDS, { default: "poop", label: "What" }),
    note: text({ nullable: true, label: "Note", help: "Colour, texture, anything unusual." }),
  },

  order: { column: "changed_at", direction: "desc" },
});
