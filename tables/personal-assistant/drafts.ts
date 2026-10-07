import { bool, datetime, defineTable, enumOf, text } from "../../src/core/define.ts";

/**
 * Replies the assistant wrote and nobody has sent yet.
 *
 * Nothing here is ever sent without a person saying so: the assistant can
 * only create a row, `pending`, and the approval card is what moves it on.
 * A comment on the card sets `revise` and fills `feedback`; the assistant
 * then writes a new draft with `revision_of` pointing here, and this one
 * becomes `replaced`. When the assistant learns the draft should not exist at
 * all — "that was for Amin, not me" — it takes it back as `withdrawn`, and
 * the card says so. So the history of a reply — every version, and what
 * was said about each — stays readable in one table.
 */
export default defineTable({
  name: "drafts",
  description:
    "Replies the assistant drafted, waiting for approval. pending: waiting for you. revise: " +
    "you commented — feedback says what to change. replaced: superseded by a newer draft. " +
    "withdrawn: the assistant took it back. sent / skipped / failed: finished.",

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
    quote: text({
      nullable: true,
      label: "They wrote",
      help: "What it answers, as shown on the card: the message it quotes, or the chat's latest from them.",
    }),
    status: enumOf(["pending", "revise", "replaced", "withdrawn", "sent", "skipped", "failed"], {
      default: "pending",
      label: "Status",
    }),
    feedback: text({ nullable: true, label: "Your comments", help: "What to change, from the card." }),
    reason: text({ nullable: true, label: "Withdrawn because", help: "The assistant's reason, when it took the draft back." }),
    revision_of: text({ nullable: true, label: "Revision of", help: "The draft this one replaces." }),
    chat_url: text({
      nullable: true,
      label: "Chat link",
      help: "Opens the conversation from the card: wa.me for a WhatsApp number, t.me/c for a Telegram group.",
    }),
    sent_at: datetime({ nullable: true, label: "Sent" }),
    error: text({ nullable: true, label: "Error", help: "Why sending failed." }),
    card_id: text({
      nullable: true,
      label: "Card",
      help: "The Telegram message id of its approval card. Empty until the card is sent.",
    }),
    card_outdated: bool({
      default: false,
      label: "Card outdated",
      help: "Set when the assistant withdrew it; the card is rewritten and this cleared.",
    }),
    learned: bool({
      default: false,
      label: "Learned from",
      help: "Set once the assistant has drawn its lesson from how this draft ended.",
    }),
  },

  order: { column: "created_at", direction: "desc" },
});
