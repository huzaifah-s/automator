import { store } from "./db.ts";
import { credentialReady } from "./credentials.ts";
import { createLogger, log } from "./logger.ts";
import { alertBlocked, alertFailure } from "./alerts.ts";
import { buildIntegrations } from "../integrations/index.ts";
import { capture, MAX_CHECKPOINT_BYTES } from "./capture.ts";
import { createState } from "./state.ts";
import { isEnabled, isPaused, pausedInfo } from "./pause.ts";
import type { Ctx, LoadedWorkflow, RunStatus, TriggerKind } from "./types.ts";
import type { Registry } from "./loader.ts";

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  result?: unknown;
  error?: Error;
}

/** How deep a chain of ctx.run() calls may go before it is treated as runaway. */
const MAX_WORKFLOW_DEPTH = 8;

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 2_000;

/** Workflows with a run in flight right now (for onOverlap: "skip"). */
const active = new Set<string>();
/** Serialization point for onOverlap: "queue". */
const tail = new Map<string, Promise<unknown>>();

let shuttingDown = false;

/**
 * Set once at boot. `ctx.run()` resolves workflow names through this, and the
 * registry is only built after this module has been imported.
 */
let registry: Registry | undefined;

export function setRegistry(r: Registry): void {
  registry = r;
}

export function beginShutdown(): void {
  shuttingDown = true;
}

/**
 * Whether the process is on its way out. The inbox needs this to tell the two
 * kinds of skipped run apart: one the shutdown caused, which has to survive to
 * the other side of the restart, and one `onOverlap` decided, which must not.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function activeCount(): number {
  return active.size;
}

/* --------------------------------------------------- global concurrency */

/**
 * `onOverlap` bounds one workflow against itself. Nothing bounded the process:
 * 50 webhooks arriving together meant 50 runs at once in a single Bun process,
 * every one of them holding sockets, memory, and a share of the event loop.
 * This is the ceiling across all workflows. 0 disables it.
 */
const MAX_CONCURRENT_RUNS = readLimit(process.env.MAX_CONCURRENT_RUNS);

/** Runs executing right now — past the semaphore, not yet finished. */
let running = 0;
/** Runs that have been accepted and are waiting for a slot, oldest first. */
const waiting: Array<() => void> = [];

export function runningCount(): number {
  return running;
}

export function queuedCount(): number {
  return waiting.length;
}

/**
 * Waits for a slot. Callers queue rather than being rejected — a webhook that
 * arrives during a burst should be slow, not lost.
 */
function acquireSlot(): Promise<void> {
  if (MAX_CONCURRENT_RUNS === 0 || running < MAX_CONCURRENT_RUNS) {
    running++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  // The slot is handed straight to the next waiter instead of being released
  // and re-contended for: strict FIFO, and no wake-everyone stampede.
  const next = waiting.shift();
  if (next) next();
  else running--;
}

function readLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 10;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    log.warn(`MAX_CONCURRENT_RUNS="${raw}" is not a non-negative integer — using 10`);
    return 10;
  }
  return n;
}

export interface RunOptions {
  input?: unknown;
  trigger: TriggerKind;
  /**
   * Reuse another run's completed steps. Set by the dashboard's Resume action;
   * defaults to the new run's own id, which is what makes retries resumable.
   */
  checkpointKey?: string;
  resumedFrom?: string;
  /**
   * Lineage for the Replay action: the run whose input this one is re-using.
   * A replay gets a *fresh* checkpoint key — it redoes the work rather than
   * skipping past it — which is the whole difference from a resume.
   */
  replayedFrom?: string;
  /** Set when another run started this one through ctx.run(). */
  parent?: {
    runId: string;
    /** Workflow names from the root of the chain down to the caller. */
    ancestry: string[];
    /** The caller's signal, so a parent timeout takes its children with it. */
    signal: AbortSignal;
  };
}

