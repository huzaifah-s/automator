# automator

A code-first automation runner. Workflows are TypeScript files, not JSON blobs
in a database — you get type checking, code review, and `git revert`.

Built to replace a self-hosted n8n that was eating too much of a small server.
Most of n8n's weight is the visual editor and 400+ node packages — none of
which you need if you're happy writing the code.

The image is **188 MB** (measured, `oven/bun:1-alpine`), runs as a non-root
user, and needs no Postgres or Redis alongside it — state lives in one SQLite
file on a mounted volume.

## What it is

Four small pieces:

| Piece | Job |
|---|---|
| **Loader** | Imports `workflows/*.ts`, validates everything at boot |
| **Triggers** | cron (croner), webhooks (Hono), manual |
| **Runner** | Retries, timeouts, overlap control, run history in SQLite |
| **Dashboard** | Read-only view of workflows, runs, and logs |

Everything else is just TypeScript — which is the point.

## Quick start

```bash
cp .env.example .env       # fill in what your workflows need
docker compose up -d
```

Dashboard on `http://localhost:3000`.

Locally, without Docker:

```bash
bun install
bun run dev
```

## Writing a workflow

Drop a file in `workflows/`. Default-export `defineWorkflow`. That's it.

```ts
import { z } from "zod";
import { cron, defineSecrets, defineWorkflow } from "../src/core/define.ts";

const secrets = defineSecrets({
  GITHUB_TOKEN: z.string().min(10),
});

export default defineWorkflow({
  name: "daily-digest",
  trigger: cron("0 9 * * 1-5", { tz: "Asia/Kuala_Lumpur" }),
  retries: 2,

  async run(ctx) {
    const commits = await ctx.step("fetch", () =>
      ctx.http.get("https://api.github.com/repos/you/repo/commits", {
        headers: { authorization: `Bearer ${secrets.GITHUB_TOKEN}` },
      }),
    );

    const messages = commits.map((c) => c.commit.message).join("\n");
    const summary = await ctx.ai.claude(`Summarise for standup:\n${messages}`);
    await ctx.slack.send("#general", summary);

    return { commits: commits.length };   // shows up on the run page
  },
});
```

Worked examples ship in `workflows/`: a cron + AI + Slack digest, a
schema-validated Stripe webhook, a minimal uptime check, and demos for
checkpoint resume, `ctx.state`, and polling.

### Triggers

```ts
cron("0 9 * * *", { tz: "Asia/Kuala_Lumpur" })   // 5- or 6-field, DST-aware
webhook("stripe", { schema, respond: "async" })   // → POST /hooks/stripe
poll("*/5 * * * *", { fetch, id })                // runs only when there's something new
manual()                                          // dashboard button / CLI only
```

Webhooks default to `respond: "async"` — a 202 with the run id, immediately.
Most providers retry on a slow reply, so waiting for the workflow is usually
the wrong default. Use `respond: "sync"` when the caller genuinely needs the
result.

### Options

| Option | Default | Notes |
|---|---|---|
| `retries` | `2` | Extra attempts, exponential backoff with jitter |
| `timeoutMs` | `300_000` | Per attempt |
| `onOverlap` | `"skip"` | `"skip"` drops the new run, `"queue"` serialises it |
| `enabled` | `true` | Keep the file, stop scheduling it |
| `onFailure` | — | Runs once after every attempt has failed |
| `checkpoint` | `true` | Memoise successful `ctx.step` results (see below) |
| `checkpointTtlHours` | `24` | Checkpoints older than this are ignored on resume |

### What's on `ctx`

`http` `slack` `telegram` `discord` `ai` `email` `sql` `sheets` `scrape`,
plus `log`, `step`, `state`, `signal`, `input`, `attempt`, `runId`.

All of them except `http` are lazy — a workflow that only makes an HTTP call
never opens a Postgres pool or reads an unrelated env var.

`ctx.step(name, fn, { input })` wraps a unit of work. It gets its own timing
line, its input and output are recorded, and its result becomes a checkpoint.

