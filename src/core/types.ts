import type { ZodType } from "zod";
import type { Logger } from "./logger.ts";
import type { Integrations } from "../integrations/index.ts";

export type TriggerKind = "cron" | "webhook" | "manual";

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
  | { kind: "manual" };

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