export async function runWorkflow(
  wf: LoadedWorkflow,
  opts: RunOptions = { trigger: "manual" },
): Promise<RunOutcome> {
  if (shuttingDown) {
    return { runId: "", status: "skipped", error: new Error("Shutting down") };
  }

  /*
   * A paused or disabled workflow does not fire on its own.
   *
   * The scheduler already took its timer down and the webhook routes already
   * stopped matching it, so nothing should reach here — this is the backstop
   * for the gap between the two, which is real: a cron tick that fired the
   * instant before somebody clicked pause is already on its way, and a poll
   * mid-fetch will call this when it finishes. One skipped run beats one run
   * that was switched off.
   *
   * `manual` is deliberately let through. That is what "off" has always meant
   * for `enabled: false` — the dashboard's Run now button works on those today
   * — and it is the useful meaning: pausing stops a workflow firing by itself,
   * it does not take away the ability to test it before switching it back on.
   * A person clicking Run now is not the workflow running; it is them running
   * it, and the run record says `manual` so nobody has to guess later.
   */
  if (opts.trigger !== "manual" && !isEnabled(wf)) {
    const runId = crypto.randomUUID();
    const paused = pausedInfo(wf.name);
    const why = paused
      ? `Paused from the dashboard${paused.note ? ` — ${paused.note}` : ""}`
      : "Disabled in its workflow file (enabled: false)";
    const message = `Not started: ${why}`;
    store.startRun(runId, wf.name, opts.trigger, {
      parentRun: opts.parent?.runId ?? null,
      input: capture(opts.input).json,
    });
    store.finishRun(runId, "skipped", 0, message, null);
    createLogger(wf.name, runId).warn(message);
    return { runId, status: "skipped" };
  }

  /*
   * A workflow whose credentials are not connected does not start. This is the
   * other half of the loader's decision to warn rather than abort the boot: the
   * server comes up so you can connect the thing, and until you have, the
   * workflow fails loudly at the door instead of part-way through with whatever
   * error the platform returns for an empty token.
   *
   * Recorded as a run rather than dropped, because a cron trigger that quietly
   * does nothing is indistinguishable from a scheduler that stopped.
   */
  const unconnected = (wf.credentials ?? []).filter((ref) => {
    const [provider, id] = ref.split(":");
    return !credentialReady(provider!, id!);
  });
  if (unconnected.length > 0) {
    const runId = crypto.randomUUID();
    const message =
      `Not connected: ${unconnected.join(", ")} — ` +
      `open the Credentials tab and fill ${unconnected.length === 1 ? "it" : "them"} in`;
    store.startRun(runId, wf.name, opts.trigger);
    store.finishRun(runId, "failed", 0, message, null);
    createLogger(wf.name, runId).error(message);
    // The dashboard already says this, and nobody is looking at the dashboard.
    // A cron workflow blocked on an unconnected credential is otherwise silent
    // until somebody notices the thing it was supposed to do never happened.
    await alertBlocked(wf, runId, message);
    return { runId, status: "failed", error: new Error(message) };
  }

  if (active.has(wf.name)) {
    if ((wf.onOverlap ?? "skip") === "skip") {
      const runId = crypto.randomUUID();
      store.startRun(runId, wf.name, opts.trigger);
      store.finishRun(runId, "skipped", 0, "Previous run still in progress", null);
      createLogger(wf.name, runId).warn("Skipped — previous run still in progress");
      return { runId, status: "skipped" };
    }
    // "queue": chain behind whatever is already pending for this workflow.
    const prev = tail.get(wf.name) ?? Promise.resolve();
    const next = prev.then(() => execute(wf, opts));
    tail.set(
      wf.name,
      next.catch(() => {}),
    );
    return next;
  }

  const p = execute(wf, opts);
  tail.set(
    wf.name,
    p.catch(() => {}),
  );
  return p;
}

/**
 * One run, from queueing to outcome. The workflow is marked active *before*
 * waiting for a slot, so onOverlap: "skip" still sees a queued run as in
 * flight — otherwise a burst of webhooks would slip past it while the first
 * one sat in the queue.
 */
