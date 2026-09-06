import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { log } from "./logger.ts";
import { collectSecretProblems } from "./secrets.ts";
import {
  credentialRef,
  credentialRequirements,
  credentialReady,
  setLoadingFile,
} from "./credentials.ts";
import type { LoadedWorkflow, WorkflowDef } from "./types.ts";

/**
 * Imports every .ts file under the workflows directory and collects the default
 * export. Everything is validated up front — a bad name, a duplicate, or a
 * missing secret stops the boot rather than failing on the first trigger.
 */
export async function loadWorkflows(dir = "./workflows"): Promise<LoadedWorkflow[]> {
  const root = resolve(dir);
  if (!existsSync(root)) {
    log.warn(`No workflows directory at ${root} — nothing to run`);
    return [];
  }

  const workflows: LoadedWorkflow[] = [];
  const errors: string[] = [];
  const seenNames = new Map<string, string>();
  const seenHooks = new Map<string, string>();

  const glob = new Bun.Glob("**/*.{ts,js}");
  const files = (await Array.fromAsync(glob.scan({ cwd: root, absolute: true })))
    .filter((f) => !/\.(test|spec|d)\.(ts|js)$/.test(f))
    // An underscore prefix means "this is not a workflow" — shared code for a
    // folder of related ones, which otherwise has nowhere to live: every other
    // file here must default-export a workflow, and src/ is for things the
    // whole runner uses, not one client's message catalogue.
    //
    // An explicit opt-out rather than "quietly skip anything without a default
    // export", because that guard is what catches a typo'd export and is worth
    // keeping. Renaming a file to _thing.ts is a decision; forgetting to
    // export is not.
    .filter((f) => !basename(f).startsWith("_"))
    .sort();

  for (const file of files) {
    const rel = file.slice(root.length + 1);
    let mod: { default?: WorkflowDef<any> };

    // defineCredential() runs at module scope and has no other way to know
    // which workflow asked for it, so the importer says so first.
    setLoadingFile(rel);
    try {
      mod = await import(file);
    } catch (err) {
      errors.push(`${rel}: failed to import — ${err instanceof Error ? err.message : err}`);
      continue;
    } finally {
      setLoadingFile(null);
    }

    const def = mod.default;
    if (!def || typeof def.run !== "function") {
      errors.push(`${rel}: no default export from defineWorkflow()`);
      continue;
    }

    const first = seenNames.get(def.name);
    if (first) {
      errors.push(`${rel}: duplicate workflow name "${def.name}" (already in ${first})`);
      continue;
    }
    seenNames.set(def.name, rel);

    if (def.trigger.kind === "webhook") {
      // Which one was guarding the route would otherwise be a guess, and the
      // guess people make is "both".
      if (def.trigger.verify && def.trigger.secret !== undefined) {
        errors.push(`${rel}: webhook declares both secret and verify — they are alternatives`);
        continue;
      }

      const key = `${def.trigger.method ?? "POST"} /${def.trigger.path}`;
      const owner = seenHooks.get(key);
      if (owner) {
        errors.push(`${rel}: webhook ${key} already handled by ${owner}`);
        continue;
      }
      seenHooks.set(key, rel);
    }

    const slash = rel.lastIndexOf("/");
    // Hashed here because this is the one place that already has the path.
    // What it is for lives in db.ts, above `workflow_versions`.
    const hash = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(file).text())
      .digest("hex");
    workflows.push({
      ...def,
      file: rel,
      folder: slash === -1 ? null : rel.slice(0, slash),
      hash,
      credentials: credentialRequirements()
        .filter((r) => r.file === rel)
        .map((r) => credentialRef(r.provider, r.id)),
    });
  }

  /*
   * A credential that has not been connected yet warns; it does not stop the
   * boot the way a missing defineSecrets key does.
   *
   * That difference is deliberate and it is not a softening of the rule. The
   * rule exists because a credential problem should surface on deploy rather
   * than at 3am — and it still does, twice: here in the log and as a blocked
   * workflow on the dashboard. What changes is the remedy. A secret is fixed
   * in the environment or by the CLI, both of which work on a dead server; a
   * credential is fixed on the dashboard, which a dead server does not serve.
   * Aborting would make the one workflow that needs connecting unfixable
   * without a redeploy, which is the thing this whole feature exists to end.
   *
   * Nothing runs on a half-connected credential regardless: runner.ts refuses
   * the run.
   */
  const blocked = credentialRequirements().filter((r) => !credentialReady(r.provider, r.id));
  for (const r of blocked) {
    log.warn(
      `credential ${credentialRef(r.provider, r.id)} is not connected — ` +
        `${r.file ?? "a workflow"} cannot run until it is (Credentials tab)`,
    );
  }

  const secretProblems = collectSecretProblems();
  if (errors.length || secretProblems.length) {
    const problems = [...errors, ...secretProblems.map((s) => `secret ${s}`)];
    for (const p of problems) log.error(p);
    // The list rides along on the error as well as going to the log, because
    // the one place that needs it is somewhere nobody can see the log: the
    // boot alert. A summary count tells you a deploy is down and nothing about
    // why, which is one round trip too many at the moment it happens.
    throw Object.assign(
      new Error(`${problems.length} problem(s) found while loading workflows`),
      { problems },
    );
  }

  const enabled = workflows.filter((w) => w.enabled !== false);
  log.info(
    `Loaded ${enabled.length} workflow(s)` +
      (workflows.length > enabled.length
        ? ` (${workflows.length - enabled.length} disabled)`
        : ""),
  );
  return workflows;
}

export class Registry {
  constructor(private readonly workflows: LoadedWorkflow[]) {}

  all(): LoadedWorkflow[] {
    return this.workflows;
  }

  enabled(): LoadedWorkflow[] {
    return this.workflows.filter((w) => w.enabled !== false);
  }

  get(name: string): LoadedWorkflow | undefined {
    return this.workflows.find((w) => w.name === name);
  }

  byHook(path: string, method: string): LoadedWorkflow | undefined {
    return this.enabled().find(
      (w) =>
        w.trigger.kind === "webhook" &&
        w.trigger.path === path &&
        (w.trigger.method ?? "POST") === method,
    );
  }

  /**
   * The workflow that answers a URL-verification handshake on this path,
   * whatever method it arrives on. Meta verifies a callback URL with a GET and
   * then delivers events to it with POST, so the handshake cannot be bound to
   * the trigger's own method the way everything else is. Only ever consulted
   * when `byHook` found nothing — an exact match always wins.
   */
  byHandshake(path: string): LoadedWorkflow | undefined {
    return this.enabled().find(
      (w) => w.trigger.kind === "webhook" && w.trigger.path === path && w.trigger.handshake,
    );
  }
}
