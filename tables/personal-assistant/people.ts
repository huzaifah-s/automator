import { defineTable, enumOf, text } from "../../src/core/define.ts";

/**
 * Who and what matters — one row per WhatsApp or Telegram chat the assistant
 * has seen, and what it should do about them.
 *
 * Rows arrive by themselves: the sync workflow adds a chat the first time it
 * records a message from one, with no priority. An empty priority is the
 * assistant's cue to ask ("Is *Projek X* important?"), and the answer is
 * written back here — so this table is the one place both sides edit, and
 * editing it on the dashboard is always allowed.
 *
 * A WhatsApp person can arrive twice, as a phone number and as a hidden
 * privacy id (`@lid`). Once the two are known to be one person, the `@lid`
 * row keeps only `same_as`, pointing at the number's row, which holds
 * everything else (src/core/chat-link.ts).
 *
 * `notes` says who the chat is, in a line — his role in a group, who a
 * person is. The messages themselves are forgotten after two weeks (see
 * src/core/chat-log.ts); what is still pending with them is a `loops` row,
 * and lasting facts about his world are in `brain`.
 */
export default defineTable({
  name: "people",
  description:
    "WhatsApp and Telegram chats and how much they matter: always (checked every run, never " +
    "waits), normal (looked at when they spoke last), ignore (never read). Empty means not " +
    "decided yet — ask. Notes say who they are, in a line.",

  columns: {
    name: text({ label: "Name", help: "The person's or group's name, as the chat shows it." }),
    channel: enumOf(["whatsapp", "telegram"], { label: "Channel" }),
    kind: enumOf(["person", "group", "channel", "bot"], { label: "Kind" }),
    priority: enumOf(["always", "normal", "ignore"], {
      nullable: true,
      label: "Priority",
      help: "always: never waits. normal: when they spoke last. ignore: never read. Empty: not decided.",
    }),
    notes: text({
      nullable: true,
      label: "Notes",
      help: "Who they are, in a line — and his role, in a group. What is pending is in loops.",
    }),
    chat_key: text({
      label: "Chat",
      help: "channel:id — the WhatsApp JID or Telegram chat id. Set by the sync; do not edit.",
    }),
    same_as: text({
      nullable: true,
      label: "Same as",
      help:
        "Set on a WhatsApp hidden id (@lid) that is the same person as a phone number: that " +
        "chat's key. Its priority, notes and messages live there. See src/core/chat-link.ts.",
    }),
  },

  dedupe: "chat_key",
  order: { column: "name", direction: "asc" },
});
