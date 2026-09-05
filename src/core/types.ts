import type { ZodType } from "zod";
import type { Logger } from "./logger.ts";
import type { StateClient } from "./state.ts";
import type { Integrations } from "../integrations/index.ts";

/** "workflow" means another workflow started this run through ctx.run(). */
export type TriggerKind = "cron" | "webhook" | "manual" | "poll" | "workflow";

/**
 * Decides whether a webhook call is genuine, from the request as it arrived.
 *
 * `body` is the undecoded text: an HMAC recomputed over a re-serialised
 * object will not match, so the bytes are handed over untouched.
 */
export type WebhookVerifier = (req: {
  body: string;
  headers: Headers;
}) => boolean | Promise<boolean>;

export type Trigger =
  | {
      kind: "cron";
      /** Standard 5- or 6-field cron expression. */
      expression: string;
      /** IANA zone, e.g. "Asia/Kuala_Lumpur". Defaults to the TZ env var, then UTC. */
      tz?: string;
    }
  | {
      kind: "webhook";
      /** Mounted at /hooks/<path>. */
      path: string;
      method?: "GET" | "POST";
      /** Validates the parsed body (POST) or query string (GET). */
      schema?: ZodType;
      /**
       * "async" (default) returns 202 + runId immediately — correct for almost
       * every provider, which will retry on a slow response.
       * "sync" waits for the workflow and returns its result.
       */
      respond?: "async" | "sync";
      /**
       * Overrides the global WEBHOOK_SECRET for this route. `false` opts the
       * route out of the secret check altogether — for a URL a person clicks,
       * where a shared secret cannot travel in the link and the workflow
       * authenticates the caller itself. See README "Links a human clicks".
       */
      secret?: string | false;
      /**
       * Authenticates the caller from the raw request instead of a shared
       * secret — for a provider that signs the body rather than echoing a
       * token back. Runs before any run exists, so a forged call leaves no
       * trace but a warning; returning false is a 401.
       *
       * Mutually exclusive with `secret`: declaring both stops the boot,
       * because which one was actually guarding the route would otherwise be
       * a guess. See hmacSignature() and tallySignature().
       */
      verify?: WebhookVerifier;
      /**
       * Creates and deletes the subscription at the provider, so a webhook is
       * not a URL somebody pasted into a dashboard once and has to remember.
       * Reconciled at boot against the id kept in state: an existing
       * subscription at the same URL is left alone, a changed `PUBLIC_URL` is
       * migrated, and a disabled workflow's subscription is deleted.
       *
       * Never called during a run, and a provider being down never fails boot.
       */
      register?: WebhookRegistration;
    }
  | {
      kind: "poll";
      /** How often to check. Same 5- or 6-field cron expression as cron(). */
      expression: string;
      /** IANA zone, e.g. "Asia/Kuala_Lumpur". Defaults to the TZ env var. */
      tz?: string;
      /**
       * Returns everything the source currently has. Only the items this
       * workflow has never seen reach run(), as ctx.input — and when there are
       * none, no run happens at all.
       */
      fetch(ctx: PollCtx): Promise<unknown[]>;
      /**
       * Stable identity for one item, which is what "seen before" is decided
       * on. Defaults to a hash of the whole item, so an item whose fields
       * change looks new. Give an id whenever the source has one.
       */
      id?(item: any): string | number;
      /** How many recent ids to remember. Default 500. */
      remember?: number;
      /**
       * What the very first poll does. "skip" (default) records what is
       * already there and runs nothing, so turning a workflow on doesn't fire
       * once per pre-existing item. "emit" treats everything as new.
       */
      firstRun?: "skip" | "emit";
      /** Ceiling on fetch() itself, separate from the run. Default 60_000. */
      timeoutMs?: number;
    }
  | { kind: "manual" };

export interface WebhookRegistration {
  /** Creates the subscription and returns the provider's id for it. */
  create(ctx: RegisterCtx): Promise<string>;
  /**
   * Deletes the subscription the provider gave back. Called when the workflow
   * is disabled, or when its public URL changed and is being migrated.
   * A subscription the provider already dropped should be treated as removed,
   * not as an error.
   */
  remove(ctx: RegisterCtx, subscriptionId: string): Promise<void>;
}

/**
 * What a webhook registration hook gets: the same clients a run has, minus
 * everything that only means something inside a run — this happens once at
 * boot, with no runId to attach steps or captured calls to.
 */
