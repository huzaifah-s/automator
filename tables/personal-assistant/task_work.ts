import { bool, datetime, defineTable, enumOf, text } from "../../src/core/define.ts";

/**
 * Every note the assistant has written on one of your To Do tasks, and what
 * you did about it.
 *
 * A note is a callout appended to the task's page — a draft, a plan, its
 * questions, or your answer written down. A task it created gets a row too,
 * kind `created`, whose text is the category and due date it chose. `text` is what it wrote; the sync
 * keeps reading the callout, and when it no longer says that, `outcome` is
 * set and `learned` cleared:
 *
 *   edited       you changed the note — `detail` is your version
 *   removed      you deleted the note
 *   done / kiv   the task was marked Done, or KIV, after the note
 *   page_edited  you changed something else on the page
 *   deleted      the task itself was deleted
 *   changed      on a task it created: you changed the category or due date
 *                it set — `detail` is what they are now
 *
 * Like a draft's ending, an outcome stays on the assistant's `outcomes` list
 * until it has drawn a lesson from it with `learn`. A second edit after that
 * sets it again.
 */
export default defineTable({
  name: "task_work",
  description:
    "Notes the assistant wrote on your To Do tasks, and what you did about each — edited, " +
    "removed, the task done — until it has learned from it.",

  columns: {
    page_id: text({ label: "Page", help: "The task's Notion page id." }),
    task_title: text({ label: "Task" }),
    kind: enumOf(["draft", "plan", "questions", "update", "answer", "created"], {
      label: "Kind",
      help:
        "draft: the work itself, ready to use. plan: steps or a checklist. questions: what it " +
        "needs from you. update: progress. answer: your answer to its question, written down. " +
        "created: it added the task — Note is the category and due date it set.",
    }),
    text: text({ label: "Note", help: "What the assistant wrote, as it reads it back." }),
    block_id: text({ nullable: true, label: "Block", help: "The callout's Notion block id." }),
    seen_text: text({
      nullable: true,
      label: "Now says",
      help: "The callout's text when the sync last looked. Differs from Note once you edit it.",
    }),
    seen_status: text({ nullable: true, label: "Task status", help: "The task's status when last looked at." }),
    outcome: enumOf(["edited", "removed", "done", "kiv", "page_edited", "deleted", "changed"], {
      nullable: true,
      label: "What you did",
    }),
    detail: text({ nullable: true, label: "Detail", help: "Your version of the note, when you edited it." }),
    outcome_at: datetime({ nullable: true, label: "Noticed" }),
    learned: bool({
      default: false,
      label: "Learned from",
      help: "Set once the assistant has drawn its lesson from what you did.",
    }),
  },

  order: { column: "created_at", direction: "desc" },
});
