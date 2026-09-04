# Changelog

What changed, why, and what was traded away. Newest first.

Entries record the *reasoning*, not just the diff — `git log` already has the
diff. If a change settled a question, say what was settled and what the losing
option was, so nobody relitigates it from scratch.

## 2026-09-05

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
