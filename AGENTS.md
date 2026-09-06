# AGENTS.md

Instructions for AI agents working in this repository. Human-facing docs are in
[README.md](README.md).

## What this is

A code-first automation runner — the lightweight replacement for a self-hosted
n8n. Workflows are TypeScript files in `workflows/`, discovered and validated at
boot. Runtime is **Bun**; the HTTP layer is **Hono**; all state is one SQLite
file. There is no build step and no bundler.

## Commands

```bash
bun install
bun run dev                      # watch mode
bun run check                    # tsc --noEmit — MUST pass before you finish
bun run list                     # every workflow and its trigger
bun run trigger -- <name>        # run one workflow, non-zero exit on failure
docker compose up -d --build
```

There is no test suite. Verify by running the thing (see **Verifying** below).

## Layout

```
src/core/          define · loader · runner · scheduler · poll · db · secrets
                   secret-store · credentials · providers · crypto · redact
                   capture · state · pause · logger · alerts · types
src/cli/           secrets — the write side of the store, run before the loader
src/integrations/  index (barrel + lazy ctx clients) · http · messaging
                   ai · email · sql · sheets · scrape · oauth
src/server/        app (webhooks + REST + dashboard routes) · views (HTML)
workflows/         user workflows — the only directory most changes touch
                   subdirectories just group them: workflows/pblsh/thing.ts
                   loads the same way, and names stay global and flat
```

`src/core/define.ts` is the **public API surface** that workflow files import
from. Nothing in `workflows/` should reach deeper than that.

## The most common task: adding a workflow

Create one file in `workflows/`. Default-export `defineWorkflow`. Nothing else
needs editing — the loader finds it, subdirectories included. A file one level
down imports `../../src/core/define.ts`; that is the only thing a folder
changes.

A file whose basename starts with `_` is skipped by the loader — the one way to
put shared code inside `workflows/`, for a folder of related workflows that
needs it. Everything else there must default-export a workflow, and not doing
so is an error rather than a quiet skip, because that is what catches a typo'd
export. Keep `_` files to what one folder owns; the moment two folders want the
same helper it is an integration.

One wart to know about: a workflow's "updated" time is a hash of *its own*
source, so editing a `_` file it imports does not move any workflow's
`updated_at` on the dashboard. The code is live after the deploy either way;
only the timestamp is misleading.

```ts
import { z } from "zod";
import { cron, defineSecrets, defineWorkflow } from "../src/core/define.ts";

const secrets = defineSecrets({
  SOME_API_KEY: z.string().min(20),
});

export default defineWorkflow({
  name: "my-workflow",                   // lowercase, digits, dashes ONLY
  description: "One line, shown on the dashboard",
  trigger: cron("0 9 * * *", { tz: "Asia/Kuala_Lumpur" }),
  retries: 2,
  timeoutMs: 120_000,

  async run(ctx) {
    const data = await ctx.step(
      "fetch data",
      () => ctx.http.get("https://api.example.com/thing", {
        headers: { authorization: `Bearer ${secrets.SOME_API_KEY}` },
      }),
      { input: { endpoint: "thing" } },   // recorded for the run page
    );

    await ctx.step("notify", () => ctx.slack.send("#ops", `Got ${data.length}`));
    return { count: data.length };        // shown on the run page
  },
});
```

Every workflow is connected to the alert channel unless it says otherwise:
`alerts: false` opts out, `alerts: { channel: "telegram:pblsh" }` routes its
problems somewhere else. See README "Alerts".

Triggers: `cron(expr, { tz })`, `webhook(path, { method, schema, filter, respond, secret, verify })`,
`poll(expr, { fetch, id })`, `manual()`. On `ctx`: `http` `slack` `telegram` `discord` `ai` `email` `sql`
`sheets` `scrape`, plus `log` `step` `run` `state` `signal` `input` `attempt` `runId`.
Multi-page GETs go through `ctx.http.paginate(url)` rather than a hand-rolled
loop — see README "Pagination".

## Rules that will bite you

