# Changelog

What changed, why, and what was traded away. Newest first.

Entries record the *reasoning*, not just the diff — `git log` already has the
diff. If a change settled a question, say what was settled and what the losing
option was, so nobody relitigates it from scratch.

## 2026-09-05

### Compose is the deploy path, so a workflow change is a restart

The Dockerfile build pack bakes `workflows/` into the image, so editing one
line of a workflow meant rebuilding and redeploying the whole thing. The
compose file already bind-mounted the directory; it just wasn't what Coolify
was pointed at, and it had three things in it that a Coolify deployment trips
over.

Measured after the change: `docker compose up -d --build` against a modified
workflow completes in about two seconds, because the layer cache makes the
build a no-op and the bind mount means the file is already in place.

**Decided along the way:**

- **`expose`, not `ports`.** Publishing 3000 on the host makes the dashboard
  answerable over plain HTTP alongside the proxy's HTTPS, on basic auth alone.
  Local use needs the published port though, so it moved to a second file —
  named `compose.local.yml`, *not* `docker-compose.override.yml`. The override
  name is auto-loaded by a bare `docker compose up`, and that turned out to be
  literally Coolify's start command, so the "server never publishes" property
  would have depended on a flag nobody controls. A name Compose only loads when
  asked for makes it unconditional. Verified with `docker compose up --dry-run`
  rather than assumed.
- **`env_file` is optional.** `.env` is gitignored, so a required one fails the
  deploy on a file that is never meant to be committed, and Coolify injects the
  environment itself.
- **No `container_name`, no fixed `image` tag.** Coolify derives both per
  deployment; pinning them makes two deployments on one host collide.
- **Zero-downtime was considered and rejected as unavailable.** Two overlapping
  processes would share one SQLite file and each run their own in-process
  scheduler, so every cron fires twice across the swap. Single-process is the
  settled architecture; the restart is the price, and it is now seconds rather
  than minutes.
- **The build packs use different volumes.** Switching drops you on an empty
  database — run history, state, OAuth tokens, and the secret store. The README
  carries the backup and volume-copy steps; this is the one part of the switch
  that can lose data.

### Credentials in the database, so rotating one is not a redeploy

Env vars are read once at process start, so changing a credential meant a
Coolify redeploy — an image rebuild for a one-line change, plus the restart.
`src/core/secret-store.ts` adds an encrypted table that overrides the
environment, `bun run secret -- set KEY` writes to it, and the value is live on
the next run.

The README named this shape a while ago and left it unbuilt on the grounds that
"env vars are the right answer until they aren't". The rebuild-per-rotation is
where they stopped being.

**Decided along the way:**

- **A stored value beats an env value.** The other order is the obvious one and
  it is wrong: a credential a deploy had already set could then only be changed
  by another deploy, which is the entire thing this removes. Deleting a stored
  value restores the environment's, so the fallback is never lost.
- **`defineSecrets` returns a proxy, not a snapshot.** This is what let the
  change land without editing a single workflow: the type is identical and
  `secrets.API_KEY` still reads like a property, but each access resolves the
  current value. A snapshot would have made the store a boot-time-only feature
  and bought nothing over an env var.
  - The cost is that a read at *module* scope is still frozen — a closure holds
    the string from import. `hmacSignature` now takes `string | (() => string)`
    for exactly this reason, and `tallySignature(() => secrets.X)` is the
    documented form. Rejected making every workflow read secrets inside `run()`
    instead; a getter at the one import-time call site is a smaller tax.
  - A live value that fails its schema warns once and keeps the last good one
    rather than throwing. An operator's typo should not take down a workflow
    that was working a second ago.
- **Stored values are mirrored into `process.env`.** Integrations read their own
  credentials from the environment inside their factories, so without the
  mirror the store would have covered `defineSecrets` keys and silently not
  covered `SLACK_BOT_TOKEN`. That in turn forces `loadSecretStore()` to run
  before the loader imports anything.
- **The CLI runs before the loader, and therefore without schemas.** Setting a
  credential for a workflow you have not deployed yet is the main win — it
  breaks the lockstep where a workflow and its secrets had to ship in the same
  deploy — and `loadWorkflows()` would abort on that workflow's missing key
  first. So `set` does a tolerant import pass purely to collect zod schemas,
  swallowing every failure, and warns when it could not validate. Rejected
  validating only in the API: the CLI is the path an operator reaches for, and
  an unvalidated write there is how you find out at 3am.
- **Writes go to the CLI and `/api`, not the dashboard.** A credential form in
  the browser is precisely the read-only-dashboard rule being given up, and the
  rule is what means a browser cannot break production. `GET /api/secrets`
  returns names and timestamps; no route returns a value, and `secret get`
  masks unless you pass `--reveal`.
