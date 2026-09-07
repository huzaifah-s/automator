import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, resolve } from "node:path";
import { loadWorkflows, type Registry } from "./loader.ts";
import { startScheduler, stopScheduler } from "./scheduler.ts";
import { reconcileWebhooks } from "./webhooks.ts";
import { store } from "./db.ts";
import { log } from "./logger.ts";

/**
 * Picking up a workflow change without restarting the process.
 *
 * The runner is one process holding one SQLite file, an in-memory run queue,
 * and a set of cron timers, so a redeploy is a restart and a restart costs
 * in-flight runs and a window where webhooks are refused. None of that is
 * needed to change a workflow: workflow files are leaves. Nothing in `src/`
 * imports them, so a new copy can be imported and swapped into the registry
 * while everything around it keeps running.
 *
 * What makes this safe is that a run holds the workflow object it started
 * with. It finishes on the code it started with; the next trigger gets the new
 * code. There is no such thing as a run that is half old and half new.
 *
 * Deliberately not a general-purpose hot reload. It reaches workflow files and
 * nothing else — a change under `src/`, or a new dependency, is still a
 * restart, and `_`-prefixed shared files are the awkward middle case handled
 * below.
 */

/** Set `WORKFLOW_RELOAD=0` to switch this off and go back to restart-only. */
const ENABLED = (process.env.WORKFLOW_RELOAD ?? "1") !== "0";

/**
 * How long to wait for the filesystem to go quiet before reloading. A `git
 * pull` writes many files and is not atomic across them, so the risk being
 * bought off here is loading half of one commit and half of the next. A second
 * is far longer than a pull takes to write and far shorter than anyone would
 * notice waiting.
 */
const QUIET_MS = 1_000;

let watcher: FSWatcher | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let reloading = false;
/** A change that arrived while a reload was already running. */
let again = false;
/**
 * Hashes of the `_`-prefixed files, which are shared code rather than
 * workflows. See `sharedChanged` for why they are watched separately.
 */
let sharedHashes = new Map<string, string>();
/** Set once a shared file has changed. Never cleared — only a restart clears it. */
let sharedStale = false;
/** Bumped per reload, and what makes the runtime re-import rather than reuse. */
let generation = 0;

/**
 * Starts watching the workflows directory.
 *
 * Failing to watch is a warning and not an error. The runner is completely
 * functional without this — it is a convenience that removes a restart, and a
 * platform whose `fs.watch` cannot do recursive directories should lose the
 * convenience rather than the deploy.
 */