`ctx.signal` aborts on timeout or shutdown. Pass it to `fetch` and other
cancellable calls — the runner can *stop waiting* on work that ignores it, but
it can't *cancel* it.

## Checkpoints and resume

A successful `ctx.step` stores its result. A later run against the same
checkpoint key gets that result back instead of doing the work again.

Two things fall out of that:

**Retries don't repeat completed work.** If a workflow sends an email in step 2
and fails in step 3, attempt 2 skips the email. This is on by default.

**Failed runs get a Resume button.** Fix the code, redeploy, open the failed
run, click *Resume from last good step*. Every step that already succeeded is
reused — tagged `reused` in the UI, with its original timing — and execution
picks up at the one that broke.

```
▶ resumed from e286a6b6
↳ fetch users ⤿ reused from checkpoint
↳ enrich      ⤿ reused from checkpoint
↳ deliver     ok (0ms)
✓ succeeded
```

`workflows/checkpoint-demo.ts` fails on purpose so you can try it.

Also available on the API: `POST /api/runs/:id/resume`.

### What checkpointing needs from you

- **Stable, unique step names.** `ctx.step("send email")` inside a loop
  collides across iterations. Use ``ctx.step(`send email ${user.id}`)`` instead.
- **JSON-serialisable results.** A DB handle or a stream can't be a checkpoint.
- **Results under `CHECKPOINT_MAX_BYTES`** (256KB). Larger results are still
  recorded for viewing, but flagged `truncated` and re-run on resume — the log
  says so when it happens.
- **Freshness awareness.** A step that reads a live value ("current price")
  will replay the old one. Checkpoints expire after `checkpointTtlHours`
  (24 by default), and `ctx.step(name, fn, { checkpoint: false })` opts a
  single step out permanently.

## Polling

`poll()` is a cron that only starts a run when the source has something new.

```ts
export default defineWorkflow<Issue[]>({
  name: "new-issues",
  trigger: poll("*/5 * * * *", {
    fetch: (ctx) => ctx.http.get("https://api.github.com/repos/you/repo/issues"),
    id: (issue) => issue.id,
  }),

  async run(ctx) {
    // ctx.input is only the issues this workflow has never seen.
    for (const issue of ctx.input) {
      await ctx.step(`notify ${issue.id}`, () => ctx.slack.send("#dev", issue.title));
    }
    return { notified: ctx.input.length };
  },
});
```

**Nothing new means no run at all** — not a run that returns zero. A five-minute
poll would otherwise bury the dashboard under 288 empty runs a day.

| Option | Default | Notes |
|---|---|---|
| `fetch` | — | Gets every client a run has: `http`, `sql`, `state`, … |
| `id` | hash of the whole item | What "seen before" is decided on |
| `remember` | `500` | How many recent ids to keep |
| `firstRun` | `"skip"` | Baseline instead of firing for everything already there |
| `timeoutMs` | `60_000` | Ceiling on `fetch`, separate from the run's own timeout |
| `tz` | `TZ` | Same as `cron()` |

Four behaviours worth knowing before you rely on it:

**The first poll doesn't run.** It records what is already there and stops, so
pointing a workflow at a feed of 500 open issues doesn't send 500 messages.
Use `firstRun: "emit"` if you want the opposite.

**Items are marked seen only after the run succeeds.** A failed run gets the
same items again on the next tick rather than dropping them — at-least-once,
because silent loss is the worse failure. A workflow that fails forever will
retry forever; that is what `ALERT_WEBHOOK_URL` is for.

**Give it an `id`.** Without one the whole item is hashed, so an item whose
title or timestamp changed reads as new.

**A `fetch` that throws becomes a failed run** with the error on its run page,
and alerts like any other failure. Polling never stops silently.

