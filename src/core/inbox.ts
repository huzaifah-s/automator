import { createHash } from "node:crypto";
import { capture, isTruncated, MAX_CHECKPOINT_BYTES } from "./capture.ts";
import { store } from "./db.ts";
import { isEnabled } from "./pause.ts";
import { createLogger, log } from "./logger.ts";
import { isShuttingDown, runWorkflow } from "./runner.ts";
import type { LoadedWorkflow } from "./types.ts";
import type { Registry } from "./loader.ts";

/**
 * How long a repeat of the same delivery counts as a caller retrying rather
 * than a second real event. Only has to cover a retry: five minutes is longer
 * than any redeploy and shorter than the gap between two genuine events that
 * happen to carry byte-identical payloads.
 */
const DEDUP_WINDOW_MS = readMs(process.env.INBOX_DEDUP_MS, 300_000);

/**
 * Past this, a delivery that never ran is dropped instead of run. A webhook
 * from a week ago is rarely still worth acting on, and running one is the more
 * expensive mistake — the same reason checkpoints have a TTL.
 */
const MAX_AGE_MS = readMs(process.env.INBOX_MAX_AGE_MS, 86_400_000);

function readMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    log.warn(`"${raw}" is not a non-negative number of milliseconds — using ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * What happened when a delivery was offered to the inbox.
 *
 * `unrecorded` is not a failure: the webhook still runs, it just cannot be
 * recovered afterwards. Saying so explicitly keeps the caller from having to
 * decide what a null id meant.
 */
export type Accepted =
  | { kind: "recorded"; id: string }
  | { kind: "duplicate"; id: string }
  | { kind: "unrecorded" };

/**
 * Identifies a delivery. The raw body is hashed rather than stored, so a
 * payload carrying a credential contributes to the digest without the digest
 * being able to give it back.
 */
function fingerprint(method: string, path: string, body: string): string {
  return createHash("sha256").update(`${method} ${path}\n${body}`).digest("hex");
}

/**
 * Writes a delivery down before its 202 is sent. `input` is the parsed and
 * validated payload — the same value the run will receive — and `body` is the
 * bytes that arrived, used only to recognise a retry of the same delivery.
 */
export function acceptDelivery(
  wf: LoadedWorkflow,
  method: string,
  path: string,
  body: string,
  input: unknown,
): Accepted {
  // `force`, so switching observational capture off does not switch recovery
  // off with it, and the checkpoint ceiling because this is fed back into a
  // workflow rather than displayed.
  const captured = capture(input, { force: true, limit: MAX_CHECKPOINT_BYTES });

  // A payload too big to store whole cannot be recovered, and a truncated one
  // fed back into a workflow is worse than an honest gap — the same refusal
  // replay already makes. The run still happens; only its recovery is lost.
  if (isTruncated(captured.json)) {
    log.warn(
      `Webhook for ${wf.name} is larger than ${MAX_CHECKPOINT_BYTES} bytes — ` +
        `running it, but it will not survive a restart`,
    );
    return { kind: "unrecorded" };
  }

  const { id, duplicate } = store.recordDelivery({
    workflow: wf.name,
    fingerprint: fingerprint(method, path, body),
    input: captured.json,
    dedupWindowMs: DEDUP_WINDOW_MS,
  });
  return duplicate ? { kind: "duplicate", id } : { kind: "recorded", id };
}

/**
 * Runs a recorded delivery and settles its entry. Never throws: it is called
 * from a queueMicrotask with nobody to catch it, and from boot recovery where
 * one bad entry must not stop the rest.
 */
export async function deliver(wf: LoadedWorkflow, id: string, input: unknown): Promise<void> {
  let outcome;
  try {
    outcome = await runWorkflow(wf, { input, trigger: "webhook" });
  } catch (err) {
    // runWorkflow records a failed run rather than throwing, so reaching here
    // means the runner itself broke. Retrying that on every boot for a day
    // would just repeat it, so the entry is closed and the reason logged.
    store.settleDelivery(id, "abandoned", null);
    log.error(
      `Inbox: ${wf.name} could not be run — ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // A run skipped *because the process is going down* has not happened, and
  // its entry has to survive to the other side of the restart. A run skipped
  // by `onOverlap` has happened as far as the workflow is concerned — leaving
  // that one pending would resurrect a webhook it deliberately dropped.
  if (outcome.status === "skipped" && isShuttingDown()) return;

  store.settleDelivery(id, "done", outcome.runId || null);
}

/**
 * Finishes deliveries that were accepted but never ran, which in practice
 * means the last deploy landed between the 202 and the run.
 *
 * Runs each as a fresh webhook run with the recorded input, rather than
 * resuming the interrupted one: resume carries a checkpoint key and no
 * `ctx.input`, so a workflow that reads its payload would get an empty object.
 * That makes recovery at-least-once — a run interrupted half way through
 * repeats the steps it had already done — which is the same guarantee polling
 * gives, and for the same reason.
 */
export async function recoverInbox(registry: Registry): Promise<void> {
  const pending = store.pendingDeliveries();
  if (pending.length === 0) return;

  log.info(`Inbox: ${pending.length} accepted webhook(s) did not finish before the restart`);

  for (const entry of pending) {
    const wf = registry.get(entry.workflow);

    // isEnabled(), not wf.enabled: a workflow paused from the dashboard is off
    // for this too, and a delivery it never got to run is dropped rather than
    // replayed the moment the process comes back.
    if (!wf || wf.trigger.kind !== "webhook" || !isEnabled(wf)) {
      store.settleDelivery(entry.id, "abandoned", null);
      log.warn(
        `Inbox: dropped a delivery for ${entry.workflow} — it no longer takes webhooks`,
      );
      continue;
    }

    const age = Date.now() - entry.received_at;
    if (age > MAX_AGE_MS) {
      store.settleDelivery(entry.id, "abandoned", null);
      log.warn(
        `Inbox: dropped a delivery for ${entry.workflow} — received ` +
          `${new Date(entry.received_at).toISOString()}, past the ${MAX_AGE_MS}ms limit`,
      );
      continue;
    }

    let input: unknown = {};
    try {
      input = entry.input === null ? {} : JSON.parse(entry.input);
    } catch {
      store.settleDelivery(entry.id, "abandoned", null);
      log.warn(`Inbox: dropped a delivery for ${entry.workflow} — its payload no longer parses`);
      continue;
    }

    createLogger(wf.name).info(
      `recovering a webhook received ${new Date(entry.received_at).toISOString()}`,
    );
    // Sequential on purpose. The concurrency cap would bound these anyway, but
    // a backlog that arrives all at once at boot is the worst moment to spend
    // every slot at once — the scheduler's own first runs are due too.
    await deliver(wf, entry.id, input);
  }
}
