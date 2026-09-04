import { Cron } from "croner";
import { log } from "./logger.ts";
import { runWorkflow } from "./runner.ts";
import { pollOnce } from "./poll.ts";
import { store } from "./db.ts";
import type { Registry } from "./loader.ts";

const jobs: Cron[] = [];

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

  const retentionDays = Number(process.env.RUN_RETENTION_DAYS ?? 30);
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

export function nextRunFor(name: string): Date | null {
  return jobs.find((j) => j.name === name)?.nextRun() ?? null;
}

export function stopScheduler(): void {
  for (const job of jobs) job.stop();
  jobs.length = 0;
}
