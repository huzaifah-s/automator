import { Cron } from "croner";
import { log } from "./logger.ts";
import { runWorkflow } from "./runner.ts";
import { pollOnce } from "./poll.ts";
import { store } from "./db.ts";
import type { Registry } from "./loader.ts";

const jobs: Cron[] = [];

/** Days of run history kept when `RUN_RETENTION_DAYS` says nothing usable. */
const DEFAULT_RETENTION_DAYS = 14;

/** Wires every scheduled workflow to croner and starts a nightly prune. */
export function startScheduler(registry: Registry): void {
  for (const wf of registry.enabled()) {
    const trigger = wf.trigger;
    // cron and poll are both "run me on this expression"; they differ only in
    // what happens when the expression fires.
    if (trigger.kind !== "cron" && trigger.kind !== "poll") continue;

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
      jobs.push(job);
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

  const retentionDays = resolveRetentionDays();
  jobs.push(
    new Cron("0 4 * * *", { name: "prune" }, () => {
      if (retentionDays > 0) {
        const removed = store.pruneOlderThan(retentionDays);
        if (removed > 0) log.info(`Pruned ${removed} run(s) older than ${retentionDays}d`);
      }
      // Expired state is already invisible to reads, so this is only about
      // reclaiming disk — it runs even when run pruning is switched off.
      const stale = store.pruneExpiredState();
      if (stale > 0) log.info(`Pruned ${stale} expired state key(s)`);
    }),
  );
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

export function nextRunFor(name: string): Date | null {
  return jobs.find((j) => j.name === name)?.nextRun() ?? null;
}

export function stopScheduler(): void {
  for (const job of jobs) job.stop();
  jobs.length = 0;
}
