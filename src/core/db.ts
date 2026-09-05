import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.ts";
import type {
  CallRecord,
  CredentialRow,
  InboxRecord,
  LogRecord,
  PollRecord,
  RejectionRecord,
  RunRecord,
  RunStatus,
  StepRecord,
  TriggerKind,
  WorkflowVersion,
} from "./types.ts";

const path = process.env.DATABASE_PATH ?? "./data/automator.db";

/** Ceiling on a rejection's `detail`. Long enough for a sentence or a field list. */
const REJECTION_DETAIL_MAX = 500;

/** Ceiling on a poll tick's `error`. Same reasoning as a rejection's detail. */
const POLL_ERROR_MAX = 500;

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

  -- Webhook deliveries, written down before the 202 goes back and settled once
  -- the run they started reaches a decision. The gap between those two points
  -- is the whole reason this table exists: the payload used to live only in the
  -- closure a queueMicrotask was holding, so a restart in that window dropped
  -- work the caller had already been told was accepted, with nothing on the
  -- dashboard to say so.
  --
  -- Functional data, not observational. Stored with capture()'s force flag, so
  -- CAPTURE_DATA=false cannot quietly turn recovery off, and against the
  -- checkpoint ceiling rather than the smaller capture one — the same trade
  -- step outputs already make, for the same reason: something that gets fed
  -- back into a workflow needs room to survive whole.
  CREATE TABLE IF NOT EXISTS inbox (
    id          TEXT    PRIMARY KEY,
    workflow    TEXT    NOT NULL,
    -- sha256 of the method, path and raw body. A digest of the payload rather
    -- than the payload, which is what makes it the one column here that needs
    -- no redaction.
    fingerprint TEXT    NOT NULL,
    input       TEXT,
    received_at INTEGER NOT NULL,
    -- pending → accepted, not finished. done → the run reached a decision.
    -- abandoned → it can never run now (workflow gone, or too old to be worth
    -- running), recorded rather than deleted so it is still answerable.
    status      TEXT    NOT NULL,
    run_id      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_pending ON inbox(status, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbox_print   ON inbox(fingerprint, received_at DESC);

  -- Webhook deliveries turned away at the door: a bad secret, a signature that
  -- did not check out, a body that would not parse, a payload the schema
  -- refused. None of those reach a run, so until this table existed the only
  -- record of them was a warn line on stdout — and the dashboard, which is
  -- where somebody looks, showed a workflow that was simply never called. A
  -- Notion subscription piling up failed deliveries against a route that was
  -- silently 401ing is what prompted it.
  --
  -- Counted, not logged one row per attempt. An unauthenticated public endpoint
  -- is exactly the thing that gets hammered, and a row per rejection is a way
  -- to fill a disk from outside. The primary key bounds the table at
  -- (workflows × reasons), which is a handful, and nothing is recorded at all
  -- for a path no workflow claims — otherwise a scanner walking URLs would
  -- write a row per guess.
  --
  -- The detail column is the reason the check failed where there is one to give: a
  -- verifier's thrown message, or which fields the schema rejected. Redacted
  -- and capped on the way in like everything else observational. The request
  -- body is deliberately absent — a rejected call is by definition one nobody
  -- authenticated, and storing what it sent is storing whatever a stranger
  -- chose to send.
  CREATE TABLE IF NOT EXISTS rejections (
    workflow TEXT    NOT NULL,
    path     TEXT    NOT NULL,
    reason   TEXT    NOT NULL,
    detail   TEXT,
    count    INTEGER NOT NULL DEFAULT 0,
    first_at INTEGER NOT NULL,
    last_at  INTEGER NOT NULL,
    -- When a delivery to this workflow last got all the way through the door,
    -- stamped across its rows at that moment. A row whose resolved_at is at or
    -- after its last_at is history: whatever was wrong is demonstrably not
    -- wrong now. That is the difference between a record and an alarm, and
    -- deriving it at read time instead does not work — the evidence lives in
    -- the inbox, which only async webhooks write to and which is pruned.
    resolved_at INTEGER,
    PRIMARY KEY (workflow, path, reason)
  ) WITHOUT ROWID;

  -- The last time each poll trigger looked, and what it saw. A tick that finds
  -- nothing new deliberately starts no run (see poll.ts) — which is what keeps
  -- the runs list readable, and also what makes "quiet" and "dead" look
  -- identical from the dashboard: both are an empty list. This row is the
  -- difference. It is stamped on every tick, so a stale at means the scheduler
  -- stopped rather than that there was nothing to do.
  --
  -- One row per workflow, overwritten. Keeping the tick history would be 360
  -- rows a day per poll to answer a question the newest row already answers,
  -- and the ticks that did find something are already in the runs table.
  --
  -- The error column is a message thrown by workflow-authored fetch code, and
  -- it is rendered on the workflow page, so it is redacted and capped on the
  -- way in. State, which is where a poll's own bookkeeping already lives, was
  -- the tempting place to keep all this and is the wrong one for exactly that
  -- reason: it is stored unredacted on purpose and is never displayed.
  CREATE TABLE IF NOT EXISTS polls (
    workflow TEXT    PRIMARY KEY,
    at       INTEGER NOT NULL,
    items    INTEGER,
    fresh    INTEGER,
    error    TEXT
  ) WITHOUT ROWID;

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

  -- When each workflow's file last *changed*, which is a different question
  -- from when it last ran and is not answerable from the filesystem: a deploy
  -- is a fresh git clone, so every file carries the same checkout mtime and a
  -- dashboard built on mtime would report every workflow as updated at the
  -- last deploy. Keyed on a hash of the file's source instead, so the time
  -- only moves when the bytes do.
  CREATE TABLE IF NOT EXISTS workflow_versions (
    workflow   TEXT    PRIMARY KEY,
    hash       TEXT    NOT NULL,
    first_seen INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- Credentials that outlive the process, so changing one is not a redeploy.
  -- The value column is always ciphertext — base64(iv + AES-256-GCM), never a
  -- readable string, which is what makes this table different from state above.
  CREATE TABLE IF NOT EXISTS secrets (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- The grouping half of a credential: which platform it is for, which folder
  -- it is filed under, and how the last connection test went. Deliberately
  -- holds no values at all — the fields themselves are ordinary rows in the
  -- secrets table above, under derived names, so there is exactly one
  -- encrypted store and one set of rules about what may reach disk.
  --
  -- Keyed on (provider, id) rather than id alone so "main" can exist for two
  -- platforms at once, which is what people actually name their first one.
  CREATE TABLE IF NOT EXISTS credentials (
    provider    TEXT    NOT NULL,
    id          TEXT    NOT NULL,
    folder      TEXT,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    tested_at   INTEGER,
    test_ok     INTEGER,
    test_detail TEXT,
    PRIMARY KEY (provider, id)
  ) WITHOUT ROWID;
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
// Migration for databases created before ctx.run() existed. A third lineage
// column, because it is a third relation: resumed_from and replayed_from are
// both "this run derives from that one", parent_run is "that run called this
// one" — composition, not derivation.
if (!runColumns.has("parent_run")) {
  db.exec("ALTER TABLE runs ADD COLUMN parent_run TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run)");
}

// Migration for databases whose rejections table predates the resolved/active
// distinction — every row in one of those was written while the only way to
// quiet the panel was the Clear button, so they start unresolved, which is what
// they were.
const rejectionColumns = new Set(
  (db.query("PRAGMA table_info(rejections)").all() as { name: string }[]).map((c) => c.name),
);
if (rejectionColumns.size > 0 && !rejectionColumns.has("resolved_at")) {
  db.exec("ALTER TABLE rejections ADD COLUMN resolved_at INTEGER");
}

// Migration for databases created before credentials and folders existed.
// Both columns are metadata about a row, never part of the credential: the
// value column stays the only thing that matters and stays ciphertext.
const secretColumns = new Set(
  (db.query("PRAGMA table_info(secrets)").all() as { name: string }[]).map((c) => c.name),
);
if (!secretColumns.has("folder")) {
  db.exec("ALTER TABLE secrets ADD COLUMN folder TEXT");
}
// `provider:id` of the credential this row belongs to, NULL for a loose
// secret. Derivable from the credentials table, but stored anyway: it makes
// "delete everything this credential owns" exact rather than reconstructed,
// which still works for a credential whose platform was removed from the code.
if (!secretColumns.has("owner")) {
  db.exec("ALTER TABLE secrets ADD COLUMN owner TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_secrets_owner ON secrets(owner)");
}

/**
 * The executions tab's filter, and the shape both the run list and the counts
 * above it are built from. `since`/`until` are epoch milliseconds, inclusive
 * on both ends; leaving either off means "unbounded in that direction".
 */
export interface RunFilter {
  status?: string;
  workflow?: string;
  /**
   * Restricts the result to these workflow names — how the folder chips
   * filter, since a run records a name and the folder it came from lives in
   * the registry. An empty array matches nothing, which is what a folder
   * whose workflows have all been deleted should show.
   */
  workflows?: string[];
  since?: number;
  until?: number;
}

/** Stands in for "no upper bound" — SQLite compares it as a plain integer. */
const TIME_MAX = Number.MAX_SAFE_INTEGER;

const stmts = {
  insertRun: db.prepare(
    `INSERT INTO runs (id, workflow, status, trigger, attempts, started_at,
                       checkpoint_key, resumed_from, replayed_from, input,
                       parent_run)
     VALUES (?, ?, 'running', ?, 1, ?, ?, ?, ?, ?, ?)`,
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
  childRuns: db.prepare(`SELECT * FROM runs WHERE parent_run = ? ORDER BY started_at`),
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
  // The workflows tab shows a health strip per workflow, so it needs the last
  // handful of runs for *every* workflow — one windowed query rather than one
  // query per row, which on a folder full of workflows is the difference
  // between a page render and a page render times N.
  recentRunsPerWorkflow: db.prepare(
    `SELECT workflow, status, started_at, duration_ms, id FROM (
       SELECT workflow, status, started_at, duration_ms, id,
              ROW_NUMBER() OVER (PARTITION BY workflow ORDER BY started_at DESC) AS rn
       FROM runs
     ) WHERE rn <= ?
     ORDER BY workflow, started_at DESC`,
  ),
  // Filters are passed twice rather than as `?1`, so the binding stays
  // positional and order-independent of the driver's numbered-parameter
  // support. An empty string means "no filter".
  // The name set arrives as a JSON array rather than a generated IN list, so
  // this stays one prepared statement instead of one per folder size. `''`
  // means "not filtering by folder"; `'[]'` is a folder with nothing in it.
  filteredRuns: db.prepare(
    `SELECT * FROM runs
     WHERE (? = '' OR status = ?) AND (? = '' OR workflow = ?)
       AND (? = '' OR workflow IN (SELECT value FROM json_each(?)))
       AND started_at >= ? AND started_at <= ?
     ORDER BY started_at DESC LIMIT ?`,
  ),
  // Takes the same window and workflow as `filteredRuns`, so the numbers on
  // the executions tab describe the rows underneath them. A fixed 24h count
  // sitting above a 30-day list reads as a contradiction, not as two facts.
  statusCounts: db.prepare(
    `SELECT status, COUNT(*) AS count FROM runs
     WHERE (? = '' OR workflow = ?)
       AND (? = '' OR workflow IN (SELECT value FROM json_each(?)))
       AND started_at >= ? AND started_at <= ?
     GROUP BY status`,
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

  allWorkflowVersions: db.prepare(
    `SELECT workflow, hash, first_seen, updated_at FROM workflow_versions`,
  ),
  // The WHERE on the upsert is what makes a boot that changed nothing write
  // nothing: an identical hash leaves updated_at where it was, so restarting
  // the server is not mistaken for editing every workflow.
  upsertWorkflowVersion: db.prepare(
    `INSERT INTO workflow_versions (workflow, hash, first_seen, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workflow) DO UPDATE SET
       hash = excluded.hash, updated_at = excluded.updated_at
     WHERE workflow_versions.hash <> excluded.hash`,
  ),

  allSecrets: db.prepare(`SELECT key, value, updated_at FROM secrets ORDER BY key`),
  // Metadata without the ciphertext, for the dashboard and the folder view.
  // Separate from allSecrets so a page that only lists names never has an
  // encrypted value in scope to accidentally render.
  secretMeta: db.prepare(
    `SELECT key, folder, owner, updated_at FROM secrets ORDER BY key`,
  ),
  // COALESCE keeps the existing folder and owner when a write does not carry
  // them — rotating a value must not silently move the row out of its folder.
  // Clearing either is what secretSetFolder / secretDropByOwner are for.
  setSecret: db.prepare(
    `INSERT INTO secrets (key, value, updated_at, folder, owner) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at,
       folder = COALESCE(excluded.folder, secrets.folder),
       owner  = COALESCE(excluded.owner,  secrets.owner)`,
  ),
  deleteSecret: db.prepare(`DELETE FROM secrets WHERE key = ?`),
  setSecretFolder: db.prepare(`UPDATE secrets SET folder = ? WHERE key = ?`),
  setSecretFolderByOwner: db.prepare(`UPDATE secrets SET folder = ? WHERE owner = ?`),
  deleteSecretsByOwner: db.prepare(`DELETE FROM secrets WHERE owner = ?`),
  secretWatermark: db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS latest FROM secrets`,
  ),
  credentialWatermark: db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS latest FROM credentials`,
  ),

  allCredentials: db.prepare(
    `SELECT * FROM credentials ORDER BY COALESCE(folder, ''), provider, id`,
  ),
  getCredential: db.prepare(`SELECT * FROM credentials WHERE provider = ? AND id = ?`),
  putCredential: db.prepare(
    `INSERT INTO credentials (provider, id, folder, is_primary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, id) DO UPDATE SET
       folder = excluded.folder, is_primary = excluded.is_primary,
       updated_at = excluded.updated_at`,
  ),
  deleteCredential: db.prepare(`DELETE FROM credentials WHERE provider = ? AND id = ?`),
  clearPrimary: db.prepare(
    `UPDATE credentials SET is_primary = 0 WHERE provider = ? AND id <> ?`,
  ),
  recordCredentialTest: db.prepare(
    `UPDATE credentials SET tested_at = ?, test_ok = ?, test_detail = ?
     WHERE provider = ? AND id = ?`,
  ),

  markOrphans: db.prepare(
    `UPDATE runs SET status = 'failed', error = 'Interrupted by restart',
       finished_at = ?, duration_ms = ? - started_at
     WHERE status = 'running'`,
  ),

  recentDelivery: db.prepare(
    `SELECT id, status FROM inbox
     WHERE fingerprint = ? AND received_at >= ?
     ORDER BY received_at DESC LIMIT 1`,
  ),
  insertDelivery: db.prepare(
    `INSERT INTO inbox (id, workflow, fingerprint, input, received_at, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  ),
  settleDelivery: db.prepare(`UPDATE inbox SET status = ?, run_id = ? WHERE id = ?`),
  pendingDeliveries: db.prepare(
    `SELECT * FROM inbox WHERE status = 'pending' ORDER BY received_at`,
  ),
  pendingDeliveryCount: db.prepare(
    `SELECT COUNT(*) AS count FROM inbox WHERE status = 'pending'`,
  ),
  // One row per (workflow, path, reason), incremented. `detail` takes the
  // newest value rather than the first: a route that was failing for one reason
  // and is now failing for another should say the current one.
  bumpRejection: db.prepare(
    `INSERT INTO rejections (workflow, path, reason, detail, count, first_at, last_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(workflow, path, reason) DO UPDATE SET
       count    = count + 1,
       detail   = excluded.detail,
       last_at  = excluded.last_at`,
  ),
  rejectionsFor: db.prepare(
    `SELECT * FROM rejections WHERE workflow = ? ORDER BY last_at DESC`,
  ),
  rejectionTotals: db.prepare(
    `SELECT workflow, SUM(count) AS count, MAX(last_at) AS last_at
     FROM rejections
     WHERE resolved_at IS NULL OR resolved_at < last_at
     GROUP BY workflow`,
  ),
  clearRejections: db.prepare(`DELETE FROM rejections WHERE workflow = ?`),
  // Replaced wholesale each tick — the previous tick's numbers are never
  // wanted alongside the current ones.
  recordPoll: db.prepare(
    `INSERT INTO polls (workflow, at, items, fresh, error)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workflow) DO UPDATE SET
       at    = excluded.at,
       items = excluded.items,
       fresh = excluded.fresh,
       error = excluded.error`,
  ),
  lastPoll: db.prepare(`SELECT * FROM polls WHERE workflow = ?`),
  lastPolls: db.prepare(`SELECT * FROM polls`),
  // Narrowed to rows that are not already settled, so the overwhelmingly
  // common case — a healthy hook with nothing to resolve — matches no rows and
  // writes nothing. This runs on every accepted delivery.
  resolveRejections: db.prepare(
    `UPDATE rejections SET resolved_at = ?
     WHERE workflow = ? AND (resolved_at IS NULL OR resolved_at < last_at)`,
  ),
  // Settled rows only: a pending one is work that has not happened yet, and
  // age is exactly what makes it interesting rather than disposable.
  pruneInbox: db.prepare(
    `DELETE FROM inbox WHERE status <> 'pending' AND received_at < ?`,
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
      parentRun?: string | null;
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
      opts.parentRun ?? null,
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
  childRuns: (id: string) => stmts.childRuns.all(id) as RunRecord[],
  logsForRun: (id: string) => stmts.logsForRun.all(id) as LogRecord[],
  recentRuns: (limit = 50) => stmts.recentRuns.all(limit) as RunRecord[],
  runsForWorkflow: (name: string, limit = 20) =>
    stmts.runsForWorkflow.all(name, limit) as RunRecord[],

  /** The last `perWorkflow` runs of every workflow, newest first within each. */
  recentRunsPerWorkflow: (perWorkflow = 12) =>
    stmts.recentRunsPerWorkflow.all(perWorkflow) as Pick<
      RunRecord,
      "workflow" | "status" | "started_at" | "duration_ms" | "id"
    >[],

  filteredRuns: (
    filter: RunFilter = {},
    limit = 100,
  ): RunRecord[] => {
    const status = filter.status ?? "";
    const workflow = filter.workflow ?? "";
    const names = filter.workflows ? JSON.stringify(filter.workflows) : "";
    return stmts.filteredRuns.all(
      status,
      status,
      workflow,
      workflow,
      names,
      names,
      filter.since ?? 0,
      filter.until ?? TIME_MAX,
      limit,
    ) as RunRecord[];
  },

  /** Runs per status in a window, optionally narrowed to a folder or workflow. */
  statusCounts: (
    range: Omit<RunFilter, "status"> = {},
  ): Record<string, number> => {
    const workflow = range.workflow ?? "";
    const names = range.workflows ? JSON.stringify(range.workflows) : "";
    const rows = stmts.statusCounts.all(
      workflow,
      workflow,
      names,
      names,
      range.since ?? 0,
      range.until ?? TIME_MAX,
    ) as { status: string; count: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  },

  statusCountsSince: (since: number): Record<string, number> =>
    store.statusCounts({ since }),
  statsForWorkflow: (name: string) =>
    stmts.statsForWorkflow.get(name) as {
      total: number;
      succeeded: number;
      failed: number;
      last_run: number | null;
    },

  /* -------------------------------------------------- workflow versions */

  /**
   * Notes what each workflow file hashes to right now, moving `updated_at`
   * only for the ones whose bytes actually changed. Called once at boot, from
   * `src/index.ts` rather than from the loader — loading workflows is a read.
   *
   * The hash covers the workflow file alone. A workflow whose behaviour
   * changed because `src/integrations/http.ts` did will not show as updated,
   * which is the right answer to "when was this workflow last edited" and the
   * wrong one to "when did this last behave differently". It answers the
   * first question.
   */
  recordWorkflowVersions(
    workflows: { name: string; hash: string }[],
  ): { added: number; changed: number } {
    const now = Date.now();
    const known = new Map(
      (stmts.allWorkflowVersions.all() as WorkflowVersion[]).map((v) => [v.workflow, v.hash]),
    );

    let added = 0;
    let changed = 0;
    db.transaction(() => {
      for (const w of workflows) {
        const previous = known.get(w.name);
        if (previous === w.hash) continue;
        if (previous === undefined) added++;
        else changed++;
        stmts.upsertWorkflowVersion.run(w.name, w.hash, now, now);
      }
    })();

    // Rows for workflows that no longer exist are left alone. A file deleted
    // and restored unchanged genuinely has not been edited, and keeping the
    // row is what lets it say so.
    return { added, changed };
  },

  /** Keyed by workflow name, for the dashboard. */
  workflowVersions(): Map<string, WorkflowVersion> {
    const rows = stmts.allWorkflowVersions.all() as WorkflowVersion[];
    return new Map(rows.map((r) => [r.workflow, r]));
  },

  /** Runs that were mid-flight when the process died can never complete. */
  markOrphans(): number {
    const now = Date.now();
    return stmts.markOrphans.run(now, now).changes;
  },

  pruneOlderThan(days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    const removed = stmts.pruneRuns.run(cutoff).changes;
    // steps aren't FK-bound to runs (they outlive them across resumes), so
    // they need their own sweep once the owning runs are gone.
    stmts.pruneSteps.run();
    // Settled deliveries age out on the same schedule as the runs they
    // started; pending ones are left alone at any age, because dropping work
    // that has not happened yet is the failure this table exists to prevent.
    stmts.pruneInbox.run(cutoff);
    return removed;
  },

  /* ------------------------------------------------------------- inbox */

  /**
   * Writes down a webhook delivery, or reports that this one is already here.
   *
   * The lookup and the insert are deliberately inside one synchronous method.
   * bun:sqlite is synchronous and nothing between them awaits, so two copies
   * of the same request arriving together cannot both pass the check; split
   * across an await, they could.
   *
   * Duplicates are judged inside a window rather than by a unique index on the
   * fingerprint, because an identical payload an hour later is usually a
   * second real event — two "ping" webhooks are not one webhook. The window
   * only has to be long enough to cover a caller retrying.
   */
  recordDelivery(entry: {
    workflow: string;
    fingerprint: string;
    input: string | null;
    dedupWindowMs: number;
  }): { id: string; duplicate: boolean } {
    const now = Date.now();
    const seen = stmts.recentDelivery.get(entry.fingerprint, now - entry.dedupWindowMs) as
      | { id: string }
      | null;
    if (seen) return { id: seen.id, duplicate: true };

    const id = crypto.randomUUID();
    stmts.insertDelivery.run(id, entry.workflow, entry.fingerprint, entry.input, now);
    return { id, duplicate: false };
  },

  settleDelivery(id: string, status: "done" | "abandoned", runId: string | null): void {
    stmts.settleDelivery.run(status, runId, id);
  },

  pendingDeliveries: () => stmts.pendingDeliveries.all() as InboxRecord[],
  pendingDeliveryCount: () => (stmts.pendingDeliveryCount.get() as { count: number }).count,

  /* -------------------------------------------------------- rejections */

  /**
   * Counts one webhook delivery that never became a run. Only ever called for
   * a path some workflow claims — see the table comment for why an unclaimed
   * path is not recorded.
   */
  recordRejection(entry: {
    workflow: string;
    path: string;
    reason: string;
    detail?: string | null;
  }): void {
    const now = Date.now();
    stmts.bumpRejection.run(
      entry.workflow,
      redact(entry.path),
      entry.reason,
      // A verifier's message is arbitrary text from workflow code, and a
      // schema's issue list names fields a caller controls. Both go through the
      // same treatment as any other observational string, and both are capped
      // so a pathological one cannot grow the row without bound.
      entry.detail == null ? null : redact(entry.detail).slice(0, REJECTION_DETAIL_MAX),
      now,
      now,
    );
  },

  /**
   * Marks this workflow's rejections as belonging to the past, because a
   * delivery just got through. Called from the one place in the webhook route
   * where every door check has passed, which is what makes it cover a
   * `respond: "sync"` hook too — those never reach the inbox, so anything
   * inferred from delivery records would have left them alarming forever.
   */
  resolveRejections(workflow: string): void {
    stmts.resolveRejections.run(Date.now(), workflow);
  },

  rejectionsFor: (workflow: string) =>
    stmts.rejectionsFor.all(workflow) as RejectionRecord[],

  /**
   * Totals per workflow for the list badge — **unresolved only**. A route that
   * was broken and now works keeps its record on the workflow page and stops
   * putting a red tag on the list, which is the whole point of resolved_at.
   */
  rejectionTotals(): Map<string, { count: number; last_at: number }> {
    const rows = stmts.rejectionTotals.all() as Array<{
      workflow: string;
      count: number;
      last_at: number;
    }>;
    return new Map(rows.map((r) => [r.workflow, { count: r.count, last_at: r.last_at }]));
  },

  clearRejections: (workflow: string) => stmts.clearRejections.run(workflow).changes,

  /* ------------------------------------------------------------- polls */

  /**
   * Stamps one tick of a poll trigger. Called from every exit in `pollOnce`,
   * including — especially — the ones that start no run: a quiet poll is the
   * only kind the dashboard cannot otherwise see.
   */
  recordPoll(tick: {
    workflow: string;
    at: number;
    items?: number | null;
    fresh?: number | null;
    error?: string | null;
  }): void {
    stmts.recordPoll.run(
      tick.workflow,
      tick.at,
      tick.items ?? null,
      tick.fresh ?? null,
      // Arbitrary text from workflow code, headed for a web page. Same
      // treatment as any other observational string.
      tick.error == null ? null : redact(tick.error).slice(0, POLL_ERROR_MAX),
    );
  },

  lastPoll: (workflow: string) =>
    (stmts.lastPoll.get(workflow) as PollRecord | null) ?? null,

  lastPolls(): Map<string, PollRecord> {
    const rows = stmts.lastPolls.all() as PollRecord[];
    return new Map(rows.map((r) => [r.workflow, r]));
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
      // `input` and `output` came through capture(), which redacts. `error` is
      // a provider's own words and has not been near it: Telegram puts the bot
      // token in the URL, so an unredacted 401 writes the credential onto the
      // run page. Redacted here, at the storage boundary, for the same reason
      // recordRun() redacts its own — not at the call site, where the next
      // caller would have to remember.
      redact(step.error),
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

  /* ----------------------------------------------------------- secrets */

  /*
   * Like `state`, and for the same reason, nothing here is redacted on the way
   * in — a credential you can't read back is not a credential. Unlike `state`,
   * every value is encrypted before it arrives, so `sqlite3` on this table
   * shows ciphertext. src/core/secret-store.ts is the only caller.
   */

  secretRows: () =>
    stmts.allSecrets.all() as { key: string; value: string; updated_at: number }[],

  /** Names, folders and owners — everything about a secret except its value. */
  secretMeta: () =>
    stmts.secretMeta.all() as {
      key: string;
      folder: string | null;
      owner: string | null;
      updated_at: number;
    }[],

  secretPut(
    key: string,
    ciphertext: string,
    meta: { folder?: string | null; owner?: string | null } = {},
  ): void {
    stmts.setSecret.run(key, ciphertext, Date.now(), meta.folder ?? null, meta.owner ?? null);
  },

  secretDrop(key: string): boolean {
    return stmts.deleteSecret.run(key).changes > 0;
  },

  /** Folders are metadata, so moving one never touches the ciphertext. */
  secretSetFolder(key: string, folder: string | null): boolean {
    return stmts.setSecretFolder.run(folder, key).changes > 0;
  },

  secretSetFolderByOwner(owner: string, folder: string | null): number {
    return stmts.setSecretFolderByOwner.run(folder, owner).changes;
  },

  secretDropByOwner(owner: string): number {
    return stmts.deleteSecretsByOwner.run(owner).changes;
  },

  /* ------------------------------------------------------- credentials */

  /*
   * Grouping only. Nothing here is encrypted because nothing here is a
   * credential — the values live in `secrets` under derived names. The one
   * field that carries text from outside is test_detail, and that is redacted
   * by src/core/credentials.ts before it arrives.
   */

  credentialRows: () => stmts.allCredentials.all() as CredentialRow[],

  /** Same probe as secretWatermark, over the credentials table alone. */
  credentialWatermark: () =>
    stmts.credentialWatermark.get() as { count: number; latest: number },

  credentialRow: (provider: string, id: string) =>
    stmts.getCredential.get(provider, id) as CredentialRow | undefined,

  credentialPut(row: {
    provider: string;
    id: string;
    folder: string | null;
    is_primary: number;
    created_at: number;
    updated_at: number;
  }): void {
    stmts.putCredential.run(
      row.provider,
      row.id,
      row.folder,
      row.is_primary,
      row.created_at,
      row.updated_at,
    );
  },

  credentialDrop(provider: string, id: string): boolean {
    return stmts.deleteCredential.run(provider, id).changes > 0;
  },

  /** Exactly one credential per platform feeds the built-in integration. */
  credentialClearPrimary(provider: string, keep: string): number {
    return stmts.clearPrimary.run(provider, keep).changes;
  },

  credentialRecordTest(
    provider: string,
    id: string,
    ok: boolean,
    detail: string,
    at: number,
  ): void {
    stmts.recordCredentialTest.run(at, ok ? 1 : 0, detail, provider, id);
  },

  /**
   * Cheap "has anything changed" probe, so the running server can pick up a
   * write made by the CLI in another process without re-reading every row.
   * Count as well as timestamp: a delete moves one and not the other.
   *
   * Covers the credentials table too, so a second process flipping which
   * credential is primary reaches this one's env mapping — that write moves no
   * secret row at all and would otherwise be invisible until a restart.
   */
  secretWatermark(): { count: number; latest: number } {
    const secrets = stmts.secretWatermark.get() as { count: number; latest: number };
    const creds = stmts.credentialWatermark.get() as { count: number; latest: number };
    return {
      count: secrets.count + creds.count,
      latest: Math.max(secrets.latest, creds.latest),
    };
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
