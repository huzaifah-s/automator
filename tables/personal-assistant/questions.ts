import { bool, datetime, defineTable, enumOf, json, text } from "../../src/core/define.ts";

/**
 * What the assistant asked you, and what you said.
 *
 * `open` until you answer on the card (or here), then `answered` until the
 * assistant has acted on it and closed it as `done` — so an answer given at
 * 23:50 is still waiting for the 08:00 run rather than lost between two.
 *
 * A tap is an answer. A typed reply is a `note` that quotes the card and
 * points at it with `reply_to`, and the question stays open: the assistant
 * reads it and decides whether it answers the card ("Ali, supplier") or
 * asks something back ("telegram or whatsapp"), with or without a "?". Only
 * a bare always / normal / ignore is taken as the answer on arrival.
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
    task_id: text({
      nullable: true,
      label: "About task",
      help: "The Notion page id, when the question is about one To Do task.",
    }),
    quote: text({
      nullable: true,
      label: "Their latest",
      help: "question about a chat: its latest messages from them, shown on the card so you can tell who it is.",
    }),
    answer: text({ nullable: true, label: "Answer" }),
    status: enumOf(["open", "answered", "done"], { default: "open", label: "Status" }),
    answered_at: datetime({ nullable: true, label: "Answered" }),
    expired_at: datetime({
      nullable: true,
      label: "Expired",
      help: "question: closed unanswered after two days on its card. The next digest mentions it once.",
    }),
    card_id: text({
      nullable: true,
      label: "Card",
      help:
        "The Telegram message id it was asked in — or, for a note, the message you sent. " +
        "Empty until it is sent.",
    }),
    reply_to: text({
      nullable: true,
      label: "Re",
      help:
        "note: the card you replied to. update: the note or question it answers, and its card " +
        "is threaded under that one.",
    }),
    link: text({
      nullable: true,
      label: "Link",
      help: "update: a page the card opens with a button — the task, for a task the assistant added.",
    }),
    card_outdated: bool({
      default: false,
      label: "Card outdated",
      help: "Set when the assistant recorded your answer from a reply; the card is rewritten and this cleared.",
    }),
  },

  order: { column: "created_at", direction: "desc" },
});
