import { alertHeardAgain, alertQuiet } from "./alerts.ts";
import { store } from "./db.ts";
import type { Registry } from "./loader.ts";
import { log } from "./logger.ts";
import { isEnabled } from "./pause.ts";
import type { HeardRecord, LoadedWorkflow } from "./types.ts";

/**
 * Quiet webhooks: a route that has stopped hearing from its sender.
 *
 * The one failure that nothing else in the runner can see. A provider that
 * stops calling — Notion switching a subscription off after deliveries it
 * counted as failed, a URL deleted on the provider's side — produces no failed
 * run, no rejection and no error. The workflow page shows a last run a few days
 * old, which is also what a quiet week looks like. `quietAfterMs` on the
 * trigger is the author saying how long is too long, and this is what holds
 * the route to it.
 *
 * Two halves. The webhook route stamps every delivery that gets through the
 * door (`noteDelivery`), and a maintenance job measures every watched route
 * against its limit every fifteen minutes (`checkQuiet`). One alert per
 * stretch of quiet, and one more when it ends, so the person who went and
 * fixed the subscription is told that it worked.
 */

/**
 * Called by the webhook route for a delivery that passed every check at the
 * door — before the filter, so a delivery it ignores still counts: it proves
 * the sender is calling, which is the only thing this is about.
 *
 * Stamped for every webhook, watched or not. It is one upsert, and it means a
 * route that gains `quietAfterMs` later starts with a real last delivery
 * rather than a guess.
 */
export function noteDelivery(wf: LoadedWorkflow): void {
  const before = store.stampHeard(wf.name);
  if (before?.alerted_at == null || wf.trigger.kind !== "webhook") return;
  alertHeardAgain(wf, wf.trigger.path, Date.now() - quietSince(before));
}

/** Where the quiet clock started for this row. */
function quietSince(row: HeardRecord): number {
  return Math.max(row.heard_at ?? 0, row.since ?? 0);
}

/** A watched route that is over its limit right now. */
export interface QuietRoute {
  workflow: LoadedWorkflow;
  path: string;
  quietSince: number;
  heardAt: number | null;
  limitMs: number;
  alerted: boolean;
  /**
   * Unresolved rejections counted since the quiet began, or 0. A route whose
   * sender is calling and failing a check is quiet too, and the alert has to
   * say which of the two it is looking at.
   */
  rejected: number;
}

/** Watched routes: webhooks whose trigger declares `quietAfterMs`. */
function watched(registry: Registry) {
  return registry.all().flatMap((wf) =>
    wf.trigger.kind === "webhook" && wf.trigger.quietAfterMs !== undefined
      ? [{ wf, path: wf.trigger.path, limitMs: wf.trigger.quietAfterMs }]
      : [],
  );
}

/**
 * Every watched route over its limit right now, for the check below and for
 * anything that wants to show them. Reads only — a route the check has not
 * started watching yet, or one that is switched off, is not in the answer.
 */
export function quietRoutes(registry: Registry, now = Date.now()): QuietRoute[] {
  const out: QuietRoute[] = [];
  const rejections = store.rejectionTotals();
  for (const { wf, path, limitMs } of watched(registry)) {
    const row = store.getHeard(wf.name);
    if (!row || !isEnabled(wf)) continue;
    const since = quietSince(row);
    if (now - since < limitMs) continue;
    const rejected = rejections.get(wf.name);
    out.push({
      workflow: wf,
      path,
      quietSince: since,
      heardAt: row.heard_at,
      limitMs,
      alerted: row.alerted_at !== null,
      rejected: rejected && rejected.last_at >= since ? rejected.count : 0,
    });
  }
  return out;
}

/**
 * Starts watching a route not seen before, and holds the clock at now for one
 * that is switched off.
 */
function keepClocks(registry: Registry, now: number): void {
  for (const { wf } of watched(registry)) {
    if (!store.getHeard(wf.name)) {
      // First sight — a new workflow, or the deploy that added this. Measure
      // from the last delivery the database already knows about, so a route
      // that was dead before the check existed is reported on the first pass
      // instead of after another full window. Nothing known: start now.
      const heardAt =
        Math.max(
          store.lastRunAt(wf.name, "webhook") ?? 0,
          store.ignoredTotals().get(wf.name)?.last_at ?? 0,
        ) || null;
      store.startHeard(wf.name, heardAt, heardAt ?? now);
    }

    // Off means nobody should be calling, so quiet is correct and the clock
    // is held at now. Otherwise resuming a workflow paused for a week would be
    // greeted with an alert that it has heard nothing for a week.
    if (!isEnabled(wf)) store.restartHeard(wf.name, now);
  }
}

/**
 * The maintenance job. Alerts once for each route that has gone over its
 * limit since the last delivery, and records that it did so that neither the
 * next pass nor a restart sends it again. Must not throw: it runs on a timer
 * nobody is watching.
 */
export function checkQuiet(registry: Registry): void {
  try {
    const now = Date.now();
    keepClocks(registry, now);
    for (const q of quietRoutes(registry, now)) {
      if (q.alerted) continue;
      // Stamped before the send, like the alert throttle: a channel that is
      // down costs this alert rather than one every fifteen minutes.
      store.markQuietAlerted(q.workflow.name, now);
      log.warn(
        `${q.workflow.name}: nothing has arrived at /hooks/${q.path} since ` +
          `${new Date(q.quietSince).toISOString()} (quietAfterMs ${q.limitMs})`,
      );
      void alertQuiet(q.workflow, q.path, q.quietSince, q.heardAt, q.limitMs, q.rejected);
    }
  } catch (err) {
    log.warn(`Quiet-webhook check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