- **The CLI writes to the database, not to the running server**, so it needs no
  URL and no auth. The server picks the write up on a `SECRET_REFRESH_MS` tick
  (default 10s) that probes one aggregate over a table with tens of rows. An
  API write skips the wait and applies in-process. Rejected making the CLI an
  HTTP client — it would stop working exactly when you need it, on a server
  that will not boot.
- **`SECRETS_ENCRYPTION_KEY` falls back to `OAUTH_ENCRYPTION_KEY`**, so an
  existing deployment needs no new variable, and setting both separates the two
  concerns for anyone who wants that. Encryption moved to `src/core/crypto.ts`
  and both callers share it; the wire format is byte-identical to what OAuth
  wrote before, because tokens in the field are already encoded that way.
- **An unreadable value warns and falls through to the environment.** Same
  recovery OAuth already took. A deployment that rotated its master key and can
  no longer start is worse than one running on env vars, and a boot that dies
  on an undecryptable row would be exactly that.
- **What did not change:** a missing credential still stops the boot. The store
  does not soften that into per-workflow quarantine, and does not need to —
  setting the secret on the running instance *before* pushing the workflow is
  now possible, which is what the lockstep actually cost.

### PBLSH authenticates Tally by its signature

`workflows/pblsh/send-signed-agreement.ts` now verifies Tally's
`tally-signature` instead of expecting `WEBHOOK_SECRET` in the request. Tally
has no field for a custom header, so the only alternative was `?secret=` in
the webhook URL — and that puts the secret in every access log between Tally
and here, ours included.

**Decided along the way:**

- **`TALLY_SIGNING_SECRET` is boot-stopping**, declared with `defineSecrets`
  like `BREVO_API_KEY`. A signing secret that is absent is a webhook with no
  authentication, and the deploy should fail rather than accept anything that
  reaches the path.
- **The old `?secret=` URL stops working.** `verify` replaces the shared-secret
  check rather than adding to it, so the query parameter is no longer read for
  this route. The webhook URL in Tally goes back to being just the URL.

### `verify`, for the providers that sign instead of echoing

`WEBHOOK_SECRET` assumes the caller sends the secret back. Most providers
don't: they keep it, HMAC the body with it, and send only the digest in a
header — so the shared-secret check can never match and every call is a 401,
however the secret is configured at either end. `webhook(path, { verify })`
authenticates those callers from the request itself, with `hmacSignature()`
for the general shape and `tallySignature()` for the one in use here.

**Decided along the way:**

- **The body reaches the verifier as undecoded text.** An HMAC recomputed over
  a parsed and re-serialised payload does not match — a reordered key or a
  dropped space is a different digest — so `app.ts` now reads the body once as
  a string and both the verifier and the schema parse work from it. This is
  the invariant that breaks if anyone reinstates a parse-before-verify.
- **`secret` and `verify` are alternatives, enforced at boot.** Declaring both
  stops the load naming the file, rather than quietly applying one. Which one
  was guarding the route would otherwise be a guess, and the guess people make
  is "both".
- **A verifier is a function, and the built-ins are just functions.** Providers
  differ on four things — header, hash, encoding, prefix — so `hmacSignature`
  takes those four and `tallySignature` is one line of it. A scheme that isn't
  an HMAC of the body writes a closure instead of waiting for a provider
  helper to be added here.
- **`hmacSignature` throws when handed no secret**, at import, rather than
  returning a verifier that rejects everything. An HMAC keyed on nothing is
  computable by the caller too, and a webhook that 401s forever with a clean
  boot log is the worse failure.
- **A verifier that throws is a failed check, not a 500.** The caller gets the
  same 401 as a bad digest; the reason is logged for us, not returned to them.
- **Verification precedes the run.** A forged call costs a warning and never
  reaches the database, so run history stays a record of real events rather
  than of everyone who probed the endpoint.
- **`parseBody` rebuilds a Request for form bodies** so multipart parsing
  stays the runtime's job. The cost is that a binary part is decoded as text;
  webhook payloads here are documents, not uploads.

### The dashboard refreshes by fetch, not by re-navigating

`<meta http-equiv="refresh" content="15">` re-ran the whole navigation every
15 seconds, which under basic auth means re-running the credential exchange
every 15 seconds. A browser that declines to reuse the credentials answers
with a prompt and an error page, so an intermittent auth hiccup became a
permanent-looking one: four chances a minute to lose the page you were reading.
`.wrap` is now swapped in from a `fetch` instead.

**Decided along the way:**

