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
| **Loader** | Imports `workflows/**/*.ts`, validates everything at boot |
| **Triggers** | cron (croner), webhooks (Hono), manual |
| **Runner** | Retries, timeouts, overlap control, run history in SQLite |
| **Dashboard** | Two tabs — workflows by folder, and every execution |

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

### Folders

Subdirectories are filing, nothing more. The loader recurses, so
`workflows/pblsh/send-signed-agreement.ts` loads exactly like a top-level file.
The dashboard's **Workflows** tab is organised around them: one collapsible
section per folder, each with the health strip of its workflows' recent runs.
Which sections you collapse is remembered in the browser, and the filter box
searches names, descriptions and paths — so typing a folder name narrows the
page to it.

Names stay global and flat — a folder is **not** a namespace. A workflow in
`workflows/pblsh/` still has to pick a `name` no other workflow uses, and the
convention worth keeping is to prefix it with the project
(`pblsh-send-signed-agreement`). Hook paths nest if you want them to:
`webhook("pblsh/agreement-signed")` mounts `/hooks/pblsh/agreement-signed`.

The one thing to remember is the import depth — a workflow one level down
imports `../../src/core/define.ts`. Nothing else about a folder is load-bearing:
secrets, state namespaces, the concurrency cap, and run history are all
unaffected by where the file sits.

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

