import { bool, defineTable, enumOf, text } from "../../src/core/define.ts";

/**
 * What the assistant has learned from you — the part of it that improves.
 *
 * Every comment on a draft, every skip, every draft sent unchanged and every
 * answer is evidence about how you want things done. The assistant reads all
 * active lessons at the start of every run and writes new ones as it works
 * through the evidence (`drafts.learned` marks what has been worked through),
 * so a correction is made once rather than every hour.
 *
 * A lesson is either general ("keep replies short, no greetings") or about
 * one chat ("Ali: always BM, call him Encik Ali"). Facts about a person —
 * who they are, what is pending — belong in `people.notes`; this is about
 * *how to act*. Edit or retire any of them here: the next run reads exactly
 * what is in this table.
 */
export default defineTable({
  name: "lessons",
  description:
    "How the user wants the assistant to act, learned from their comments, skips, sends and " +
    "answers. Read before every run. chat_key empty = applies everywhere. Retired = no longer " +
    "applies; kept for history.",

  columns: {
    lesson: text({ label: "Lesson", help: "One instruction, written so it can be followed." }),
    chat_key: text({
      nullable: true,
      label: "Chat",
      help: "channel:id when it is about one chat. Empty means everywhere.",
    }),
    source: enumOf(["comment", "skip", "sent", "answer", "you"], {
      label: "Learned from",
      help: "comment: you asked for a change. skip: you skipped a draft. sent: you sent it unchanged. answer: a question. you: you said so directly.",
    }),
    evidence: text({
      nullable: true,
      label: "Evidence",
      help: "The draft or question id it came from, or your words.",
    }),
    retired: bool({ default: false, label: "Retired", help: "Set when it no longer applies." }),
  },

  order: { column: "created_at", direction: "desc" },
});
