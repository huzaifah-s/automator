import { Cron } from "croner";
import { createLogger, log } from "./logger.ts";
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

/**
 * How far back a missed tick is still worth mentioning. Past this it is not
 * news that a workflow which has been off for a week did not run — the same
 * judgement the inbox makes about a delivery older than a day, and the same
 * number.
 */
const MISSED_LOOKBACK_MS = 86_400_000;

/**
 * Ceiling on how many missed ticks are enumerated for one workflow. A
 * per-minute cron on a host that was down overnight has hundreds, and the
 * exact figure is worth nothing next to the fact that it happened.
 */
const MAX_MISSED_REPORTED = 50;

/**
 * Records the scheduled runs that fell in the window where nothing was
 * running — a deploy, a crash, a host reboot.
 *
 * Croner schedules forward from now and has no memory across processes, so a
 * cron due at 09:00 on a deploy that lands at 08:59:30 simply never fired: no
 * run row, no log line, and a workflow page whose last run is yesterday's,
 * which looks identical to a scheduler that has quietly died. This closes that
 * one hole — the *reporting* one. It does not run anything.
 *
 * **It deliberately does not catch up.** A daily 09:00 report firing at 15:40
 * because that is when the deploy finished is a surprise delivered to whoever
 * receives it, and a crash-looping process would deliver it on every boot.
 * "Run now" is one click away on a workflow page, and the person clicking it
 * knows what time it is. If a workflow ever genuinely wants the other
 * behaviour, that is an opt-in on its own trigger and not a default.
 *
 * Poll triggers are left out on purpose. A missed poll tick costs nothing: the
 * seen-set is only advanced by a successful run, so the next tick fetches the
 * same items and delivers whatever it had not delivered yet. Cron is the only
 * trigger where a skipped tick is work that never happens.
 *
 * No alert either. Every deploy that lands near a scheduled time produces one
 * of these, which is exactly the traffic the alert cooldown exists to stop —
 * and unlike a failure, there is nothing here to act on.
 */
export function reportMissedTicks(registry: Registry): void {
  const now = Date.now();

  for (const wf of registry.enabled()) {
    if (wf.trigger.kind !== "cron") continue;
    const job = jobs.get(wf.name);
    // No job means the expression did not parse; scheduleWorkflow already said
    // so, and a workflow with no schedule cannot have missed one.
    if (!job) continue;

    const lastRun = store.lastRunAt(wf.name, "cron");
    // Never run on this trigger, or its history has aged out. Either way there
    // is no point to measure from, and inventing one would report every tick
    // since the epoch on a workflow deployed this morning.
    if (lastRun === null) continue;

    // Whichever is later. The floor is what stops a workflow that was paused
    // for a fortnight from coming back with a fortnight of missed ticks.
    const since = new Date(Math.max(lastRun, now - MISSED_LOOKBACK_MS));
    const missed = job
      .nextRuns(MAX_MISSED_REPORTED, since)
      .filter((d) => d.getTime() <= now);
    if (missed.length === 0) continue;

    const capped = missed.length === MAX_MISSED_REPORTED;
    const last = missed[missed.length - 1]!;
    const message =
      `Missed ${capped ? `at least ${MAX_MISSED_REPORTED}` : missed.length} scheduled ` +
      `run(s) while the process was not running — the latest was due ` +
      `${last.toISOString()}`;

    // A run row rather than only a log line, so it lands where somebody looks
    // for it: the workflow's own history, next to the runs that did happen.
    // `skipped`, because that is what it is — not a failure of anything.
    const runId = crypto.randomUUID();
    store.startRun(runId, wf.name, "cron");
    store.finishRun(runId, "skipped", 0, message, null);
    createLogger(wf.name, runId).warn(message);
  }
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