An async delivery is written down before that 202 goes back, and finished on
the next boot if a restart landed in between — see
[The webhook inbox](#the-webhook-inbox).

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
plus `log`, `step`, `run`, `state`, `signal`, `input`, `attempt`, `runId`.

All of them except `http` are lazy — a workflow that only makes an HTTP call
never opens a Postgres pool or reads an unrelated env var.

`ctx.http.paginate(url)` walks a paginated endpoint — see
[Pagination](#pagination). `ctx.run(name, input)` runs another workflow — see
[Calling one workflow from another](#calling-one-workflow-from-another).

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

Also available on the API: `POST /api/runs/:id/resume`.

### Replay — the other button

A run records the input its trigger handed it, so any run with one gets a
*Replay with this input* button (and `POST /api/runs/:id/replay`). That is the
end of re-sending a webhook payload by hand every time you change the workflow.

**Replay is not resume.** Resume reuses the failed run's checkpoint key and
skips every step that already succeeded. Replay starts a *fresh* checkpoint
key and does all of it again with the same input. Reach for resume to finish a
run, replay to develop one.

Three things it will tell you rather than fake:

- **The input is the redacted copy.** It goes through the same secret filter as
  everything else on disk, so a credential inside a payload comes back as
  `«redacted»` — that is the invariant working, not a bug, but it does mean a
  payload that *carries* a secret can't be replayed faithfully.
- **`CAPTURE_DATA=false` means no stored inputs**, so those runs aren't
  replayable. Recording them anyway would ignore the setting.
- **An input over `CAPTURE_MAX_BYTES` was stored as a preview**, and replay
  refuses rather than handing the workflow a truncated payload.

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

## Pagination

`ctx.http.paginate(url)` walks a paginated GET endpoint. Every page is an
ordinary request — same retries, same 429 handling, same `ctx.signal`, and each
one lands in the run page's HTTP log.

```ts
// Auto-detected: GitHub sends Link: <…>; rel="next".
for await (const issue of ctx.http.paginate<Issue>(url, { query: { per_page: 100 } })) {
  await ctx.step(`triage ${issue.number}`, () => triage(issue));
}

// Or take the whole thing.
const all = await ctx.http.paginate<Issue>(url).all();
```

The iterator holds one page at a time; `.all()` holds everything; `.pages()`
yields page by page when the boundaries matter.

**Auto-detection covers only what a response says unambiguously:** an RFC 5988
`Link: rel="next"` header, and a body field (`next`, `next_url`, `links.next`, …)
holding an actual URL. An opaque cursor token needs the query parameter spelled
out, because nothing in the response says what to call it:

```ts
// Cursor token in the body (Slack, Notion, Stripe-style)
{ next: { cursor: "response_metadata.next_cursor", param: "cursor" } }
// Page counter                     // Offset counter, advanced by page size
{ next: { page: "page" } }          { next: { offset: "offset" } }
// Anything else
{ next: (info) => info.body.paging?.after && `${url}?after=${info.body.paging.after}` }
```

Items are found the same way: the body if it's an array, else its one
array-valued field (`data`, `items`, `results`, …). Point at it with
`items: "data.records"` or a function when that's ambiguous.

| Option | Default | Notes |
|---|---|---|
| `items` | auto | Dotted path or function |
| `next` | auto | `Link` header, then a URL-valued body field |
| `maxPages` | `100` | Hard ceiling — **throws** when hit |
| `maxItems` | — | Stops cleanly |
| `headers` `query` `timeoutMs` `retries` | | As `get()`; `query` applies to the first page |

**It errs loud, not short.** A walk that hits `maxPages`, revisits a URL it
already fetched, or finds a cursor token it has no parameter name for *throws*.
Returning what it has so far would be a partial answer that looks like a
complete one — the bug you find weeks later in a report with missing rows. The
quiet endings are the honest ones: an empty page, no next link, `maxItems`.

## Webhooks that register themselves

A webhook is normally a URL you paste into a provider's dashboard once and then
have to remember. Fine at five, bad at thirty — nothing tells you when somebody
deletes one provider-side. Give the trigger a `register` block and the runner
keeps the subscription in step with the workflow:

```ts
trigger: webhook("github-push", {
  register: {
    async create(ctx) {
      const hook = await ctx.http.post(`https://api.github.com/repos/${repo}/hooks`, {
        config: { url: ctx.url, content_type: "json", secret: process.env.WEBHOOK_SECRET },
        events: ["push"],
      }, { headers: { authorization: `Bearer ${secrets.GITHUB_TOKEN}` } });
      return String(hook.id);            // the provider's id, kept in ctx.state
    },
    async remove(ctx, id) {
      const res = await ctx.http.raw(`https://api.github.com/repos/${repo}/hooks/${id}`, {
        method: "DELETE", headers: { authorization: `Bearer ${secrets.GITHUB_TOKEN}` },
      });
      if (!res.ok && res.status !== 404) throw new Error(`GitHub said ${res.status}`);
    },
  },
})
```

`ctx.url` is this workflow's own hook, externally: `${PUBLIC_URL}/hooks/<path>`.
Set `PUBLIC_URL` or nothing registers.

**It reconciles at boot; it does not register at boot.** Once the server is
listening, each `register` block is compared against the id stored in state:

| On disk | In state | What happens |
|---|---|---|
| enabled | same URL | nothing — this is the redeploy case |
| enabled | different URL | old subscription deleted, new one created |
| enabled | none | created |
| `enabled: false` | any | deleted |
| file deleted | any | **warned about, every boot** — see below |

**Nothing here can fail a boot.** A provider that is down is logged and left
exactly as it was, so the next start tries the same thing again. The server
comes up and serves either way.

**Subscriptions are not deleted on shutdown**, deliberately. A redeploy is a
process restart: deleting on the way down would drop the subscription on every
deploy and race to recreate it, losing events in the window — and `SIGKILL`
never runs the cleanup anyway, so it could never be relied on. Boot-time
reconciliation gets the same result without the hole.

**Deleting the workflow file strands its subscription.** The code that knows
how to call the provider went with the file, so the runner can only tell you
about it — which it does, on every boot, naming the id. To clean up properly,
put the file back with `enabled: false` for one boot; the subscription is then
deleted and the warning stops.

## Calling one workflow from another

`ctx.run(name, input)` runs another workflow and returns its result. The child
gets its own run page, its own retries, and its own checkpoints — which is what
you lose by importing the other workflow's function directly, and what you pay
for in webhook secrets by POSTing your own hook.

```ts
const enriched = await ctx.run<Customer[]>("enrich-customers", { ids });
await ctx.step("deliver", () => ctx.slack.send("#ops", `${enriched.length} ready`));
```

Both run pages show the relationship: the parent lists *Workflows it ran*, the
child says who started it, and its trigger reads `workflow`.

**A failing child fails the parent** — `ctx.run` throws, so wrap it in
`try`/`catch` if that isn't what you want. It also throws, before starting
anything, when:

- the call would **loop** back into a workflow already in the chain
  (`a → b → a`, or a workflow calling itself), or go deeper than 8 workflows;
- the child is **already running** and its `onOverlap` is `"skip"`. Give a
  workflow that gets called by others `onOverlap: "queue"` and the parent waits
  its turn instead;
- the name is unknown or the workflow is disabled.

Two things worth knowing:

- **A child inherits the parent's concurrency slot** rather than taking a
  second one. The parent is blocked waiting for it, so nothing more is running
  at once — and taking a slot per level would deadlock as soon as every slot
  held a parent waiting on a child.
- **A parent timeout aborts its children.** `ctx.signal` is chained down, so a
  child doesn't outlive the run that asked for it.

To make a parent's resume skip a child that already succeeded, wrap the call:
`ctx.step("enrich", () => ctx.run("enrich-customers", { ids }))`.

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

### State is deliberately not redacted

Everything else this project writes to SQLite goes through the secret filter,
because that data is observational — nobody reads a log line back and acts on
it. State is the exception, on purpose: it is operational. Store a rotating
OAuth refresh token and you need the same bytes back, so scrubbing on write
would destroy the value rather than protect it. (Tokens written by
[`defineOAuth`](#oauth2-with-refresh-tokens) are encrypted instead, which
protects the bytes without losing them.)

What holds the guarantee is that **state is never displayed** — no dashboard
view, no API route, no log line renders it. It goes in from a workflow and comes
back out to that workflow alone. Adding a state viewer would put credentials on
a web page; don't.

Values that cannot round-trip are rejected rather than quietly mangled:
`undefined`, functions, bigints, circular structures, and anything over
`STATE_MAX_BYTES` all throw with a message naming the key.

## Approval gates

There is no Wait node here, and there is not going to be one. A run is a single
async function under a `timeoutMs` ceiling; suspending one for a day would mean
holding the process open for a day, which breaks graceful shutdown, the
concurrency cap, and the timeout contract in one go. What replaces it is two
workflows that meet in `ctx.state.shared`:

```
approval-request  (any trigger)  → writes shared "approval:<random-id>" = { status: "pending", … }
                                 → posts the decision links
       …hours or days pass, no run is in flight, the runner can restart freely…