export function startWorkflowWatch(dir: string, registry: Registry): void {
  if (!ENABLED) {
    log.info("Workflow reloading is off (WORKFLOW_RELOAD=0) — changes need a restart");
    return;
  }

  const root = resolve(dir);
  if (!existsSync(root)) return;

  sharedHashes = hashShared(root);

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      // A rename with no name, and anything that is not a module, are both
      // noise. Editors also write .swp and friends into the same tree.
      if (filename && !/\.(ts|js)$/.test(filename)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void reload(root, registry), QUIET_MS);
    });
  } catch (err) {
    log.warn(
      `Cannot watch ${root} for changes, so workflow edits will need a restart — ` +
        `${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  log.info(`Watching ${root} — a workflow change reloads without a restart`);
}

export function stopWorkflowWatch(): void {
  clearTimeout(timer);
  watcher?.close();
  watcher = undefined;
}

/**
 * Loads the workflows again and swaps them in, or changes nothing at all.
 *
 * Every refusal below leaves the process exactly as it was, still serving the
 * previous set. That is the property worth protecting: the failure mode of a
 * reload has to be "your change is not live yet", which a person can see and
 * fix, and never "the runner is down", which is the thing restarts already
 * cost us.
 */
async function reload(root: string, registry: Registry): Promise<void> {
  if (reloading) {
    again = true;
    return;
  }
  reloading = true;

  try {
    if (sharedStale) return;

    /*
     * A `_`-prefixed file is shared code that workflows import directly, and
     * the cache-busting query the loader adds does not reach it: a relative
     * specifier resolves against the importing file's URL with the query
     * dropped, so the copy already in memory is the one that gets used.
     *
     * Reloading anyway would run new workflow code against a stale helper —
     * a mixed state, and the one outcome worse than not reloading, because it
     * is invisible. So a shared change switches reloading off until a restart,
     * which is what you were going to do anyway to pick it up.
     */
    const now = hashShared(root);
    const changed = sharedChanged(sharedHashes, now);
    if (changed) {
      sharedStale = true;
      sharedHashes = now;
      log.warn(
        `${changed} is shared code, not a workflow — it cannot be swapped in on its ` +
          `own, so reloading is off until the next restart`,
      );
      return;
    }

    const next = await loadWorkflows(root, String(++generation)).catch((err) => {
      const problems = (err as { problems?: string[] }).problems;
      log.error(
        `Workflows did not reload — still running the previous set. ` +
          (problems?.join("; ") ?? (err instanceof Error ? err.message : String(err))),
      );
      return undefined;
    });
    if (!next) return;

    const before = new Map(registry.all().map((w) => [w.name, w.hash]));
    registry.replace(next);

    // The scheduler is rebuilt wholesale rather than diffed. Cron expressions
    // are absolute — croner computes the next 09:00 from the expression, not
    // from when the timer was created — so a job taken down and put back up
    // fires at exactly the same moment it would have. Diffing would buy
    // nothing and would be a second place for "is this workflow scheduled"
    // to disagree with the registry.
    stopScheduler();
    startScheduler(registry);

    const versions = store.recordWorkflowVersions(next);
    const added = next.filter((w) => !before.has(w.name)).map((w) => w.name);
    const removed = [...before.keys()].filter((n) => !next.some((w) => w.name === n));
    const changedNames = next
      .filter((w) => before.has(w.name) && before.get(w.name) !== w.hash)
      .map((w) => w.name);

    // Nothing to say when a write touched no workflow the runner can see —
    // a `git pull` that only changed a README should be silent.
    if (added.length || removed.length || changedNames.length || versions.changed) {
      log.info(
        `Reloaded ${next.length} workflow(s) without a restart` +
          (changedNames.length ? ` — changed: ${changedNames.join(", ")}` : "") +
          (added.length ? ` — new: ${added.join(", ")}` : "") +
          (removed.length ? ` — gone: ${removed.join(", ")}` : ""),
      );
    }

    // A workflow whose `register` block changed needs its subscription moved.
    // Idempotent and does nothing when every URL still matches, which is the
    // normal case — and never awaited, for the same reason as at boot.
    void reconcileWebhooks(registry).catch((err) =>
      log.error(`Webhook reconciliation failed: ${err instanceof Error ? err.message : err}`),
    );
  } finally {
    reloading = false;
    if (again) {
      again = false;
      timer = setTimeout(() => void reload(root, registry), QUIET_MS);
    }
  }
}

/** Current contents of every `_`-prefixed module, by path. */
function hashShared(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const glob = new Bun.Glob("**/_*.{ts,js}");
  for (const rel of glob.scanSync({ cwd: root })) {
    if (!basename(rel).startsWith("_")) continue;
    try {
      out.set(rel, Bun.hash(readFileSync(`${root}/${rel}`, "utf8")).toString(36));
    } catch {
      // A file that vanished between the scan and the read counts as changed,
      // which the caller works out from it being absent from this map.
    }
  }
  return out;
}

/** The first shared file that was added, removed, or edited, if any. */
function sharedChanged(
  before: Map<string, string>,
  after: Map<string, string>,
): string | undefined {
  for (const [file, hash] of after) if (before.get(file) !== hash) return file;
  for (const file of before.keys()) if (!after.has(file)) return file;
  return undefined;
}