async function execute(wf: LoadedWorkflow, opts: RunOptions): Promise<RunOutcome> {
  active.add(wf.name);
  try {
    // A nested run inherits its caller's slot instead of taking a second one.
    // The caller is blocked awaiting it, so the process is not doing more work
    // at once — and a chain that took a slot per level would deadlock the pool
    // the moment every slot was held by a parent waiting on a child.
    if (opts.parent) return await executeNow(wf, opts);

    if (MAX_CONCURRENT_RUNS > 0 && running >= MAX_CONCURRENT_RUNS) {
      createLogger(wf.name).info(
        `waiting for a run slot — ${running} running, ${waiting.length} queued`,
      );
    }
    await acquireSlot();
    try {
      // Shutdown can begin while a run sits in the queue. Starting it now
      // would race the shutdown deadline, so it is recorded as skipped —
      // dropped work that leaves a trace beats dropped work that doesn't.
      if (shuttingDown) {
        const runId = crypto.randomUUID();
        store.startRun(runId, wf.name, opts.trigger);
        store.finishRun(runId, "skipped", 0, "Shutting down before its turn in the queue", null);
        createLogger(wf.name, runId).warn("Skipped — shutting down while queued");
        return { runId, status: "skipped" };
      }
      return await executeNow(wf, opts);
    } finally {
      releaseSlot();
    }
  } finally {
    active.delete(wf.name);
  }
}

async function executeNow(wf: LoadedWorkflow, opts: RunOptions): Promise<RunOutcome> {
  const runId = crypto.randomUUID();
  const checkpointKey = opts.checkpointKey ?? runId;
  const logger = createLogger(wf.name, runId);
  const maxAttempts = (wf.retries ?? DEFAULT_RETRIES) + 1;
  const timeoutMs = wf.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseDelay = wf.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  store.startRun(runId, wf.name, opts.trigger, {
    checkpointKey,
    resumedFrom: opts.resumedFrom,
    replayedFrom: opts.replayedFrom,
    parentRun: opts.parent?.runId,
    // Stored so the run can be replayed later. Observational capture rules
    // apply: with CAPTURE_DATA=false nothing is kept, and those runs simply
    // aren't replayable — recording input anyway would ignore the setting.
    input: capture(opts.input).json,
  });
  const startedAt = Date.now();

  if (opts.resumedFrom) {
    const expired = store.expireCheckpoints(checkpointKey, wf.checkpointTtlHours ?? 24);
    if (expired > 0) logger.warn(`Dropped ${expired} checkpoint(s) past their TTL`);
    logger.info(`▶ resumed from ${opts.resumedFrom.slice(0, 8)}`);
  } else if (opts.replayedFrom) {
    logger.info(`▶ replaying ${opts.replayedFrom.slice(0, 8)} with its original input`);
  } else if (opts.parent) {
    logger.info(`▶ started by ${opts.parent.ancestry.at(-1)} (${opts.parent.runId.slice(0, 8)})`);
  } else {
    logger.info(`▶ started (${opts.trigger})`);
  }

  let lastError: Error = new Error("Workflow did not run");
  let ctx!: Ctx<unknown>;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    // A child aborts when its parent does, so a parent timeout doesn't leave
    // orphans running past it.
    const signal = opts.parent
      ? AbortSignal.any([controller.signal, opts.parent.signal])
      : controller.signal;
    ctx = buildCtx(wf, runId, checkpointKey, attempt, opts, logger, signal);

    try {
      const result = await Promise.race([wf.run(ctx), rejectOnAbort(signal)]);
      clearTimeout(timer);
      store.finishRun(runId, "success", attempt, null, result);
      logger.info(`✓ succeeded in ${Date.now() - startedAt}ms`);
      return { runId, status: "success", result };
    } catch (err) {
      clearTimeout(timer);
      lastError = toError(err);

      if (attempt < maxAttempts) {
        // Exponential backoff with jitter so retries don't synchronise.
        const delay = Math.round(baseDelay * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
        logger.warn(
          `attempt ${attempt}/${maxAttempts} failed: ${lastError.message} — retrying in ${delay}ms`,
        );
        await sleep(delay);
      } else {
        logger.error(`✗ failed after ${attempt} attempt(s): ${lastError.message}`, {
          stack: lastError.stack,
        });
      }
    }
  }

  store.finishRun(runId, "failed", maxAttempts, lastError.message, null);

  if (wf.onFailure) {
    try {
      await wf.onFailure(ctx, lastError);
    } catch (err) {
      logger.error("onFailure handler threw", { error: String(err) });
    }
  }
  await alertFailure(wf, runId, lastError);

  return { runId, status: "failed", error: lastError };
}

