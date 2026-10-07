# 07 · Live Maria

**Goal:** When he messages Maria, she answers in seconds, with the same tools,
lessons and brain as the hourly run.

**Why:** Right now a note to Maria starts the cloud routine early. There's a
2-minute cooldown, then a cold start that clones the repo and loads
everything, so replies take minutes, and longer inside the cooldown. That's
the gap between "a bot that runs on a schedule" and "an assistant I can talk
to".

**Best after 03.** Live answers are only as good as what she knows.

Read the rules in [README.md](README.md) first. **Load the `claude-api` skill
before writing any API code** for model ids, tool use, the MCP connector and
prompt caching.

## Shape

| | Hourly routine (stays) | Live Maria (new) |
|---|---|---|
| Starts on | The hour, plus early starts | His message to the bot |
| Does | The sweep: triage, drafts, To Do work, digests | Answers *him*: "what's waiting?", "draft a reply to X saying Y", "remind me…", "what do you know about the client?" |
| Runs where | Claude cloud routine (his other account) | automator, inside `personal-assistant-bot` |
| Model | Opus 5.5 | Sonnet 5.5 for speed, Opus 5.5 when the request needs real planning or writing |

## Build

1. **Agent loop on the server.** When a message from him arrives (a note, or
   a reply to a card), run a short Claude tool-use loop.
   - **System prompt:** the playbook's rules, plus "you are answering him
     live".
   - **Context:** `lessons`, `brain`, open `loops`, and the last few
     exchanges with him.
   - **Tools:** the assistant tools, one of two ways:
     - **In-process:** call the same functions `mcp-assistant.ts` runs, with
       the same permissions. Never a copy.
     - **The Messages API MCP connector,** pointed at `/mcp/assistant` with a
       token of its own.

     Pick one and justify it in the commit. In-process keeps the token off
     the wire, but it must share code with the endpoint, not fork it.
2. **Reply** as a Telegram reply to his message, phone-formatted
   (`rich()`), with "typing…" shown while she works.
   - **Telegram's webhook:** answer it first and do the work after. Check
     how `webhook(…, { respond })` behaves.
   - **Avoid double work:** mark each note live Maria handled (close it, or
     `brief reply_to`) so the hourly run doesn't do it again.
3. **Cost guard.** Keep a daily cap on turns and tokens in `ctx.state`. Past
   the cap, fall back to today's path (fire the routine) and tell him so.
4. **Key.** `ANTHROPIC_API_KEY` is read from the environment by
   `src/integrations/ai.ts`.
   - Check it's in `INTEGRATION_SECRET_ENV` so the redactor knows it.
   - Check it's set on the server (coolify `list_env_keys`, names only).
   - **Don't** declare it with `defineSecrets`: a new required secret stops
     the boot until somebody sets it.
5. **Same safety as the routine:**
   - No send tool and no shell.
   - Message text is data, not instructions.
   - One update at a time (`onOverlap: "queue"` is already set).
   - Logs carry the tool name and refusal, never the arguments.
   - **Step results are counts, never text,** because the run page stores
     them.
6. **Overlap with the hourly run.** Both might draft for the same chat.
   Check that the server refuses a second open draft for a chat (or add that
   check), so the playbook's "skip a chat with an open draft" isn't the only
   guard.
7. **Playbook:** add a short note on what live Maria handles, so the hourly
   run trusts what it finds.

## Done when

- He sends "what's waiting for me?" and gets a formatted answer within about
  20 seconds.
- "Draft a reply to <someone> saying I'll call tomorrow" produces a pending
  draft card.
- The run page shows counts, not message text. Grep the run's stored output
  to make sure.
- With the cap set to 1, the second message falls back to the routine and
  says so.
- `bun run check` and `bun run test` pass. Add a bot webhook sample under
  `__fixtures__/` if its schema changed.