The seen-set lives in [`ctx.state`](#durable-state) under `@poll:seen`, so it
survives restarts and redeploys; the `@poll:` prefix is reserved. It widens
automatically if one page is bigger than `remember`, so a large fetch can't push
its own items out of the window and re-deliver them forever.

`workflows/poll-demo.ts` is a working example that needs no network or
credentials — set `enabled: true` to watch it.

## Durable state

`ctx.state` is a key/value store that outlives the run — and the process, the
redeploy, and run-history pruning. It is for what a run needs to remember about
the last one.

```ts
// Polling: only handle what you haven't seen before.
const since = (await ctx.state.get<number>("cursor")) ?? 0;
const items = await ctx.http.get(`https://api.example.com/items?since=${since}`);
if (items.length) await ctx.state.set("cursor", items.at(-1).id);
```

| Method | Notes |
|---|---|
| `get<T>(key)` | `undefined` when absent or expired |
| `set(key, value, { ttlSeconds })` | JSON-serialisable, under `STATE_MAX_BYTES` (256KB) |
| `update<T>(key, fn, opts)` | Read-modify-write in one tick — see below |
| `delete(key)` | `true` if a key was actually removed |
| `keys(prefix?)` | Live keys, sorted |

Keys are namespaced per workflow, so two workflows can both keep a `"cursor"`.
`ctx.state.shared` reaches a namespace every workflow can see, for handing data
between them — a webhook resolving an approval that a cron workflow created.
Those keys are global, so prefix them.

**Use `update` for anything you increment.** `get` then `set` is two awaits with
a gap in between, and concurrent runs interleave in that gap. `update` runs the
whole read-modify-write synchronously before it yields, so it cannot lose a
write. Under 100-way concurrency `update` counted 100; get-then-set counted 1.

```ts
await ctx.state.update<number>("processed", (n) => (n ?? 0) + 1);
```

`workflows/state-demo.ts` is a runnable cursor example — run it twice and the
second run finds nothing new.

### State is deliberately not redacted

Everything else this project writes to SQLite goes through the secret filter,
because that data is observational — nobody reads a log line back and acts on
it. State is the exception, on purpose: it is operational. Store a rotating
OAuth refresh token and you need the same bytes back, so scrubbing on write
would destroy the value rather than protect it.

What holds the guarantee is that **state is never displayed** — no dashboard
view, no API route, no log line renders it. It goes in from a workflow and comes
back out to that workflow alone. Adding a state viewer would put credentials on
a web page; don't.

Values that cannot round-trip are rejected rather than quietly mangled:
`undefined`, functions, bigints, circular structures, and anything over
`STATE_MAX_BYTES` all throw with a message naming the key.

## Seeing the data

Every run page shows what actually happened, n8n-style:

- **Steps** — each `ctx.step` with its input, output, duration, and whether it
  was reused from a checkpoint.
- **HTTP calls** — every `ctx.http` request with method, URL, status, timing,
  request body, and response body. Failed and retried attempts all appear.

Everything is redacted through the same secret filter as the logs before it's
stored — including workflow return values, error messages, and recorded URLs, and capped at `CAPTURE_MAX_BYTES` (32KB) per value so run history can't
run away with your disk. Request *headers* are never captured at all, so
`Authorization` never reaches SQLite.

Set `CAPTURE_DATA=false` to turn observational capture off. Step outputs are
still stored — resume depends on them.

## Secrets

Secrets come from the environment. `.env` is mounted by Compose via
`env_file:`, never baked into the image.

Declare what each workflow needs:

```ts
const secrets = defineSecrets({
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  OPENAI_API_KEY: z.string().min(20),
});
```

### Several accounts for one service

`defineSecretGroup` collects every `PREFIX_*` variable into one typed object:

```bash
GITHUB_TOKEN_PERSONAL=ghp_…
GITHUB_TOKEN_WORK=ghp_…
GITHUB_TOKEN_CLIENT_ACME=ghp_…
```

```ts
const github = defineSecretGroup("GITHUB_TOKEN", z.string().min(10));
// → { personal: "ghp_…", work: "ghp_…", client_acme: "ghp_…" }

github.work                        // typed access to one account
for (const [name, token] of Object.entries(github)) { … }   // fan out over all
```

Each value is validated and registered for redaction individually. A bare
`GITHUB_TOKEN` with no suffix lands under `default`. Adding a fourth account is
an env var and a redeploy — no code change.

Two things this buys you:

1. **Boot-time failure.** Every workflow is imported at startup, so a missing
   or malformed key kills the process on deploy — not at 3am, halfway through
   the run that needed it.

   ```
   error [automator] secret GITHUB_TOKEN is not set
   error [automator] 1 problem(s) found while loading workflows
   ```

2. **Automatic redaction.** Every value that comes out of `defineSecrets` is
   registered with the logger, so a stray `ctx.log.info("config", cfg)` can't
   leak a token into stdout or the run history — it prints `«redacted»`.

   The credentials the built-in integrations read for themselves
   (`SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `POSTGRES_URL`, …) are registered at
   boot too, so the guarantee doesn't depend on whether a workflow happened to
   declare them. A password is also registered separately from the connection
   URL it lives in, and the private key separately from the Google
   service-account blob — so a credential your code pulls apart by hand is still
   scrubbed.

   Redaction is applied at every point data reaches disk: log lines, step inputs
   and outputs, recorded HTTP URLs and bodies, workflow return values, and error
   messages. Request *headers* are never captured at all.

