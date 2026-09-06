import { createLogger, log } from "./logger.ts";
import { alertBoot } from "./alerts.ts";
import { createState, type StateClient } from "./state.ts";
import { isEnabled } from "./pause.ts";
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
/** Ceiling on the reachability probe. Short — it is one request to ourselves. */
const PROBE_TIMEOUT_MS = 10_000;
/**
 * How long to wait for PUBLIC_URL to start answering before registering
 * anyway. Generous, because it costs nothing: reconciliation is not awaited by
 * boot, so the server is already serving while this waits.
 */
const READY_TIMEOUT_MS = 120_000;
/** How often to re-probe while waiting. */
const READY_INTERVAL_MS = 2_000;

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

  /**
   * Waits for PUBLIC_URL to answer before the first subscription is created,
   * and gives up rather than blocking.
   *
   * This is a race, not a misconfiguration, and it was the whole of the
   * StudentQR failure: a reverse proxy does not route to a container until its
   * healthcheck passes, so for the first several seconds of a deploy the public
   * URL answers 503 while the process behind it is perfectly healthy. A
   * provider asked to create a subscription in that window calls the URL,
   * gets the 503, and refuses — Monday reports it as an internal error of its
   * own, which names nothing. Every registration failed on a deployment whose
   * URL was correct the entire time.
   *
   * Waiting is free: reconciliation is deliberately not awaited by boot, so the
   * server is already listening and answering while this polls. The deadline is
   * what keeps a host that genuinely cannot reach its own name — no NAT
   * hairpin, split-horizon DNS — from waiting forever: it warns and registers
   * anyway, because the probe is evidence and never a verdict. Ran at most once
   * per boot, and only when something is actually about to be created.
   */
  let ready: Promise<void> | undefined;
  const awaitReachable = (): Promise<void> =>
    (ready ??= (async () => {
      // Non-null: the guard above returns when a candidate needs PUBLIC_URL,
      // and this only runs from inside the candidate loop.
      const origin = publicUrl!;
      const startedAt = Date.now();
      let result = await probePublicUrl(origin);
      let waited = false;

      while (!result.ok && Date.now() - startedAt < READY_TIMEOUT_MS) {
        if (!waited) {
          log.info(
            `Waiting for ${origin} to answer before registering webhooks — ${result.why}. ` +
              `A proxy usually needs a few seconds after a deploy before it routes here.`,
          );
          waited = true;
        }
        await sleep(READY_INTERVAL_MS);
        result = await probePublicUrl(origin);
      }

      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (result.ok) {
        if (waited) log.info(`${origin} is answering after ${seconds}s — registering now`);
        else log.debug(`PUBLIC_URL reaches this server (${origin}/healthz)`);
        return;
      }

      log.warn(
        `PUBLIC_URL still did not answer after ${seconds}s — GET ${origin}/healthz ` +
          `${result.why}. Registering anyway. A provider verifies a new subscription by ` +
          `calling it and reports the failure as an error of its own, so check this first ` +
          `if the registrations below fail. Not conclusive: this request left and ` +
          `re-entered the network, and a host that cannot reach its own public name can ` +
          `still be perfectly reachable from outside.`,
      );
    })());

  for (const wf of candidates) {
    const trigger = wf.trigger;
    if (trigger.kind !== "webhook" || !trigger.register) continue;
    const url = `${publicUrl}/hooks/${trigger.path}`;
    const state = createState(wf.name);
    const logger = createLogger(wf.name);

    try {
      const current = await state.get<Subscription>(SUBSCRIPTION_KEY);
      // isEnabled(), not wf.enabled: a workflow paused from the dashboard has
      // its provider-side subscription taken down at the next boot too, so a
      // long pause does not leave a provider posting into a 404 forever.
      const wanted = isEnabled(wf);

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
            : `webhook subscription ${current.id} removed — workflow is switched off`,
        );
      }

      if (!wanted) continue;

      // Before the provider is asked to accept the URL: it will call that URL
      // as part of accepting it, so asking while the proxy is still returning
      // 503 is the failure this waits out.
      await awaitReachable();

      const id = await withCtx(wf, url, state, (ctx) => trigger.register!.create(ctx));
      if (typeof id !== "string" || id === "") {
        throw new Error("register.create must return the provider's subscription id");
      }
      await state.set<Subscription>(SUBSCRIPTION_KEY, { id, url, registeredAt: Date.now() });
      registered.add(wf.name);
      logger.info(`webhook subscription ${id} registered at ${url}`);
    } catch (err) {
      // Left exactly as it was, so the next boot tries the same thing again.
      const message = err instanceof Error ? err.message : String(err);
      // Naming the URL matters most on the path where it did *not* work: the
      // success line below prints it, so a failure was the one case where the
      // address nobody can see is also the likeliest thing to be wrong. A
      // provider that answers "internal error" while it is really failing to
      // reach you is unreadable without it. Safe to print — this is the bare
      // URL, and a provider that needs the shared secret appends it inside its
      // own create(), which is why that one is never logged.
      logger.error(`webhook registration failed for ${url}: ${message}`);
      // A subscription that never got created means the provider is calling
      // nobody. Nothing fails, no run is recorded, and the workflow simply
      // never fires — the exact shape of problem this is here to catch.
      await alertBoot("webhook subscription could not be registered", message, wf);
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


/**
 * Asks whether PUBLIC_URL actually reaches this process, by fetching our own
 * `/healthz` over it.
 *
 * This exists because a provider that cannot reach the URL it was handed does
 * not usually say so. Monday answers `Internal Server Error
 * [DOWNSTREAM_SERVICE_ERROR]` — a description of its own plumbing, not of the
 * endpoint — and every registration fails identically whatever is wrong with
 * them, so the provider's error cannot distinguish a bad event name from a
 * domain that does not resolve. Something on this side has to have an opinion.
 *
 * `/healthz` rather than the hook path: it is unauthenticated, it is purpose
 * built for exactly this question, and its shape is a contract rather than an
 * error string that could be reworded. A proxy routes by host, so reaching it
 * means reaching `/hooks/*` too.
 *
 * **What a success proves:** the domain resolves, TLS verifies, and whatever
 * sits in front routes to this process — which is the set of things actually
 * wrong when a registration fails this way. Checking `ok: true` in the body
 * rather than only the status is what catches the case that looks healthiest
 * and is worst: a stale deployment still holding the domain.
 *
 * **What a failure does not prove.** It is evidence, not a verdict. A
 * container frequently cannot reach its own public hostname — no NAT hairpin,
 * split-horizon DNS — so the provider may well get through where we did not.
 * That is precisely why this warns and registration goes ahead anyway: a
 * diagnostic that blocked the deploy would be worse than the fault it
 * diagnoses. Nothing here throws, for the same reason as the rest of the file.
 */
async function probePublicUrl(origin: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const url = `${origin}/healthz`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { ok: false, why: `answered HTTP ${res.status}` };

    const body: unknown = await res.json().catch(() => null);
    if (typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) {
      return {
        ok: false,
        why: "answered 200, but not with this server's /healthz — something else holds that domain",
      };
    }
    return { ok: true };
  } catch (err) {
    // A DNS failure, a TLS failure and a timeout all arrive here, and the name
    // is the useful half: "TimeoutError" says something "fetch failed" doesn't.
    return { ok: false, why: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
