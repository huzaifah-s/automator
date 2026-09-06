import { Cron } from "croner";
import { log } from "./logger.ts";
import { runWorkflow } from "./runner.ts";
import { pollOnce } from "./poll.ts";
import { store } from "./db.ts";
import type { Registry } from "./loader.ts";
import type { LoadedWorkflow } from "./types.ts";

/**
 * One croner job per scheduled workflow, keyed by name so a pause can take
 * exactly its own job down. Kept apart from the maintenance job below rather
 * than in one list: that one is not a workflow, and a workflow legitimately
 * named "prune" would otherwise share its key.
 */
const jobs = new Map<string, Cron>();
/** The nightly prune. Not a workflow, and never unscheduled by a pause. */
let maintenance: Cron | undefined;

/** Days of run history kept when `RUN_RETENTION_DAYS` says nothing usable. */
const DEFAULT_RETENTION_DAYS = 14;

/** Wires every scheduled workflow to croner and starts a nightly prune. */
export function startScheduler(registry: Registry): void {
  // enabled() already leaves out anything paused, so a workflow switched off
  // before the last restart comes back up switched off.
  for (const wf of registry.enabled()) scheduleWorkflow(wf);

  const retentionDays = resolveRetentionDays();
  maintenance = new Cron("0 4 * * *", { name: "@prune" }, () => {
    if (retentionDays > 0) {
      const removed = store.pruneOlderThan(retentionDays);
      if (removed > 0) log.info(`Pruned ${removed} run(s) older than ${retentionDays}d`);
    }
    // Expired state is already invisible to reads, so this is only about
    // reclaiming disk — it runs even when run pruning is switched off.
    const stale = store.pruneExpiredState();
    if (stale > 0) log.info(`Pruned ${stale} expired state key(s)`);
  });
}

/**
 * Starts this workflow's timer, if it has one. Called at boot for everything
 * enabled, and again when a pause is lifted from the dashboard — which is why
 * it has to be idempotent: resuming something that was never paused must not
 * leave two jobs firing the same workflow.
 *
 * A trigger that is neither cron nor poll has no timer and this is a no-op.
 */
export function scheduleWorkflow(wf: LoadedWorkflow): void {
  const trigger = wf.trigger;
  // cron and poll are both "run me on this expression"; they differ only in
  // what happens when the expression fires.
  if (trigger.kind !== "cron" && trigger.kind !== "poll") return;
  if (jobs.has(wf.name)) return;

  try {
    const job = new Cron(
      trigger.expression,
      { timezone: trigger.tz, name: wf.name, protect: true },
      trigger.kind === "poll"
        ? () => {
            void pollOnce(wf);
          }
        : () => {
            void runWorkflow(wf, { trigger: "cron" });
          },
    );
    jobs.set(wf.name, job);
    log.info(
      `Scheduled ${wf.name}: ${trigger.kind === "poll" ? "poll " : ""}${trigger.expression}` +
        `${trigger.tz ? ` (${trigger.tz})` : ""} — next ${job.nextRun()?.toISOString() ?? "never"}`,
    );
  } catch (err) {
    // A bad expression should be loud but must not take the other jobs down.
    log.error(
      `Invalid cron expression for ${wf.name}: "${trigger.expression}" — ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

/**
 * Stops this workflow's timer. The pause path — taking the job down rather
 * than leaving it running and dropping the run when it fires, so the "next
 * run" the dashboard shows is honest: a paused workflow has no next run, and
 * printing one it will not honour is the kind of small lie that costs an hour.
 *
 * A run already in flight is left alone. Pausing means "stop starting", not
 * "abandon what is half done"; runner.ts refuses the *next* trigger.
 */
export function unscheduleWorkflow(name: string): void {
  const job = jobs.get(name);
  if (!job) return;
  job.stop();
  jobs.delete(name);
  log.info(`Unscheduled ${name} — it is paused`);
}

/**
 * How many days of run history to keep, from `RUN_RETENTION_DAYS`.
 *
 * Two weeks is the default because it is exactly the widest window the
 * executions tab can ask for — history no chip can select is disk nobody
 * reads. Raise this and the tab is where a wider chip belongs, so the two stay
 * the same number. `0` keeps everything forever.
 *
 * A value that is not a number falls back to the default *loudly*. Silently
 * reading `NaN` switched pruning off entirely, which is the failure you notice
 * a month later when the database has quietly grown instead of the moment you
 * mistyped the variable.
 */
function resolveRetentionDays(): number {
  const raw = process.env.RUN_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;

  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    log.error(
      `RUN_RETENTION_DAYS is "${raw}", which is not a number of days — ` +
        `keeping the default of ${DEFAULT_RETENTION_DAYS}d`,
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return days;
}

/** Null for a workflow with no timer, and for one that is paused. */
export function nextRunFor(name: string): Date | null {
  return jobs.get(name)?.nextRun() ?? null;
}

export function stopScheduler(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  maintenance?.stop();
  maintenance = undefined;
}
