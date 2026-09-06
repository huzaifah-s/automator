import { store } from "./db.ts";
import { log } from "./logger.ts";
import type { LoadedWorkflow, WorkflowPause } from "./types.ts";

/**
 * The operator's switch: whether a workflow is allowed to run on its own right
 * now, as opposed to whether the file says it should exist at all.
 *
 * There are two answers to "is this workflow on", and keeping them apart is the
 * whole design.
 *
 *   `enabled: false` in the file is the **code's** answer. It lives in the
 *   repo, it is reviewed, and it travels with a deploy.
 *
 *   A row in `workflow_pauses` is the **operator's** answer. It lives in the
 *   database, it is one click on the dashboard, and it survives restarts.
 *
 * A pause can only ever *subtract*. There is no way to switch on a workflow the
 * file turned off, and that asymmetry is deliberate: the dashboard being able
 * to resurrect code that says it should not run is exactly the configuration
 * drift this project left n8n to avoid, and it would make the file a lie. A
 * kill switch is the useful half — it is what you want at 2am — and it is the
 * half that cannot make the repo wrong, because turning a pause off restores
 * whatever the file already said rather than overriding it.
 *
 * What a pause stops: the scheduler (cron and poll), webhook routes, inbox
 * recovery, `ctx.run()` from another workflow, and provider-side webhook
 * subscriptions at the next boot. What it deliberately does **not** stop is the
 * dashboard's own Run now button — the same latitude `enabled: false` already
 * had, and the reason is that "off" here means "stops firing by itself", not
 * "cannot be tested". A person clicking Run now is not the workflow running;
 * it is them running it.
 */

/**
 * Mirrors `workflow_pauses`. This is read on the hot path — every webhook
 * match, every scheduler tick, every registry lookup — and the table is empty
 * on almost every deployment, so it is loaded whole and kept.
 *
 * Safe to cache because this process is the only writer: unlike secrets, there
 * is no CLI writing pauses behind the server's back, so there is nothing to
 * refresh from. Null until the first read loads it.
 */
let cache: Map<string, WorkflowPause> | null = null;

function pauses(): Map<string, WorkflowPause> {
  return (cache ??= store.pauses());
}

/** The pause on this workflow, or null when it is not paused. */
export function pausedInfo(name: string): WorkflowPause | null {
  return pauses().get(name) ?? null;
}

export function isPaused(name: string): boolean {
  return pauses().has(name);
}

/** Every paused workflow, for the dashboard and the API. */
export function allPauses(): Map<string, WorkflowPause> {
  return new Map(pauses());
}

/**
 * Whether this workflow runs on its own right now: the file allows it *and*
 * nobody has paused it. The one question everything else should ask —
 * `wf.enabled !== false` on its own is now only half the answer.
 */
export function isEnabled(wf: Pick<LoadedWorkflow, "name" | "enabled">): boolean {
  return wf.enabled !== false && !isPaused(wf.name);
}

/**
 * Switches a workflow off. Returns false when the file already had it off, in
 * which case nothing is written: a pause on top of `enabled: false` would be a
 * row that changes nothing and a button that claims to have done something.
 *
 * Pausing something already paused is not an error and does not restamp
 * `paused_at` — it only updates the note. Re-clicking a switch that is already
 * down is not a new decision.
 */
export function pause(wf: LoadedWorkflow, note: string | null = null): boolean {
  if (wf.enabled === false) return false;
  const already = isPaused(wf.name);
  store.pauseWorkflow(wf.name, note);
  cache = store.pauses();
  // Warn, not info: something that used to run does not any more, and the
  // person who finds that out weeks later is reading this log.
  if (!already) log.warn(`${wf.name} was paused from the dashboard${note ? ` — ${note}` : ""}`);
  return true;
}

/** Lifts a pause, restoring whatever the file says. False if it was not paused. */
export function resume(name: string): boolean {
  const lifted = store.resumeWorkflow(name);
  cache = store.pauses();
  if (lifted) log.info(`${name} was resumed from the dashboard`);
  return lifted;
}

/** Logs what is switched off at boot, so a pause cannot be quietly forgotten. */
export function reportPauses(names: Iterable<string>): void {
  const known = new Set(names);
  const paused = [...pauses().values()].filter((p) => known.has(p.workflow));
  if (paused.length === 0) return;
  log.warn(
    `${paused.length} workflow(s) paused from the dashboard and will not run: ` +
      paused
        .map((p) => `${p.workflow} (since ${new Date(p.paused_at).toISOString()})`)
        .join(", "),
  );
}