approval-resolve  (GET webhook)  → claims "approval:<id>", acts on it, records the decision
```

That pair no longer ships as example files, so the pattern below is the whole
specification. The resolving half answers a `GET` hook:

```bash
curl "http://localhost:3000/hooks/approval?id=<id>&decision=approve"
```

**What it is not.** No single run sits there pending, so there is nothing to
watch and no "waited 2h 14m" on any timeline. The two halves get separate run
pages, joined only by the `openedByRun` id in the resolving run's result. If you
need one run that genuinely spans the wait, that is a durable execution engine
(Temporal, Inngest), not a change to this runner.

The pieces that make it correct are worth copying if you write your own:

- **The id is a `crypto.randomUUID()`**, because it is the credential (below).
- **`ctx.state.shared.update()` claims the decision**, so a second click — or a
  contradicting one — is refused with `already approved` rather than paying out
  twice. Whether the claim succeeded travels back *inside* the checkpointed
  step result; as a closure variable it would read `false` on a retry and the
  retry would refuse to finish what it had itself just started.
- **The claim and the payout are separate steps.** A payout that fails for good
  leaves an approved-but-unpaid approval, and clicking the link again will not
  fix it — the decision is already made. Resume the failed run from its run
  page instead: the claim is reused from its checkpoint and only the payout
  re-runs, so a resume can never flip a decision on its way through.
- **A TTL is the whole expiry mechanism.** Nothing sweeps abandoned approvals;
  the row simply stops being readable and the link starts answering
  `unknown or expired` — the same answer a made-up id gets, so a wrong guess
  learns nothing.
- **`onOverlap: "queue"`.** The default is `"skip"`, which would drop the second
  of two clicks landing at once — including clicks on two *different*
  approvals — and answer that manager with a skipped run instead of a decision.

### Links a human clicks

A webhook whose caller is a person following a link cannot carry
`WEBHOOK_SECRET`: putting it in the URL would paste the runner's shared secret
into a Slack channel. Such a route opts out explicitly, and authenticates the
caller from its own payload instead:

```ts
trigger: webhook("approval", { method: "GET", schema: query, secret: false })
```

`secret: false` is the opt-out; omitting `secret` still falls back to the global
`WEBHOOK_SECRET`, so this can only happen on purpose. It shifts the whole burden
onto the workflow: an unguessable single-use id in the query string is what
stands between a stranger and an approved refund, which is why the id is
generated with a CSPRNG and why a used one is refused. Do not reach for it on a
route a machine calls — a provider can hold a secret, and should.

The id does reach the run page in the request run's result. Anyone holding the
dashboard password can therefore approve their own request — and could already
trigger any workflow here, so it is not an escalation. It is worth knowing
before you point `PUBLIC_URL` at something and hand out the password.

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

### When a workflow last changed

Each row on the **Workflows** tab carries an **Updated** time, and the workflow
page shows it alongside a `Version` — the first twelve characters of the
SHA-256 of the file. Both come from the same place: at boot the runner hashes
every workflow file and compares it to what it recorded last time, moving the
timestamp only for the ones whose bytes actually changed. Restarting the server
does not make everything look freshly edited, and `sha256sum` on your copy of
the file tells you whether the deploy shipped the edit you think it did.

The file's mtime deliberately isn't used. A deploy is a fresh `git clone`, so
every file carries the same checkout time and the column would report every
workflow as updated at the last deploy.

Two things it does not claim. The hash covers the workflow file alone, so a
workflow whose behaviour changed because `src/integrations/http.ts` changed
does not show as updated — the question being answered is "when was this
workflow last edited". And a workflow's first boot records it as added, so a
runner that already had workflows before this existed dates them all to the
deploy that introduced it, once.

`GET /api/workflows` carries the same three fields: `version`, `addedAt`,
`updatedAt`.

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

### The secret store — changing a credential without a redeploy

Env vars are read once, at process start, so changing one is a restart at best
and an image rebuild at worst. The store is the layer above them: credentials
in the database, encrypted, editable while the server runs.

```bash
bun run secret -- list                      # names and when they changed
bun run secret -- set BREVO_API_KEY         # then paste the value, then Ctrl-D
bun run secret -- get BREVO_API_KEY         # masked; --reveal to see it
bun run secret -- rm  OLD_API_KEY
```

Set `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`) and nothing else
changes: no workflow file is edited, and `defineSecrets` keeps working exactly
as above.

**A stored value wins over the same name in the environment.** If it were the
other way round, changing a credential a deploy had already set would need
another deploy — which is the thing this exists to avoid. Deleting a stored
value puts the environment's back.

**A change is live on the next run, with no restart.** `defineSecrets` returns
an object that reads through to the store on every property access, so:

```ts
run: () => ctx.http.get(url, { headers: { key: secrets.API_KEY } })   // live
```

The one place that doesn't reach is a value captured at module scope, outside
`run()` — a closure holds the string from boot and nothing can update it.
Where a helper needs one at import time, pass a getter instead:

```ts
trigger: webhook("tally", { verify: tallySignature(() => secrets.SIGNING_SECRET) }),
```

**Deploy order stops being lockstep.** A workflow whose credentials aren't set
still stops the boot — but you can now set them on the running instance
*before* pushing the workflow, so the deploy that introduces it just works.
That is why `bun run secret` runs before the loader rather than after it.

**Values are AES-256-GCM encrypted with the same scheme as OAuth tokens**, so
`sqlite3` on the `secrets` table shows ciphertext and a `/data` backup isn't a
pile of live credentials. Losing the key costs the stored values, not access:
the store warns and falls through to the environment rather than failing the
boot.

| Where you write | When it takes effect |
| --- | --- |
| `PUT /api/secrets/:key` | immediately — the write lands in the running process |
| `bun run secret -- set` | within `SECRET_REFRESH_MS` (default 10s) |
| The environment | next process start |

The write API sits on `/api` behind the dashboard's basic auth, and the
dashboard itself stays read-only — there is no form to edit a credential in a
browser. `GET /api/secrets` lists names and timestamps; no route ever returns
a value.

**Writes are validated against the schema the workflow declared**, so
`secret set BREVO_API_KEY=oops` is rejected at the point you make the mistake
rather than at 3am. A key nothing declares is accepted with a warning.

### Credentials — several values that only work together

A secret is one value under one name. A credential is a platform: the fields it
wants, kept as one thing, with a button that proves they work.

```ts
import { defineCredential } from "../src/core/define.ts";

