import { bool, datetime, defineTable, text } from "../../src/core/define.ts";

/**
 * One diaper change, and what was in the diaper.
 *
 * The change is the event. When the baby actually weed or pooped is never
 * known — only what you find when you open the diaper — so a row is the time
 * of the change plus two ticks. Wee starts ticked because nearly every diaper
 * is wet; both unticked is a dry diaper, which is worth logging too.
 *
 * It used to be one `kind` of poop / wee / both, which made a parent decide
 * what had *happened* rather than record what they *saw*. `backfill` turns
 * those older rows into the two ticks the first time this file boots, and the
 * old `kind` column stays in the database, unread.
 *
 * The table keeps its original name, `baby_nappies`: it is the identity that
 * share links, MCP tokens and the rows themselves are filed under. Everything
 * a person sees says diaper.
 */
export default defineTable({
  name: "baby_nappies",
  description:
    "Diaper changes: one row per change, with the time it was changed and what was in it — " +
    "wee (wet) and/or poop, both false for a dry diaper.",

  columns: {
    changed_at: datetime({ label: "Time", help: "When the diaper was changed." }),
    wee: bool({ default: true, label: "Wee", help: "Wet" }),
    poop: bool({ default: false, label: "Poop", help: "Poop in it" }),
    note: text({ nullable: true, label: "Note", help: "Colour, texture, rash, anything unusual." }),
  },

  backfill: {
    wee: { sql: "kind IN ('wee', 'both')", needs: ["kind"] },
    poop: { sql: "kind IN ('poop', 'both')", needs: ["kind"] },
  },

  order: { column: "changed_at", direction: "desc" },
});