- **A failed refresh leaves the page alone.** That is the whole point. A
  re-navigation replaces what you were reading with a browser error page; a
  failed fetch is caught and the next tick tries again, so a redeploy or a
  restart no longer costs you the run you had open.
- **The interval is read back off `.wrap` after every swap.** A run page asks
  for 5 seconds while the run is `running` and `null` once it is not, so the
  polling stops on its own when the finished page arrives — a fixed
  `setInterval` would have outlived the reason it was started.
- **A hidden tab is not polled.** Same 15 seconds, but nothing is fetched
  while nobody is looking, which matters for a page people leave open.
- **No-JS loses auto-refresh, and that is accepted.** The alternative is
  keeping the meta tag as a fallback, which would keep the bug for exactly the
  case that reported it.

### A 401 a browser can render

`basicAuth` answers with its own response, and that response is an
`application/octet-stream` body reading `Unauthorized`. A browser handed a
binary content type for a top-level navigation cannot display it, so
dismissing the credential prompt showed Chrome's *this site can't be reached*
rather than a 401 — the dashboard looked down when it was only locked. The
middleware is now wrapped, and the 401 is the styled page in `views.ts`.

**Decided along the way:**

- **Wrapped rather than configured.** `basicAuth`'s `invalidUserMessage` builds
  the same `new Response(string)` with no content type, so it cannot fix this;
  a string stays octet-stream and an object becomes JSON. Catching the
  `HTTPException` is the only seam that gets to set the header.
- **The `WWW-Authenticate` header is copied off the original response**, not
  rebuilt from the realm. It is the entire reason a prompt appears, and
  re-deriving it would have been one more thing to keep in step with Hono.
- **The page says which two env vars to set.** Whoever hits this is either
  deploying it or has forgotten the password, and both are served by naming
  `DASHBOARD_USER` and `DASHBOARD_PASS` instead of the word "Unauthorized".

### `workflows/` ships only real work

The nine demo workflows are gone; `workflows/pblsh/send-signed-agreement.ts`
is the only one left. They were written to illustrate the runner's features and
they did that job in the README, which still documents every pattern they
showed.

**Decided along the way:**

- **The demos were a deploy hazard, not just clutter.** Every one that declared
  a secret was a boot-stopping requirement for a credential nobody here needs —
  `daily-digest` demanded a `GITHUB_TOKEN` to summarise commits on `oven-sh/bun`,
  a repo we have nothing to do with. Feature illustration is the README's job,
  where a wrong example costs a reread; in `workflows/` it costs a deploy.
- **The pattern docs stay, the file pointers go.** Checkpoints, pagination,
  polling, durable state, and approval gates are still documented in full —
  only the "here is the runnable example" lines were cut, because a pointer to
  a deleted file is worse than no pointer. The approval section now reads as
  the specification it always was.
- **`APPROVAL_SLACK_CHANNEL` came out of `.env.example`.** Nothing in `src/`
  ever read it; it was the deleted `approval-request` workflow's own
  configuration, and left behind it would have looked like a runner setting.
- **CHANGELOG entries were left alone.** Older entries describe files that no
  longer exist, which is what history is for — rewriting them to match the
  current tree would destroy the reasoning they exist to keep.

### Coolify deploys build the Dockerfile, not a build pack

README gained a Coolify section, because the settings that path needs are not
guessable from the repo and two of them fail quietly.

**Decided along the way:**

- **Build pack is Dockerfile, not Railpack.** Railpack autodetects Bun and
  boots, which is the trap — it ignores the non-root user, tini (so `SIGTERM`
  never reaches the process and `SHUTDOWN_TIMEOUT_MS` stops meaning anything),
  and `DATABASE_PATH=/data/automator.db`. A working dashboard on a database
  nothing persists looks like a successful deploy.
- **The `/data` mount leaves Source Path empty.** Blank is a named volume,
  which inherits `/data`'s bun:bun ownership from the image. A bind mount to a
  fresh host directory is root-owned, and the container — non-root by
  construction — cannot open the database there. The UI's placeholder in that
  field reads like a default and is not one.
- **The Compose path and the Coolify path differ on `workflows/`**, and the
  README now says so per-path instead of claiming the read-only host mount
  everywhere. Compose bind-mounts it, so a workflow edit is a restart; a
  Dockerfile build bakes it in, so it is a push and a redeploy.
- **Boot-stopping secrets are a deploy-time concern**, so the README says so
  where you set the environment. `enabled: false` does not exempt a workflow
  from its `defineSecrets` — that runs at import, before the loader reads
  `enabled` — and the asymmetry is worth one sentence there rather than a bug
  report.

### PBLSH: the signed agreement, off n8n

