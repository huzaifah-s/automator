# 06 · Weekly scorecard

**Goal:** Every Sunday he sees, in numbers, whether Maria got better this
week. She reads the same numbers and picks one thing to fix.

**Why:** "She feels dumb" can't be fixed if nobody can tell whether a change
helped. Every number below is already in the tables. Nobody adds them up.

Read the rules in [README.md](README.md) first.

## The numbers (this week vs last, with an arrow)

| Area | Count | Headline |
|---|---|---|
| Drafts | made · sent as written · sent after a comment · skipped · withdrawn | **% sent as written** |
| Questions | asked · answered · expired · answered "ignore" (a wasted tap) | **questions per day** |
| Tasks she made | created · edited by him (her guess was wrong) · trashed · done | **% kept as made** |
| Replies to him | median time from his note to her `brief` reply | **minutes** |
| Learning | lessons added and retired; outcomes still unlearned (should be 0) | |
| Sorting (after 04) | chats she sorted · how many he changed | **% of her choices kept** |

Sources:

- `drafts`: `status`, `feedback`, `revision_of`, `sent_at`
- `questions`: `kind`, `status`, `answer`, `answered_at`, `expired_at`,
  `reply_to`
- `task_work`
- `lessons`
- `run_log`
- `people` (`priority_by`, after 04)

Check each column exists before counting it. Leave out any metric the data
can't support, and say so in the commit.

## Build

1. **A view** at `views/personal-assistant/maria-scorecard.ts`, the
   dashboard page. AGENTS.md "Verifying", step 6: check both themes and a
   phone width.
2. **The headline numbers on the Sunday 20:00 card**
   (`workflows/personal-assistant/lessons-review.ts`), phone-formatted with
   `rich()`.
3. **A `scorecard` read tool** on the assistant endpoint. The Sunday run
   reads it, picks her worst number, and writes **one** lesson aimed at it
   (`learn`, with `evidence` = the number). That's how she improves herself
   between your corrections.
4. **Playbook:** add the Sunday step.

## Done when

- The view renders with real data. Screenshot both themes and a phone width.
- `bun run try -- personal-assistant-lessons-review` shows the card with the
  numbers, without sending it.
- The `scorecard` tool returns the same numbers as the view.
- `bun run check` and `bun run test` pass.
