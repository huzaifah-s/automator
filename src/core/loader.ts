import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { log } from "./logger.ts";
import { collectSecretProblems } from "./secrets.ts";
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
    .sort();

  for (const file of files) {
    const rel = file.slice(root.length + 1);
    let mod: { default?: WorkflowDef<any> };

    try {
      mod = await import(file);
    } catch (err) {
      errors.push(`${rel}: failed to import — ${err instanceof Error ? err.message : err}`);
      continue;
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
    });
  }

  const secretProblems = collectSecretProblems();
  if (errors.length || secretProblems.length) {
    for (const e of errors) log.error(e);
    for (const s of secretProblems) log.error(`secret ${s}`);
    throw new Error(
      `${errors.length + secretProblems.length} problem(s) found while loading workflows`,
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
}
