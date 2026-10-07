import { bool, datetime, defineTable, enumOf, text } from "../../src/core/define.ts";

/**
 * The assistant's own priority calls, and what you did with them.
 *
 * She sorts new chats herself (always / normal / ignore, with a one-line
 * reason) instead of asking about each one, and every call is a row here as
 * well as the priority on `people`. `deliver-cards` puts a run's worth of
 * them on one "I sorted these" card, with a row of buttons per chat; if you
 * do not tap, her call stands.
 *
 * A tap that changes her call — or a priority you gave in words that
 * differs from it — is the feedback: `answer` is set, `learned` stays false,
 * and the endpoint's `outcomes` lists it until `learn` turns it into a
 * lesson ("his old school's groups: ignore"). A tap that agrees is kept too,
 * but it is not a correction and is not listed.
 */
export default defineTable({
  name: "sorting",
  description:
    "Chats the assistant sorted by herself: her choice and why, the card it was shown on, and " +
    "your change if you made one — which she learns from.",

  columns: {
    chat_key: text({ label: "Chat", help: "channel:id, as in people." }),
    choice: enumOf(["always", "normal", "ignore"], { label: "Her choice" }),
    reason: text({ label: "Why", help: "Her one-line reason." }),
    quote: text({
      nullable: true,
      label: "Their latest",
      help: "A person she could not place: their latest words, shown on the card so you can tell who it is.",
    }),
    card_id: text({
      nullable: true,
      label: "Card",
      help: "The Telegram message it was shown on. Empty until the run that made it has finished.",
    }),
    answer: enumOf(["always", "normal", "ignore"], {
      nullable: true,
      label: "Your choice",
      help: "What you set it to, when you tapped or said so. Empty: her choice stands.",
    }),
    answered_at: datetime({ nullable: true, label: "Answered" }),
    learned: bool({
      default: false,
      label: "Learned",
      help: "Set once the assistant has drawn a lesson from your change (or decided there was none).",
    }),
  },

  order: { column: "created_at", direction: "desc" },
});
