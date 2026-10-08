import { bool, date, datetime, defineTable, enumOf, text } from "../../src/core/define.ts";

/**
 * Follow-ups the assistant offered, and what you chose.
 *
 * When you write something that needs an answer — a demo link sent to a
 * client, a question to a partner — and nobody has replied, she offers to
 * follow up (`offer_followup`). The card asks when: in 2 days, a week, two
 * weeks, or not at all. A tap is applied by the bot at once, with no model:
 * a loop waiting on them, due that day (the hourly run offers a nudge once
 * it is overdue), and a task in your Notion To Do for the same day.
 *
 * Every answer is feedback: `outcomes` lists it until `learn` marks it, so
 * "no need" for a kind of message, or always "2 weeks" for clients, becomes
 * a lesson rather than the same offer next time.
 */
export default defineTable({
  name: "followups",
  description:
    "Follow-ups the assistant offered on messages you sent that are waiting for a reply: when you " +
    "chose to follow up (or not), and the loop and To Do task that made.",

  columns: {
    chat_key: text({ label: "Chat", help: "channel:id, as in people." }),
    what: text({ label: "Waiting for", help: "One line: what they owe him, e.g. “Faiz to try the demo”." }),
    title: text({ label: "Task title", help: "The To Do task made if he says yes. English." }),
    category: text({ nullable: true, label: "Category", help: "The To Do category for that task." }),
    quote: text({ nullable: true, label: "His message", help: "What he sent, shown on the card." }),
    card_id: text({ nullable: true, label: "Card", help: "The Telegram message it was offered on." }),
    answer: enumOf(["2 days", "1 week", "2 weeks", "no"], {
      nullable: true,
      label: "Your choice",
      help: "When to follow up, or no. Empty until you tap.",
    }),
    answered_at: datetime({ nullable: true, label: "Answered" }),
    due: date({ nullable: true, label: "Follow up on" }),
    loop_id: text({ nullable: true, label: "Loop", help: "The loop opened for it." }),
    task_url: text({ nullable: true, label: "Task", help: "The Notion To Do task made for it." }),
    learned: bool({
      default: false,
      label: "Learned",
      help: "Set once the assistant has drawn a lesson from your choice (or decided there was none).",
    }),
  },

  order: { column: "created_at", direction: "desc" },
});