export interface RegisterCtx extends Integrations {
  workflow: string;
  /** This workflow's own hook, externally: `${PUBLIC_URL}/hooks/${path}`. */
  url: string;
  log: Logger;
  signal: AbortSignal;
  state: StateClient;
}

/**
 * What a poll trigger's fetch() gets. Every client a run has, minus the things
 * that only make sense inside one — there is no run yet, and there may never
 * be one if nothing new turns up.
 */
export interface PollCtx extends Integrations {
  workflow: string;
  log: Logger;
  signal: AbortSignal;
  state: StateClient;
}

/** What the runner hands to `run()`. */
export interface Ctx<Input = unknown> extends Integrations {
  runId: string;
  workflow: string;
  input: Input;
  /** 1 on the first try, 2 on the first retry, and so on. */
  attempt: number;
  triggeredBy: TriggerKind;
  log: Logger;
  /** Aborts on timeout or shutdown. Pass it to fetch and long operations. */
  signal: AbortSignal;
  /**
   * Durable key/value store, scoped to this workflow and surviving restarts,
   * redeploys, and run-history pruning. For the things a run needs to remember
   * about the last one: polling cursors, rotating OAuth tokens, dedupe marks.
   * `state.shared` is a namespace every workflow can reach.
   */
  state: StateClient;
  /**
   * Wraps a unit of work so it shows up in the run log with its own timing.
   * Purely observational — a failing step fails the run.
   */
  step<R>(
    name: string,
    fn: () => Promise<R>,
    opts?: {
      /** Recorded alongside the result so the run page shows what went in. */
      input?: unknown;
      /** Set false to always re-run this step, even on a resume. */
      checkpoint?: boolean;
    },
  ): Promise<R>;
  /**
   * Runs another workflow and returns its result — the composition primitive,
   * in place of importing its function (which loses the run record) or POSTing
   * your own webhook (which means dealing with the secret).
   *
   * The child gets its own run page, its own retries, and its own checkpoints,
   * and it inherits this run's concurrency slot rather than taking a second
   * one. A child that fails throws here, so the parent fails too unless you
   * catch it. Wrap the call in `ctx.step` if a parent resume should skip it.
   *
   * Throws before starting anything if the call would loop back into a
   * workflow already in this chain, or if the child was skipped because a run
   * of it was already in flight.
   */
  run<R = unknown>(name: string, input?: unknown): Promise<R>;
}

/**
 * A workflow's connection to the runner's alert channel. `true` (the default)
 * uses ALERT_CHANNEL; `false` opts out; an object names a different one. See
 * `alerts` on WorkflowDef and src/core/alerts.ts.
 */
export type WorkflowAlerts = boolean | { channel?: string };

export interface WorkflowDef<Input = unknown> {
  /** Unique. Used in URLs, logs, and the CLI. */
  name: string;
  description?: string;
  trigger: Trigger;
  /** Set false to keep the file but stop scheduling it. Default true. */
  enabled?: boolean;
  /** Extra attempts after the first failure. Default 2. */
  retries?: number;
  /** Base backoff; doubles each attempt with jitter. Default 2000. */
  retryDelayMs?: number;
  /** Hard ceiling per attempt. Default 300_000 (5 min). */
  timeoutMs?: number;
  /**
   * What to do when a run is triggered while one is already in flight.
   * "skip" (default) drops it — right for cron. "queue" waits its turn.
   */
  onOverlap?: "skip" | "queue";
  /**
   * Whether the runner tells you when *this* workflow has a problem it did not
   * choose to report itself — a run that used up its retries, a run refused
   * because a credential is not connected, a webhook delivery turned away, a
   * subscription that failed to register. Default true; the destination is
   * ALERT_CHANNEL.
   *
   * `false` opts out. An object routes this workflow's alerts somewhere else,
   * which is what one server serving several brands needs: a pblsh failure
   * belongs in the pblsh chat, not The Mantra's.
   *
   *   alerts: false
   *   alerts: { channel: "telegram:pblsh" }
   *
   * This has nothing to do with a workflow messaging you from inside run().
   * That is part of what the workflow does, and it only happens while the
   * workflow works.
   */
  alerts?: WorkflowAlerts;
  run(ctx: Ctx<Input>): Promise<unknown>;
  /**
   * Memoise successful ctx.step results so a retry — or an explicit resume from
   * the dashboard — skips work that already succeeded. Default true.
   */
  checkpoint?: boolean;
  /** Checkpoints older than this are ignored on resume. Default 24. 0 disables. */
  checkpointTtlHours?: number;
  /** Called once after every attempt has failed. Errors here are logged, not thrown. */
  onFailure?(ctx: Ctx<Input>, error: Error): Promise<void>;
}