If you later want to add credentials from a UI without redeploying, the shape
to add is a SQLite table with AES-256-GCM values and a master key from the
environment. Deliberately not built yet — env vars are the right answer until
they aren't.

Credentials a workflow *rotates* rather than reads — an OAuth refresh token —
belong in [`ctx.state`](#durable-state) instead. Those are stored as given, not
encrypted, on the same footing as anything else in the database file.

## Security

- **Dashboard**: set `DASHBOARD_USER` / `DASHBOARD_PASS`. Without them it's
  public, and the log says so on every boot.
- **Webhooks**: set `WEBHOOK_SECRET`. Required on every `/hooks/*` call as an
  `X-Automator-Secret` header, a Bearer token, or `?secret=`. Compared in
  constant time. Per-workflow overrides via `webhook(path, { secret })`.
- Webhook routes are **not** behind basic auth — callers use the secret. That
  separation is deliberate.
- `/healthz` is open for container health checks and carries no useful data.

## Operations

```bash
bun run list                        # every workflow and its trigger
bun run trigger -- daily-digest         # run one now, exit non-zero on failure
docker compose logs -f automator
```

- Runs interrupted by a restart are marked failed at boot, not left `running`.
- Run history is pruned nightly (`RUN_RETENTION_DAYS`, default 30). The same
  job sweeps expired `ctx.state` keys, whatever retention is set to.
- `SIGTERM` stops the scheduler and waits up to `SHUTDOWN_TIMEOUT_MS` (20s) for
  in-flight runs before exiting.
- Set `ALERT_WEBHOOK_URL` to a Slack or Discord incoming webhook to get a ping
  on every workflow that exhausts its retries. Set `PUBLIC_URL` and the alert
  links straight to the run page.

## Deploying

Any Docker host. With Coolify or similar, point it at the repo — the
`docker-compose.yml` is the whole deployment. Persist the `/data` volume to
keep run history across deploys.

`workflows/` is mounted read-only from the host, so editing a workflow needs a
restart, not a rebuild.

## Trade-offs

Worth knowing before you commit:

- **Workflows live in the repo.** Changing one means a redeploy. In exchange
  there is no code sandbox to secure and no way to break production from a
  browser.
- **Single process, no external queue.** Fine for hundreds of runs a day.
  If you need horizontal scale or work that survives a crash mid-workflow,
  you want a durable execution engine (Temporal, Inngest), not this.
- **Checkpoints are memoised results, not deterministic replay.** Resume skips
  steps that already succeeded; it does not rewind side effects that happened
  *inside* a step before it threw. Keep each step to one logical action and
  that distinction stays invisible.
- **No visual editor.** That's the entire 1.9GB you're not shipping.

## For AI agents

[AGENTS.md](AGENTS.md) has the working instructions — layout, how to add a
workflow, the invariants that have already caused bugs, and how to verify.
[CLAUDE.md](CLAUDE.md) points there.

## License

MIT.