function buildCtx(
  wf: LoadedWorkflow,
  runId: string,
  checkpointKey: string,
  attempt: number,
  opts: RunOptions,
  logger: ReturnType<typeof createLogger>,
  signal: AbortSignal,
): Ctx<unknown> {
  const base = {
    runId,
    workflow: wf.name,
    input: opts.input ?? {},
    attempt,
    triggeredBy: opts.trigger,
    log: logger,
    signal,
    state: createState(wf.name),
    run<R = unknown>(name: string, input?: unknown): Promise<R> {
      return runChild(wf.name, runId, opts.parent?.ancestry ?? [], signal, logger, name, input) as
        Promise<R>;
    },
    async step<R>(
      name: string,
      fn: () => Promise<R>,
      stepOpts: { input?: unknown; checkpoint?: boolean } = {},
    ): Promise<R> {
      const memoise = stepOpts.checkpoint ?? wf.checkpoint ?? true;

      if (memoise) {
        const hit = store.findStep(checkpointKey, name);
        if (hit) {
          logger.info(`↳ ${name} ⤿ reused from checkpoint`);
          return (hit.output === null ? undefined : JSON.parse(hit.output)) as R;
        }
      }

      const startedAt = Date.now();
      const input = capture(stepOpts.input);
      logger.debug(`↳ ${name}`);

      try {
        const out = await fn();
        const durationMs = Date.now() - startedAt;
        // force: the output is the checkpoint, so it is stored even when
        // observational capture is switched off.
        const output = capture(out, { limit: MAX_CHECKPOINT_BYTES, force: true });

        store.saveStep({
          checkpointKey,
          runId,
          name,
          status: "ok",
          startedAt,
          durationMs,
          input: input.json,
          output: output.json,
          error: null,
          truncated: output.truncated,
        });

        if (memoise && output.truncated) {
          logger.warn(`↳ ${name} result too large to checkpoint — it will re-run on resume`);
        }
        logger.info(`↳ ${name} ok (${durationMs}ms)`);
        return out;
      } catch (err) {
        const error = toError(err);
        store.saveStep({
          checkpointKey,
          runId,
          name,
          status: "failed",
          startedAt,
          durationMs: Date.now() - startedAt,
          input: input.json,
          output: null,
          error: error.message,
          truncated: false,
        });
        logger.error(`↳ ${name} failed (${Date.now() - startedAt}ms): ${error.message}`);
        throw err;
      }
    },
  };

  // Copied as property *descriptors*, not spread: a spread would invoke every
  // lazy getter here and eagerly build clients the workflow may never touch.
  return Object.defineProperties(
    base,
    Object.getOwnPropertyDescriptors(buildIntegrations(signal, runId)),
  ) as Ctx<unknown>;
}

/**
 * Records an attempt that never reached `runWorkflow` — an unknown name, a
 * cycle, the depth limit — as a run of the child, so it is visible where a
 * person looks for it.
 *
 * Without this the refusal left nothing behind at all: no row was written,
 * and a caller that catches the error — every StudentQR notification does,
 * deliberately, so a bookkeeping row cannot fail a delivered message — reduced
 * the whole attempt to one warn line buried on its own run page. The child's
 * page said it had never been called, which is a different claim and a false
 * one. One row is a cheap price for making "did it run?" answerable.
 *
 * No alert fires from here on purpose. A refusal that matters reaches the alert
 * channel through whichever run ends up failing because of it, and a caller
 * that swallows it has already decided it is not worth waking anyone —
 * alerting anyway would put a Telegram message behind every catch block.
 *
 * `attempts` is 0 for the same reason as the unconnected-credential path above:
 * the workflow body never executed.
 */
function recordRefusal(
  name: string,
  callerRunId: string,
  input: unknown,
  status: Extract<RunStatus, "failed" | "skipped">,
  message: string,
): string {
  const runId = crypto.randomUUID();
  store.startRun(runId, name, "workflow", {
    parentRun: callerRunId,
    input: capture(input).json,
  });
  store.finishRun(runId, status, 0, message, null);
  return runId;
}

