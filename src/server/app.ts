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
import {
  credentialReady,
  credentialRef,
  credentialRequirements,
  deleteCredential,
  fieldKey,
  getCredential,
  listCredentials,
  saveCredential,
  testCredential,
  type CredentialStatus,
} from "../core/credentials.ts";
import { PROVIDERS, isProviderId, providerIds, type Provider } from "../core/providers.ts";
import type { Registry } from "../core/loader.ts";
import type { LoadedWorkflow, RunRecord } from "../core/types.ts";
import {
  credentialFormPage,
  credentialsPage,
  executionsPage,
  providerPickerPage,
  runPage,
  secretFormPage,
  unauthorizedPage,
  workflowPage,
  workflowsPage,
  type CredentialView,
  type ProviderView,
  type SecretView,
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
    for (const p of [
      "/",
      "/runs",
      "/runs/*",
      "/workflows",
      "/workflows/*",
      "/credentials",
      "/credentials/*",
      "/secrets",
      "/secrets/*",
      "/api/*",
    ])
      app.use(p, auth);
  } else {
    log.warn("DASHBOARD_USER / DASHBOARD_PASS are not set — the dashboard is public");
  }

  /* ---------------------------------------------------------- dashboard */

  /**
   * Which workflows cannot run because a credential they declared has not been
   * connected. Computed per request rather than at boot: connecting one on the
   * Credentials tab has to clear the badge without a restart.
   */
  const blockedWorkflows = (): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const w of registry.all()) {
      const missing = (w.credentials ?? []).filter((ref) => {
        const [provider, id] = ref.split(":");
        return !credentialReady(provider!, id!);
      });
      if (missing.length > 0) out.set(w.name, missing);
    }
    return out;
  };

  app.get("/", (c) =>
    c.html(
      workflowsPage(
        registry.all(),
        nextRunFor,
        store.recentRunsPerWorkflow(12),
        store.statusCountsSince(Date.now() - 86_400_000),
        store.workflowVersions(),
        blockedWorkflows(),
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
        blockedWorkflows().get(wf.name) ?? [],
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

  /* -------------------------------------------------------- credentials */

  /*
   * The one part of the dashboard that writes, and the only one gated by a
   * flag. DASHBOARD_WRITE is the switch that decides whether "the dashboard is
   * read-only" still holds for this deployment: off, the tab renders exactly
   * the same page with no buttons on it.
   *
   * The reason to allow it at all is narrower than convenience. A credential
   * typed into this form goes from a person straight into the encrypted store.
   * Every other route into the store — the CLI, the API — means whoever is
   * driving handles the raw value on the way past, and when that is an agent
   * writing workflow code, the credential ends up in a transcript. This form
   * is the only path where it does not.
   */
  const writable = process.env.DASHBOARD_WRITE === "1";
  if (writable) log.warn("DASHBOARD_WRITE=1 — credentials can be changed from the browser");

  /** Blocks a write route when the flag is off, rather than hiding the button. */
  const requireWrite = (c: any) =>
    writable
      ? null
      : c.text(
          "The dashboard is read-only. Set DASHBOARD_WRITE=1 to change credentials here, " +
            "or use `bun run secret` and the API.",
          403,
        );

  const providerView = (id: string): ProviderView => {
    const p = PROVIDERS[id as keyof typeof PROVIDERS] as Provider;
    return {
      id,
      label: p.label,
      blurb: p.blurb,
      docs: p.docs,
      envNamesForPrimary: Object.values(p.envMap ?? {}),
      fields: Object.entries(p.fields).map(([name, f]) => ({
        name,
        label: f.label,
        secret: f.secret !== false,
        optional: f.optional === true,
        set: false,
        placeholder: f.placeholder,
        help: f.help,
      })),
    };
  };

  /**
   * A stored credential as the browser is allowed to see it. Secret fields
   * report only whether a value exists; non-secret ones — a hostname, a port —
   * carry their value, because an edit form you cannot read is not one.
   */
  const credentialView = (status: CredentialStatus): CredentialView => {
    const { row, provider } = status;
    const requiredBy = credentialRequirements()
      .filter((r) => r.provider === row.provider && r.id === row.id)
      .map((r) => r.file)
      .filter((f): f is string => f !== null);

    return {
      provider: row.provider,
      id: row.id,
      folder: row.folder,
      platform: provider?.label ?? null,
      primary: row.is_primary === 1,
      envNames: row.is_primary === 1 ? Object.values(provider?.envMap ?? {}) : [],
      missing: status.missing,
      testedAt: row.tested_at,
      testOk: row.test_ok === null ? null : row.test_ok === 1,
      testDetail: row.test_detail,
      requiredBy,
      fields: Object.entries(provider?.fields ?? {}).map(([name, f]) => {
        const stored = secretValue(fieldKey(row.provider, row.id, name));
        return {
          name,
          label: f.label,
          secret: f.secret !== false,
          optional: f.optional === true,
          set: stored !== undefined,
          value: f.secret === false ? stored : undefined,
          placeholder: f.placeholder,
          help: f.help,
        };
      }),
    };
  };

  /** Loose secrets are the rows no credential owns. */
  const looseSecrets = (): SecretView[] =>
    store
      .secretMeta()
      .filter((r) => r.owner === null)
      .map((r) => ({ key: r.key, folder: r.folder, updatedAt: r.updated_at }));

  const knownFolders = (): string[] => {
    const set = new Set<string>();
    for (const row of store.credentialRows()) if (row.folder) set.add(row.folder);
    for (const r of store.secretMeta()) if (r.folder) set.add(r.folder);
    return [...set].sort();
  };

  /** Declared by a workflow with nothing stored for it yet. */
  const wantedCredentials = () => {
    const have = new Set(store.credentialRows().map((r) => credentialRef(r.provider, r.id)));
    const seen = new Map<string, { provider: string; id: string; requiredBy: string[] }>();
    for (const r of credentialRequirements()) {
      const ref = credentialRef(r.provider, r.id);
      if (have.has(ref)) continue;
      const entry = seen.get(ref) ?? { provider: r.provider, id: r.id, requiredBy: [] };
      if (r.file) entry.requiredBy.push(r.file);
      seen.set(ref, entry);
    }
    return [...seen.values()].map((w) => ({ ...w, known: isProviderId(w.provider) }));
  };

  const renderCredentials = (c: any, error?: string) =>
    c.html(
      credentialsPage({
        credentials: listCredentials().map(credentialView),
        secrets: looseSecrets(),
        wanted: wantedCredentials(),
        writable,
        encryptionReady: secretStoreReady(),
        failed24h: store.statusCountsSince(Date.now() - 86_400_000).failed ?? 0,
        workflowCount: registry.all().length,
        error: error ?? null,
      }) as any,
      error ? 400 : 200,
    );

  app.get("/credentials", (c) => renderCredentials(c));

  // Registered before "/credentials/:provider/:id" so a literal "new" is not
  // read as a platform name. No provider is called "new", but relying on that
  // rather than on the order would be relying on a coincidence.
  app.get("/credentials/new", (c) => {
    const denied = requireWrite(c);
    if (denied) return denied;
    return c.html(providerPickerPage(providerIds().map(providerView)) as any);
  });

  app.get("/credentials/new/:provider", (c) => {
    const denied = requireWrite(c);
    if (denied) return denied;
    const provider = c.req.param("provider");
    if (!isProviderId(provider)) return c.notFound();
    return c.html(
      credentialFormPage({
        provider: providerView(provider),
        suggestedId: c.req.query("id"),
        folders: knownFolders(),
      }) as any,
    );
  });

  app.get("/credentials/:provider/:id", (c) => {
    const denied = requireWrite(c);
    if (denied) return denied;
    const status = getCredential(c.req.param("provider"), c.req.param("id"));
    if (!status || !status.provider) return c.notFound();
    return c.html(
      credentialFormPage({
        provider: providerView(status.row.provider),
        existing: credentialView(status),
        folders: knownFolders(),
      }) as any,
    );
  });

  app.post("/credentials", async (c) => {
    const denied = requireWrite(c);
    if (denied) return denied;

    const body = await c.req.parseBody();
    const text = (name: string): string | undefined => {
      const value = body[name];
      return typeof value === "string" ? value : undefined;
    };

    const providerId = text("provider") ?? "";
    if (!isProviderId(providerId)) return c.notFound();
    const provider = PROVIDERS[providerId] as Provider;
    const id = (text("id") ?? "").trim();
    const folder = (text("folder") ?? "").trim();

    // A field the form did not send stays untouched — that is what makes
    // submitting an unchanged password placeholder keep the stored value
    // rather than blanking it. An empty *secret* box means "unchanged"; an
    // empty non-secret box means "clear it".
    const values: Record<string, string | undefined> = {};
    for (const [name, field] of Object.entries(provider.fields)) {
      const given = text(`f_${name}`);
      if (given === undefined) continue;
      if (field.secret !== false && given === "") continue;
      values[name] = given;
    }

    try {
      await saveCredential({
        provider: providerId,
        id,
        folder: folder || null,
        primary: body.primary === "1",
        values,
      });
    } catch (err) {
      const existing = getCredential(providerId, id);
      // Non-secret values come back so one bad field does not cost the rest.
      const submitted: Record<string, string> = { "@id": id, "@folder": folder };
      for (const [name, field] of Object.entries(provider.fields)) {
        if (field.secret !== false) continue;
        const given = text(`f_${name}`);
        if (given !== undefined) submitted[name] = given;
      }
      return c.html(
        credentialFormPage({
          provider: providerView(providerId),
          existing: existing?.provider ? credentialView(existing) : undefined,
          folders: knownFolders(),
          submitted,
          error: err instanceof Error ? err.message : String(err),
        }) as any,
        400,
      );
    }

    // Saving and connecting are the same act as far as anyone using this is
    // concerned, so the test runs here rather than waiting for a second click.
    await testCredential(providerId, id).catch(() => {});
    return c.redirect("/credentials", 303);
  });

  app.post("/credentials/:provider/:id/test", async (c) => {
    const denied = requireWrite(c);
    if (denied) return denied;
    const provider = c.req.param("provider");
    const id = c.req.param("id");
    if (!getCredential(provider, id)) return c.notFound();
    await testCredential(provider, id).catch(() => {});
    return c.redirect("/credentials", 303);
  });

  app.post("/credentials/:provider/:id/delete", (c) => {
    const denied = requireWrite(c);
    if (denied) return denied;
    deleteCredential(c.req.param("provider"), c.req.param("id"));
    return c.redirect("/credentials", 303);
  });

  /* ------------------------------------------------------ loose secrets */

  app.get("/secrets/new", (c) => {
    const denied = requireWrite(c);
    if (denied) return denied;
    return c.html(secretFormPage({ folders: knownFolders() }) as any);
  });

  app.get("/secrets/:key", (c) => {
    const denied = requireWrite(c);
    if (denied) return denied;
    const key = c.req.param("key");
    const row = store.secretMeta().find((r) => r.key === key && r.owner === null);
    if (!row) return c.notFound();
    return c.html(
      secretFormPage({ existingKey: key, folder: row.folder, folders: knownFolders() }) as any,
    );
  });

  app.post("/secrets", async (c) => {
    const denied = requireWrite(c);
    if (denied) return denied;

    const body = await c.req.parseBody();
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const value = typeof body.value === "string" ? body.value : "";
    const folder = typeof body.folder === "string" ? body.folder.trim() : "";

    // A credential's fields are stored secrets too. Letting this form write one
    // directly would edit a credential from behind its own validation.
    const existing = store.secretMeta().find((r) => r.key === key);
    if (existing?.owner) {
      return c.html(
        secretFormPage({
          folders: knownFolders(),
          error: `${key} belongs to credential ${existing.owner} — edit it there.`,
        }) as any,
        400,
      );
    }

    // An empty value box on a secret that already exists means "keep it" — the
    // same contract the credential form uses for its password fields. Moving a
    // secret between folders is metadata, and making it cost a trip to the
    // password manager is how a value ends up mistyped or pasted from the
    // wrong place.
    if (existing && value === "") {
      store.secretSetFolder(key, folder || null);
      log.info(`Secret ${key} was moved to ${folder || "no folder"} from the dashboard`);
      return c.redirect("/credentials", 303);
    }

    try {
      await setSecret(key, value, { folder: folder || null });
      if (!folder) store.secretSetFolder(key, null);
    } catch (err) {
      return c.html(
        secretFormPage({
          existingKey: existing ? key : undefined,
          folder: folder || null,
          folders: knownFolders(),
          error: err instanceof Error ? err.message : String(err),
        }) as any,
        400,
      );
    }
    log.info(`Secret ${key} was set from the dashboard`);
    return c.redirect("/credentials", 303);
  });

  app.post("/secrets/:key/delete", (c) => {
    const denied = requireWrite(c);
    if (denied) return denied;
    const key = c.req.param("key");
    if (store.secretMeta().find((r) => r.key === key)?.owner) {
      return renderCredentials(c, `${key} belongs to a credential — delete that instead.`);
    }
    deleteSecret(key);
    log.info(`Secret ${key} was deleted from the dashboard`);
    return c.redirect("/credentials", 303);
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
    const rows = store.secretMeta().map((r) => ({
      key: r.key,
      source: "store" as const,
      updatedAt: r.updated_at,
      folder: r.folder,
      // `provider:id` when this row is one field of a credential — those are
      // edited through /api/credentials, which validates the whole bundle.
      credential: r.owner,
    }));

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
    const folder = (body as { folder?: unknown } | null)?.folder;

    if (typeof value !== "string") {
      return c.json({ error: "Body must be {\"value\": \"…\"}" }, 400);
    }

    const owner = store.secretMeta().find((r) => r.key === key)?.owner;
    if (owner) {
      return c.json(
        { error: `${key} is a field of credential ${owner} — use /api/credentials` },
        409,
      );
    }

    try {
      await setSecret(key, value, { folder: typeof folder === "string" ? folder : null });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    // The name only. The value is the one thing that must not come back out.
    log.info(`Secret ${key} was set over the API`);
    return c.json({ key, ok: true });
  });

  app.delete("/api/secrets/:key", (c) => {
    const key = c.req.param("key");
    const owner = store.secretMeta().find((r) => r.key === key)?.owner;
    if (owner) {
      return c.json(
        { error: `${key} is a field of credential ${owner} — delete that instead` },
        409,
      );
    }
    if (!deleteSecret(key)) return c.json({ error: "Not in the store" }, 404);

    log.info(`Secret ${key} was deleted over the API`);
    return c.json({ key, ok: true, fallsBackToEnv: secretValue(key) !== undefined });
  });

  /*
   * Credentials over the API. Same rule as secrets, one step further: a field
   * declared `secret` is never returned, and neither is a field's value in any
   * response — `fields` says which ones are set, and that is the whole of it.
   *
   * Not gated by DASHBOARD_WRITE. The flag exists to decide whether a *browser
   * session* can change production; the API was already a write surface before
   * this tab existed, and quietly narrowing it would break the CLI-shaped
   * callers it was built for.
   */

  app.get("/api/providers", (c) =>
    c.json(
      providerIds().map((id) => {
        const p = PROVIDERS[id] as Provider;
        return {
          id,
          label: p.label,
          blurb: p.blurb,
          docs: p.docs ?? null,
          suppliesEnv: Object.values(p.envMap ?? {}),
          fields: Object.entries(p.fields).map(([name, f]) => ({
            name,
            label: f.label,
            secret: f.secret !== false,
            optional: f.optional === true,
          })),
        };
      }),
    ),
  );

  app.get("/api/credentials", (c) =>
    c.json(
      listCredentials().map((status) => {
        const view = credentialView(status);
        return {
          provider: view.provider,
          id: view.id,
          folder: view.folder,
          platform: view.platform,
          primary: view.primary,
          suppliesEnv: view.envNames,
          // Whether every required field has a value — not whether the last
          // test passed. A credential can be complete and still be refused by
          // the platform, which is exactly what lastTest is for.
          complete: view.missing.length === 0 && view.platform !== null,
          missing: view.missing,
          requiredBy: view.requiredBy,
          lastTest:
            view.testedAt === null
              ? null
              : {
                  at: new Date(view.testedAt).toISOString(),
                  ok: view.testOk,
                  detail: view.testDetail,
                },
          // Which fields hold a value — never what the value is.
          fields: view.fields.map((f) => ({ name: f.name, secret: f.secret, set: f.set })),
        };
      }),
    ),
  );

  app.put("/api/credentials/:provider/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const values = (body as { values?: unknown } | null)?.values;
    if (values === null || typeof values !== "object") {
      return c.json({ error: 'Body must be {"values": {…}}' }, 400);
    }

    try {
      await saveCredential({
        provider: c.req.param("provider"),
        id: c.req.param("id"),
        folder: (body as { folder?: string }).folder ?? null,
        primary: (body as { primary?: boolean }).primary === true,
        values: values as Record<string, string>,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    // Names only, as everywhere else.
    log.info(`Credential ${credentialRef(c.req.param("provider"), c.req.param("id"))} set over the API`);
    const test = await testCredential(c.req.param("provider"), c.req.param("id")).catch(
      (err) => ({ ok: false, detail: err instanceof Error ? err.message : String(err), at: Date.now() }),
    );
    return c.json({ ok: true, test: { ok: test.ok, detail: test.detail } });
  });

  app.post("/api/credentials/:provider/:id/test", async (c) => {
    const provider = c.req.param("provider");
    const id = c.req.param("id");
    if (!getCredential(provider, id)) return c.json({ error: "No such credential" }, 404);
    const result = await testCredential(provider, id);
    return c.json({ ok: result.ok, detail: result.detail, at: new Date(result.at).toISOString() });
  });

  app.delete("/api/credentials/:provider/:id", (c) => {
    const provider = c.req.param("provider");
    const id = c.req.param("id");
    if (!deleteCredential(provider, id)) return c.json({ error: "No such credential" }, 404);
    log.info(`Credential ${credentialRef(provider, id)} deleted over the API`);
    return c.json({ ok: true });
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


