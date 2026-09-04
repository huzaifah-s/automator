import { store } from "./db.ts";
import { createLogger } from "./logger.ts";
import { alertFailure } from "./alerts.ts";
import { buildIntegrations } from "../integrations/index.ts";
import { capture, MAX_CHECKPOINT_BYTES } from "./capture.ts";
import { createState } from "./state.ts";
import type { Ctx, LoadedWorkflow, RunStatus, TriggerKind } from "./types.ts";

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  result?: unknown;
  error?: Error;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 2_000;

/** Workflows with a run in flight right now (for onOverlap: "skip"). */
const active = new Set<string>();
/** Serialization point for onOverlap: "queue". */
const tail = new Map<string, Promise<unknown>>();

let shuttingDown = false;

export function beginShutdown(): void {
  shuttingDown = true;
}

export function activeCount(): number {
  return active.size;
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
}

export async function runWorkflow(
  wf: LoadedWorkflow,
  opts: RunOptions = { trigger: "manual" },
): Promise<RunOutcome> {
  if (shuttingDown) {
    return { runId: "", status: "skipped", error: new Error("Shutting down") };
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

async function execute(wf: LoadedWorkflow, opts: RunOptions): Promise<RunOutcome> {
  const runId = crypto.randomUUID();
  const checkpointKey = opts.checkpointKey ?? runId;
  const logger = createLogger(wf.name, runId);
  const maxAttempts = (wf.retries ?? DEFAULT_RETRIES) + 1;
  const timeoutMs = wf.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseDelay = wf.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  active.add(wf.name);
  store.startRun(runId, wf.name, opts.trigger, checkpointKey, opts.resumedFrom ?? null);
  const startedAt = Date.now();

  if (opts.resumedFrom) {
    const expired = store.expireCheckpoints(checkpointKey, wf.checkpointTtlHours ?? 24);
    if (expired > 0) logger.warn(`Dropped ${expired} checkpoint(s) past their TTL`);
    logger.info(`▶ resumed from ${opts.resumedFrom.slice(0, 8)}`);
  } else {
    logger.info(`▶ started (${opts.trigger})`);
  }

  let lastError: Error = new Error("Workflow did not run");
  let ctx!: Ctx<unknown>;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      ctx = buildCtx(wf, runId, checkpointKey, attempt, opts, logger, controller.signal);

      try {
        const result = await Promise.race([wf.run(ctx), rejectOnAbort(controller.signal)]);
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
    await alertFailure(wf.name, runId, lastError);

    return { runId, status: "failed", error: lastError };
  } finally {
    active.delete(wf.name);
  }
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
