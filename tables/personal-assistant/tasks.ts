import { datetime, defineTable, enumOf, text } from "../../src/core/define.ts";

/**
 * The open tasks on your Notion To Do list, as the assistant reads them.
 *
 * A mirror, written only by `personal-assistant-sync-tasks` every ten
 * minutes: Notion stays the place you edit a task, and an edit here is
 * overwritten by the next sync. It exists so the assistant's hourly run reads
 * twenty tasks from SQLite instead of making twenty calls to Notion, and so
 * that "did you change this since Maria wrote on it" is worked out once, by
 * the sync, rather than guessed by a model.
 *
 * A task leaves the table when it is Done, deleted, or moved out of the
 * database. It is also the list of pages the assistant may write on: a note
 * is only accepted for a page that is here.
 */
export default defineTable({
  name: "tasks",
  description:
    "Your open Notion To Do tasks, mirrored every ten minutes for the assistant. Read-only " +
    "in practice: edit the task in Notion, not here.",

  columns: {
    page_id: text({ label: "Page", help: "The Notion page id." }),
    title: text({ label: "Task" }),
    status: text({ nullable: true, label: "Status" }),
    due: text({ nullable: true, label: "Due", help: "YYYY-MM-DD, or a date and time." }),
    category: text({ nullable: true, label: "Category" }),
    url: text({ label: "Link" }),
    body: text({
      nullable: true,
      label: "Page",
      help: "The page's text as the assistant reads it, cut at 8,000 characters. Maria's own notes are labelled.",
    }),
    edited_at: datetime({ label: "Edited", help: "When the page last changed in Notion." }),
    edited_by: enumOf(["you", "automation"], {
      nullable: true,
      label: "Edited by",
      help: "you: a person. automation: this runner — Maria's notes, or a task it created.",
    }),
    checked_at: datetime({ label: "Read", help: "When the sync last read the page's text." }),
  },

  dedupe: "page_id",
  order: { column: "edited_at", direction: "desc" },
});
