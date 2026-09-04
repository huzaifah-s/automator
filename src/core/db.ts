import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.ts";
import type {
  CallRecord,
  LogRecord,
  RunRecord,
  RunStatus,
  StepRecord,
  TriggerKind,
} from "./types.ts";

const path = process.env.DATABASE_PATH ?? "./data/automator.db";
mkdirSync(dirname(path), { recursive: true });

export const db = new Database(path, { create: true });

// WAL lets the dashboard read while a workflow is mid-write.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    workflow    TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    trigger     TEXT    NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 1,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER,
    error       TEXT,
    result      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_started  ON runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow, started_at DESC);

  CREATE TABLE IF NOT EXISTS logs (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts     INTEGER NOT NULL,
    level  TEXT    NOT NULL,
    msg    TEXT    NOT NULL,
    data   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(run_id, id);

  -- One row per ctx.step(). Doubles as the checkpoint store and the "what did
  -- this call send and receive" view: keyed by checkpoint_key, not run_id, so a
  -- resumed run inherits the steps its parent already completed.
  CREATE TABLE IF NOT EXISTS steps (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    checkpoint_key TEXT    NOT NULL,
    run_id         TEXT    NOT NULL,
    name           TEXT    NOT NULL,
    status         TEXT    NOT NULL,
    started_at     INTEGER NOT NULL,
    duration_ms    INTEGER,
    input          TEXT,
    output         TEXT,
    error          TEXT,
    truncated      INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_key ON steps(checkpoint_key, name);
  CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, id);

  -- One row per outbound ctx.http call, for the n8n-style request/response view.
  CREATE TABLE IF NOT EXISTS calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts          INTEGER NOT NULL,
    method      TEXT    NOT NULL,
    url         TEXT    NOT NULL,
    status      INTEGER,
    duration_ms INTEGER,
    request     TEXT,
    response    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_calls_run ON calls(run_id, id);

  -- Durable key/value state — the one table here that deliberately outlives
  -- run history: polling cursors, rotating OAuth tokens, cross-run handoffs.
  -- Namespaced per workflow; "@shared" is the cross-workflow namespace, which
  -- workflow names can never collide with (no "@" in the allowed charset).
  CREATE TABLE IF NOT EXISTS state (
    namespace  TEXT    NOT NULL,
    key        TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (namespace, key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_state_expires
    ON state(expires_at) WHERE expires_at IS NOT NULL;
`);

// Migration for databases created before checkpointing existed.
const runColumns = new Set(
  (db.query("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name),
);
if (!runColumns.has("checkpoint_key")) {
  db.exec("ALTER TABLE runs ADD COLUMN checkpoint_key TEXT");
  db.exec("UPDATE runs SET checkpoint_key = id WHERE checkpoint_key IS NULL");
}
if (!runColumns.has("resumed_from")) {
  db.exec("ALTER TABLE runs ADD COLUMN resumed_from TEXT");
}
// Migration for databases created before replay existed. `input` is what the
// trigger handed the run — the thing you otherwise have to re-send by hand to
// develop a webhook workflow.
if (!runColumns.has("input")) {
  db.exec("ALTER TABLE runs ADD COLUMN input TEXT");
}
// Kept separate from resumed_from rather than folded into it: a resume reuses
// the parent's checkpoint key and skips completed steps, a replay starts clean
// and redoes everything. Two different lineages that happen to share a shape,
// and one column would make the run page guess which it was looking at.
if (!runColumns.has("replayed_from")) {
  db.exec("ALTER TABLE runs ADD COLUMN replayed_from TEXT");
}

const stmts = {
  insertRun: db.prepare(
    `INSERT INTO runs (id, workflow, status, trigger, attempts, started_at,
                       checkpoint_key, resumed_from, replayed_from, input)
     VALUES (?, ?, 'running', ?, 1, ?, ?, ?, ?, ?)`,
  ),
  finishRun: db.prepare(
    `UPDATE runs SET status = ?, attempts = ?, finished_at = ?,
       duration_ms = ? - started_at, error = ?, result = ?
     WHERE id = ?`,
  ),
  insertLog: db.prepare(
    `INSERT INTO logs (run_id, ts, level, msg, data) VALUES (?, ?, ?, ?, ?)`,
  ),
  getRun: db.prepare(`SELECT * FROM runs WHERE id = ?`),
  logsForRun: db.prepare(`SELECT * FROM logs WHERE run_id = ? ORDER BY id`),
  recentRuns: db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`),
  runsForWorkflow: db.prepare(
    `SELECT * FROM runs WHERE workflow = ? ORDER BY started_at DESC LIMIT ?`,
  ),
  statsForWorkflow: db.prepare(
    `SELECT
       COUNT(*)                                              AS total,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)   AS succeeded,
       SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END)   AS failed,
       MAX(started_at)                                       AS last_run
     FROM runs WHERE workflow = ?`,
  ),
  pruneRuns: db.prepare(`DELETE FROM runs WHERE started_at < ?`),
  pruneSteps: db.prepare(
    `DELETE FROM steps WHERE run_id NOT IN (SELECT id FROM runs)`,
  ),

  findStep: db.prepare(
    `SELECT * FROM steps WHERE checkpoint_key = ? AND name = ? AND status = 'ok' AND truncated = 0`,
  ),
  upsertStep: db.prepare(
    `INSERT INTO steps (checkpoint_key, run_id, name, status, started_at,
                        duration_ms, input, output, error, truncated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(checkpoint_key, name) DO UPDATE SET
       run_id = excluded.run_id, status = excluded.status,
       started_at = excluded.started_at, duration_ms = excluded.duration_ms,
       input = excluded.input, output = excluded.output,
       error = excluded.error, truncated = excluded.truncated`,
  ),
  stepsForKey: db.prepare(`SELECT * FROM steps WHERE checkpoint_key = ? ORDER BY id`),
  clearStalePoints: db.prepare(`DELETE FROM steps WHERE checkpoint_key = ? AND started_at < ?`),

  insertCall: db.prepare(
    `INSERT INTO calls (run_id, ts, method, url, status, duration_ms, request, response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  callsForRun: db.prepare(`SELECT * FROM calls WHERE run_id = ? ORDER BY id`),
  getState: db.prepare(
    `SELECT value FROM state
     WHERE namespace = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)`,
  ),
  setState: db.prepare(
    `INSERT INTO state (namespace, key, value, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(namespace, key) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`,
  ),
  deleteState: db.prepare(`DELETE FROM state WHERE namespace = ? AND key = ?`),
  stateKeys: db.prepare(
    `SELECT key FROM state
     WHERE namespace = ? AND key LIKE ? ESCAPE '\\'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY key`,
  ),
  pruneState: db.prepare(
    `DELETE FROM state WHERE expires_at IS NOT NULL AND expires_at <= ?`,
  ),

  markOrphans: db.prepare(
    `UPDATE runs SET status = 'failed', error = 'Interrupted by restart',
       finished_at = ?, duration_ms = ? - started_at
     WHERE status = 'running'`,
  ),
};

export const store = {
  startRun(
    id: string,
    workflow: string,
    trigger: TriggerKind,
    opts: {
      checkpointKey?: string;
      resumedFrom?: string | null;
      replayedFrom?: string | null;
      /** Already through capture() — redacted and capped — or null. */
      input?: string | null;
    } = {},
  ): void {
    stmts.insertRun.run(
      id,
      workflow,
      trigger,
      Date.now(),
      opts.checkpointKey ?? id,
      opts.resumedFrom ?? null,
      opts.replayedFrom ?? null,
      opts.input ?? null,
    );
  },

  finishRun(
    id: string,
    status: RunStatus,
    attempts: number,
    error: string | null,
    result: unknown,
  ): void {
    const now = Date.now();
    // Redacted at the storage boundary: a workflow can return, or an error can
    // quote, a credential it pulled apart itself (a password lifted out of a
    // connection URL, a token in a query string on an HttpError message).
    stmts.finishRun.run(
      status,
      attempts,
      now,
      now,
      error === null ? null : redact(error),
      result === undefined ? null : redact(safeJson(result)),
      id,
    );
  },

  log(runId: string, level: string, msg: string, data: unknown): void {
    stmts.insertLog.run(
      runId,
      Date.now(),
      level,
      msg,
      data === undefined ? null : safeJson(data),
    );
  },

  getRun: (id: string) => stmts.getRun.get(id) as RunRecord | null,
  logsForRun: (id: string) => stmts.logsForRun.all(id) as LogRecord[],
  recentRuns: (limit = 50) => stmts.recentRuns.all(limit) as RunRecord[],
  runsForWorkflow: (name: string, limit = 20) =>
    stmts.runsForWorkflow.all(name, limit) as RunRecord[],
  statsForWorkflow: (name: string) =>
    stmts.statsForWorkflow.get(name) as {
      total: number;
      succeeded: number;
      failed: number;
      last_run: number | null;
    },

  /** Runs that were mid-flight when the process died can never complete. */
  markOrphans(): number {
    const now = Date.now();
    return stmts.markOrphans.run(now, now).changes;
  },

  pruneOlderThan(days: number): number {
    const removed = stmts.pruneRuns.run(Date.now() - days * 86_400_000).changes;
    // steps aren't FK-bound to runs (they outlive them across resumes), so
    // they need their own sweep once the owning runs are gone.
    stmts.pruneSteps.run();
    return removed;
  },

  /* ------------------------------------------------------------- steps */

  findStep(checkpointKey: string, name: string): StepRecord | null {
    // Redacted on both read and write, so the key stays consistent.
    return stmts.findStep.get(checkpointKey, redact(name)) as StepRecord | null;
  },

  saveStep(step: {
    checkpointKey: string;
    runId: string;
    name: string;
    status: "ok" | "failed";
    startedAt: number;
    durationMs: number;
    input: string | null;
    output: string | null;
    error: string | null;
    truncated: boolean;
  }): void {
    stmts.upsertStep.run(
      step.checkpointKey,
      step.runId,
      redact(step.name),
      step.status,
      step.startedAt,
      step.durationMs,
      step.input,
      step.output,
      step.error,
      step.truncated ? 1 : 0,
    );
  },

  stepsForKey: (key: string) => stmts.stepsForKey.all(key) as StepRecord[],

  /** Drops checkpoints older than the TTL so a stale resume can't reuse them. */
  expireCheckpoints(key: string, ttlHours: number): number {
    if (ttlHours <= 0) return 0;
    return stmts.clearStalePoints.run(key, Date.now() - ttlHours * 3_600_000).changes;
  },

  /* ------------------------------------------------------------- calls */

  recordCall(call: {
    runId: string;
    method: string;
    url: string;
    status: number | null;
    durationMs: number;
    request: string | null;
    response: string | null;
  }): void {
    stmts.insertCall.run(
      call.runId,
      Date.now(),
      call.method,
      // A token can ride in a query string, so the URL is data, not a label.
      redact(call.url),
      call.status,
      call.durationMs,
      call.request,
      call.response,
    );
  },

  callsForRun: (runId: string) => stmts.callsForRun.all(runId) as CallRecord[],

  /* ------------------------------------------------------------- state */

  /*
   * State is deliberately NOT redacted, and it is the only thing in this file
   * that isn't. Redaction is right everywhere else because that data is
   * observational — nobody reads a log line back and acts on it. State is
   * operational: a workflow stores a rotating OAuth refresh token and needs
   * the same bytes back, so scrubbing on write would destroy the value rather
   * than protect it.
   *
   * What holds the invariant is that state is never displayed. There is no
   * dashboard view, no API route, and no log line that renders it — it goes in
   * from a workflow and comes back out to that workflow alone. Keep it that
   * way: adding a state viewer would put credentials on a web page.
   */

  stateGet(namespace: string, key: string): string | null {
    const row = stmts.getState.get(namespace, key, Date.now()) as { value: string } | null;
    return row?.value ?? null;
  },

  stateSet(namespace: string, key: string, value: string, expiresAt: number | null): void {
    stmts.setState.run(namespace, key, value, Date.now(), expiresAt);
  },

  stateDelete(namespace: string, key: string): boolean {
    return stmts.deleteState.run(namespace, key).changes > 0;
  },

  stateKeys(namespace: string, prefix = ""): string[] {
    const rows = stmts.stateKeys.all(namespace, `${likeEscape(prefix)}%`, Date.now()) as {
      key: string;
    }[];
    return rows.map((r) => r.key);
  },

  /** Expired keys are already invisible to reads; this reclaims their disk. */
  pruneExpiredState(): number {
    return stmts.pruneState.run(Date.now()).changes;
  },
};

/** A prefix is user data, so its LIKE wildcards have to be literal. */
function likeEscape(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value, replacer);
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}

function replacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}
