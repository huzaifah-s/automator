import { datetime, defineTable, enumOf, text } from "../../src/core/define.ts";

/**
 * Replies the assistant wrote and nobody has sent yet.
 *
 * Nothing here is ever sent without a person saying so: the assistant can
 * only create a row, `pending`, and the approval card is what moves it on.
 * A comment on the card sets `revise` and fills `feedback`; the assistant
 * then writes a new draft with `revision_of` pointing here, and this one
 * becomes `replaced`. So the history of a reply — every version, and what
 * was said about each — stays readable in one table.
 */
export default defineTable({
  name: "drafts",
  description:
    "Replies the assistant drafted, waiting for approval. pending: waiting for you. revise: " +
    "you commented — feedback says what to change. replaced: superseded by a newer draft. " +
    "sent / skipped / failed: finished.",

  columns: {
    chat_key: text({ label: "Chat", help: "channel:id, the same key as in people." }),
    chat_name: text({ label: "To", help: "Who it is for, as the chat shows them." }),
    text: text({ label: "Draft", help: "Exactly what would be sent." }),
    why: text({
      nullable: true,
      label: "Why",
      help: "What the assistant thinks this answers — shown on the card.",
    }),
    reply_to: text({
      nullable: true,
      label: "Replying to",
      help: "The message id it quotes, when it answers one message in particular.",
    }),
    status: enumOf(["pending", "revise", "replaced", "sent", "skipped", "failed"], {
      default: "pending",
      label: "Status",
    }),
    feedback: text({ nullable: true, label: "Your comments", help: "What to change, from the card." }),
    revision_of: text({ nullable: true, label: "Revision of", help: "The draft this one replaces." }),
    sent_at: datetime({ nullable: true, label: "Sent" }),
    error: text({ nullable: true, label: "Error", help: "Why sending failed." }),
    card_id: text({
      nullable: true,
      label: "Card",
      help: "The Telegram message id of its approval card. Empty until the card is sent.",
    }),
  },

  order: { column: "created_at", direction: "desc" },
});
