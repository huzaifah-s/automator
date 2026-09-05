import { store } from "./db.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createState, type StateClient } from "./state.ts";
import { runWorkflow } from "./runner.ts";
import { alertFailure } from "./alerts.ts";
import { buildIntegrations } from "../integrations/index.ts";
import type { LoadedWorkflow, PollCtx } from "./types.ts";

/**
 * Where the seen-set lives, inside the workflow's own state namespace. The
 * "@poll:" prefix is reserved for the runner — workflow code should not write
 * to it, though it will show up in ctx.state.keys().
 */
const SEEN_KEY = "@poll:seen";
const DEFAULT_REMEMBER = 500;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/**
 * One tick of a poll trigger: fetch everything, work out what's new, and start
 * a run only if something is. Nothing new means no run record at all — a poll
 * on a five-minute cron would otherwise bury the dashboard in 288 empty runs a
 * day.
 *
 * Every tick is still *stamped*, though, run or no run (`store.recordPoll`).
 * Without that, a poll whose scheduler had died looked exactly like a poll
 * with nothing to do: a workflow page showing its last run an hour ago and no
 * way to tell which. The stamp is what the dashboard reads to say "polled 2m
 * ago, nothing due" instead of leaving you to guess.
 */
export async function pollOnce(wf: LoadedWorkflow): Promise<void> {
  const t = wf.trigger;
  if (t.kind !== "poll") return;

  const logger = createLogger(wf.name);
  const state = createState(wf.name);
  const startedAt = Date.now();
  const timeoutMs = t.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`poll fetch timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  /**
   * Records what this tick saw. Every exit below goes through it — above all
   * the ones that start no run, which are the whole reason it exists.
   *
   * Stamped with `startedAt` and written *before* the run rather than after
   * it, because a fifteen-minute run would otherwise leave the page insisting
   * nothing had polled for fifteen minutes — the opposite of what this is for.
   * Something throwing after that point re-stamps with the error, which is the
   * truer of the two records.
   */
  const stamp = (seen: { items?: number; fresh?: number; error?: string }): void => {
    try {
      store.recordPoll({ workflow: wf.name, at: startedAt, ...seen });
    } catch (err) {
      // Observational. Losing the stamp must not cost the tick its real work.
      logger.warn(
        `could not record the poll tick: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  try {
    const items = await t.fetch(buildPollCtx(wf.name, logger, state, controller.signal));
    if (!Array.isArray(items)) {
      throw new Error(`fetch must return an array, got ${describe(items)}`);
    }

    const identify = (item: unknown) => (t.id ? String(t.id(item)) : hash(item));
    const remember = t.remember ?? DEFAULT_REMEMBER;
    // A single page bigger than the window would push its own items out of the
    // set and re-deliver them forever, so the window never goes below one page.
    const cap = Math.max(remember, items.length);
    if (items.length > remember) {
      logger.warn(
        `fetch returned ${items.length} item(s), more than remember=${remember} — ` +
          `keeping all of them this round; raise \`remember\` to make that explicit`,
      );
    }

    const seen = await state.get<string[]>(SEEN_KEY);

    // The first ever poll adopts whatever exists as the baseline. Without this,
    // enabling a workflow fires once for every item that was already there.
    if (seen === undefined && (t.firstRun ?? "skip") === "skip") {
      await state.set(SEEN_KEY, trim(items.map(identify), cap));
      logger.info(`first poll — baselined ${items.length} existing item(s), no run`);
      stamp({ items: items.length, fresh: 0 });
      return;
    }

    const known = new Set(seen ?? []);
    const fresh: unknown[] = [];
    const freshIds: string[] = [];
    for (const item of items) {
      const id = identify(item);
      // known covers earlier polls; adding as we go covers duplicates within
      // this one page.
      if (known.has(id)) continue;
      known.add(id);
      fresh.push(item);
      freshIds.push(id);
    }

    if (fresh.length === 0) {
      logger.debug(`polled ${items.length} item(s), nothing new`);
      stamp({ items: items.length, fresh: 0 });
      return;
    }

    logger.info(`${fresh.length} new item(s) of ${items.length} — starting a run`);
    stamp({ items: items.length, fresh: fresh.length });
    const outcome = await runWorkflow(wf, { trigger: "poll", input: fresh });

    // Marked seen only after the run succeeds. A failed or skipped run gets the
    // same items again on the next tick rather than losing them — at-least-once
    // delivery, which is the right default when the alternative is silent loss.
    if (outcome.status === "success") {
      await state.set(SEEN_KEY, trim([...(seen ?? []), ...freshIds], cap));
    } else {
      logger.warn(
        `run ${outcome.status} — ${fresh.length} item(s) stay unseen and will be retried next poll`,
      );
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // A throwing fetch never reaches the runner, so nothing else would record
    // it. Give it a failed run of its own so it shows up on the dashboard and
    // alerts like any other failure.
    stamp({ error: error.message });
    const runId = crypto.randomUUID();
    store.startRun(runId, wf.name, "poll");
    createLogger(wf.name, runId).error(`poll fetch failed: ${error.message}`, {
      stack: error.stack,
    });
    store.finishRun(runId, "failed", 1, `poll fetch failed: ${error.message}`, null);
    await alertFailure(wf, runId, error);
  } finally {
    clearTimeout(timer);
  }
}

function buildPollCtx(
  workflow: string,
  logger: Logger,
  state: StateClient,
  signal: AbortSignal,
): PollCtx {
  const base = { workflow, log: logger, signal, state };
  // Property descriptors, not a spread — the same rule as buildCtx. A spread
  // would invoke every lazy getter and build clients the fetch never touches.
  // No runId, so poll fetches aren't recorded as a run's HTTP calls; there is
  // no run to attach them to.
  return Object.defineProperties(
    base,
    Object.getOwnPropertyDescriptors(buildIntegrations(signal)),
  ) as PollCtx;
}

/** Keeps the most recently added ids, which is the tail. */
function trim(ids: string[], cap: number): string[] {
  return ids.length > cap ? ids.slice(ids.length - cap) : ids;
}

/**
 * Default identity when no id() is given. Hashed rather than stored whole so a
 * window of 500 fat items stays a few KB instead of megabytes.
 */
function hash(item: unknown): string {
  try {
    return Bun.hash(JSON.stringify(item) ?? "undefined").toString(36);
  } catch {
    return String(item);
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}
