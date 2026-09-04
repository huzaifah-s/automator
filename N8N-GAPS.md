# What we still don't have that n8n did

> **This is a working file. Delete it when every open item below is either done
> or explicitly rejected.** It exists to hand off the n8n migration, not to
> become permanent documentation. Anything worth keeping belongs in
> [README.md](README.md) (how to use it), [AGENTS.md](AGENTS.md) (invariants),
> or [CHANGELOG.md](CHANGELOG.md) (why we chose it). Nothing links here on
> purpose, so removing it leaves no dangling references.

Context: we replaced a self-hosted n8n with this runner. Most of n8n's weight is
the visual editor and 400+ node packages, which we don't need. This file is the
honest list of what we gave up that *wasn't* the editor — what's been closed,
what's left, and enough detail to pick any of it up cold.

## Status

| # | Gap | Status |
|---|---|---|
| 1 | No durable state between runs | **Done** — `ctx.state` |
| 2 | No polling trigger | **Done** — `poll()` |
| 3 | OAuth2 with refresh tokens | **Done** — `defineOAuth()` |
| 4 | Wait / suspend / human-in-the-loop | **Done** — two workflows + `ctx.state.shared` |
| 5 | Provider webhook registration | **Done** — `register` on `webhook()` |
| 6 | Pagination helpers | **Done** — `ctx.http.paginate()` |
| 7 | Global concurrency cap | **Done** — `MAX_CONCURRENT_RUNS` |
| 8 | Sub-workflow invocation | **Done** — `ctx.run()` |
| 9 | Replay a run with its original input | **Done** — `/runs/:id/replay` |
| 10 | AI tool-loop / agent | Open — medium |
| 11 | Users, RBAC, audit | Open — probably won't do |
| 12 | Template library | Won't do |

## Before you start

Read [AGENTS.md](AGENTS.md) first — it has the layout, the invariants that have
already caused bugs, and how to verify. Two conventions we're holding to:

- `bun run check` must pass, and **verify by actually running the thing**. There
  is no test suite. Every entry below has a "how to verify" line.
- Separate commits per logical change, messages that explain *why* (the problem,
  the rejected alternative, what you verified), and a [CHANGELOG.md](CHANGELOG.md)
  entry for anything that settles a question.

The constraints in AGENTS.md under "Settled architecture — do not drift" bound
most of what follows. Raise a trade-off before breaking one.

---

## 4. Wait / suspend / human-in-the-loop — done, within limits

**What n8n did:** a Wait node suspended a workflow for days, or until a webhook
resumed it. "Send and wait for approval" posted a Slack button and blocked on
the click.

**What we built instead:** the two-workflow pattern this section used to
prescribe. `workflows/approval-request.ts` opens an approval in
`ctx.state.shared` and hands out decision links;
`workflows/approval-resolve.ts` is a GET webhook that claims it when someone
clicks. README "Approval gates" has the pattern, the correctness details worth
copying, and an honest paragraph on what it is not.

**The runner did not learn to suspend, and will not.** Holding a run open
across a human-paced wait breaks graceful shutdown, the concurrency cap, and
the `timeoutMs` contract at once. That was the standing advice here and it
still is.

**The durable-engine question is settled as "no", for now.** Adopting
Temporal or Inngest would mean replacing `MAX_CONCURRENT_RUNS`, `ctx.run()`,
and checkpoint resume — all working code — rather than filling a hole. Reopen
it only with a concrete need that the two-workflow pattern genuinely cannot
serve, and price it as a replacement, not an addition.

**What you still don't get**, in case someone asks for it later:

- No single run spans the wait. Two run pages, joined only by the
  `openedByRun` id in the resolving run's result.
- No "waited 2h 14m" anywhere on a timeline, because nothing was waiting.
- No timer-based resume. A pending approval expires by TTL and answers
  `unknown or expired`; nothing fires when it does. "Wait 24h then follow up"
  is a cron workflow that reads the shared namespace, not a feature of this.

One thing it needed from the core: `webhook(..., { secret: false })`, for a
route a person reaches by clicking a link and so cannot carry `WEBHOOK_SECRET`
into. See CHANGELOG for why that is an explicit flag rather than a convention.

## 10. AI tool-loop / agent

**What n8n did:** LangChain nodes — tool-calling agents, chat memory, vector
stores.

**Where we are:** `ctx.ai.claude(prompt)` is one-shot, returns text. The raw SDK
clients are exposed via `ctx.ai.clients`, so an agent loop is buildable today,
just not built.

**Sketch:** `ctx.ai.agent({ tools, prompt, maxTurns })` over the Anthropic SDK's
tool-runner. Keep tools as plain TS functions — that's the whole point of this
project over n8n. Cap turns, pass `ctx.signal`, and log each turn through
`ctx.step` so the run page shows the trajectory.

**Skip** vector stores unless something concrete needs one. Postgres +
`pgvector` through `ctx.sql` is the answer if it comes up; don't add a dependency
speculatively.

## 11. Users, RBAC, audit

n8n had users, projects, sharing, and per-execution ownership. We have one
`DASHBOARD_USER` / `DASHBOARD_PASS`. There's no attribution for who triggered
what, and non-engineers can't author anything at all.

That last part is an org cost, not a technical one, and it was the deliberate
trade for "workflows live in the repo." Flagged for visibility. **Probably don't
build this** — if multiple non-engineers need to author automations, that's an
argument for a different tool, not for growing this one.

## 12. Template library — won't do

Thousands of community workflows to crib from. Gone, and not replaceable. Noted
so nobody goes looking.

---

## Already matched — don't rebuild these

Worth stating so nobody re-solves a solved problem:

- Retries with exponential backoff + jitter, per-attempt timeouts
- Run history with step inputs/outputs and full HTTP request/response capture
- Failure alerts (`ALERT_WEBHOOK_URL`), nightly history pruning
- Webhook auth (constant-time, per-workflow override), graceful shutdown
- Boot-time secret validation — n8n failed at 3am, we fail on deploy
- Email attachments (`ctx.email.send`), binary fetches (`http` `as: "buffer"`)
- **Checkpoint resume**, which n8n has no equivalent of — it re-runs from the start

And what the move bought: git review/revert/blame on automation logic, type
checking, a 188MB image instead of 1.9GB, no code sandbox to secure, and a
redaction guarantee at every storage boundary.

## Suggested order

1. **10 (AI agent loop)** when something concrete wants it. It is the only
   open row with any work in it; 11 is a flag, not a task.

Item 3 settled the credential-encryption question on the way past: `@oauth:`
keys are encrypted, the rest of `ctx.state` is not. Anything else that wants to
store a credential inherits that answer rather than reopening it.

Delete this file when the table at the top has no "Open" rows left.
