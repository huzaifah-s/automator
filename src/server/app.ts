import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { logger as httpLogger } from "hono/logger";
import { store } from "../core/db.ts";
import { log } from "../core/logger.ts";
import { queuedCount, runningCount, runWorkflow } from "../core/runner.ts";
import { nextRunFor } from "../core/scheduler.ts";
import type { Registry } from "../core/loader.ts";
import { indexPage, runPage, workflowPage } from "./views.ts";

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

    const expected = wf.trigger.secret ?? process.env.WEBHOOK_SECRET;
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

    let input: unknown;
    try {
      input = method === "GET" ? c.req.query() : await readBody(c.req.raw);
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
    const auth = basicAuth({ username: user, password: pass });
    for (const p of ["/", "/runs/*", "/workflows/*", "/api/*"]) app.use(p, auth);
  } else {
    log.warn("DASHBOARD_USER / DASHBOARD_PASS are not set — the dashboard is public");
  }

  /* ---------------------------------------------------------- dashboard */

  app.get("/", (c) =>
    c.html(indexPage(registry.all(), nextRunFor, store.recentRuns(40)) as any),
  );

  app.get("/workflows/:name", (c) => {
    const wf = registry.get(c.req.param("name"));
    if (!wf) return c.notFound();
    return c.html(
      workflowPage(
        wf,
        nextRunFor(wf.name),
        store.statsForWorkflow(wf.name),
        store.runsForWorkflow(wf.name, 40),
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

  /* ---------------------------------------------------------------- API */

  app.get("/api/workflows", (c) =>
    c.json(
      registry.all().map((w) => ({
        name: w.name,
        description: w.description ?? null,
        trigger: w.trigger,
        enabled: w.enabled !== false,
        file: w.file,
        nextRun: nextRunFor(w.name)?.toISOString() ?? null,
      })),
    ),
  );

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
    });
  });

  return app;
}

async function readBody(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return req.json();
  if (type.includes("form")) {
    const form = await req.formData();
    return Object.fromEntries(form.entries() as Iterable<[string, FormDataEntryValue]>);
  }
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Constant-time compare so a wrong secret can't be recovered byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Length alone is not secret enough to be worth leaking through an early exit.
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < Math.max(ba.length, bb.length); i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
