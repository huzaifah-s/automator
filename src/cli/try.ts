import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { store } from "../core/db.ts";
import { createLogger } from "../core/logger.ts";
import { createState } from "../core/state.ts";
import { buildPollCtx } from "../core/poll.ts";
import { runWorkflow } from "../core/runner.ts";
import { redact } from "../core/redact.ts";
import { heldCalls, isPractice } from "../core/practice.ts";
import { collectSecretProblems } from "../core/secrets.ts";
import {
  credentialReady,
  credentialRef,
  credentialRequirements,
  setLoadingFile,
} from "../core/credentials.ts";
import type { Registry } from "../core/loader.ts";
import type { LoadedWorkflow } from "../core/types.ts";

/**
 * `bun run try` — run a workflow on this machine, against the real services,
 * with every write held back. See src/core/practice.ts for what "held" means
 * and why it is decided at fetch.
 *
 *   bun run try -- <workflow-name>                  a workflow in workflows/
 *   bun run try -- ./scratch/look.ts                any file default-exporting defineWorkflow
 *   bun run try -- <name> --input sample.json       a webhook payload, or a fixture file
 *   bun run try -- <name> --live                    no gate: writes are really sent
 *   bun run try -- <name> --full                    print bodies whole, not clipped
 *
 * What it feeds the run, when `--input` is not given:
 *
 *   poll     the trigger's own fetch(), run for real — its items, all of them,
 *            because a practice run ignores the seen-list rather than updating it
 *   webhook  the first `"expect": "run"` sample under the workflow's __fixtures__
 *   other    nothing, as `bun run trigger` does
 *
 * A file outside workflows/ is the point of the second form. Looking something
 * up — which properties a Notion database has, what a Monday board's columns
 * are called — is a five-line throwaway workflow in a scratch directory, run
 * with the credentials this machine already holds, printed redacted, and never
 * committed.
 */
export async function runTryCli(registry: Registry, args: string[]): Promise<number> {
  const target = args.find((a) => !a.startsWith("--") && !isFlagValue(args, a));
  if (!target) {
    console.error(
      "Usage: bun run try -- <workflow-name | file.ts> [--input <file.json>] [--live] [--full]",
    );
    return 1;
  }
  const full = args.includes("--full");
  const inputPath = flagValue(args, "--input");

  const wf = await resolveWorkflow(registry, target);
  if (!wf) return 1;

  // Checked here as well as by the runner, because a poll's fetch() runs
  // before the runner is reached — and against an empty token it fails with
  // the provider's 401, which names nothing.
  const unconnected = wf.credentials.filter((ref) => {
    const [provider, id] = ref.split(":");
    return !credentialReady(provider!, id!);
  });
  if (unconnected.length) {
    console.error(
      `${wf.name} needs ${unconnected.join(", ")} connected on this machine first — ` +
        `start the local server (bun run dev), open its /credentials page ` +
        `and fill ${unconnected.length === 1 ? "it" : "them"} in. The server's copy does not reach here.`,
    );
    return 1;
  }

  let input: unknown;
  let inputFrom = "no input";
  if (inputPath) {
    const got = await readInput(wf, inputPath);
    if (!got.ok) return 1;
    input = got.input;
    inputFrom = got.from;
  } else if (wf.trigger.kind === "poll") {
    const t = wf.trigger;
    const logger = createLogger(wf.name);
    const items = await t.fetch(
      buildPollCtx(wf.name, logger, createState(wf.name), AbortSignal.timeout(t.timeoutMs ?? 60_000)),
    );
    if (!Array.isArray(items)) {
      console.error(`poll fetch must return an array, got ${items === null ? "null" : typeof items}`);
      return 1;
    }
    if (items.length === 0) {
      console.log(`${wf.name}: the poll's fetch() returned nothing, so there is nothing to run.`);
      printHeld(full);
      return 0;
    }
    input = items;
    inputFrom = `poll fetch() — ${items.length} item(s), seen-list ignored`;
  } else if (wf.trigger.kind === "webhook") {
    const sample = await firstRunningSample(wf);
    if (sample) {
      const got = await readInput(wf, sample);
      if (!got.ok) return 1;
      input = got.input;
      inputFrom = got.from;
    }
  }

  const mode = isPractice() ? "practice run — writes held back" : "LIVE run — writes are sent";
  console.log(`\n▶ ${wf.name}  (${mode})\n  input: ${inputFrom}\n`);

  // Once, not `retries + 1` times: somebody is watching the terminal, and a
  // failure is the answer they came for rather than something to wait out.
  const outcome = await runWorkflow({ ...wf, retries: 0 }, { trigger: "manual", input });
  const held = heldCalls();
  if (outcome.runId && isPractice()) {
    // So the run reads as a rehearsal on the local run page as well, not only
    // in this terminal. Redacted like every other thing that reaches SQLite.
    store.log(
      outcome.runId,
      "warn",
      `Practice run — ${held.length} write(s) held back, nothing was sent`,
      redact(held.map((h) => ({ method: h.method, url: h.url, why: h.why }))),
    );
  }

  report(outcome.runId, full);
  return outcome.status === "success" ? 0 : 1;
}