`workflows/pblsh/send-signed-agreement.ts` replaces the n8n graph of the same
name — Tally posts a Content Buyout Agreement submission, the creator gets the
signed PDF by email, Huzaifah gets a Telegram summary. Five nodes became four
steps, and the port fixed things on the way across rather than transcribing
them.

**Decided along the way:**

- **Fields are read by label, not by index.** The n8n Telegram node read
  `fields[2]`, `fields[3]`, `fields[7]` … so dragging a question in the Tally
  editor would have sent the KTP number as the date of birth, silently and
  forever. Labels are the only stable handle in the payload, so all of it goes
  through one lookup, and a renamed question now fails the run with the label
  named in the error instead of delivering a wrong summary.
- **Every value interpolated into the Telegram HTML is escaped.** A creator
  named "Tan & Sons" broke the whole message under `parse_mode: HTML`; the n8n
  version was one apostrophe away from finding that out in production.
- **The payload is read inside the first step, not at the top of `run()`.**
  A resumed run has no `ctx.input`, so reading it early makes a resume report
  the form's own questions missing. This is the second workflow to need that
  shape, after `approval-resolve`.
- **The PDF download is deliberately *not* checkpointed.** A few hundred KB of
  base64 as a step result would be truncated on the way into SQLite and leave
  the run page holding a useless copy, so the buffer leaves the step through a
  closure and the result is just its size — which means a checkpoint hit would
  hand a later step an empty buffer. `checkpoint: false` is the only
  combination of those two that is correct; re-downloading on a resume is
  cheap, and it was verified by resuming a run that had failed at the email.
- **Brevo over HTTP rather than `ctx.email`.** The SMTP client would work, but
  its credentials are global to the runner while `BREVO_API_KEY` is declared
  by this file — and the flow needs Brevo's verified sender, reply-to, and
  base64 attachment exactly as the n8n node had them. One `defineSecrets` key
  validated at boot beats five shared SMTP variables.
- **The route keeps `WEBHOOK_SECRET`.** Tally's webhook form has no
  custom-header field, so the secret travels as `?secret=…` in the URL pasted
  into Tally. The rejected alternative was `secret: false` plus an unguessable
  path, which is all the n8n webhook had — not good enough for a payload
  carrying a KTP number and bank details.

**Known and accepted:** a run page for this workflow holds personal data — the
captured payload has the KTP number, address, and bank details, and Tally's
signed `submissionPdfUrl` is a bearer link to the PDF while its token lives.
That is bounded by the dashboard's basic auth and `RUN_RETENTION_DAYS`, with
`CAPTURE_DATA=false` as the runner-wide off switch. The file says so at the top
rather than leaving it to be discovered.

### Folders in `workflows/`

Projects now group: `workflows/pblsh/…` loads exactly like a top-level file
(the loader always globbed `**/*.ts`), `LoadedWorkflow.folder` carries the
subdirectory, and the dashboard prints a folder header above each group — only
once there is more than one, so a flat repo looks unchanged.

**Folders are filing, not namespacing.** Workflow names stay global and flat,
because they are URLs, CLI arguments, and `ctx.run()` targets; deriving
`pblsh/send-signed-agreement` from the path would have changed all three and
made a file move a breaking change. The convention is to prefix the name with
the project instead. Nothing else is scoped by directory either — secrets,
state namespaces, and the concurrency cap are all indifferent to where a file
sits, and the only cost of moving one down a level is the import depth.

### Approval gates, without a Wait node

The last n8n gap anyone was likely to hit: a workflow that stops and waits for a
person. `workflows/approval-request.ts` and `workflows/approval-resolve.ts` are
now a runnable pair — one opens an approval in `ctx.state.shared` and hands out
decision links, the other claims it when someone clicks — and README documents
the pattern along with what it is not.

**Decided along the way:**

- **The runner does not learn to suspend, and the durable-engine question stays
  closed.** Holding a run open across a human-paced wait would break graceful
  shutdown, the concurrency cap, and the `timeoutMs` contract at once, and the
  alternative — adopting Temporal or Inngest — now means *replacing*
  `MAX_CONCURRENT_RUNS`, `ctx.run()`, and checkpoint resume rather than filling
  a hole. Two workflows joined by shared state buy most of the value for the
  price of an example file. What they do not buy is one run you can watch: the
  halves have separate run pages, joined only by an id in the result, and the
  README says so rather than implying otherwise.
- **`webhook(..., { secret: false })` is a new, explicit opt-out.** A route a
  person reaches by clicking a link cannot carry `WEBHOOK_SECRET` — the link
  would paste the runner's shared secret into a Slack channel. The rejected
  alternative was leaning on `secret: ""` already being falsy, which works by
  accident and reads like a mistake. Omitting `secret` still falls back to the
  global one, so a public route can only happen on purpose, and the burden it
  shifts onto the workflow (an unguessable single-use id, refused once spent)
  is documented where the flag is.
