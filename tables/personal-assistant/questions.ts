import { datetime, defineTable, enumOf, json, text } from "../../src/core/define.ts";

/**
 * What the assistant asked you, and what you said.
 *
 * `open` until you answer on the card (or here), then `answered` until the
 * assistant has acted on it and closed it as `done` — so an answer given at
 * 23:50 is still waiting for the 08:00 run rather than lost between two.
 */
export default defineTable({
  name: "questions",
  description:
    "The conversation between you and the assistant outside of drafts: its questions (open → " +
    "answered → done), your notes to it (answered until acted on), and its updates to you.",

  columns: {
    kind: enumOf(["question", "note", "update"], {
      default: "question",
      label: "Kind",
      help: "question: the assistant asks you. note: you told it something. update: it tells you (the morning and night digests).",
    }),
    question: text({ label: "Question" }),
    options: json({
      nullable: true,
      label: "Choices",
      help: "Buttons offered on the card, as a list of strings. Empty means a typed answer.",
    }),
    chat_key: text({
      nullable: true,
      label: "About chat",
      help: "channel:id, when the question is about one chat.",
    }),
    answer: text({ nullable: true, label: "Answer" }),
    status: enumOf(["open", "answered", "done"], { default: "open", label: "Status" }),
    answered_at: datetime({ nullable: true, label: "Answered" }),
    card_id: text({
      nullable: true,
      label: "Card",
      help: "The Telegram message id it was asked in. Empty until it is sent.",
    }),
  },

  order: { column: "created_at", direction: "desc" },
});
