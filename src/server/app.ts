import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { logger as httpLogger } from "hono/logger";
import { store } from "../core/db.ts";
import { isTruncated } from "../core/capture.ts";
import { log } from "../core/logger.ts";
import { queuedCount, runningCount, runWorkflow } from "../core/runner.ts";
import { timingSafeEqual } from "../core/verify.ts";
import { nextRunFor } from "../core/scheduler.ts";
import {
  deleteSecret,
  secretStoreReady,
  secretValue,
  setSecret,
  storedSecretKeys,
} from "../core/secret-store.ts";
import type { Registry } from "../core/loader.ts";
import type { LoadedWorkflow, RunRecord } from "../core/types.ts";
import {
  executionsPage,
  runPage,
  unauthorizedPage,
  workflowPage,
  workflowsPage,
} from "./views.ts";

const RUN_STATUSES = ["success", "failed", "running", "skipped"];

export function createApp(registry: Registry): Hono {
  const app = new Hono();

  if (process.env.LOG_LEVEL === "debug") app.use("*", httpLogger());

  /* ---------------------------------------------------------- liveness */

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      workflows: registry.enabled().length,
      uptime: process.uptime(),
      // The concurrency cap is invisible from the outside otherwise: a queue
      // that never drains looks exactly like a quiet runner.
      running: runningCount(),
      queued: queuedCount(),
    }),
  );

  /* ----------------------------------------------------------- webhooks */

  // Registered before the auth middleware: webhook callers authenticate with
  // WEBHOOK_SECRET, not with the dashboard's basic-auth credentials.
  app.all("/hooks/:path{.*}", async (c) => {
    const path = c.req.param("path");
    const method = c.req.method;
    const wf = registry.byHook(path, method === "HEAD" ? "GET" : method);

    if (!wf || wf.trigger.kind !== "webhook") {
      return c.json({ error: `No workflow handles ${method} /hooks/${path}` }, 404);
    }

    // Read the body once, as text. A verifier recomputes an HMAC over exactly
    // the bytes that arrived, so parsing first and re-serialising would never
    // match; the parse below works from this same string.
    let raw = "";
    if (method !== "GET" && method !== "HEAD") {
      try {
        raw = await c.req.raw.text();
      } catch {
        return c.json({ error: "Could not read request body" }, 400);
      }
    }

    if (wf.trigger.verify) {
      let ok = false;
      try {
        ok = await wf.trigger.verify({ body: raw, headers: c.req.raw.headers });
      } catch (err) {
        // A verifier that throws is a failed check, not a 500: the caller
        // gets the same 401 either way, and the reason is ours to read.
        log.warn(
          `Verifier for ${wf.name} threw — ${err instanceof Error ? err.message : err}`,
        );
      }
      if (!ok) {
        log.warn(`Rejected webhook for ${wf.name}: failed verification`);
        return c.json({ error: "Unauthorized" }, 401);
      }
    } else {
      // `secret: false` is an explicit opt-out, not an absent override: a route
      // whose caller is a person following a link cannot carry the shared secret,
      // so that workflow authenticates the caller from its own payload instead.
      const expected =
        wf.trigger.secret === false
          ? undefined
          : (wf.trigger.secret ?? process.env.WEBHOOK_SECRET);
      if (expected) {
        const provided =
          c.req.header("x-automator-secret") ??
          c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
          c.req.query("secret") ??
          "";
        if (!timingSafeEqual(provided, expected)) {
          log.warn(`Rejected webhook for ${wf.name}: bad secret`);
          return c.json({ error: "Unauthorized" }, 401);
        }
      }
    }

    let input: unknown;
    try {
      input = method === "GET" ? c.req.query() : await parseBody(raw, c.req.raw);
    } catch {
      return c.json({ error: "Could not parse request body" }, 400);
    }

    if (wf.trigger.schema) {
      const parsed = wf.trigger.schema.safeParse(input);
      if (!parsed.success) {
        return c.json({ error: "Validation failed", issues: parsed.error.issues }, 422);
      }
      input = parsed.data;
    }

    // Async is the default: most providers time out or retry on a slow reply.
    if ((wf.trigger.respond ?? "async") === "async") {
      queueMicrotask(() => void runWorkflow(wf, { input, trigger: "webhook" }));
      return c.json({ accepted: true, workflow: wf.name }, 202);
    }

    const outcome = await runWorkflow(wf, { input, trigger: "webhook" });
    return c.json(
      {
        runId: outcome.runId,
        status: outcome.status,
        result: outcome.result ?? null,
        error: outcome.error?.message ?? null,
      },
      outcome.status === "failed" ? 500 : 200,
    );
  });

  /* --------------------------------------------------------------- auth */

  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;
  if (user && pass) {
    const credentials = basicAuth({ username: user, password: pass });

    // basicAuth throws its own 401 with an octet-stream body, which a browser
    // cannot render for a top-level navigation — a dismissed prompt then looks
    // like the site is unreachable. Re-dress it as HTML, keeping the
    // WWW-Authenticate header that is what makes the prompt appear at all.
    const auth: MiddlewareHandler = async (c, next) => {
      try {
        return await credentials(c, next);
      } catch (err) {
        if (!(err instanceof HTTPException) || err.status !== 401) throw err;
        const challenge = err.getResponse().headers.get("www-authenticate");
        return c.html(
          unauthorizedPage() as any,
          401,
          challenge ? { "WWW-Authenticate": challenge } : undefined,
        );
      }
    };

    // "/runs" and "/workflows" are listed alongside their wildcards: a bare
    // "/runs/*" does not match "/runs" itself, and the executions tab lives
    // there.
    for (const p of ["/", "/runs", "/runs/*", "/workflows", "/workflows/*", "/api/*"])
      app.use(p, auth);
  } else {
    log.warn("DASHBOARD_USER / DASHBOARD_PASS are not set — the dashboard is public");
  }

  /* ---------------------------------------------------------- dashboard */

  app.get("/", (c) =>
    c.html(
      workflowsPage(
        registry.all(),
        nextRunFor,
        store.recentRunsPerWorkflow(12),
        store.statusCountsSince(Date.now() - 86_400_000),
        store.workflowVersions(),
      ) as any,
    ),
  );

  // The executions tab. Both filters are optional and validated here rather
  // than in the view, so an unknown ?status= widens to "everything" instead of
  // rendering a tab that can only ever be empty.
  app.get("/runs", (c) => {
    const asked = c.req.query("status") ?? "";
    const status = RUN_STATUSES.includes(asked) ? asked : "";
    const workflow = registry.get(c.req.query("workflow") ?? "")?.name ?? "";

    return c.html(
      executionsPage(
        store.filteredRuns({ status, workflow }, 100),
        { status, workflow },
        store.statusCountsSince(Date.now() - 86_400_000),
        registry.all().map((w) => w.name),
        runningCount(),
      ) as any,
    );
  });

  // "/workflows" is not a page of its own — the workflows tab is the index.
  app.get("/workflows", (c) => c.redirect("/", 302));

  app.get("/workflows/:name", (c) => {
    const wf = registry.get(c.req.param("name"));
    if (!wf) return c.notFound();
    return c.html(
      workflowPage(
        wf,
        nextRunFor(wf.name),
        store.statsForWorkflow(wf.name),
        store.runsForWorkflow(wf.name, 40),
        store.workflowVersions().get(wf.name),
      ) as any,
    );
  });

  app.post("/workflows/:name/run", async (c) => {
    const wf = registry.get(c.req.param("name"));
    if (!wf) return c.notFound();
    const outcome = await runWorkflow(wf, { trigger: "manual" });
    return c.redirect(outcome.runId ? `/runs/${outcome.runId}` : "/", 303);
  });

  app.get("/runs/:id", (c) => {
    const run = store.getRun(c.req.param("id"));
    if (!run) return c.notFound();
    return c.html(
      runPage(
        run,
        store.logsForRun(run.id),
        store.stepsForKey(run.checkpoint_key ?? run.id),
        store.callsForRun(run.id),
        store.childRuns(run.id),
      ) as any,
    );
  });

  // Re-runs a failed workflow against the same checkpoint key, so every step
  // that already succeeded is reused instead of repeated.
  app.post("/runs/:id/resume", async (c) => {
    const run = store.getRun(c.req.param("id"));
    if (!run) return c.notFound();

    const wf = registry.get(run.workflow);
    if (!wf) return c.text(`Workflow "${run.workflow}" no longer exists`, 409);

    const outcome = await runWorkflow(wf, {
      trigger: "manual",
      checkpointKey: run.checkpoint_key ?? run.id,
      resumedFrom: run.id,
    });
    return c.redirect(outcome.runId ? `/runs/${outcome.runId}` : `/runs/${run.id}`, 303);
  });

  // Replays a run against its original input, with a *fresh* checkpoint key:
  // it redoes the work, where resume skips past whatever already succeeded.
  app.post("/runs/:id/replay", async (c) => {
    const plan = planReplay(registry, c.req.param("id"));
    if ("error" in plan) return c.text(plan.error, plan.code);

    const outcome = await runWorkflow(plan.wf, {
      trigger: "manual",
      input: plan.input,
      replayedFrom: plan.run.id,
    });
    return c.redirect(outcome.runId ? `/runs/${outcome.runId}` : `/runs/${plan.run.id}`, 303);
  });

  /* ---------------------------------------------------------------- API */

  app.get("/api/workflows", (c) => {
    const versions = store.workflowVersions();
    return c.json(
      registry.all().map((w) => {
        const version = versions.get(w.name);
        return {
          name: w.name,
          description: w.description ?? null,
          trigger: w.trigger,
          enabled: w.enabled !== false,
          file: w.file,
          // The file's own history: `version` is a hash of its source, and
          // `updatedAt` moves only when that hash does. Neither says anything
          // about runs — /api/runs is the place for those.
          version: w.hash,
          addedAt: version ? new Date(version.first_seen).toISOString() : null,
          updatedAt: version ? new Date(version.updated_at).toISOString() : null,
          nextRun: nextRunFor(w.name)?.toISOString() ?? null,
        };
      }),
    );
  });

  app.post("/api/workflows/:name/run", async (c) => {
    const wf = registry.get(c.req.param("name"));
    if (!wf) return c.json({ error: "Unknown workflow" }, 404);

    const input = c.req.header("content-type")?.includes("json")
      ? await c.req.json().catch(() => ({}))
      : {};
    const outcome = await runWorkflow(wf, { input, trigger: "manual" });

    return c.json({
      runId: outcome.runId,
      status: outcome.status,
      result: outcome.result ?? null,
      error: outcome.error?.message ?? null,
    });
  });

  app.post("/api/runs/:id/resume", async (c) => {
    const run = store.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "Unknown run" }, 404);
    const wf = registry.get(run.workflow);
    if (!wf) return c.json({ error: `Workflow "${run.workflow}" no longer exists` }, 409);

    const outcome = await runWorkflow(wf, {
      trigger: "manual",
      checkpointKey: run.checkpoint_key ?? run.id,
      resumedFrom: run.id,
    });
    return c.json({
      runId: outcome.runId,
      status: outcome.status,
      resumedFrom: run.id,
      result: outcome.result ?? null,
      error: outcome.error?.message ?? null,
    });
  });

  app.post("/api/runs/:id/replay", async (c) => {
    const plan = planReplay(registry, c.req.param("id"));
    if ("error" in plan) return c.json({ error: plan.error }, plan.code);

    const outcome = await runWorkflow(plan.wf, {
      trigger: "manual",
      input: plan.input,
      replayedFrom: plan.run.id,
    });
    return c.json({
      runId: outcome.runId,
      status: outcome.status,
      replayedFrom: plan.run.id,
      result: outcome.result ?? null,
      error: outcome.error?.message ?? null,
    });
  });

  /* ------------------------------------------------------------ secrets */

  /*
   * Write access to credentials, and the only write surface in the whole app
   * that isn't "start a run". It lives on /api and not on the dashboard on
   * purpose: the dashboard stays read-only, which is the thing that keeps a
   * browser from being able to break production.
   *
   * A write here lands in the running process, so it is live on the next run
   * with no restart at all. The CLI writes to the database instead and is
   * picked up by the refresh tick — same result, a few seconds later.
   *
   * No route returns a value. Reading a credential back over HTTP is not a
   * thing this needs to do, and not offering it is cheaper than guarding it.
   */

  app.get("/api/secrets", (c) => {
    const stored = new Set(storedSecretKeys());
    const rows = store
      .secretRows()
      .map((r) => ({ key: r.key, source: "store" as const, updatedAt: r.updated_at }));

    // Rows the store holds but this process could not decrypt still exist and
    // should be visible — otherwise a wrong master key looks like a missing key.
    return c.json({
      encryptionReady: secretStoreReady(),
      secrets: rows.map((r) => ({ ...r, readable: stored.has(r.key) })),
    });
  });

  app.put("/api/secrets/:key", async (c) => {
    const key = c.req.param("key");
    const body = await c.req.json().catch(() => null);
    const value = (body as { value?: unknown } | null)?.value;

    if (typeof value !== "string") {
      return c.json({ error: "Body must be {\"value\": \"…\"}" }, 400);
    }

    try {
      await setSecret(key, value);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    // The name only. The value is the one thing that must not come back out.
    log.info(`Secret ${key} was set over the API`);
    return c.json({ key, ok: true });
  });

  app.delete("/api/secrets/:key", (c) => {
    const key = c.req.param("key");
    if (!deleteSecret(key)) return c.json({ error: "Not in the store" }, 404);

    log.info(`Secret ${key} was deleted over the API`);
    return c.json({ key, ok: true, fallsBackToEnv: secretValue(key) !== undefined });
  });

  app.get("/api/runs", (c) =>
    c.json(store.recentRuns(Number(c.req.query("limit") ?? 50))),
  );

  app.get("/api/runs/:id", (c) => {
    const run = store.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "Unknown run" }, 404);
    return c.json({
      ...run,
      logs: store.logsForRun(run.id),
      steps: store.stepsForKey(run.checkpoint_key ?? run.id),
      calls: store.callsForRun(run.id),
      children: store.childRuns(run.id),
    });
  });

  return app;
}

