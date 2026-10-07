import { date, datetime, defineTable, enumOf, text } from "../../src/core/define.ts";

/**
 * What is still in flight — things somebody is waiting on, so they are not
 * lost once the chat scrolls past them.
 *
 * "Partner to send his client's free times" lives in a chat for a day, then
 * scrolls out of the window the assistant reads, and the chat log forgets it
 * after two weeks. A loop is that one line kept until it settles: who it is
 * waiting on (him or them), the chat or To Do task it belongs to, and when
 * it is due. The assistant opens one when a chat starts something, closes it
 * when a later run sees it settled, offers a nudge when the other side has
 * been quiet for two days, and puts his overdue ones in the digest.
 *
 * Not a task list: a To Do task is something he does; a loop is a thread
 * left hanging, and many close without anybody doing anything. Not quotes:
 * the words stay in the chat log.
 */
export default defineTable({
  name: "loops",
  description:
    "Things in flight: what is waiting on him or on somebody else, with the chat or task it " +
    "belongs to and when it is due. The assistant opens and closes these; edit or close any here.",

  columns: {
    what: text({ label: "What", help: "One line: who owes what, e.g. “Partner to send the client's free times”." }),
    waiting_on: enumOf(["him", "them"], {
      label: "Waiting on",
      help: "him: he owes the next move. them: somebody else does.",
    }),
    chat_key: text({ nullable: true, label: "Chat", help: "channel:id of the chat it belongs to." }),
    task_id: text({ nullable: true, label: "Task", help: "The Notion To Do page it belongs to." }),
    due: date({ nullable: true, label: "Due", help: "When it should have settled by, if anyone said." }),
    status: enumOf(["open", "done", "dropped"], {
      default: "open",
      label: "Status",
      help: "open: still waiting. done: it settled. dropped: it stopped mattering.",
    }),
    note: text({ nullable: true, label: "Note", help: "Anything worth knowing; on a closed loop, how it ended." }),
    nudged_at: datetime({
      nullable: true,
      label: "Nudged",
      help: "When the assistant last drafted a nudge for it. The next is offered two days later.",
    }),
    closed_at: datetime({ nullable: true, label: "Closed" }),
  },

  order: { column: "created_at", direction: "asc" },
});