export interface LoadedWorkflow extends WorkflowDef<any> {
  /** Path relative to the workflows directory, subdirectories included. */
  file: string;
  /**
   * The subdirectory the file was found in — `"pblsh"`, or `"acme/billing"`
   * for a nested one — and `null` at the top level. Workflow names stay
   * global and flat; this only groups them for the eye.
   */
  folder: string | null;
  /**
   * SHA-256 of the file's source, as read at boot. The dashboard's "updated"
   * time is derived from this changing — see `workflow_versions` in db.ts for
   * why it is not the file's mtime.
   */
  hash: string;
  /**
   * Credentials this file declared with defineCredential(), as `provider:id`.
   * Unlike a declared secret, one that is not connected yet does not stop the
   * boot — it blocks this workflow's runs instead, because the dashboard where
   * you would connect it is not reachable from a server that refused to start.
   */
  credentials: string[];
}

/** When a workflow file was first seen, and when its contents last changed. */
export interface WorkflowVersion {
  workflow: string;
  hash: string;
  first_seen: number;
  /** Equal to `first_seen` until the file is edited for the first time. */
  updated_at: number;
}

export type RunStatus = "running" | "success" | "failed" | "skipped";

export interface RunRecord {
  id: string;
  workflow: string;
  status: RunStatus;
  trigger: TriggerKind;
  attempts: number;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  result: string | null;
  checkpoint_key: string;
  resumed_from: string | null;
  /** The run this one replayed, if any. Distinct from resumed_from — see db.ts. */
  replayed_from: string | null;
  /** The run that called this one through ctx.run(), if any. */
  parent_run: string | null;
  /** The captured trigger input, redacted and capped like every other payload. */
  input: string | null;
}

/** One accepted webhook delivery — see the `inbox` table in db.ts. */
export interface InboxRecord {
  id: string;
  workflow: string;
  fingerprint: string;
  /** The trigger input as JSON, ready to be handed straight to a run. */
  input: string | null;
  received_at: number;
  status: "pending" | "done" | "abandoned";
  /** The run that consumed this delivery, once there was one. */
  run_id: string | null;
}

/**
 * A webhook delivery that was turned away before any run existed, counted per
 * (workflow, path, reason) rather than stored per attempt — see the table
 * comment in db.ts for why.
 */
export interface RejectionRecord {
  workflow: string;
  path: string;
  reason: string;
  /** Why the check failed, where there is something to say. Redacted, capped. */
  detail: string | null;
  count: number;
  first_at: number;
  last_at: number;
  /**
   * When a delivery to this workflow last got through the door. At or after
   * `last_at` means this row is history rather than a live problem.
   */
  resolved_at: number | null;
}

/**
 * The last time a poll trigger looked, and what it saw. One row per workflow,
 * overwritten every tick — see the `polls` table in db.ts for why the tick
 * history is not kept.
 */
export interface PollRecord {
  workflow: string;
  /** When the tick started fetching, not when it finished. */
  at: number;
  /** How many items the fetch returned. Null only when it threw. */
  items: number | null;
  /** How many of those had not been seen before. Null only when it threw. */
  fresh: number | null;
  /** Why the fetch failed, redacted and capped. Null on a healthy tick. */
  error: string | null;
}

export interface LogRecord {
  id: number;
  run_id: string;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  data: string | null;
}

export interface StepRecord {
  id: number;
  checkpoint_key: string;
  run_id: string;
  name: string;
  status: "ok" | "failed";
  started_at: number;
  duration_ms: number | null;
  input: string | null;
  output: string | null;
  error: string | null;
  truncated: number;
}

export interface CallRecord {
  id: number;
  run_id: string;
  ts: number;
  method: string;
  url: string;
  status: number | null;
  duration_ms: number | null;
  request: string | null;
  response: string | null;
}

/**
 * The grouping half of a credential — see `credentials` in db.ts. Holds no
 * values: the fields are ordinary rows in the encrypted `secrets` table under
 * derived names, and this row only says which platform, which folder, and how
 * the last connection test went.
 */
export interface CredentialRow {
  provider: string;
  id: string;
  folder: string | null;
  /** 1 when this credential feeds the matching built-in integration's env vars. */
  is_primary: number;
  created_at: number;
  updated_at: number;
  tested_at: number | null;
  test_ok: number | null;
  /** Already redacted and capped by src/core/credentials.ts. */
  test_detail: string | null;
}
