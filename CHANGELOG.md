# Changelog

What changed, why, and what was traded away. Newest first.

Entries record the *reasoning*, not just the diff — `git log` already has the
diff. If a change settled a question, say what was settled and what the losing
option was, so nobody relitigates it from scratch.

## 2026-09-05

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
