import { datetime, defineTable, enumOf, int, text } from "../../src/core/define.ts";

/**
 * Every time the chat pass read a chat, and what it decided.
 *
 * `personal-assistant-chat-pass` looks at each chat where somebody wrote
 * last — one chat per Claude call, with only that chat in front of it — and
 * decides: draft a reply, or leave it. This is the record: which message it
 * had read up to (`upto_at`), so a chat is read again only when something
 * new arrives, and her one-line reason, so "why didn't she draft to X?" has
 * an answer. What she wrote is in `drafts`; what the second reader said is
 * in `draft_checks`. No message text here.
 */
export default defineTable({
  name: "chat_passes",
  description:
    "The chat pass's decision on each chat it read: draft, nothing needed, a revision, a withdrawal, " +
    "skipped by code (a group message not for him) or failed (tried again later). why is her reason.",

  columns: {
    chat_key: text({ label: "Chat", help: "channel:id, as in people." }),
    chat_name: text({ label: "Chat name" }),
    upto_at: datetime({ label: "Read up to", help: "The newest message it had seen. A newer one makes it read the chat again." }),
    decision: enumOf(["draft", "none", "revise", "withdraw", "skipped", "failed"], {
      label: "Decision",
      help:
        "draft: a reply is waiting for you. none: nothing needed. revise: a new version after your comment. " +
        "withdraw: your comment said not to send it. skipped: a group message not meant for you, by code. " +
        "failed: no answer from the model — read again later.",
    }),
    why: text({ nullable: true, label: "Why", help: "Her one line — or what stopped it." }),
    draft_id: text({ nullable: true, label: "Draft", help: "The drafts row it saved." }),
    did: text({
      nullable: true,
      label: "Also did",
      help: "Sorted, named, a task, a loop — one word each, with the row id.",
    }),
    ms: int({ default: 0, label: "Took (ms)" }),
  },

  order: { column: "created_at", direction: "desc" },
});