- **The claim is checkpointed; the payout is a separate step.** Whether a run
  won the claim has to travel back inside the step's result — as a closure
  variable it reads `false` on a retry, and the retry then refuses to finish
  what it just started. Splitting the payout out means a permanent failure is
  recoverable by resuming the run, without the resume re-deciding anything.
- **`onOverlap: "queue"`, not the default `"skip"`.** Skip drops the second of
  two clicks arriving together — including clicks on two unrelated approvals —
  and answers that person with a skipped run instead of a decision.

Found by running it: **a resumed run has no `ctx.input`.** Resume passes the
checkpoint key and nothing else, so the first version looked up
`approval:undefined` and reported a live approval missing. Anything derived
from the input has to be derived inside a step; AGENTS.md now carries that as
an invariant.


### OAuth2 credentials that refresh themselves

Every user-consent integration was blocked: `process.env` is immutable at
runtime and a refresh token *rotates*, so there was nowhere to put the new one.
`ctx.state` removed that obstacle, and `defineOAuth(name, { tokenUrl })` now
sits beside `defineSecrets` — the provider's details in the file, its
credentials in the environment, the rotating half in encrypted state.

**Decided along the way:**

- **OAuth rows are encrypted; the rest of `ctx.state` is not.** This was the
  open question the item was parked on, and the answer is neither of the
  extremes. Encrypting everything costs the documented "open the database file"
  escape hatch for debugging cursors, and buys nothing for a polling cursor.
  Encrypting nothing was defensible when state held cursors, and stops being
  defensible the moment one file holds live tokens for a dozen services. So:
  AES-256-GCM under `OAUTH_ENCRYPTION_KEY` for `@oauth:` keys, WebCrypto, no
  new dependency. Losing the key costs the stored tokens, not access — the next
  call falls back to the seed in the environment, warns once, and carries on.
- **No consent flow, deliberately.** You run the authorization-code flow by
  hand once and paste the refresh token in. The alternative is a callback
  route, session storage, and parked half-finished consent, all for an action
  performed once per credential in the lifetime of an integration.
- **The in-process refresh lock is not optional.** `ctx.state.update()` is
  synchronous by design and cannot wrap an async token refresh, so two
  concurrent runs would both refresh — and most providers kill the old refresh
  token on use, so the second write stores a credential the provider has
  already invalidated. A `Map<name, Promise<Token>>` is sufficient because we
  are single-process by design. Each lock holder re-reads state before spending
  a token, so a caller that queued behind a refresh uses its result rather than
  the token it rotated away. Verified: 20 concurrent callers, one refresh, one
  distinct token, and exactly one live refresh token at the provider.
- **The redactor has to be told about a token it reads back from disk, not
  just one it fetched.** Registering only inside the token exchange looked
  complete and passed the first run. The second run — a fresh process, token
  decrypted from state, no exchange — wrote it unredacted onto the run page.
  Caught by running it, which is the whole reason that rule exists.
- **The refresh window is clamped to half the token's life.** A flat 60s of
  skew means a provider issuing 30-second tokens gets refreshed on every single
  call, which against a rotating provider spends a credential per API request.
- **The environment stays the source of truth for which chain is legitimate.**
  Each stored chain records a hash of the env refresh token it grew from; when
  that stops matching, the operator has deliberately pasted a new one and the
  stored chain is abandoned rather than preferred. Without it, recovering from
  a revoked token would mean hand-editing SQLite.

Verified against a stand-in provider that rotates and invalidates on every use
(no credentials for a real one): cold start under 20-way concurrency, reuse
across a restart with zero refreshes, refresh after expiry using the rotated
token, a hand-pasted replacement seed, both client-authentication styles, a
forced refresh, a lost master key falling back to the environment, boot
refusing to start on a missing or malformed key, and a grep of the database
file for every token, seed, client secret, and the master key itself — zero
hits.

### Webhooks that register themselves with the provider

A webhook was a URL somebody pasted into Stripe or GitHub once and had to
remember. Nothing reconciled a subscription deleted provider-side, and nothing
told you a workflow's hook had stopped existing. A webhook trigger can now
carry a `register` block with `create` and `remove`, and the runner keeps the
subscription in step with what is on disk.

**Decided along the way:**

- **Reconcile at boot; never unregister on shutdown.** The handoff note
  suggested registering at boot and unregistering at shutdown, and that is
  wrong here: a redeploy is a process restart, so every deploy would delete the
  subscription and race to recreate it, losing events in the window — and
  `SIGKILL` skips the cleanup anyway, so the tidy path could never be trusted.
  Comparing against the stored id at boot gets the same outcome with no hole,
  and an unchanged URL costs zero provider calls.
