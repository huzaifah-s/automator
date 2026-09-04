import { createLogger, log } from "./logger.ts";
import { createState, type StateClient } from "./state.ts";
import { buildIntegrations } from "../integrations/index.ts";
import type { LoadedWorkflow, RegisterCtx } from "./types.ts";
import type { Registry } from "./loader.ts";

/**
 * Where a workflow's subscription id lives, inside its own state namespace.
 * The "@webhook:" prefix is reserved for the runner, like "@poll:".
 */
const SUBSCRIPTION_KEY = "@webhook:subscription";
/**
 * Names of every workflow that currently holds a subscription, in the shared
 * namespace. Without it, a workflow whose file was deleted takes its
 * registration with it into invisibility — the id is still in state, and the
 * provider is still sending events to a route that no longer exists.
 */
const DIRECTORY_KEY = "@webhook:registered";

/** Ceiling on one provider call, so a hanging API can't stall boot behind it. */
const CALL_TIMEOUT_MS = 30_000;

interface Subscription {
  id: string;
  url: string;
  registeredAt: number;
}

/**
 * Brings provider-side webhook subscriptions in line with the workflows on
 * disk. Runs once, after the server is listening — a provider that pings its
 * new subscription immediately should find the route already answering.
 *
 * Reconciles rather than registers: a redeploy must not create a second
 * subscription, so an existing id at the same URL is left completely alone.
 * Nothing here can fail the boot; a provider that is down is logged and picked
 * up on the next start.
 */
export async function reconcileWebhooks(registry: Registry): Promise<void> {
  const candidates = registry
    .all()
    .filter((w) => w.trigger.kind === "webhook" && w.trigger.register);

  const directory = createState("@shared");
  const known = (await directory.get<string[]>(DIRECTORY_KEY)) ?? [];
  if (candidates.length === 0 && known.length === 0) return;

  const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  if (!publicUrl && candidates.length > 0) {
    log.warn(
      `${candidates.length} workflow(s) register their own webhook, but PUBLIC_URL ` +
        `is not set — no subscriptions were created or changed`,
    );
    return;
  }

  const registered = new Set(known);

  for (const wf of candidates) {
    const trigger = wf.trigger;
    if (trigger.kind !== "webhook" || !trigger.register) continue;
    const url = `${publicUrl}/hooks/${trigger.path}`;
    const state = createState(wf.name);
    const logger = createLogger(wf.name);

    try {
      const current = await state.get<Subscription>(SUBSCRIPTION_KEY);
      const wanted = wf.enabled !== false;

      if (current && current.url === url && wanted) {
        logger.debug(`webhook subscription ${current.id} already registered`);
        registered.add(wf.name);
        continue;
      }

      // Anything else starts by taking down what is there: a stale URL has to
      // be removed before its replacement is created, or the provider ends up
      // sending every event twice.
      if (current) {
        await withCtx(wf, url, state, (ctx) => trigger.register!.remove(ctx, current.id));
        await state.delete(SUBSCRIPTION_KEY);
        registered.delete(wf.name);
        logger.info(
          wanted
            ? `webhook subscription ${current.id} removed — its URL changed`
            : `webhook subscription ${current.id} removed — workflow is disabled`,
        );
      }

      if (!wanted) continue;

      const id = await withCtx(wf, url, state, (ctx) => trigger.register!.create(ctx));
      if (typeof id !== "string" || id === "") {
        throw new Error("register.create must return the provider's subscription id");
      }
      await state.set<Subscription>(SUBSCRIPTION_KEY, { id, url, registeredAt: Date.now() });
      registered.add(wf.name);
      logger.info(`webhook subscription ${id} registered at ${url}`);
    } catch (err) {
      // Left exactly as it was, so the next boot tries the same thing again.
      logger.error(
        `webhook registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // A workflow that still exists can be unregistered through its own remove().
  // One whose file is gone cannot — the code that knows how to call the
  // provider went with it — so all we can do is say so, every boot, until
  // somebody deletes it provider-side.
  for (const name of known) {
    if (candidates.some((w) => w.name === name)) continue;
    const orphan = await createState(name).get<Subscription>(SUBSCRIPTION_KEY);
    log.warn(
      `${name} still has a webhook subscription${orphan ? ` (${orphan.id} at ${orphan.url})` : ""} ` +
        `but no longer registers one. Delete it at the provider, or restore the ` +
        `workflow with enabled: false for one boot to have it removed cleanly.`,
    );
    registered.add(name);
  }

  await directory.set(DIRECTORY_KEY, [...registered].sort());
}

/**
 * Builds the RegisterCtx and bounds the call. Property descriptors, not a
 * spread — the same rule as buildCtx: a spread invokes every lazy getter and
 * builds clients the hook never touches. No runId, so these calls are not
 * captured; there is no run to attach them to.
 */
async function withCtx<T>(
  wf: LoadedWorkflow,
  url: string,
  state: StateClient,
  fn: (ctx: RegisterCtx) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`provider call timed out after ${CALL_TIMEOUT_MS}ms`)),
    CALL_TIMEOUT_MS,
  );
  try {
    const base = {
      workflow: wf.name,
      url,
      log: createLogger(wf.name),
      signal: controller.signal,
      state,
    };
    const ctx = Object.defineProperties(
      base,
      Object.getOwnPropertyDescriptors(buildIntegrations(controller.signal)),
    ) as RegisterCtx;
    return await fn(ctx);
  } finally {
    clearTimeout(timer);
  }
}
