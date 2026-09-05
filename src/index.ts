import { loadWorkflows, Registry } from "./core/loader.ts";
import { startScheduler, stopScheduler, nextRunFor } from "./core/scheduler.ts";
import {
  runWorkflow,
  beginShutdown,
  activeCount,
  queuedCount,
  runningCount,
  setRegistry,
} from "./core/runner.ts";
import { createApp } from "./server/app.ts";
import { reconcileWebhooks } from "./core/webhooks.ts";
import { store, db } from "./core/db.ts";
import { log } from "./core/logger.ts";
import { closeSql, registerIntegrationSecrets } from "./integrations/index.ts";
import { loadSecretStore, startSecretRefresh, stopSecretRefresh } from "./core/secret-store.ts";
import { initCredentials } from "./core/credentials.ts";
import { runSecretCli } from "./cli/secrets.ts";

const args = process.argv.slice(2);

// The secret CLI runs before workflows are imported, and that ordering is the
// point of it: setting a credential for a workflow you have not deployed yet
// is exactly the case loadWorkflows() would abort on.
if (args[0] === "--secret") {
  process.exit(await runSecretCli(args.slice(1)));
}

// Before anything reads the environment: fold the stored credentials into it,
// so defineSecrets validates against what is actually available and the
// integrations — which read process.env inside their own factories — see the
// same values. A key present only in the store must satisfy boot validation.
const storedSecrets = await loadSecretStore();
if (storedSecrets > 0) log.info(`Loaded ${storedSecrets} secret(s) from the store`);

// Immediately after, and for the same reason: a credential's fields are stored
// secrets under derived names, and the one marked primary supplies the bare env
// vars an integration reads for itself. Both have to be in place before the
// loader imports a workflow that declares either.
const credentialFields = initCredentials();
if (credentialFields > 0) log.info(`Loaded ${credentialFields} credential field(s)`);

// Before anything can log: make the redactor aware of the credentials the
// built-in integrations read for themselves, not just workflow-declared ones.
const registered = registerIntegrationSecrets();
if (registered > 0) log.debug(`Redacting ${registered} integration credential(s)`);

const registry = new Registry(
  await loadWorkflows(process.env.WORKFLOWS_DIR ?? "./workflows").catch((err) => {
    log.error(err.message);
    log.error("Fix the problems above and start again.");
    process.exit(1);
  }),
);

// When each workflow file last changed, for the dashboard's "updated" column.
// Here rather than inside loadWorkflows(): loading is a read, this is a write.
const versions = store.recordWorkflowVersions(registry.all());
if (versions.added || versions.changed) {
  log.info(
    `Workflow files: ${versions.added} new, ${versions.changed} changed since the last boot`,
  );
}

// ctx.run() resolves workflow names through this. Set before the CLI section
// runs, so `bun run trigger` can drive a workflow that calls another one.
setRegistry(registry);

// Declared before the CLI section because shutdown() is called from inside it.
// Left below, these are still in their temporal dead zone at that point and
// every `bun run trigger` ends in a ReferenceError instead of its exit code.
let server: ReturnType<typeof Bun.serve> | undefined;
let shuttingDown = false;

/* ------------------------------------------------------------------- CLI */

if (args[0] === "--list") {
  for (const w of registry.all()) {
    const trigger =
      w.trigger.kind === "cron"
        ? `cron ${w.trigger.expression}`
        : w.trigger.kind === "poll"
          ? `poll ${w.trigger.expression}`
          : w.trigger.kind === "webhook"
            ? `${w.trigger.method ?? "POST"} /hooks/${w.trigger.path}`
            : "manual";
    console.log(
      `${w.enabled === false ? "○" : "●"} ${w.name.padEnd(28)} ${trigger.padEnd(34)} ${w.file}`,
    );
  }
  process.exit(0);
}

if (args[0] === "--run") {
  const name = args[1];
  const wf = name ? registry.get(name) : undefined;
  if (!wf) {
    log.error(name ? `Unknown workflow "${name}"` : "Usage: bun run trigger -- <workflow-name>");
    process.exit(1);
  }
  const outcome = await runWorkflow(wf, { trigger: "manual" });
  await shutdown("cli", outcome.status === "success" ? 0 : 1);
}

/* ---------------------------------------------------------------- server */

const orphans = store.markOrphans();
if (orphans > 0) log.warn(`Marked ${orphans} interrupted run(s) as failed`);

// A `bun run secret set` writes to the database from another process; this is
// how the long-lived server hears about it without being restarted.
startSecretRefresh();

startScheduler(registry);

const port = Number(process.env.PORT ?? 3000);
server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  idleTimeout: 60,
  fetch: createApp(registry).fetch,
});

log.info(`Dashboard on http://localhost:${port}`);
for (const w of registry.enabled()) {
  if (w.trigger.kind === "webhook") {
    log.info(`Webhook ${w.trigger.method ?? "POST"} /hooks/${w.trigger.path} → ${w.name}`);
  }
}
// After the server is listening, and never awaited: a provider that pings its
// new subscription straight away should find the route answering, and one that
// is down must not hold up or fail a boot.
void reconcileWebhooks(registry).catch((err) =>
  log.error(`Webhook reconciliation failed: ${err instanceof Error ? err.message : err}`),
);

if (registry.enabled().some((w) => w.trigger.kind === "cron")) {
  const soonest = registry
    .enabled()
    .map((w) => nextRunFor(w.name))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (soonest) log.info(`Next scheduled run at ${soonest.toISOString()}`);
}

/* -------------------------------------------------- graceful shutdown */

async function shutdown(signal: string, code = 0): Promise<never> {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;

  log.info(`${signal} received — shutting down`);
  beginShutdown();
  stopScheduler();
  stopSecretRefresh();

  // Give in-flight runs a chance to finish before the process goes away.
  const deadline = Date.now() + Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 20_000);
  // activeCount() covers queued runs too, so the loop stays alive long enough
  // for each of them to reach its turn and record itself as skipped.
  while (activeCount() > 0 && Date.now() < deadline) {
    const queued = queuedCount();
    log.info(
      `Waiting for ${runningCount()} run(s) to finish` +
        (queued > 0 ? ` — ${queued} queued run(s) will be skipped` : "") +
        "…",
    );
    await new Promise((r) => setTimeout(r, 1_000));
  }
  if (activeCount() > 0) log.warn(`${activeCount()} run(s) still going — leaving them behind`);

  await server?.stop(true);
  await closeSql().catch(() => {});
  db.close(false);
  process.exit(code);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  // A workflow that forgot an await must not take the whole runner down.
  log.error("Unhandled promise rejection", { reason: String(reason) });
});