- **Boot never fails on a provider.** Reconciliation runs after the server is
  listening (so a provider that pings its new subscription finds the route
  answering), is never awaited, and leaves state untouched on failure so the
  next start retries. Verified by taking the provider down mid-migration: the
  error was logged, the dashboard came up, the route served, and the next boot
  completed the migration.
- **A deleted workflow file strands its subscription, and we say so.** The
  `remove` function lived in the file, so there is nothing left to call. A
  directory of registered names in shared state makes the orphan visible, and
  it is warned about on every boot with its id — the honest option, where the
  alternative is a provider quietly posting to a 404 forever. Restoring the
  file with `enabled: false` for one boot cleans it up, and that advice is
  verified, not assumed.
- **The stale subscription is removed before its replacement is created**, so a
  changed `PUBLIC_URL` can't leave the provider posting to both.

Verified across eleven real boots against a stand-in provider (no credentials
for a real one): create, redeploy with no change and no provider call, URL
migration, disable, re-enable, provider down, provider back, file deleted,
`PUBLIC_URL` unset, the documented orphan cleanup, and a clean directory
afterwards — exactly one subscription at the provider at every step.

### `ctx.run()` — one workflow calling another

Composition had two bad options: import the other workflow's `run` function
directly and lose its run record, retries, and checkpoints, or POST your own
webhook and deal with the secret. `ctx.run(name, input)` resolves through the
registry, gives the child its own run page, and returns its result.

**Decided along the way:**

- **Everything that can go wrong throws, and is checked before anything
  starts.** A sub-workflow call is the caller asking for a value; returning
  `undefined` because the child was skipped is the kind of silence that shows
  up as a downstream `TypeError` an hour later. Cycles, depth, unknown names,
  disabled workflows, and a busy `onOverlap: "skip"` child all fail loudly, and
  the skip message names the fix (`onOverlap: "queue"`).
- **A child inherits its parent's concurrency slot.** Taking a second one reads
  as more correct and deadlocks the moment every slot holds a parent waiting on
  a child. The parent is blocked anyway, so the process is not doing more work
  at once. Verified with `MAX_CONCURRENT_RUNS=1`, where a nested call would
  otherwise hang forever.
- **Cycle detection is an ancestry chain, not a depth counter alone.** The
  error names the loop (`a → b → a`) instead of reporting a limit, which is the
  difference between a two-second fix and a bisect. A depth limit of 8 stays as
  the backstop for the case ancestry can't see: two separate chains calling
  into each other under `onOverlap: "queue"`.
- **A self-call is refused rather than allowed to queue.** Under
  `onOverlap: "queue"` it deadlocks outright — the child waits for the parent
  that is waiting for the child.
- **`parent_run` is a third lineage column.** `resumed_from` and
  `replayed_from` both mean "this run derives from that one"; this one means
  "that run called this one". Composition, not derivation.
- **The parent's signal is chained into the child**, so a parent timeout
  doesn't leave orphans running past it. Verified: an 800ms parent cut off a
  child that would have slept 10s, at 803ms.

Verified across 30 generated workflows: result passing, failure propagation and
catching, self-cycle, indirect cycle, the depth limit, unknown and disabled
targets, a busy skip-child, a busy queue-child (parent waited 1.4s for its
turn), nested calls under a cap of 1, timeout propagation, both run pages, and
the same path through `bun run trigger`.

### Replay a run with its original input

Developing a webhook workflow meant re-sending the payload by hand after every
change, because the `runs` table recorded everything about a run *except* what
went into it. Runs now store their trigger input, and any run that has one gets
a *Replay with this input* button plus `POST /api/runs/:id/replay`.

**Decided along the way:**

- **Replay and resume stay separate, including their lineage columns.** Resume
  reuses the parent's checkpoint key and skips completed steps; replay takes a
  fresh key and redoes everything. Reusing `resumed_from` for both — one column,
  distinguishable by whether the checkpoint key matches — would have worked and
  would have left the run page inferring which operation it was rendering. A
  `replayed_from` column costs one `ALTER TABLE` and says it outright.
- **The input obeys capture rules, not checkpoint rules.** Step outputs are
  stored with `force` because resume is functional and needs them. Input could
  have been argued the same way, but `CAPTURE_DATA=false` is somebody switching
  off payload storage on purpose, and quietly storing payloads anyway is not a
  choice to make on their behalf. Those runs are simply not replayable, and the
  endpoint says so.
