import { bool, datetime, defineTable, enumOf, int, text } from "../../src/core/define.ts";
import { MILKS } from "./_shared.ts";

/**
 * One bottle — expressed breast milk or formula — at the time it was given.
 *
 * Vitamin D rides on the feed as a tick rather than being its own row: it goes
 * into a bottle, and "was it given today" is the only question anyone asks of
 * it. Logged by either parent from the baby view's share link, so
 * `written_by` says which of them it was.
 */
export default defineTable({
  name: "baby_feeds",
  description:
    "Milk the baby drank: one row per bottle, with the time, breast milk or formula, and " +
    "how many ml. vitamin_d is ticked when the drops went into that bottle.",

  columns: {
    fed_at: datetime({ label: "Time", help: "When the feed was given." }),
    milk: enumOf(MILKS, { default: "breast_milk", label: "Milk" }),
    ml: int({ label: "Amount (ml)", help: "How much was drunk, in ml." }),
    vitamin_d: bool({ default: false, label: "Vitamin D", help: "Vitamin D given with this feed" }),
    note: text({ nullable: true, label: "Note", help: "Anything worth remembering — spat up, fussy, left some." }),
  },

  order: { column: "fed_at", direction: "desc" },
});