/* ---------------------------------------------------------------- target */

async function resolveWorkflow(registry: Registry, target: string): Promise<LoadedWorkflow | null> {
  const looksLikeFile = target.endsWith(".ts") || target.includes("/");
  if (!looksLikeFile) {
    const wf = registry.get(target);
    if (!wf) console.error(`Unknown workflow "${target}" — \`bun run list\` shows them`);
    return wf ?? null;
  }

  const abs = resolve(target);
  if (!existsSync(abs)) {
    console.error(`No file at ${abs}`);
    return null;
  }
  const rel = relative(resolve(process.env.WORKFLOWS_DIR ?? "./workflows"), abs);
  const known = registry.all().find((w) => w.file === rel);
  if (known) return known;

  // A scratch file. Imported the way the loader imports one, so its
  // defineCredential calls are attributed to it and a missing connection
  // blocks the run with the same message it would on the server.
  setLoadingFile(abs);
  let mod: { default?: unknown };
  try {
    mod = await import(abs);
  } finally {
    setLoadingFile(null);
  }
  const def = mod.default as LoadedWorkflow | undefined;
  if (!def || typeof def !== "object" || typeof def.run !== "function" || !def.trigger) {
    console.error(`${target}: no default export from defineWorkflow()`);
    return null;
  }
  const problems = collectSecretProblems();
  if (problems.length) {
    for (const p of problems) console.error(`secret ${p}`);
    return null;
  }
  return {
    ...def,
    file: abs,
    folder: null,
    hash: "",
    credentials: credentialRequirements()
      .filter((r) => r.file === abs)
      .map((r) => credentialRef(r.provider, r.id)),
  };
}

/* ----------------------------------------------------------------- input */

type Input = { ok: true; input: unknown; from: string } | { ok: false };

/**
 * A payload file, or a fixture — `{ expect, note, body }` — which is unwrapped
 * to its body. A webhook's payload goes through the route's schema first,
 * because the parsed value is what the real door hands to run(); the filter is
 * reported and not obeyed, the way a manual run or a replay bypasses it.
 */
async function readInput(wf: LoadedWorkflow, path: string): Promise<Input> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (err) {
    console.error(`${path}: not readable JSON — ${err instanceof Error ? err.message : err}`);
    return { ok: false };
  }
  const isFixture =
    raw !== null && typeof raw === "object" && "body" in raw && "expect" in raw;
  let input = isFixture ? (raw as { body: unknown }).body : raw;
  const from = `${path}${isFixture ? " (sample body)" : ""}`;

  if (wf.trigger.kind !== "webhook") return { ok: true, input, from };

  const { schema, filter } = wf.trigger;
  if (schema) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      console.error(`${path}: the webhook's schema rejects it — ${issues(parsed.error)}`);
      return { ok: false };
    }
    input = parsed.data;
  }
  if (filter) {
    try {
      const decision = await filter(input as never);
      if (decision !== true) {
        console.log(`  note: the filter would ignore this delivery ("${decision}") — running it anyway`);
      }
    } catch {
      /* a throwing filter runs the workflow on the server too */
    }
  }
  return { ok: true, input, from };
}