- **Every refusal names its cause.** No recorded input, an input truncated past
  `CAPTURE_MAX_BYTES`, a workflow that no longer exists — each returns 409 with
  the reason. The tempting alternative, replaying with `{}` or with the
  truncated preview, produces a run that looks like it worked.
- **The stored input is the redacted copy**, like everything else that reaches
  disk. A payload carrying a credential replays with `«redacted»` in its place.
  That is the storage invariant holding, and it is documented rather than
  worked around — the alternative is credentials in a database column that the
  dashboard renders.

Migration is the existing `ALTER TABLE` pattern, so old databases pick up the
columns on boot; runs recorded before today have no input and say so.

Verified on a database created before the change: columns added at boot, a
webhook run's input recorded and replayed to an identical result with fresh
checkpoints, the input-less run and the truncated-input run each refused with
their own message, and a secret planted in the webhook body appearing zero
times across the API, both run pages, the dashboard, stdout, and the SQLite
file — while the input itself is stored and shown, redacted.

### `MAX_CONCURRENT_RUNS` — a ceiling across workflows, not just within one

`onOverlap` bounded a workflow against itself and nothing bounded the process.
Fifty webhooks arriving together meant fifty runs at once in one Bun process,
each holding sockets, memory, and a share of the event loop — the failure mode
being a burst that degrades everything else rather than queueing politely.
n8n's answer was queue mode with worker pools; ours is a counting semaphore
around `execute()`, default 10, `0` for the old unbounded behaviour.

**Decided along the way:**

- **Queue, never reject.** A dropped webhook is worse than a slow one, and most
  providers won't redeliver a 200. Runs past the cap wait their turn.
- **A queued run counts as active.** `onOverlap: "skip"` is checked against a
  set the workflow joins *before* it waits for a slot. Marking it after — the
  obvious placement — would let a burst of the same webhook slip past `skip`
  entirely while the first one sat in the queue. Verified: with one slot and
  two concurrent hits of the same workflow, the second is still skipped.
- **Shutdown skips the queue instead of draining it.** A run that hasn't
  started when `SIGTERM` arrives gets a `skipped` run record with the reason,
  so the work is visibly dropped rather than invisibly dropped. The shutdown
  loop stays alive until each one has recorded itself, which takes as long as
  the in-flight runs and no longer.
- **The slot is handed to the next waiter, not released into contention.**
  FIFO, and no wake-everyone stampede on each completion.
- **`/healthz` reports `running` and `queued`.** A cap you can't see turns a
  queue that never drains into a runner that merely looks quiet.

Verified with 50 workflows and 50 concurrent webhook POSTs: max observed
concurrency exactly 4 under a cap of 4, all 50 runs recorded and successful,
5.2s wall clock against the 5.0s the cap implies; 50 concurrent under `0`; and
a `SIGTERM` mid-burst leaving 12 successes, 38 skipped-with-reason, and a
prompt exit.

### `ctx.http.paginate()` — the one API quirk we were still hand-rolling

The part of n8n's "400 nodes" that wasn't UI was pre-solved API quirks, and
`src/integrations/http.ts` already covered the biggest slice — retries, 429 and
`Retry-After`, backoff with jitter. Pagination was what was left, rewritten by
hand for every API and got subtly wrong each time.

```ts
for await (const issue of ctx.http.paginate<Issue>(url, { query: { per_page: 100 } })) …
const all = await ctx.http.paginate<Issue>(url).all();
```

Covers the three shapes that account for nearly everything: `Link: rel="next"`
headers, a cursor token in the body, and page/offset counters. Each page is an
ordinary request, so retries, `ctx.signal`, and run-page capture all still apply.

**Decided along the way:**

- **It throws instead of returning a short answer.** Hitting the `maxPages`
  ceiling, revisiting a URL already fetched, or finding a cursor token with no
  parameter name given are all misconfigurations, and the rejected alternative —
  return what we have — produces a partial result indistinguishable from a
  complete one. That is the bug you find weeks later in a report with missing
  rows. Only the honest endings are quiet: empty page, no next link, `maxItems`.
- **Auto-detection stops where the response stops being unambiguous.** A `Link`
  header or a body field holding an actual URL is self-describing. An opaque
  token is not — nothing in `{"next_cursor":"dXNlcjox"}` says the parameter is
  called `cursor` — so guessing a name from the field would work on Slack and
  silently truncate elsewhere. Cursors and counters are configured explicitly.
- **An `items` path that misses on page one throws; on a later page it doesn't.**
  A wrong path otherwise yields zero items and reads as an empty collection.
  Missing on a later page is just how a last page often looks.
- **Iterator first, `.all()` second.** The iterator holds one page in memory,
  which is what makes it safe to point at something large; `.all()` and
  `.pages()` are there because most workflows genuinely want the array.