**Never spread the integrations object.** `{ ...buildIntegrations(signal) }`
invokes every lazy getter and eagerly constructs clients — a Postgres pool for a
workflow that only makes an HTTP call. Copy property *descriptors* instead; see
`buildCtx` in `src/core/runner.ts`. This has already caused one bug.

**Re-export new public helpers from `src/core/define.ts`.** Adding a function to
`src/core/secrets.ts` is not enough — workflow files import only from
`define.ts`, and a missing re-export fails at boot. This has already caused one
bug.

**Redact at every storage boundary.** Anything written to SQLite that could
contain data — run results, error messages, step names, step inputs/outputs,
recorded HTTP URLs and bodies — goes through `redact()` or `capture()` first.
The invariant is: *no raw credential ever reaches disk or stdout.* If you add a
new column that holds workflow-controlled data, redact it.

**A credential read back from storage is unknown to the redactor.**
`registerSecret` builds a per-process set, from `defineSecrets` at import and
from live values as they are obtained. An OAuth token is registered when it is
exchanged **and again every time it is decrypted out of state**, because the
process reading it may never have done an exchange. Dropping that second
registration puts a live token on the run page after every restart — this is
not hypothetical, it was caught by running it, not by reading it.

**New integration env vars go in `INTEGRATION_SECRET_ENV`**
(`src/integrations/index.ts`). Integrations read their own credentials from the
environment, so the redactor only learns about them from that list.

**A poll's `fetch` runs outside a run.** There is no runId, so its HTTP calls
are not captured and `PollCtx` has no `ctx.step`. Keep `fetch` to "return the
current list" and put the actual work in `run()`, where it is observable,
retried, and checkpointed.

**Poll items are marked seen only after the run succeeds.** Do not "optimise"
this into marking them up front — a failed run would then silently drop its
items. The seen-set lives in the workflow's own state namespace under the
reserved `@poll:` prefix.

**"Is this workflow on" has two answers, and `wf.enabled` is only one of
them.** The file's `enabled: false` is the code's answer; a row in
`workflow_pauses` is an operator's, put there by the dashboard's pause button.
Ask `isEnabled(wf)` from `src/core/pause.ts` — never `wf.enabled !== false` —
anywhere you are deciding whether something may fire. Both are already wired
into `Registry.enabled()`, the scheduler, the webhook routes, inbox recovery,
webhook reconciliation and `ctx.run()`; a new trigger path that checks only the
field would run a workflow somebody switched off, which is the one failure this
feature exists to prevent.

**A pause can only subtract.** There is no route, and must not be one, that
turns on a workflow whose file says `enabled: false` — `pause()` refuses it,
and the dashboard offers no button. The asymmetry is the whole reason this is
allowed to exist next to "the dashboard is read-only about workflows": a switch
that could resurrect code that says it should not run makes the repo a lie
about what is running, which is the drift n8n was left to avoid. Resuming
removes the pause and lets the file answer again; it does not override it.

**A manual run is deliberately not blocked by either of them.** The runner's
guard exempts `trigger: "manual"`, which is what the dashboard's Run now and
`bun run trigger` use. Off means "stops firing by itself", not "cannot be
tested" — the same latitude `enabled: false` already had before pausing
existed. Do not "close the hole": switching a workflow off and then being
unable to check whether your fix worked is how a pause becomes something people
avoid using.

**The scheduler is updated when a pause changes, not consulted on every tick.**
`scheduleWorkflow` / `unscheduleWorkflow` take the croner job up and down, so a
paused workflow has no timer and `nextRunFor` returns null — the dashboard's
"next run" is then the truth rather than a time it will not honour. The guard
in `runWorkflow` is a backstop for the gap (a tick already in flight when the
button was clicked), not the mechanism; leaving the job running and dropping
the run at the last moment would print a next run every fifteen seconds that
never happens.

