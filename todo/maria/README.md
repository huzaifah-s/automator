# Making Maria smart

Seven jobs that take Maria from "asks about everything" to an assistant who
knows who you are, sees your calendar and email, decides for herself, and
answers you in seconds. They're numbered in the order to do them.

## How to run one

Open a new Claude Code chat in this folder and say:

```
Do todo/maria/02-one-person-one-chat.md
```

**Do them one at a time.** Most of them edit the same two files: the
assistant endpoint (`src/server/mcp-assistant.ts`) and Maria's playbook. Two
chats running at once would overwrite each other's work. When a job is done
and deployed, tick its box here.

## The jobs

- [x] **01 · Push her latest playbook.** 5 min. Chat (needs your OK to push).
      She's running yesterday's rules; this is the cheapest fix of all.
- [x] **02 · One person = one chat.** ~2 h. Chat.
      Merge hidden WhatsApp ids (`@lid`) with the real number, so lessons and
      history follow the person.
- [x] **03 · Give her a brain.** ~3 h. Chat, then a seeding pass.
      Who you are, your work, projects and people, and what's still open,
      read every run and kept up to date by her.
- [x] **04 · Decide, don't ask.** ~2 h. Chat.
      She sorts new chats herself and sends one "here's what I did" card.
      There's a question budget, and every question has to be answerable from
      the card alone.
- [ ] **05 · Connect Calendar, Gmail, Drive.** ~1 h. **You** on the other
      Claude account, then a chat.
      Real free times instead of "let me check my schedule", plus Gmail drafts
      and meeting prep.
- [ ] **06 · Scorecard, twice a week.** ~2 h. Chat.
      Numbers every Wednesday and Sunday that show whether she's actually
      getting better. She reads them too.
- [x] **07 · Live Maria.** About half a day. Chat.
      She answers your messages in seconds instead of minutes — Claude Code
      on your subscription (`CLAUDE_CODE_OAUTH_TOKEN`, optional `_2`).

03 makes 04 better (she sorts using the brain), and 05 needs 03 (meeting
prep needs to know your projects). The rest can go in any order after 01.

## Rules for every job

The chat doing a job follows all of these. They aren't optional.

1. **Read `AGENTS.md` and `CLAUDE.md` first.** The personal-assistant
   invariants in AGENTS.md stay as they are: she cannot send, the routine
   has no shell, feedback is never consumed and forgotten, and chat messages
   have exactly one copy.
2. **Two repos, one contract.** Server, tools, tables and bot live here, in
   automator. What Maria reads each run is the playbook,
   `../maria-personal-assistant/CLAUDE.md` (a private repo). A tool change
   here almost always needs a playbook change there.
3. **This repo is public.** No real names, phone numbers, chat ids, company
   names or message text in code, commits, fixtures or these files. Use
   made-up values (`Cikgu Contoh`, `60120000000`). When testing, print counts
   and shapes, never message text.
4. **Live data for examples:** the `assistant` MCP (`questions`, `lessons`,
   `drafts`, `people`, `thread`) and the ops MCP (`overview`, `runs`) are
   connected in this desktop app. Look, but don't copy what you see into git.
5. **Her output rules still hold:**
   - Notion is always English.
   - Everything sent to him on Telegram is phone-formatted (`rich()` in
     `workflows/personal-assistant/_bot.ts`).
   - Every card says which app (WhatsApp or Telegram) and whether it's a
     group.
   - Every message he sends her gets a visible reply.
6. **Every new kind of feedback** (a tap, a correction, an edit) is read back
   by the routine until it becomes a lesson. Use `outcomes` / `learn` or the
   same pattern.
7. **Finish:**
   1. `bun run check` and `bun run test` pass.
   2. Exercise the real path: `bun run try`, start the server, call the tool.
   3. Commit in both repos.
   4. **Ask the user**, then deploy automator with the coolify MCP `deploy`.
      The app uuid is in the project memory. Coolify does **not** deploy on
      push.
   5. Wait for the deploy to finish, *then* push the playbook. The server
      goes first because the playbook names its tools.
8. **Leave a trail:** update the project memory file
   (`personal-assistant-project.md`) and tick the box above.