type ReplayPlan =
  | { run: RunRecord; wf: LoadedWorkflow; input: unknown }
  | { error: string; code: 404 | 409 };

/**
 * Everything that can stop a replay, decided in one place so the HTML and JSON
 * routes can't drift. Each refusal names its cause: a replay that quietly
 * substituted `{}` for a missing input would look like it worked.
 */
function planReplay(registry: Registry, id: string): ReplayPlan {
  const run = store.getRun(id);
  if (!run) return { error: "Unknown run", code: 404 };

  const wf = registry.get(run.workflow);
  if (!wf) return { error: `Workflow "${run.workflow}" no longer exists`, code: 409 };

  if (!run.input) {
    return {
      error:
        "This run has no recorded input — it predates the input column, or " +
        "CAPTURE_DATA was off when it ran.",
      code: 409,
    };
  }
  if (isTruncated(run.input)) {
    return {
      error:
        "This run's input was too large to record whole (CAPTURE_MAX_BYTES), " +
        "so replaying it would feed the workflow a truncated payload.",
      code: 409,
    };
  }

  try {
    return { run, wf, input: JSON.parse(run.input) };
  } catch {
    return { error: "This run's recorded input is not readable back", code: 409 };
  }
}

/**
 * Parses the body text the handler already read. Form bodies go back through
 * a rebuilt Request so multipart parsing stays the runtime's job — which does
 * mean a binary part is decoded as text on the way in, and webhook payloads
 * here are documents, not uploads.
 */
async function parseBody(text: string, req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return JSON.parse(text);
  if (type.includes("form")) {
    const rebuilt = new Request("http://body.local", {
      method: "POST",
      headers: { "content-type": type },
      body: text,
    });
    const form = await rebuilt.formData();
    return Object.fromEntries(form.entries() as Iterable<[string, FormDataEntryValue]>);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}


