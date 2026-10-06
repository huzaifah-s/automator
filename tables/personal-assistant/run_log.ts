import { defineTable, int, text } from "../../src/core/define.ts";

/**
 * One row per assistant run: what it did and, in its own words, why.
 *
 * The routine runs on claude.ai, where its transcript is only visible on the
 * routine's page. This is the part worth seeing next to everything else —
 * written by the `log_run` tool at the end of every run.
 *
 * The numbers are counted by the runner, not reported by the model: chats
 * waiting at the moment the run logged, and drafts, questions, lessons and
 * tasks made since the previous entry. A model that misremembers what it did
 * cannot make this table say otherwise. `summary` is the model's own account,
 * which is where "no tasks: nothing was promised" lives.
 */
export default defineTable({
  name: "run_log",
  description:
    "What each assistant run did. Counts are measured by the runner (waiting at the end of the " +
    "run; drafts, questions, lessons and tasks since the previous entry); summary is the " +
    "assistant's own account of why.",

  columns: {
    summary: text({ label: "Summary", help: "The assistant's account of the run, in a line or two." }),
    trigger: text({
      nullable: true,
      label: "Why it ran",
      help: "schedule, or the reason it was started early.",
    }),
    waiting_whatsapp: int({ default: 0, label: "Waiting · WhatsApp" }),
    waiting_telegram: int({ default: 0, label: "Waiting · Telegram" }),
    drafts: int({ default: 0, label: "Drafts" }),
    questions: int({ default: 0, label: "Questions" }),
    lessons: int({ default: 0, label: "Lessons" }),
    tasks: int({ default: 0, label: "Tasks" }),
    problems: text({ nullable: true, label: "Problems", help: "Anything that failed or got in the way." }),
  },

  order: { column: "created_at", direction: "desc" },
});
