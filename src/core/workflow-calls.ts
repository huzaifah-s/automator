/**
 * Reaching workflows by name from outside a run — an agent's tool, which is
 * called by a model rather than started by a trigger, and so has no `ctx`.
 *
 * Inside a workflow, `ctx.run(name, input)` is the way to start another
 * one: it nests the child under the run and shares its concurrency slot.
 * A tool has no run to nest under, so `startWorkflow` starts a manual run,
 * the same as the dashboard's Run now.
 */

import { store } from "./db.ts";
import { isEnabled } from "./pause.ts";
import { currentRegistry, runWorkflow, type RunOutcome } from "./runner.ts";
import { schedulesOn } from "./scheduler.ts";
import type { RunStatus } from "./types.ts";

export type { RunOutcome };

/** Whether a workflow by this name is loaded on this server. */
export function workflowLoaded(name: string): boolean {
  return Boolean(currentRegistry()?.get(name));
}

/**
 * Starts a workflow as a manual run and waits for it — its own run page,
 * retries and checkpoints. Resolves with the outcome rather than throwing
 * on a failed run; throws only when nothing by that name is loaded.
 */
export async function startWorkflow(name: string, input?: unknown): Promise<RunOutcome> {
  const wf = currentRegistry()?.get(name);
  if (!wf) throw new Error(`${name} is not loaded on this server`);
  return runWorkflow(wf, { trigger: "manual", input });
}

/**
 * Whether a workflow runs on its own here right now: loaded, not paused or
 * disabled, and this process firing schedules (not a laptop with
 * SCHEDULE=off).
 */
export function workflowIsLive(name: string): boolean {
  const wf = currentRegistry()?.get(name);
  return Boolean(wf && isEnabled(wf) && schedulesOn());
}

/** One past run, as `workflowRuns` returns it. `result` is the stored JSON. */
export interface PastRun {
  id: string;
  status: RunStatus;
  startedAt: number;
  result: string | null;
}

/** A workflow's latest runs, newest first — what it returned, not its input or steps. */
export function workflowRuns(name: string, limit = 20): PastRun[] {
  return store.runsForWorkflow(name, limit).map((r) => ({
    id: r.id,
    status: r.status as RunStatus,
    startedAt: r.started_at,
    result: r.result ?? null,
  }));
}
