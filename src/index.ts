import { loadWorkflows, Registry } from "./core/loader.ts";
import { startScheduler, stopScheduler, nextRunFor } from "./core/scheduler.ts";
import { runWorkflow, beginShutdown, activeCount } from "./core/runner.ts";
import { createApp } from "./server/app.ts";
import { store, db } from "./core/db.ts";
import { log } from "./core/logger.ts";
import { closeSql, registerIntegrationSecrets } from "./integrations/index.ts";

const args = process.argv.slice(2);

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

/* ------------------------------------------------------------------- CLI */

if (args[0] === "--list") {
  for (const w of registry.all()) {
    const trigger =
      w.trigger.kind === "cron"
        ? `cron ${w.trigger.expression}`
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

// Declared up front so shutdown() can reach it from the CLI path too, where
// the server is never started.
let server: ReturnType<typeof Bun.serve> | undefined;

const orphans = store.markOrphans();
if (orphans > 0) log.warn(`Marked ${orphans} interrupted run(s) as failed`);

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
if (registry.enabled().some((w) => w.trigger.kind === "cron")) {
  const soonest = registry
    .enabled()
    .map((w) => nextRunFor(w.name))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (soonest) log.info(`Next scheduled run at ${soonest.toISOString()}`);
}

/* -------------------------------------------------- graceful shutdown */

let shuttingDown = false;

async function shutdown(signal: string, code = 0): Promise<never> {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;

  log.info(`${signal} received — shutting down`);
  beginShutdown();
  stopScheduler();

  // Give in-flight runs a chance to finish before the process goes away.
  const deadline = Date.now() + Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 20_000);
  while (activeCount() > 0 && Date.now() < deadline) {
    log.info(`Waiting for ${activeCount()} run(s) to finish…`);
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