const smtp = defineCredential("smtp", "main");

// inside run() — every read resolves the current stored value
await ctx.http.post(url, { headers: { host: smtp.host } });
```

The fields are ordinary rows in the same encrypted store, under derived names
(`SMTP_MAIN_HOST`, `SMTP_MAIN_PASS`, …), so redaction, rotation and the
cross-process refresh all behave exactly as they do for a plain secret. Values
are always strings, because that is what an environment variable is —
`Number(smtp.port)` is your job.

Known platforms live in `src/core/providers.ts`: SMTP, Notion, Telegram, Slack,
Discord, Brevo. Each declares its fields and one cheap read-only call that
answers *are these credentials live*. Adding one is a few lines there. It is
code rather than a form on the dashboard on purpose — a request the server runs,
configured from a browser and stored in the database, is the shape this project
left n8n to avoid.

#### Connecting one

The Credentials tab groups credentials and loose secrets into folders, shows
what is connected, and tests on demand. Set `DASHBOARD_WRITE=1` to get the
buttons; without it the tab renders the same page read-only and every write
route answers 403.

That flag is worth turning on if you write workflows with an AI coding agent.
The agent writes the `defineCredential` line; you paste the value into the form.
Every other route into the store — `bun run secret`, `PUT /api/secrets/:key` —
means whoever is driving handles the raw value on the way past, and when that is
an agent, the credential ends up in a transcript. It is hygiene rather than a
security boundary: anything that can read `.env` can decrypt the store anyway.

#### A credential that isn't connected yet doesn't stop the boot

This is the one place the boot-time-validation rule bends, and it bends because
it has to. A missing `defineSecrets` key still kills the process on deploy. A
missing *credential* cannot: the dashboard is where you would go to connect it,
and a server that refused to start never serves that page.

So the server comes up, logs the warning, marks the workflow **Blocked** on the
dashboard, and refuses to start a run of it:

```
warn  credential notion:mantra is not connected — the-mantra/runway-alert.ts
      cannot run until it is (Credentials tab)