`workflows/paginate-demo.ts` is a `manual()` example against GitHub's public
API — no credentials, and its run page shows one recorded HTTP call per page.

### `poll()` trigger — schedule + dedupe, no empty runs

Closes the second of the two gaps that `ctx.state` unblocked. A large share of
real automation is "check this source on a schedule and act only on what's new",
and the only way to express it before was a `cron()` that re-ran a run every
interval and filtered by hand — with nowhere to keep the cursor.

```ts
trigger: poll("*/5 * * * *", {
  fetch: (ctx) => ctx.http.get("https://api.example.com/issues"),
  id: (issue) => issue.id,
})
```

`ctx.input` is the array of items never seen before. `poll` and `cron` share the
scheduler loop; they differ only in what firing does.

**Decided along the way:**

- **A quiet tick creates no run record.** The alternative — a run that returns
  `{ new: 0 }` — buries the dashboard under 288 empty runs a day on a
  five-minute poll, which makes run history useless for spotting real activity.
  The cost is that "did it poll?" is a log line, not a run; a `fetch` that
  *throws* still gets a failed run so failures are never silent.
- **Marked seen only after the run succeeds.** Marking up front is simpler and
  wrong: a failed run would drop its items permanently. At-least-once means a
  persistently failing workflow re-delivers every tick, which is noisy but
  recoverable, and `ALERT_WEBHOOK_URL` already covers the noise.
- **First poll baselines instead of firing.** Pointing a new workflow at a feed
  of 500 open issues should not send 500 messages. `firstRun: "emit"` opts out.
- **The remember-window widens to fit one page.** A fetch returning more items
  than `remember` would otherwise push its own items out of the set and
  re-deliver them forever — a silent infinite loop. The window never drops below
  one page, and the cap is warned about rather than enforced destructively.
- **`fetch` gets no `ctx.step`.** It runs outside a run, so there is nothing to
  attach steps or captured HTTP calls to. Keeping `fetch` to "return the current
  list" and the work in `run()` is what keeps the work observable.
- **One run per batch, not per item.** Per-item runs would collide with the
  default `onOverlap: "skip"` and need serialising. Looping in `run()` with
  `ctx.step(\`item ${id}\`)` already gives per-item checkpointing, which is the
  documented idiom here.

Rejected: auto-registering webhooks with providers (Stripe/GitHub push
subscriptions). Different problem, much larger surface, and polling covers the
sources that have no push at all.

### `ctx.state` — durable key/value store

Workflows had nowhere to remember anything between runs. The database held only
`runs`, `logs`, `steps`, and `calls`, and checkpoints expire by design, so a
polling cursor, a rotating OAuth refresh token, or a correlation id for a
handoff between two workflows had no home. This is the gap that made "poll an
API and emit only what's new" impossible to express.

Added `ctx.state` with `get` / `set` / `update` / `delete` / `keys`, namespaced
per workflow, plus `ctx.state.shared` for cross-workflow handoffs.

**Decided along the way:**

- **State is stored unredacted.** Everything else written to SQLite goes through
  the secret filter, because it is observational — nobody reads a log line back
  and acts on it. State is operational: a rotating refresh token has to come
  back byte-identical, so redacting on write would destroy the value rather than
  protect it. The invariant is preserved instead by never rendering state
  anywhere — no dashboard view, no API route, no log line. **Do not add a state
  viewer.** Rejected alternative: encrypt at rest with a master key from the
  environment, which is the right answer if state ever needs to be displayed.
- **`set` throws instead of degrading.** `capture()` stores a placeholder for
  values it can't serialise, which is correct for a preview. For data a workflow
  reads back and acts on, a silent placeholder is a bug you find much later, so
  `undefined`, functions, bigints, circular structures, and oversized values all
  throw with the key named.
- **`update()` over get-then-set.** Get-then-set is two awaits with a gap, and
  concurrent runs interleave in that gap. `update()` completes its
  read-modify-write in one synchronous tick. Measured under 100-way concurrency:
  `update()` counted 100, get-then-set counted 1.
- **Marked seen only after success** is the rule adopted for anything built on
  top of this (see the polling trigger), giving at-least-once delivery.

No migration needed — the table is created on boot. Expired keys vanish from
reads immediately and are swept by the nightly prune, which now runs even when
`RUN_RETENTION_DAYS` is 0.

### Fixed: `bun run trigger` never worked

The `--run` branch called `shutdown()` above the `let` declarations it depends
on, so every CLI run died with `ReferenceError: Cannot access 'shuttingDown'
before initialization` and exited non-zero regardless of the workflow's actual
result. Unrelated to the above; found while verifying it through the documented
path.