**A webhook `filter` is a shortcut, never the enforcement.** Returning a reason
instead of `true` answers 200 and starts no run — but a manual run, a replay
and inbox recovery all bypass it, so `run()` must still handle everything the
filter would have turned away. Write filters to fail towards running: one that
throws runs the workflow anyway, because a needless run costs a row and a
wrongly-dropped delivery costs the work *and* leaves a counter claiming it was
deliberate. Reasons are constants, not strings built from the payload — they
are a primary key column, capped at 80 characters and bounded at 20 per
workflow, so an interpolated id silently evicts the real reasons.

**`ctx.state` is the one thing not redacted on the way to disk, and it must
stay invisible.** Every other write to SQLite is observational, so scrubbing it
is free. State is operational — a workflow stores a rotating OAuth token and
needs the same bytes back — so redacting on write would destroy the value. What
keeps the invariant true is that nothing renders state: no dashboard view, no
API route, no log line. Do not add one. If you need to inspect it, open the
database file.

**OAuth credentials are the one encrypted thing in the database.**
`@oauth:` keys in the shared namespace hold AES-256-GCM values under
`OAUTH_ENCRYPTION_KEY`; every other state value is stored as given, so
`sqlite3` stays useful for debugging a cursor. Don't extend encryption to the
rest of state without deciding that trade again, and don't add a code path that
writes a token anywhere else. A decrypt failure must stay recoverable: it falls
back to the seed in the environment rather than throwing.

**A `flow: "self"` OAuth refresh stores the token it got *back*, not the one it
sent.** Meta's long-lived Threads and Instagram tokens have no separate refresh
token — the reply *is* the next one. The RFC 6749 path keeps the token it sent
when a provider omits `refresh_token`, which is correct there and wrong here:
it pins the chain to a token still counting down on the original clock, and the
whole point of refreshing is that it isn't. The ternary in `exchange()` is that
distinction; it is not redundant.

**Those tokens are not kept alive by being used.** Sixty days is never within
the refresh skew, so `accessToken()` never renews one on the way past, and a
token that goes its whole life unrefreshed dies with no recovery. A scheduled
`refresh()` is the only thing standing between the deployment and a manual
re-auth — see `workflows/the-mantra/threads-token-auto-refresh.ts`. Don't
delete such a workflow as "it never does anything".