async function firstRunningSample(wf: LoadedWorkflow): Promise<string | null> {
  const root = resolve(process.env.WORKFLOWS_DIR ?? "./workflows");
  const dir = join(root, dirname(wf.file), "__fixtures__", basename(wf.file, ".ts"));
  if (!existsSync(dir)) return null;
  const files = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir }))).sort();
  for (const f of files) {
    const path = join(dir, f);
    try {
      const sample = (await Bun.file(path).json()) as { expect?: string };
      if (sample.expect === "run") return relative(process.cwd(), path);
    } catch {
      /* the fixture test reports an unreadable sample; here it is just skipped */
    }
  }
  return null;
}

/* ---------------------------------------------------------------- report */

function report(runId: string, full: boolean): void {
  const run = runId ? store.getRun(runId) : null;
  if (!run) {
    console.log("No run was recorded.");
    printHeld(full);
    return;
  }

  const took = run.duration_ms === null ? "" : ` in ${ms(run.duration_ms)}`;
  const mark = run.status === "success" ? "✓" : run.status === "skipped" ? "○" : "✗";
  console.log(`${mark} ${run.status}${took}  (run ${run.id})`);
  if (run.error) console.log(`  error: ${run.error}`);

  const steps = store.stepsForKey(run.checkpoint_key).filter((s) => s.run_id === run.id);
  if (steps.length) {
    console.log("\nsteps");
    for (const s of steps) {
      const ok = s.status === "ok" ? "✓" : "✗";
      console.log(`  ${ok} ${s.name}${s.duration_ms === null ? "" : `  (${ms(s.duration_ms)})`}`);
      if (s.input) console.log(`      in   ${clip(s.input, full)}`);
      if (s.output) console.log(`      out  ${clip(s.output, full)}`);
      if (s.error) console.log(`      err  ${clip(s.error, full)}`);
    }
  }

  const calls = store.callsForRun(run.id);
  if (calls.length) {
    console.log("\ncalls  (ctx.http — a bare fetch() shows only under 'held back')");
    for (const c of calls) {
      console.log(`  ${c.method.padEnd(6)} ${String(c.status ?? "—").padEnd(4)} ${c.url}`);
      if (full && c.response) console.log(`         ${clip(c.response, true)}`);
    }
  }

  printHeld(full);

  const logs = store.logsForRun(run.id).filter((l) => l.level !== "debug");
  if (logs.length) {
    console.log("\nlogs");
    for (const l of logs) console.log(`  ${l.level.padEnd(5)} ${clip(l.msg, full)}`);
  }

  if (run.result) console.log(`\nresult\n  ${clip(run.result, full)}`);
  // A path, not a URL: the dev server's port is often not the PORT this
  // process read from .env, and a wrong link is worse than none.
  console.log(`\nOn the local dashboard: /runs/${run.id}\n`);
}

function printHeld(full: boolean): void {
  if (!isPractice()) return;
  const held = heldCalls();
  if (held.length === 0) {
    console.log("\nheld back: nothing");
    return;
  }
  console.log(`\nheld back — ${held.length} write(s), none of them sent`);
  for (const h of held) {
    console.log(`  ${h.method.padEnd(6)} ${redact(h.url)}   · ${h.why}`);
    if (h.body !== undefined) console.log(`         ${clip(JSON.stringify(redact(h.body)), full)}`);
  }
}

/* ---------------------------------------------------------------- helpers */

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function isFlagValue(args: string[], value: string): boolean {
  const i = args.indexOf(value);
  return i > 0 && args[i - 1] === "--input";
}

function clip(text: string, full: boolean): string {
  const one = redact(text).replace(/\s+/g, " ");
  return full || one.length <= 400 ? one : `${one.slice(0, 400)}… (${one.length} chars, --full for all)`;
}

function ms(n: number): string {
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

function issues(error: unknown): string {
  const list = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> })?.issues;
  if (!list) return String(error);
  return list.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
