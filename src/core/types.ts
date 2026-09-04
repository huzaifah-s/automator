import type { ZodType } from "zod";
import type { Logger } from "./logger.ts";
import type { StateClient } from "./state.ts";
import type { Integrations } from "../integrations/index.ts";

export type TriggerKind = "cron" | "webhook" | "manual" | "poll";

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
      /** Overrides the global WEBHOOK_SECRET for this route. */
      secret?: string;
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
}

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
  file: string;
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
