# 02 · One person = one chat

**Goal:** Someone WhatsApp shows under both a phone number and a hidden
privacy id (`…@lid`) is **one** row in `people`. They get one thread, one set
of notes and lessons, and one card.

**Why:** WhatsApp now hides some numbers behind `@lid` privacy ids. Evolution
keys some chats by the number (`…@s.whatsapp.net`) and some by the `@lid`,
so the same person can turn into two chats. On 7 Oct a business partner was
two `people` rows, and three things went wrong:

- A lesson taught on one row ("don't propose a time, ask what suits them")
  never applied to the other.
- He got two cards about the same call.
- Maria wrote the holding reply he had already corrected.

The "Who is *Hidden number (WhatsApp)*?" cards he couldn't answer come from
the same gap.

Read the rules in [README.md](README.md) first.

## Where

| File | What's there |
|---|---|
| `workflows/personal-assistant/sync-chats.ts` | Keys and names WhatsApp chats; `placeholder()` and the name repairs |
| `src/integrations/evolution.ts` | `toMessage`: `remoteJidAlt` / `participantAlt`, the other half of a `@lid` pair, are already parsed (see its comment) |
| `src/core/chat-log.ts` | Where messages are stored, keyed by chat |
| `tables/personal-assistant/people.ts` | `chat_key` is the dedupe key |
| `src/server/mcp-assistant.ts` | `chatArg`, `peopleByKey`, `thread`, `waiting`, `lessons`, `ask`, `draft_reply`, `update_person` |
| `workflows/personal-assistant/bot.ts`, `_bot.ts` | Sending a draft; the "Open chat" button |
| `../maria-personal-assistant/CLAUDE.md` | The rules about hidden numbers |

## Find out first (don't assume)

- **Where Evolution knows the pair.** It might be `key.remoteJidAlt` on
  messages (Evolution swaps the two when it can), its contacts or chats
  tables, or Baileys' lid mapping. Count how many `@lid` rows in `people` can
  be paired from data Evolution already has. Print counts only.
- **Which JID a reply has to go to** (`@lid` or the number) so it lands in
  the chat he sees on his phone.
- **Group authors.** In groups, `participant` can be a `@lid` with the number
  in `participantAlt`. `toMessage` already prefers the number; check that the
  chat log uses it everywhere.

## Build

1. **Link the two keys.** Pick one canonical key per person: the
   phone-number JID when it's known. Remember the `@lid` as an alias, either
   as a column on `people` (e.g. `same_as`) or as a small table. It's your
   call; say why in the commit. Learn pairs automatically in the sync from
   data Evolution gives. **Never guess from names.**
2. **Merge the existing duplicates once.** Make it idempotent and print
   counts.
   - **priority:** keep the stronger one (always > normal > ignore > empty).
   - **notes:** combine them, kept short.
   - **name:** a real name wins over "Hidden number".
   - **Repoint to the canonical key:** `lessons.chat_key`, open `questions`,
     open `drafts`, and chat links in `task_work`.
3. **Read and write through the canonical key.**
   - `thread` and `waiting` show both halves as one conversation, in time
     order.
   - `lessons(chat)` returns lessons for either key.
   - `ask` dedupe treats the two keys as one chat.
   - `draft_reply` accepts either key and stores the canonical one.
4. **Let Maria link them by hand when Evolution can't.** When he answers
   "that hidden number is X", she needs a way to record it, e.g.
   `update_person` takes `same_as: <chat>`. Only allow a chat that's already
   in `people`, the same rule drafts follow, so a number inside a message
   can't become a target. Merge the same way as in step 2.
5. **Sending** goes to whichever JID delivers, from what you found above.
6. **Playbook:** explain the link to Maria. She shouldn't ask who a hidden
   number is when the pair is already known, and she should use `same_as`
   when he tells her.

## Done when

- Where Evolution has the pair, there are no duplicate `people` rows. Show
  the counts before and after.
- `thread` on either key shows the same conversation, and a lesson on one key
  shows up on the other.
- A draft made on a `@lid` chat lands in the right WhatsApp chat. Sending is
  real: test only with a chat the user names, and only with their OK.
- `bun run check` and `bun run test` pass. The sync polls rather than taking
  a webhook, so it probably needs no new fixtures. Add some if any webhook
  schema changed.

## Don't

- Match people by name. Two different people can share a name, and a wrong
  merge sends a reply to the wrong person.
- Print message text, names or numbers while testing. Counts only.
