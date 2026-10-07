# 03 · Give her a brain

**Goal:** Maria starts every run knowing who he is, what he's working on,
who matters and why, and what's still open, and she keeps all of that up to
date herself.

**Why:** Each run starts with nothing but 14 days of chats, `people` notes
and `lessons`. Lessons say *how to act*, not *what's true*. So on 7 Oct she
had to ask who his account manager was, who a client's product owner was,
and who his business partner was. He had told her some of these before, and
a human assistant would know all of them by day two. She also loses track of
things in flight once they scroll out of the chat window, like "waiting for
the partner's client to send their free times".

Read the rules in [README.md](README.md) first.

## Three kinds of memory, kept apart

| Where | Holds | Example (made up) |
|---|---|---|
| `lessons` (exists) | How to act | "In the client's product group, only reply when he's addressed." |
| `brain` (new) | What's true about him and his world | "He's the product manager on the Acme project; Ben is the developer." |
| `loops` (new) | What's in flight | "Partner to send his client's free times for the call (waiting on them, since Tue)." |

`people.notes` stays, but holds only who that chat is, in one line. What's
pending with them moves to `loops`.

## Build

1. **`tables/personal-assistant/brain.ts`**, one row per fact, readable in
   one line:
   - `topic`: enum me / work / project / person / preference
   - `subject`: a company, project or person
   - `fact`
   - `source`: enum you / answer / chat / task
   - `evidence`: question id, chat key or task id
   - `retired`: bool

   Keep the whole brain under ~3k tokens. When it grows, merge rows and
   retire the old ones.
2. **`tables/personal-assistant/loops.ts`**:
   - `what`
   - `waiting_on`: enum him / them
   - `chat_key` (nullable)
   - `task_id` (nullable)
   - `due` (nullable)
   - `status`: enum open / done / dropped
   - `note`
3. **Tools in `src/server/mcp-assistant.ts`**, using the same scope pattern
   (`read` / `write`) and the same log rule as the other tools (tool name and
   refusal, never the arguments):
   - `brain`: every active fact, grouped by topic.
   - `remember`: add a fact. Pass `replaces` to retire the one it updates.
   - `forget`: retire a fact, with a reason.
   - `loops`: open loops, oldest first, overdue ones marked.
   - `open_loop` and `close_loop`.
4. **A bot command, `/brain`:** shows him what Maria knows, grouped by topic
   and phone-formatted (`rich()`). If he replies "that's wrong", it arrives
   as a note and Maria fixes it with `remember` / `forget`. When the
   correction is about *how* she got something wrong, it also becomes a
   lesson (`learn` with `evidence`).
5. **Playbook** (`../maria-personal-assistant/CLAUDE.md`):
   - Step 1: read `lessons`, `brain` and `loops`.
   - Step 3: any lasting fact he tells her goes into `remember`. **Never ask
     something the brain already answers.**
   - Step 5: when a chat opens or settles something in flight, use
     `open_loop` / `close_loop`.
     - Waiting on *them* for more than 2 days: offer a nudge draft.
     - Waiting on *him* and due: put it in the digest.
   - Digest: a new "Open loops" section.
   - New rule: before any `ask`, check `brain`, `people`, `thread` and the
     To Do list. If the answer is there, don't ask.
6. **Seed it.** Do this from this desktop chat through the `assistant` MCP,
   after the tools are deployed:
   1. Read `questions status=all`, `people` and `lessons`.
   2. Write every fact he has already given her: his roles and companies,
      people and how they relate to him, projects.
   3. Show him the result with `/brain` and let him correct it.

   This is personal data. It goes into SQLite through the MCP and **never
   into a file in git**.

## Done when

- `brain` returns his roles, companies and key people. He has looked at
  `/brain` and corrected it.
- A run answers a "who is X?" from the brain instead of asking him.
- A loop opened in one run is closed in a later run, and an overdue loop
  shows up in the digest.
- `bun run check` and `bun run test` pass. Run both tools against a local
  server.

## Don't

- Quote messages in `brain` or `loops`. They hold facts, not quotes; the chat
  log is the only copy of messages and it forgets them after 14 days.
- Let it turn into a diary. One line per fact: replace, don't append.
