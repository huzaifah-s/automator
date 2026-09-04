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
| 3 | OAuth2 with refresh tokens | Open — deferred, see below |
| 4 | Wait / suspend / human-in-the-loop | Open — needs an architecture call |
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

## 3. OAuth2 with refresh tokens

**What n8n did:** a "Connect account" button ran the authorization-code flow,
stored the refresh token, and silently refreshed the access token before expiry.

**Why it matters:** every user-consent OAuth integration is blocked without it —
Notion, HubSpot, Salesforce, Shopify, Xero, Gmail-as-a-person, Drive-as-a-person.
`process.env` is immutable at runtime and a refresh token *rotates*, so there was
nowhere to put the new one. `src/integrations/sheets.ts` sidesteps this by
self-signing a service-account JWT, which only covers Google server-to-server.

**Now unblocked:** `ctx.state` is the mutable store this was missing.

**Sketch:** `src/integrations/oauth.ts` exporting something like
`createOAuth(state)` with `getAccessToken(name)`. Store
`{ accessToken, refreshToken, expiresAt }` per credential name. On read, if
`expiresAt` is within ~60s, refresh and write back. The initial refresh token
still comes from an env var — we are **not** building a browser consent flow;
the user pastes a refresh token obtained once, out of band.

**The wrinkle that will bite you:** `ctx.state.update()` takes a *synchronous*
function, deliberately — that's what makes it atomic. You cannot wrap an async
token refresh in it. Two concurrent runs hitting an expired token will both
refresh, and many providers invalidate the old refresh token on use, so the
second write can clobber a live credential with a dead one. Because we are
single-process by design, an in-process `Map<string, Promise<Token>>` keyed by
credential name is a sufficient lock — first caller refreshes, everyone else
awaits the same promise. Do not skip this.

**Also decide:** refresh tokens in `ctx.state` are stored unencrypted (see the
"State is deliberately not redacted" section in README). That was fine when
state held cursors. If it's about to hold live credentials for a dozen services,
encryption at rest — a master key from the environment, AES-256-GCM — may now be
worth it. **This is a real decision, not a detail.** Make it explicitly and
write it down.

**Verify:** point it at a real provider with a short-lived token, force expiry,
confirm one refresh happens under 20 concurrent runs and the stored refresh
token still works afterwards.

**Deferred, deliberately (2026-09-05).** The encryption question above was put
to the owner with four options — encrypt credentials only, encrypt all of
`ctx.state`, don't encrypt and document the DB as `.env`-sensitive, or skip.
The call was **skip for now**: revisit when a specific integration actually
needs user-consent OAuth, and settle the storage question then rather than
build the machinery speculatively. Nothing here is blocked; it is unstarted.

## 4. Wait / suspend / human-in-the-loop

**What n8n did:** a Wait node suspended a workflow for days, or until a webhook
resumed it. "Send and wait for approval" posted a Slack button and blocked on the
click.

**Why it matters:** approval gates, "wait 24h then follow up", anything
human-paced.

**Why it's hard here:** a run is one in-process async function with a
`timeoutMs` ceiling (5 min default). Suspending means the run has to survive the
process going away, which is a different execution model. README already points
at Temporal/Inngest for the real version — that assessment stands.

**The cheap 80% you should do first:** split into two workflows joined by a
webhook, correlated through `ctx.state.shared`.

```
approval-request  (cron/manual) → writes shared "approval:<id>" = { status: "pending", … }
                                → posts a Slack button linking to /hooks/approve?id=<id>
approval-resolve  (webhook)     → reads shared "approval:<id>", acts, marks resolved
```

This works today and needs no new machinery — `ctx.state.shared` was built
partly for it. It is not a Wait node: there is no single run you can watch, and
the two halves have separate run pages. Document that honestly if you build it.

**Do not** try to make `run()` suspend by holding the process. It breaks
shutdown, overlap control, and the timeout contract at once.

**Decide first:** is a durable execution engine on the table at all? If yes, this
item is "adopt Inngest/Temporal", not "extend the runner" — and note that items
7 (`MAX_CONCURRENT_RUNS`) and 8 (`ctx.run()`) are now *built*, so adopting an
engine means replacing working code, not designing around a gap. That raises
the cost of saying yes, which is worth knowing before saying it. Still the
user's call, not ours.

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

1. **4 (wait/suspend)**, and only after deciding whether a durable execution
   engine is on the table — that answer changes several items above.
2. **3 (OAuth)** whenever an integration actually needs it, settling the
   storage question then.
3. **10 (AI agent loop)** when something concrete wants it.

Delete this file when the table at the top has no "Open" rows left.