/**
 * ctx.run(): start another workflow and hand back its result.
 *
 * Everything that can go wrong is decided before anything starts, and every
 * one of them throws. A sub-workflow call is the caller asking for a value —
 * returning undefined because the child was skipped, or silently going around
 * a loop eight times, are both worse than failing the parent.
 *
 * Every one of them also leaves a run behind. See recordRefusal.
 */
async function runChild(
  callerName: string,
  callerRunId: string,
  callerAncestry: string[],
  callerSignal: AbortSignal,
  logger: ReturnType<typeof createLogger>,
  name: string,
  input: unknown,
): Promise<unknown> {
  /** Records the refusal against the child, points the caller's log at it. */
  const refuse = (message: string, status: "failed" | "skipped" = "failed"): Error => {
    const runId = recordRefusal(name, callerRunId, input, status, message);
    // Mirrors the `← name ok (id)` line below, and names the run to open.
    logger.warn(`← ${name} ${status} (${runId.slice(0, 8)}) — ${message}`);
    return new Error(message);
  };

  if (!registry) {
    throw refuse("ctx.run() has no workflow registry — setRegistry was never called");
  }

  const chain = [...callerAncestry, callerName];
  // Checked before resolving the name so the error names the cycle, not the
  // symptom. Covers a workflow calling itself, which would otherwise deadlock
  // outright under onOverlap: "queue" — the child would wait for its own parent.
  if (chain.includes(name)) {
    throw refuse(`ctx.run("${name}") would loop: ${[...chain, name].join(" → ")}`);
  }
  if (chain.length >= MAX_WORKFLOW_DEPTH) {
    throw refuse(
      `ctx.run("${name}") is ${chain.length + 1} workflows deep, past the limit of ` +
        `${MAX_WORKFLOW_DEPTH}: ${chain.join(" → ")}`,
    );
  }

  const child = registry.get(name);
  // The run is recorded under the name that was asked for, even though no
  // workflow answers to it. A row for a name with no page beats no row: the
  // typo is the thing you need to see, and it is on the caller's run too.
  if (!child) throw refuse(`ctx.run("${name}"): no workflow by that name`);
  if (!isEnabled(child)) {
    throw refuse(
      isPaused(name)
        ? `ctx.run("${name}"): that workflow is paused from the dashboard`
        : `ctx.run("${name}"): that workflow is disabled`,
    );
  }

  logger.info(`→ ${name}`);
  const outcome = await runWorkflow(child, {
    trigger: "workflow",
    input,
    parent: { runId: callerRunId, ancestry: chain, signal: callerSignal },
  });

  if (outcome.status === "success") {
    logger.info(`← ${name} ok (${outcome.runId.slice(0, 8)})`);
    return outcome.result;
  }
  if (outcome.status === "skipped") {
    // Two kinds of skip reach here, and only one of them already has a row.
    // onOverlap: "skip" records its own; the shutdown guard at the top of
    // runWorkflow returns an empty runId without writing anything, and that
    // one still has to leave a trace — it is dropped work.
    if (!outcome.runId) {
      throw refuse(`ctx.run("${name}") was skipped — the server is shutting down`, "skipped");
    }
    logger.warn(`← ${name} skipped (${outcome.runId.slice(0, 8)})`);
    throw new Error(
      `ctx.run("${name}") was skipped — a run of it was already in flight, and its ` +
        `onOverlap is "skip". Give it onOverlap: "queue" if it should wait its turn.`,
    );
  }
  logger.warn(`← ${name} failed (${outcome.runId.slice(0, 8)})`);
  throw outcome.error ?? new Error(`ctx.run("${name}") failed`);
}

/**
 * Lets a timeout or shutdown surface as a rejection even when the workflow
 * ignores ctx.signal. Note the honest limitation: the abandoned work keeps
 * running in the background until it finishes on its own — pass ctx.signal
 * into fetch and other cancellable calls if that matters to you.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(toError(signal.reason));
    signal.addEventListener("abort", () => reject(toError(signal.reason)), { once: true });
  });
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
