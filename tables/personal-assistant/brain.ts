import { bool, defineTable, enumOf, text } from "../../src/core/define.ts";

/**
 * What is true about you and your world — the assistant's long memory.
 *
 * Each run starts with nothing but two weeks of chats, `people` and
 * `lessons`, and lessons say how to act, not what is true. Without this the
 * assistant asked who your account manager was on day two, and again the
 * next week. One row is one fact, readable in a line: your roles and
 * companies, the projects, who people are to you, and how you like things.
 *
 * The assistant reads every active fact at the start of a run (`brain`) and
 * adds what you tell it (`remember`). A fact that changes is replaced, not
 * appended to: the old row is retired with `retired_why` saying by what, so
 * the table stays a page long (about 3k tokens) and never becomes a diary.
 * Facts, never quotes — the chat log is the only copy of messages.
 *
 * Kept apart from its neighbours on purpose: `lessons` is how to act,
 * `loops` is what is still in flight, `people.notes` is who one chat is.
 * Edit or retire any row here; the next run reads exactly what is in it.
 */
export default defineTable({
  name: "brain",
  description:
    "Facts about the user and his world — roles, companies, projects, who people are to him, " +
    "preferences. One line each. Read by the assistant every run. Retired = no longer true; " +
    "kept for history.",

  columns: {
    topic: enumOf(["me", "work", "project", "person", "preference"], {
      label: "Topic",
      help: "me: who he is. work: his roles and companies. project: what he is working on. person: who someone is to him. preference: how he likes things.",
    }),
    subject: text({
      nullable: true,
      label: "About",
      help: "The company, project or person the fact is about. Empty for a fact about him.",
    }),
    fact: text({ label: "Fact", help: "One line, in English. Replace it when it changes — don't append." }),
    source: enumOf(["you", "answer", "chat", "task"], {
      label: "Learned from",
      help: "you: he said so in a note. answer: his answer to a question. chat: a chat made it plain. task: his To Do list.",
    }),
    evidence: text({
      nullable: true,
      label: "Evidence",
      help: "The question or note id, chat key or task id it came from.",
    }),
    retired: bool({ default: false, label: "Retired", help: "Set when it is no longer true." }),
    retired_why: text({
      nullable: true,
      label: "Why retired",
      help: "What replaced it, or why it stopped being true.",
    }),
  },

  order: { column: "created_at", direction: "desc" },
});
