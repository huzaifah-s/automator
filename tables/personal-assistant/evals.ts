import { defineTable, int, text } from "../../src/core/define.ts";

/**
 * The replay test's scores — whether a change made her smarter, as a number.
 *
 * `personal-assistant-eval` replays moments that already happened (a draft
 * he corrected, a message he answered himself, a group message he let pass,
 * a chat he re-sorted) through the chat pass's writer as things stood then,
 * and a fresh Claude grades each new draft against what he really sent
 * (src/server/assistant-eval.ts). One row per system per run: `baseline` is
 * what she actually did at the time; the others are writer variants, side
 * by side on the same cases. Counts only — nothing anybody wrote.
 */
export default defineTable({
  name: "evals",
  description:
    "Replay test scores. score: % of cases right (send 1, edit ½, quiet when nothing was needed 1, " +
    "sorting matched 1). common: on the cases baseline — what she really did — was graded on too.",

  columns: {
    batch: text({ label: "Run", help: "The run that produced it; rows of one run compare." }),
    system: text({ label: "System", help: "baseline (what she did then), current (the live writer) or a variant." }),
    cases: int({ default: 0, label: "Cases" }),
    score: int({ nullable: true, label: "Score %" }),
    common_score: int({ nullable: true, label: "vs baseline %", help: "Score on the cases baseline has." }),
    replies: int({ default: 0, label: "Reply cases" }),
    send: int({ default: 0, label: "Send as written" }),
    edit: int({ default: 0, label: "Edit" }),
    wrong: int({ default: 0, label: "Wrong" }),
    missed: int({ default: 0, label: "Missed", help: "Stayed quiet where he replied." }),
    quiet_cases: int({ default: 0, label: "Nothing-needed cases" }),
    quiet_right: int({ default: 0, label: "Rightly quiet" }),
    sorting: int({ default: 0, label: "Sorting cases" }),
    sorting_right: int({ default: 0, label: "Sorted as he did" }),
    no_answer: int({ default: 0, label: "No answer", help: "Writer or grader did not answer — left out of the score." }),
  },

  order: { column: "created_at", direction: "desc" },
});
