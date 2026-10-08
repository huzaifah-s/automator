import { defineTable, enumOf, int, text } from "../../src/core/define.ts";

/**
 * Every draft the second reader looked at before it reached you.
 *
 * `draft_reply` has a fresh Claude — one that did not write the draft —
 * check it against your own messages to that person, the lessons and what
 * you said about earlier drafts (src/server/assistant-check.ts). A draft it
 * fails is sent back to the assistant once with what to fix, and never
 * reaches you; the rewrite is checked again and then saved either way, so
 * a check can never stop a draft. Each attempt is a row here, so how often
 * the first try fails — and what for — can be counted, and a replayed
 * first try can be compared with the one that went out.
 */
export default defineTable({
  name: "draft_checks",
  description:
    "The second reader's verdict on each draft before you saw it: pass, fail (sent back once with " +
    "the issues) or skipped (no model to ask). draft is the draft that was saved, if any.",

  columns: {
    chat_key: text({ label: "Chat", help: "channel:id, as in people." }),
    chat_name: text({ label: "To" }),
    text: text({ label: "Checked text", help: "The draft as the assistant wrote it." }),
    attempt: int({ label: "Attempt", help: "1 for a first try, 2 for the rewrite after a failed check." }),
    verdict: enumOf(["pass", "fail", "skipped"], { label: "Verdict" }),
    issues: text({ nullable: true, label: "Issues", help: "What the check said to fix, one per line." }),
    skipped: text({ nullable: true, label: "Skipped because", help: "Why the model did not check it, when it did not." }),
    draft_id: text({ nullable: true, label: "Saved as", help: "The drafts row this became. Empty: sent back." }),
    ms: int({ label: "Took (ms)" }),
  },

  order: { column: "created_at", direction: "desc" },
});
