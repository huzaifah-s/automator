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
                   redact · capture · state · logger · alerts · types
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

Triggers: `cron(expr, { tz })`, `webhook(path, { method, schema, respond, secret })`,
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

**`ctx.run()` never takes a second concurrency slot.** A nested run inherits
its caller's, because the caller is blocked awaiting it and a slot per level
deadlocks a full pool. Cycles are refused up front from the ancestry chain
carried in `RunOptions.parent`; note that this catches loops *within* one
chain, not two separate chains that call into each other under
`onOverlap: "queue"` — that one can still deadlock, and is the reason the depth
limit exists as a backstop.

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
re-deriving it from an empty object. `workflows/approval-resolve.ts` reads its
approval id in the first step for exactly that reason: read at the top of
`run()`, a resumed approval looked up `approval:undefined` and reported itself
missing. This has already caused one bug.

**Step names must be stable and unique within a run.** They are the checkpoint
key. `ctx.step("send email")` inside a loop collides across iterations — use
`` ctx.step(`send email ${user.id}`) ``.

**Step results must be JSON-serialisable and under 256KB** to be checkpointable.
Larger or unserialisable results still display but re-run on resume.

**Webhooks default to `respond: "async"`.** Most providers retry on a slow
reply. Only use `"sync"` when the caller genuinely needs the result.

**Pass `ctx.signal` into `fetch` and other cancellable calls.** The runner can
stop *waiting* on work that ignores it, but it cannot *cancel* it.

**Workflow names must match `/^[a-z0-9][a-z0-9-]*$/`** — they appear in URLs.

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

## Settled architecture — do not drift

These were decided deliberately. Raise a trade-off before changing any of them:

- **Workflows live in the repo as files**, never rows in the database. This is
  why there is no code sandbox to secure.
- **The dashboard is read-only.** No browser-based workflow editor — that is
  the weight we left n8n to avoid.
- **Single process, SQLite only.** No Redis, no external queue, no worker pool.
- **Checkpoints are memoised step results**, not deterministic replay.
- **`ctx.state` is durable and never displayed.** It survives run pruning on
  purpose; it is not part of run history.
- **Polling is at-least-once.** Items are marked seen after a successful run,
  never before, and a quiet poll creates no run record at all.
- **Secrets come from the environment.** No credential store in the database
  unless someone explicitly asks for UI-managed credentials. The one thing the
  database holds is the *rotated* half of an OAuth credential, which by
  definition cannot live in an immutable env var — encrypted, and seeded from
  the environment.
- **No OAuth consent flow.** A refresh token is obtained by hand, once, and
  pasted into the environment. Building a browser redirect flow means sessions,
  a callback route, and parked half-finished consent — for a once-per-credential
  action.

## Verifying before you finish

1. `bun run check` passes.
2. `bun run list` shows the workflow you expect (this also proves it boots and
   that every declared secret is present).
3. Start the server and exercise the actual path — trigger the workflow, POST
   the webhook, open `/runs/<id>` and confirm steps and HTTP calls rendered.
4. If you touched anything storage-related, grep the API output and stdout for a
   known secret value and confirm zero occurrences.
5. If you touched the Dockerfile, `docker build` and run the container.

Report what you actually ran. Do not claim a behaviour works because the types
compile.
