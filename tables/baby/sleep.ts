import { datetime, defineTable, text } from "../../src/core/define.ts";

/**
 * One stretch of sleep.
 *
 * `ended_at` is optional so a sleep can be logged the moment the baby goes
 * down and finished with Edit when they wake. A row with no end is a sleep
 * still going, and the baby view counts it up to now.
 */
export default defineTable({
  name: "baby_sleep",
  description:
    "Sleep: when the baby fell asleep and woke up. ended_at is empty while the sleep is still going.",

  columns: {
    started_at: datetime({ label: "Fell asleep", help: "When the sleep started." }),
    ended_at: datetime({ nullable: true, label: "Woke up", help: "Leave empty while asleep; fill in with Edit later." }),
    note: text({ nullable: true, label: "Note" }),
  },

  order: { column: "started_at", direction: "desc" },
});
