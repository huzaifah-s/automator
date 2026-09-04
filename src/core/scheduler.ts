import { Cron } from "croner";
import { log } from "./logger.ts";
import { runWorkflow } from "./runner.ts";
import { store } from "./db.ts";
import type { Registry } from "./loader.ts";

const jobs: Cron[] = [];

/** Wires every cron-triggered workflow to croner and starts a nightly prune. */
export function startScheduler(registry: Registry): void {
  for (const wf of registry.enabled()) {
    if (wf.trigger.kind !== "cron") continue;

    try {
      const job = new Cron(
        wf.trigger.expression,
        { timezone: wf.trigger.tz, name: wf.name, protect: true },
        () => {
          void runWorkflow(wf, { trigger: "cron" });
        },
      );
      jobs.push(job);
      log.info(
        `Scheduled ${wf.name}: ${wf.trigger.expression}` +
          `${wf.trigger.tz ? ` (${wf.trigger.tz})` : ""} — next ${job.nextRun()?.toISOString() ?? "never"}`,
      );
    } catch (err) {
      // A bad expression should be loud but must not take the other jobs down.
      log.error(
        `Invalid cron expression for ${wf.name}: "${wf.trigger.expression}" — ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  const retentionDays = Number(process.env.RUN_RETENTION_DAYS ?? 30);
  if (retentionDays > 0) {
    jobs.push(
      new Cron("0 4 * * *", { name: "prune-runs" }, () => {
        const removed = store.pruneOlderThan(retentionDays);
        if (removed > 0) log.info(`Pruned ${removed} run(s) older than ${retentionDays}d`);
      }),
    );
  }
}

export function nextRunFor(name: string): Date | null {
  return jobs.find((j) => j.name === name)?.nextRun() ?? null;
}

export function stopScheduler(): void {
  for (const job of jobs) job.stop();
  jobs.length = 0;
}