```

Nothing runs half-configured; you just get a server you can fix it from. A typo
in the *platform* name is still a boot failure, because no amount of dashboard
work will fix `defineCredential("notionn", …)`.

#### Feeding the built-in clients

`ctx.email` reads `SMTP_HOST` for itself, not `SMTP_MAIN_HOST`. Tick **use this
for the built-in client** and the credential fills those bare names at boot —
so connecting SMTP on the dashboard reaches `ctx.email` without any workflow
naming a credential. One credential per platform can claim it, and it wins over
the same name set in `.env`, which is what makes rotating a password a form
submission rather than a redeploy.

#### Over the API

```bash
curl localhost:3000/api/providers                       # fields each platform wants
curl localhost:3000/api/credentials                     # what is stored, never a value
curl -XPUT localhost:3000/api/credentials/smtp/main \
     -d '{"values":{"host":"smtp.example.com","user":"me","pass":"…"},"primary":true}'
curl -XPOST localhost:3000/api/credentials/smtp/main/test
```

`PUT` runs the test and returns its result. No route returns a stored value —
`fields` says which ones are set, and that is all it says.

### OAuth2 with refresh tokens

Some providers won't take a static key at all: Notion, HubSpot, Salesforce,
Xero, Google-as-a-person all issue an access token that dies in an hour and
expect you to refresh it. `defineOAuth` owns that lifecycle.

```ts
const notion = defineOAuth("notion", {
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  auth: "basic",          // "body" (the default) puts the client id/secret in the form
});