**State keys are namespaced per workflow**, with `ctx.state.shared` as the
cross-workflow namespace (`@shared` internally — workflow names can't contain
`@`, so it can't collide). Values must be JSON-serialisable and under
`STATE_MAX_BYTES`; `set` throws rather than storing a mangled value. Use
`ctx.state.update(key, fn)` for read-modify-write — it completes in one
synchronous tick, so concurrent runs can't lose an increment the way
get-then-set does.

**`ctx.http.paginate` throws rather than returning a short answer.** Hitting
`maxPages`, revisiting a URL, or finding a cursor token with no `param` name
are all misconfigurations, and a partial result that looks complete is the
worst outcome available. Empty page, no next link, and `maxItems` end quietly;
nothing else does. Keep it that way if you extend it.

**A run holds a global concurrency slot for its whole lifetime.**
`MAX_CONCURRENT_RUNS` bounds `execute()` across every workflow; `onOverlap`
only ever bounded one workflow against itself. Two consequences: a workflow is
marked `active` *before* it waits for a slot, so `onOverlap: "skip"` still sees
a queued run as in flight — don't "tidy" that into the post-wait path — and
anything that makes one run wait on another run (sub-workflow invocation, for
one) must not acquire a second slot while holding the first, or a full pool
deadlocks.

**Webhook registration reconciles at boot and never unregisters on shutdown.**
`src/core/webhooks.ts` compares each `register` block against the id in state
and does the minimum — an unchanged URL means no provider call at all, which is
what stops a redeploy creating a duplicate. Deleting on shutdown looks tidier
and is wrong: every deploy would drop and recreate the subscription, and
`SIGKILL` skips the cleanup regardless. Nothing in there may throw out to boot.

**Registration waits for `PUBLIC_URL` to answer, then gives up rather than
blocking.** Before the first subscription is created, `reconcileWebhooks` polls
our own `/healthz` over `PUBLIC_URL` for up to two minutes. This is a race and
not a misconfiguration: a reverse proxy does not route to a container until its
healthcheck passes, so a deploy's first ten-odd seconds answer 503 while the
process is healthy — and a provider asked to create a subscription in that
window calls the URL, gets the 503, and refuses. Monday reports that as
`Internal Server Error [DOWNSTREAM_SERVICE_ERROR]`, which names nothing, and
every registration fails identically on a deployment whose URL was correct the
whole time. Waiting is free because reconciliation is not awaited by boot.

Past the deadline it warns and registers anyway. Do not "improve" that into a
precondition: a host that cannot reach its own public name — no NAT hairpin,
split-horizon DNS — is still perfectly reachable from outside, so the probe is
evidence and never a verdict, and refusing on it would turn a diagnostic into
an outage. Runs at most once per boot, and only when something is actually
about to be registered.

**`ctx.run()` never takes a second concurrency slot.** A nested run inherits
its caller's, because the caller is blocked awaiting it and a slot per level
deadlocks a full pool. Cycles are refused up front from the ancestry chain
carried in `RunOptions.parent`; note that this catches loops *within* one
chain, not two separate chains that call into each other under
`onOverlap: "queue"` — that one can still deadlock, and is the reason the depth
limit exists as a backstop.

**Every `ctx.run()` refusal writes a run for the child.** The checks that
happen before `runWorkflow` — unknown name, disabled, cycle, depth, shutting
down — used to throw with nothing recorded, which is invisible when the caller
catches the error, and both callers in this repo do. `recordRefusal` in
`runner.ts` writes a failed (or skipped) run under the requested name, parented
to the caller. Don't "tidy" it into an alert: the caller's catch block is the
decision about whether anyone should be woken, and a refusal that matters gets
there through the run that fails because of it.

**Resume and replay are different operations — keep them apart.** Resume reuses
the parent's `checkpoint_key` so completed steps are skipped; replay reuses the
parent's recorded `input` against a *fresh* checkpoint key so everything runs
again. They have separate lineage columns (`resumed_from`, `replayed_from`) for
that reason. Folding them into one column would make the run page guess which
it is looking at.

**A resumed run has no `ctx.input`.** Resume passes the checkpoint key and
nothing else, so `ctx.input` is `{}` the second time through — only replay
carries the payload. Anything derived from the input must therefore be derived
*inside* a step, where a resume gets the recorded answer back instead of
re-deriving it from an empty object. The approval-resolve workflow that found
this read its approval id at the top of `run()`, so a resumed approval looked
up `approval:undefined` and reported itself missing. Read it in the first step
instead. This has already caused one bug.

**Step names must be stable and unique within a run.** They are the checkpoint
key. `ctx.step("send email")` inside a loop collides across iterations — use
`` ctx.step(`send email ${user.id}`) ``.

**Step results must be JSON-serialisable and under 256KB** to be checkpointable.
Larger or unserialisable results still display but re-run on resume.

**`verify` gets the raw body, and `secret` and `verify` are mutually
exclusive.** An HMAC recomputed over a parsed and re-serialised payload does
not match, so `src/server/app.ts` reads the body as text once and both the
verifier and the schema parse work from that string — don't reintroduce a
parse-before-verify. Declaring both `secret` and `verify` stops the boot,
because otherwise which one guards the route is a guess.

**Webhooks default to `respond: "async"`.** Most providers retry on a slow
reply. Only use `"sync"` when the caller genuinely needs the result.

**An async webhook is written to the `inbox` table before its 202, and only
settled when the run reaches a decision.** `src/core/inbox.ts`. Three things in
there are load-bearing and look like tidying opportunities. The lookup and
insert live in *one synchronous* `store.recordDelivery` — bun:sqlite is
synchronous and nothing between them awaits, which is the only reason two
identical requests arriving together cannot both pass the dedup check; put an
await between them and duplicates get through. A `skipped` outcome is settled
or left pending depending on `isShuttingDown()`, because the two kinds of skip
mean opposite things: one the shutdown caused has to survive the restart, one
`onOverlap` decided must not be resurrected. And recovery is a **replay, not a
resume** — a resume carries no `ctx.input`, so a workflow that reads its
payload would get `{}`. The cost is that recovery is at-least-once; that is the
trade, not an oversight.

**The inbox stores regardless of `CAPTURE_DATA`.** It uses `capture()`'s
`force` and the checkpoint ceiling, like step outputs, because it is functional
data — something fed back into a workflow — not observational. Wiring it to
`CAPTURE_DATA` would let a disk-space setting quietly switch durability off.
A payload that does not fit is *not* recorded at all rather than recorded
truncated, and the run still happens.

**Nothing in `src/core/alerts.ts` may throw out.** It is called from a run's
last breath, from the middle of a boot, and from a webhook handler that owes a
caller a 401 — a broken alert channel turning any of those into an exception
would make the alerting the outage. Every path ends in a `log.warn`. For the
same reason a bad `ALERT_CHANNEL` is a warning and no alerts rather than a dead
boot, while a bad `alerts: { channel }` in a workflow file *does* stop the boot:
that one is a typo in code, like an unknown credential platform.

**An alert is composed by the runner and sent out of the process, so it is
redacted on the way.** This is the same category as a workflow relaying a
provider error into Telegram — the error message that reaches an alert is very
often the URL that produced it, and Telegram puts the bot token in the URL. The
`redact()` call in `send()` is the last thing between an error string and a chat.

**The alert cooldown is stamped before delivery is attempted.** A channel that
is down therefore costs that one alert, not thirty minutes of retries against
it. That is the trade, not an oversight — and the counters live in shared state
under a *hashed* `@alert:` key because state is the one thing not redacted on
the way to disk, and a counter row has no reason to hold an error message.

**Boot alerts fire on the server path only** (`isServerBoot` in
`src/index.ts`). `loadWorkflows()` also runs for `bun run list` and
`bun run trigger`, and a person at a terminal watching an error scroll past does
not also need it in a chat.

**Pass `ctx.signal` into `fetch` and other cancellable calls.** The runner can
stop *waiting* on work that ignores it, but it cannot *cancel* it.

**`defineSecrets` returns a live proxy, not a snapshot.** Every property read
resolves the current value through the secret store, which is what makes a
rotated credential reach a running workflow. Two consequences. A value captured
at *module* scope — `const key = secrets.X`, or `tallySignature(secrets.X)` in
a trigger — is frozen in a closure at import and this cannot reach it; pass a
getter (`() => secrets.X`) for anything evaluated at import. And a value that
stops matching its schema does not throw: the proxy warns once and keeps the
last good one, because breaking a run over an operator's typo is worse than
running on the previous credential.

**A variable is not a secret, and the difference is redaction, not intent.**
`src/core/variables.ts` is a second store over the same environment base, for
configuration — board ids, chat ids, phone numbers. It exists because the
secret store registers everything it holds with the redactor (it cannot tell a
token from a hostname), so a board id kept there is scrubbed off every run page.
The cost is that this store's default is "not protected", and the compensation
is entirely at the write: a credential-shaped **name** is refused, a
credential-shaped **value** is refused, and a key that exists in the other store
is refused — in both directions. Both collision checks read their table
directly rather than through the in-memory map, because the CLI runs before
`loadSecretStore()` and an in-memory check there silently passed everything.
That was a real bug in the first version of this, caught by running it.

The one case that cannot be refused is a variable that a workflow *later*
declares with `defineSecrets`. `warnAboutSecretLookalikes()` runs after the
loader and says so every boot; don't make it an abort, because the deployment
is already running on that value and refusing to start would not un-store it.

**Variables load before secrets in `src/index.ts`.** They cannot collide, but
if one ever did — a row written before the guard existed, or by hand — the
encrypted, redacted value is the one that should be left standing in
`process.env`.

**Stored secrets are mirrored into `process.env`.** Integrations read their own
credentials from `process.env` inside their factories, so the store would only
cover workflow-declared keys otherwise. `loadSecretStore()` therefore has to
run in `src/index.ts` **before the loader imports a single workflow** — move it
after and a key that lives only in the store fails boot validation for a
credential that is actually present.

**The secret CLI runs before the loader, on purpose.** Setting a credential for
a workflow you have not deployed yet is the main thing the store buys you, and
`loadWorkflows()` would abort on that workflow's missing key first. It pays for
this by having no schemas — those are registered by `defineSecrets` at import —
so it does a tolerant import pass of its own that swallows every failure. Don't
"fix" that into the real loader.

**A credential is never returned by an HTTP route.** `GET /api/secrets` lists
names and timestamps; there is no read-the-value route, and adding one is not a
small convenience. `secret get` in the CLI masks by default and needs
`--reveal`.

**The encryption wire format in `src/core/crypto.ts` is load-bearing.** It is
base64(iv ‖ ciphertext) with a 12-byte iv, and OAuth tokens already in the
field were written that way before the file existed. Changing it needs a
version byte and a migration, not an edit.

**Losing the master key must not stop the boot.** Both the store and OAuth warn
and fall back to the environment on an undecryptable value. A deployment that
rotated its key and now cannot start is worse than one running on env vars.

**A workflow's "updated" time comes from a content hash, not the filesystem.**
`loadWorkflows()` hashes each file's source; `src/index.ts` records it in
`workflow_versions` and moves `updated_at` only when the hash changes. Do not
"simplify" this to `statSync().mtime` — a deploy is a fresh git clone, every
file gets the same checkout time, and the dashboard would report every workflow
as edited at the last deploy. The write lives in `index.ts` rather than in the
loader on purpose: loading workflows is a read, and `bun run secret` must be
able to run before any of it.

**Workflow names must match `/^[a-z0-9][a-z0-9-]*$/`** — they appear in URLs.

**A credential is stored secrets plus a grouping row — never a second store.**
Each field of `defineCredential("smtp", "main")` is an ordinary row in the
encrypted `secrets` table under a derived name (`SMTP_MAIN_PASS`), and the
`credentials` table holds only provider, folder, primary flag and last test
result. That is what makes redaction, rotation, the master key and the
cross-process refresh apply to credentials without being re-proven. Don't add a
second encrypted table; don't put a value in the `credentials` table.

**An unconnected credential warns, a missing secret aborts.** `defineSecrets`
still stops the boot. `defineCredential` cannot, and the reason is a chicken and
egg: the dashboard is where you connect it, and a server that refused to start
never serves that page. The compensation is in two places — the loader logs it,
and `runWorkflow` refuses the run with a clear error before anything executes.
Do not "restore consistency" by making it abort; do not remove the runner check,
which is the thing that keeps nothing running half-configured. An unknown
*platform* still aborts, because that is a typo in code.

**A provider's `secret: false` fields must not reach the redactor.**
`src/core/secret-store.ts` registers every stored value by default because it
cannot tell a token from a hostname. `src/core/credentials.ts` installs a
redaction policy **at module import** — before `loadSecretStore()` applies the
first value — that exempts fields a provider declared as configuration. Move
that installation into `initCredentials()` and it runs too late: the store is
already loaded, and a hostname registered once cannot be taken back out. The
index is also rebuilt inside `saveCredential` *before* the field writes, for the
same reason on the first save of a new credential.

**A connection test's message is redacted before it is stored or shown.** This
is not belt-and-braces. Telegram puts the bot token in the URL, so an
unredacted fetch failure prints the credential onto the dashboard and into the
database. `record()` in credentials.ts is the only path that writes
`test_detail`; keep it that way. A provider's `test` must also stay read-only,
free and fast — it answers "are these live", it does not exercise the client.

**Only one credential per platform is primary, and it overwrites env vars.**
A primary credential mirrors its fields into the bare names the built-in
integration reads (`SMTP_HOST`, not `SMTP_MAIN_HOST`), because that is what
makes connecting a platform on the dashboard reach `ctx.email`. The mapping is
recomputed from scratch in `syncPrimaryEnv()` rather than tracked incrementally,
and it remembers what the environment held so clearing the flag puts it back.
A stored value under the same name loses to the credential — deliberately, and
it is logged once when it happens.

**Nothing outside `saveCredential` may write a credential's field.** The CLI,
`PUT /api/secrets/:key` and the loose-secret form all refuse a key whose `owner`
column is set, and `DELETE` refuses too. Writing one directly goes around the
bundle's validation and leaves its "connected" state claiming something that is
no longer true.

**The dashboard renders a non-secret field's value and never a secret one.**
The rule is narrower than "no value ever comes back", because an edit form you
cannot read is not an edit form. A field the provider declared `secret: false`
is configuration and is rendered; a field that is a credential is never sent to
the browser in any view, and is never echoed back into a form after a failed
submit. `GET /api/credentials` reports which fields are *set*, never what they
hold.

**An empty field means clear it; an absent field means leave it.** That is what
makes "leave the password box blank to keep it" work — `src/server/app.ts`
drops empty *secret* fields before calling `saveCredential`, rather than
`saveCredential` treating empty as unchanged. Fold the two meanings together
and clearing an optional value becomes impossible.

## Adding an integration

1. New file in `src/integrations/`, exporting a `createX(...)` factory and its
   interface.
2. Add it to the `Integrations` interface in `src/integrations/index.ts` and
   expose it as a **lazy getter** (`get x() { return (x ??= createX(http)); }`)
   so it costs nothing when unused.
3. Read credentials from `process.env` inside the factory, throwing a clear
   `"X is not set"` error, and add those names to `INTEGRATION_SECRET_ENV`.
4. Document the env vars in `.env.example` and the client on `ctx` in README.

Prefer `fetch` or the service's official SDK over heavy vendor packages —
image size is a core goal. Google Sheets deliberately signs its own JWT with
WebCrypto rather than pulling in `googleapis`.

## Adding a platform to the Credentials tab

One entry in `PROVIDERS` in `src/core/providers.ts`. Everything else — the
form, the folder view, validation, the test button, the API — is derived from
it.

```ts
shopee: {
  label: "Shopee",
  blurb: "One line, shown under the name when you pick it",
  docs: "https://…",                       // optional link on the form
  fields: {
    partner_id:  { label: "Partner ID",  schema: z.string().min(1), secret: false },
    partner_key: { label: "Partner key", schema: z.string().min(20) },
  },
  envMap: { partner_key: "SHOPEE_PARTNER_KEY" },   // only if an integration reads it
  async test(v, signal) {
    const me = await probe(url, { headers: … }, signal, "Shopee");
    return `Authenticated as ${me.shop_name}`;     // shown on the dashboard
  },
},
```

Four things that are easy to get wrong:

- **`secret: false` is a claim about redaction, not just masking.** Mark a
  hostname, a port, an account id — anything you would want to read in a log —
  and leave it off anything that authenticates.
- **`test` must be read-only, free and fast.** It answers "are these
  credentials live". It is not a smoke test of the integration, and it must not
  send anything.
- **Check the failure body, not just the status.** Slack answers `200` with
  `ok:false` for a dead token.
- **Import heavy dependencies inside `test`.** SMTP does `await
  import("nodemailer")` so a dashboard that never tests SMTP never pays for it.

A field name that collides with another credential's derived key is refused at
save time; you do not need to reason about it, but don't remove the check.

## Settled architecture — do not drift

These were decided deliberately. Raise a trade-off before changing any of them:

- **Workflows live in the repo as files**, never rows in the database. This is
  why there is no code sandbox to secure.
- **The dashboard is read-only about what a workflow *is*.** No browser-based
  workflow editor — that is the weight we left n8n to avoid. There are exactly
  two exceptions and neither may grow into one. Credentials get a real form,
  added deliberately and gated behind `DASHBOARD_WRITE`; see the entry below.
  And any workflow can be **paused** from the list or its own page, which is a
  narrower hole than it first looks: it stores no configuration, changes
  nothing about what the workflow does, and can only ever subtract — the switch
  cannot start something whose file says `enabled: false`. So the file stays
  the authority on what a workflow is and whether it may run at all; the
  database only ever says "not right now". Adding a way to *turn one on* from
  the browser, or any other form on these pages, needs this decision taken
  again.

  The pause switch is not behind `DASHBOARD_WRITE` on purpose. That flag is
  about whether a browser may put a credential into the encrypted store; this
  is the same category as Run now, Resume and Replay, which have never been
  gated. `DASHBOARD_USER`/`DASHBOARD_PASS` is what covers all of them, and the
  compensation for an unauthenticated dashboard is that a pause is loud: warned
  on the way in, warned again at every boot, and counted on `/healthz`.
- **Single process, SQLite only.** No Redis, no external queue, no worker pool.
  The webhook inbox is a table, not a broker, and deliberately does not try to
  be one: it makes an *accepted* webhook survive a restart. Catching what
  arrives while the process is down needs a separate always-up receiver in
  front, which was considered and refused — it doubles what has to stay alive,
  breaks `respond: "sync"`, and held deliveries fail the freshness window
  Slack and Stripe put on their signatures. Provider retries cover that gap.
- **Checkpoints are memoised step results**, not deterministic replay.
- **`ctx.state` is durable and never displayed.** It survives run pruning on
  purpose; it is not part of run history.
- **Polling is at-least-once.** Items are marked seen after a successful run,
  never before, and a quiet poll creates no run record at all.
- **Secrets come from the environment, with the store layered over it.** The
  environment is still the base and still the only place the master key can
  live; `src/core/secret-store.ts` is an encrypted table that overrides it, so
  rotating a credential is a write rather than a deploy. A stored value beats
  an env value deliberately — the other order would make every rotation a
  redeploy again. The database also holds the *rotated* half of an OAuth
  credential, which by definition cannot live in an immutable env var.
- **The store's write surface is the CLI, `/api`, and — behind a flag — the
  Credentials tab.** This reverses an earlier decision, on purpose. The old rule
  was that a browser must not be able to break production, and a credential
  editor is exactly what would end that. What changed is who does the typing:
  when workflows are written by an AI coding agent, every other route into the
  store makes the agent handle the raw credential, and it lands in a transcript.
  The form is the only path where the value goes from a person straight into the
  encrypted store. `DASHBOARD_WRITE` keeps the old behaviour available as a
  deployment choice rather than deleting it — unset, every write route on the
  dashboard answers 403 and the tab is a read-only view. This is hygiene, not a
  boundary: anything that can read `.env` can decrypt the store regardless, and
  the flag should not be described as if it were access control.
- **No OAuth consent flow.** A refresh token is obtained by hand, once, and
  pasted into the environment or the Credentials tab. Building a browser
  redirect flow means sessions, a callback route, and parked half-finished
  consent — for a once-per-credential action. The connection test is not the
  thin end of this: it makes one read-only call with credentials that already
  exist, and never redirects anywhere.
- **A platform's fields and its test live in code.** `src/core/providers.ts`,
  not a browser form and not a database row. A test request the server executes,
  configured from a browser and stored as data, is configuration-as-code in the
  database — the n8n shape this project exists to avoid. Adding a platform is a
  few lines and a deploy, and that cost is the point.

## Verifying before you finish

1. `bun run check` passes.
2. `bun run list` shows the workflow you expect (this also proves it boots and
   that every declared secret is present).
3. Start the server and exercise the actual path — trigger the workflow, POST
   the webhook, open `/runs/<id>` and confirm steps and HTTP calls rendered.
4. If you touched anything storage-related, grep the API output and stdout for a
   known secret value and confirm zero occurrences. For the secret store that
   means `strings data/automator.db | grep <value>` as well — the table holds
   ciphertext, and a plaintext hit there is the whole failure. Check the `-wal`
   file too. For credentials, sweep every page and every `/api` route, and
   confirm a `secret: false` field is *not* redacted while its neighbours are.
5. If you touched the Dockerfile, `docker build` and run the container.

Report what you actually ran. Do not claim a behaviour works because the types
compile.
