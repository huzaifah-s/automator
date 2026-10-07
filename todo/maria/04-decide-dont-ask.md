# 04 · Decide, don't ask

**Goal:** Maria sorts new chats herself and tells him once. She asks only
what she really can't work out, and every question can be answered from the
card alone.

**Why:** In the 24 hours to 8 Oct she sent about 30 "Is X important?" cards.
Most were obvious from the chat itself: family groups, school alumni groups,
business-community broadcasts, promos. About 60% came back "ignore". Two
"Who is this hidden number?" cards showed nothing he could recognise, and he
replied: "how do I know which number you're referring to… please think
first." A human assistant would sort these quietly and mention only the
doubtful ones.

**Best after 03.** She sorts better when she knows his world.

Read the rules in [README.md](README.md) first.

## Where

| File | What's there |
|---|---|
| `src/server/mcp-assistant.ts` | `update_person` (its description currently forbids her own guess) and `ask` (dedupe, the `@lid` rule, `quote`) |
| `workflows/personal-assistant/_bot.ts`, `deliver-cards.ts` | Cards. The batched chat-priority card with numbered button rows (`aca5fbd`) is the thing to reuse |
| `workflows/personal-assistant/bot.ts` | Handling taps |
| `tables/personal-assistant/people.ts` | |
| `../maria-personal-assistant/CLAUDE.md` | Steps 3 and 5, and the asking rules |

## Build

1. **She can set a chat's priority herself.** `people` gets two columns:
   - `priority_by`: him / maria
   - `reason`: one line on why

   `update_person` accepts her choice when it comes with a reason. His answer
   always wins and is never overwritten by hers.
2. **One "I sorted these" card instead of one question per chat.** For each
   chat it shows the app, group or 1:1, her choice and her one-line reason,
   with a numbered button row to change it (always / normal / ignore).
   - Send at most one per run, merged with any still pending.
   - If he doesn't tap, her choice stands.
3. **His changes are feedback.** When he taps to change a priority she set,
   it becomes an outcome: `outcomes` shows it, and `learn` turns it into a
   lesson (e.g. "his old school's groups: ignore"). It must never be consumed
   and forgotten (AGENTS.md).
4. **A question budget, enforced by the server.**
   - At most a few new chat questions per hour. Pick the number and say why
     in the commit.
   - Past the budget, `ask` refuses: "Too many questions this hour — decide
     yourself or wait."
   - Questions about a To Do task get their own small budget.
5. **Every question has to make sense without context.** The server already
   attaches the latest messages as `quote`. Extend the existing `@lid` rule:
   refuse a question about any unknown 1:1 chat that has no quote.
6. **Automated senders** (business templates, OTPs, delivery notices,
   newsletters) get `ignore` with the reason "automated". She never asks
   about them.
7. **Playbook:**
   - **A sorting guide**, using `brain` and the thread:

     | The chat | Her choice |
     |---|---|
     | Work group he's in, or clients / teammates in the brain | always |
     | Family and friends | normal |
     | Unknown 1:1 with real words | normal, and mention it on the card |
     | Community, alumni, broadcast, promo or marketing | ignore, unless he's addressed |
     | Automated | ignore |

     When she's torn between two, she picks the quieter one and says so in
     the reason.
   - **A "think first" check before any `ask`:**
     - Could I find this in brain, people, thread, To Do (or the calendar,
       after 05)?
     - Would he know what I mean from the card alone?
     - Is it worth his tap?

## Done when

- A run with several new chats sends **one** sorted card and **zero** "is X
  important?" questions.
- A tap that changes her choice shows up in `outcomes` and becomes a lesson.
- `ask` refuses once the budget is used up.
- His earlier answers are untouched: every row he set keeps
  `priority_by = him`.
- `bun run check` and `bun run test` pass. If the bot's webhook schema
  changes, add a made-up sample under `workflows/personal-assistant/__fixtures__/`.