// inside run() — refreshes first if this token is close to expiring
await ctx.http.get("https://api.notion.com/v1/users", {
  headers: { authorization: `Bearer ${await notion.accessToken()}` },
});
```

The provider's details live in the file; its credentials live in the
environment, named after the credential:

```bash
OAUTH_NOTION_CLIENT_ID=…
OAUTH_NOTION_CLIENT_SECRET=…
OAUTH_NOTION_REFRESH_TOKEN=…      # obtained once, by hand — see below
OAUTH_ENCRYPTION_KEY=…            # openssl rand -base64 32
```

All four are validated at boot like any other secret, so a missing one stops
the deploy. Two workflows may declare the same credential — they share one
stored token — but declaring one name against two different token URLs throws.

| Method | Notes |
|---|---|
| `accessToken()` | A usable token, refreshing first if it's within a minute of expiry (or half its life, whichever is sooner) |
| `refresh()` | Forces one, for the provider that 401s a token it said was good. Retry the call once; don't loop |
| `status()` | The stored expiry and last-refresh dates, and **no token** — so a workflow can report how long is left without holding the credential |

#### Long-lived tokens that refresh themselves

Meta's Threads and Instagram tokens are the other shape: no client secret, no
separate refresh token, and a life measured in weeks. You trade the token you
hold for a later-expiring copy of itself, and *that copy* is what you send next
time. `flow: "self"` speaks it:

```ts
const threads = defineOAuth("threads-huzaifah", {
  tokenUrl: "https://graph.threads.net/refresh_access_token",
  flow: "self",
  grantType: "th_refresh_token",   // "ig_refresh_token" for Instagram
  defaultTtlSeconds: 60 * 24 * 60 * 60,
});
```

Only `OAUTH_<NAME>_REFRESH_TOKEN` is read — it holds the long-lived token
itself — and no client id or secret is asked for, because the provider has no
concept of them. Storage, encryption, the refresh lock and the seed rule are
identical to the standard flow.

**These need a scheduled `refresh()`, and it is not optional.** A token good
for 60 days is never close enough to expiry for `accessToken()` to renew it on
the way past, so nothing keeps it alive by being used — and Meta kills a token
that goes its whole life without a refresh, permanently, with no recovery but a
manual re-auth. A weekly cron calling `refresh()` is the whole safety margin;
`status()` is how that workflow reports what is left of it. Threads also
refuses to refresh a token younger than 24 hours, so such a workflow should
check `status().refreshedAt` before asking. See
`workflows/the-mantra/threads-token-auto-refresh.ts`.

**There is no "Connect account" button, and there isn't meant to be one.** The
authorization-code flow needs a browser, a redirect URL, and a place to park
half-finished consent — all of it to be done once per credential, ever. You run
that flow yourself, out of band, and paste the refresh token into the
environment. Everything after that point is what this owns:

- refreshing before expiry, on the way into every call;
- keeping the **rotated** refresh token, since most providers kill the old one
  the moment it is used;
- one refresh per credential at a time. Twenty concurrent runs finding an
  expired token produce one refresh and share its result, because two refreshes
  would mean the second stores a token the provider has already invalidated.

**These rows are encrypted; the rest of `ctx.state` is not.** A cursor in the
clear is fine and keeps `sqlite3` useful for debugging. A dozen services' live
refresh tokens in a backup is not. Values under `@oauth:` are AES-256-GCM with
a key from `OAUTH_ENCRYPTION_KEY`; everything else in state is stored as given.
Losing that key costs the stored tokens, not access — the next call falls back
to the refresh token in the environment, with a warning.

**When a refresh token finally dies** — revoked, or spent by something else —
the provider says `invalid_grant` and the run fails naming the variable to
replace. Paste a new one into `OAUTH_<NAME>_REFRESH_TOKEN`: the stored chain is
recognised as stale (it was grown from a different seed) and abandoned on the
next call. The corollary is that the environment stays the source of truth —
reverting that variable to an older value discards the live chain too.

## Security

- **Dashboard**: set `DASHBOARD_USER` / `DASHBOARD_PASS`. Without them it's
  public, and the log says so on every boot.
- **Webhooks**: set `WEBHOOK_SECRET`. Required on every `/hooks/*` call as an
  `X-Automator-Secret` header, a Bearer token, or `?secret=`. Compared in
  constant time. Per-workflow overrides via `webhook(path, { secret })`.
- Webhook routes are **not** behind basic auth — callers use the secret. That
  separation is deliberate.
- **A provider that signs instead of echoing a token** gets `verify` — see
  [Webhooks that sign](#webhooks-that-sign) below.
- `/healthz` is open for container health checks and carries no useful data.
- **OAuth refresh tokens** are encrypted at rest with `OAUTH_ENCRYPTION_KEY`
  (32 bytes, base64 or hex). Everything else in `ctx.state` is not — see
  [OAuth2 with refresh tokens](#oauth2-with-refresh-tokens).

### Webhooks that sign

Most providers don't send your secret back. They keep it, HMAC the request
body with it, and send only the digest in a header — so the shared-secret
check can never match, and the call is a 401 no matter what you paste where.
`verify` authenticates those callers from the request itself:

```ts
trigger: webhook("pblsh/agreement-signed", {
  method: "POST",
  schema: payload,
  verify: tallySignature(secrets.TALLY_SIGNING_SECRET),
})
```

Anything else, via the four things providers differ on — which header, which
hash, base64 or hex, and whether the value carries a prefix:

```ts
verify: hmacSignature({
  header: "x-hub-signature-256",        // GitHub
  secret: secrets.GITHUB_WEBHOOK_SECRET,
  encoding: "hex",
  prefix: "sha256=",
})
```

Or a function, for a scheme that isn't an HMAC of the body at all:

```ts
verify: ({ body, headers }) => headers.get("x-tenant") === "acme" && body.length < 65_536,
```

**The body is the undecoded text.** An HMAC recomputed over a parsed and
re-serialised object won't match — a reordered key or a dropped space is a
different digest — so the raw string is what `verify` receives, and the
schema parse happens afterwards from that same string.

**`verify` runs before a run exists.** A forged call costs a warning in the
log and a 401; it never reaches the database or your workflow. A verifier that
throws is treated as a failed check, not a 500, and the reason is logged.

**`secret` and `verify` are alternatives.** Declaring both stops the boot,
naming the file. Which one was actually guarding the route would otherwise be
a guess, and the guess people make is "both".

## Operations

```bash
bun run list                        # every workflow and its trigger
bun run trigger -- send-signed-agreement   # run one now, exit non-zero on failure
docker compose logs -f automator
```

- Runs interrupted by a restart are marked failed at boot, not left `running`,
  and an async webhook that never finished is run again — see
  [The webhook inbox](#the-webhook-inbox).
- Any run with a recorded input can be replayed from its run page — see
  [Replay](#replay--the-other-button).
- Run history is pruned nightly (`RUN_RETENTION_DAYS`, default 30). The same
  job sweeps expired `ctx.state` keys, whatever retention is set to.
- `SIGTERM` stops the scheduler and waits up to `SHUTDOWN_TIMEOUT_MS` (20s) for
  in-flight runs before exiting. A run still queued when that starts is
  recorded as `skipped`, not silently dropped.
- At most `MAX_CONCURRENT_RUNS` runs execute at once across every workflow
  (default 10, `0` = unlimited). Runs past the cap **queue** — a webhook that
  arrives during a burst is slow, never lost. `/healthz` reports `running` and
  `queued`, which is the only way to see a queue that isn't draining.
- Set `ALERT_WEBHOOK_URL` to a Slack or Discord incoming webhook to get a ping
  on every workflow that exhausts its retries. Set `PUBLIC_URL` and the alert
  links straight to the run page.

### The webhook inbox

A deploy restarts the process, and an async webhook used to live only in the
closure a `queueMicrotask` was holding. A restart between the `202` and the run
therefore dropped work the caller had already been told was accepted — silently,
with nothing on the dashboard to say it happened.

So the payload is written to an `inbox` table *before* the 202 goes back, and
settled once the run it started reaches a decision. At boot, anything still
pending is run with its recorded input. Nothing to configure; `/healthz`
reports `inbox`, which is the number accepted and not yet finished — steady
state is `0`.

What it does and does not cover:

- **A run that was interrupted is run again from the top.** Recovery is a
  replay, not a [resume](#checkpoints-and-resume): a resume carries a
  checkpoint key and no `ctx.input`, so a workflow that reads its payload would
  get an empty object. That makes recovery **at-least-once** — the same
  guarantee polling gives — so a run killed half way through repeats the steps
  it had already done.
- **A repeat of the same delivery inside `INBOX_DEDUP_MS` (5 min) is treated
  as a retry** and answered `202 {"duplicate": true}` without running.
  Byte-identical payloads further apart are two real events, not one.
- **A run dropped by `onOverlap: "skip"` is finished, not resurrected.** Only a
  skip *the shutdown caused* stays pending.
- **`respond: "sync"` is deliberately not recorded.** That caller is still
  holding the connection: it sees the failure and decides for itself, and a
  delivery replayed after a restart would produce a result nobody is waiting
  for.
- **A payload larger than `CHECKPOINT_MAX_BYTES` runs but is not recorded**, and
  says so in the log. A truncated payload fed back into a workflow is worse
  than an honest gap — the same refusal [Replay](#replay--the-other-button)
  makes.
- **It cannot catch what arrives while the process is down.** Nothing in-process
  can; that window belongs to the provider's own retries. This closes the
  window where *we* said yes and then lost it.

Deliveries that can never run — the workflow no longer takes webhooks, or the
delivery is older than `INBOX_MAX_AGE_MS` (24h) — are recorded as `abandoned`
with a log line, rather than deleted or retried forever. Settled rows age out
with `RUN_RETENTION_DAYS`; pending ones are never pruned at any age.

## Deploying

Any Docker host. The `Dockerfile` runs as a non-root user, reaps zombies
through tini so `SIGTERM` reaches the process, and health-checks itself on
`/healthz`. Whatever you deploy to, **persist `/data`** — that one SQLite file
is the whole of your run history, durable state, and OAuth refresh tokens.

### Docker Compose

`docker-compose.yml` is the whole deployment — see [Quick start](#quick-start).
`workflows/` is bind-mounted read-only from the host, so the running container
reads them from the checkout rather than from the image. That makes
`docker compose restart` (~0.2s, no build) enough to pick up a workflow change.

The port is published by `compose.local.yml`, which is only ever loaded when
named. It is deliberately *not* called `docker-compose.override.yml`: Compose
auto-loads that name for a bare `docker compose up`, which is exactly how
Coolify starts the stack, and the server must not publish 3000.

```bash
bun run up                         # localhost:3000
HOST_PORT=3100 bun run up
bun run down
```

### Coolify

Point a new resource at this repo:

| Field | Value |
| --- | --- |
| Build pack | **Docker Compose** |
| Compose file location | `/docker-compose.yml` |
| Base directory | `/` |

Not Railpack or Nixpacks. Both autodetect Bun and will boot something, but
they ignore what the Dockerfile sets up — the non-root user, tini, and
`DATABASE_PATH=/data/automator.db`.

**Why Compose over the Dockerfile build pack.** Both work, and — measured, not
assumed — **neither is meaningfully faster for a `git push` deploy**. Docker's
layer cache means a workflow-only change invalidates just the final `COPY
workflows` layer: 0.78s against a warm cache, versus 5.5s for a full cold
build. Coolify runs `docker compose up -d --build` either way, so Compose does
not skip the build.

What Compose actually buys is the deployment *config* — volume, health check,
log rotation, port exposure — living in the repo under review, instead of in
form fields in the Coolify UI. Plus one escape hatch: because `workflows/` is
bind-mounted, `git pull && docker compose restart` on the server applies a
workflow change in ~0.2s with no build at all. Useful in a hurry; not what a
normal push does.

If you are already on the Dockerfile build pack and it works, this is not worth
switching for — the two build packs use different volumes, and migrating costs
more than the difference is worth.

The compose file is written for this: no `container_name` and no fixed image
tag, both of which Coolify assigns per deployment and which collide if pinned;
`env_file` is marked optional, because the repo has no committed `.env` and
Coolify injects the environment itself; and the service uses `expose` rather
than `ports`, so the dashboard is reachable through Coolify's proxy and not
also on plain HTTP at `server-ip:3000`.

Assign the domain in Coolify's UI and point its health check at `/healthz`.

**Persistent storage.** The compose file declares the `automator-data` volume
itself, so there is nothing to add in the UI. Everything lives there: run
history, `ctx.state`, OAuth refresh tokens, and the secret store.

> **Switching from the Dockerfile build pack? Back up first.** The two build
> packs use different volumes, so the new deployment starts on an empty
> database — including an empty secret store. Copy the file out before you
> switch:
>
> ```bash
> docker cp $(docker ps -qf name=automator):/data/automator.db ./automator-backup.db
> ```
>
> Then deploy once on Compose, stop it, and copy the old volume across:
>
> ```bash
> docker run --rm -v OLD_VOLUME:/from -v NEW_VOLUME:/to alpine sh -c "cp -a /from/. /to/"
> ```
>
> `docker volume ls` names both. Re-entering the secrets by hand is the other
> option, and for a small deployment it is often the faster one.

**Environment.** Before the first deploy:

```
TZ=Asia/Kuala_Lumpur
DASHBOARD_USER=admin
DASHBOARD_PASS=…
WEBHOOK_SECRET=…                  # openssl rand -hex 32
PUBLIC_URL=https://automator.example.com
```

Plus `SECRETS_ENCRYPTION_KEY` if you want the [secret
store](#the-secret-store--changing-a-credential-without-a-redeploy) — with it,
every other credential can go in the store instead of here, and changing one
stops being a Coolify redeploy.

Whichever you use, every key your workflows declare with `defineSecrets` has to
resolve — a missing one stops the boot rather than failing at 3am.
`enabled: false` does not exempt a workflow from that: `defineSecrets` runs when
the file is imported, before the loader looks at `enabled`. A workflow whose
credentials you don't have yet has to come out of `workflows/` altogether, or
have its credentials put in the store first.

Don't set `PORT` or `DATABASE_PATH` — the Dockerfile already has both right.

**Changing a workflow** is a push and a redeploy. The redeploy is fast because
of Docker's layer cache, not because of the build pack: only the final `COPY
workflows` layer re-runs, measured at 0.78s. Add Coolify's own overhead — clone,
image swap, health check — and expect a handful of seconds end to end, with the
app down for about two of them.

## Trade-offs

Worth knowing before you commit:

- **Workflows live in the repo.** Changing one means a redeploy, and on a
  single-process SQLite app that means a restart — two overlapping processes
  would double-fire every cron and both write the same database, so a
  zero-downtime rolling deploy is not available here. The redeploy itself is
  cheap — Docker's layer cache reduces a workflow change to one small `COPY`
  layer — so the cost is a couple of seconds of downtime, not a long build. In
  exchange for all of it there is no
  code sandbox to secure. Credentials are the exception and no longer need any
  of this — see the
  [secret store](#the-secret-store--changing-a-credential-without-a-redeploy).
- **The dashboard is read-only, except for credentials.** Everything else is a
  view: no workflow editor, no way to change what runs from a browser.
  Credentials are the deliberate hole in that, and `DASHBOARD_WRITE=0` closes it
  again for a deployment that would rather keep the old guarantee. See
  [Credentials](#credentials--several-values-that-only-work-together) for why
  the hole is worth having.
- **Single process, no external queue.** Fine for hundreds of runs a day.
  Concurrency is capped in-process (`MAX_CONCURRENT_RUNS`) and the queue lives
  in memory, so a restart mid-burst loses what hadn't started — those runs are
  recorded as skipped. If you need horizontal scale or work that survives a
  crash mid-workflow, you want a durable execution engine (Temporal, Inngest),
  not this.
- **Checkpoints are memoised results, not deterministic replay.** Resume skips
  steps that already succeeded; it does not rewind side effects that happened
  *inside* a step before it threw. Keep each step to one logical action and
  that distinction stays invisible.
- **No Wait node.** Nothing suspends a run and picks it up tomorrow. Approvals
  and other human-paced waits are two workflows joined by shared state — see
  [Approval gates](#approval-gates) for the pattern and what it costs.
- **No visual editor.** That's the entire 1.9GB you're not shipping. The
  Credentials tab is the only page with a form on it, and it edits credentials —
  never what runs.

## For AI agents

[AGENTS.md](AGENTS.md) has the working instructions — layout, how to add a
workflow, the invariants that have already caused bugs, and how to verify.
[CLAUDE.md](CLAUDE.md) points there.

## License

MIT.
