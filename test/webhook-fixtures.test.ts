/**
 * Sample payloads, run through each webhook's schema and filter.
 *
 * What this is for: a payload shape the route turns away. Both fixes on
 * 2026-09-28 were exactly that — a form sending `"name": null`, Monday sending
 * `label.text: null` for a cleared status — and each was a 422 on a delivery
 * that should have run. A sample of every shape somebody has seen, kept next
 * to the workflow, is what stops the next edit to a schema from quietly
 * turning one of them away again.
 *
 * What it is not: a test of run(). Nothing here reaches the network, a
 * credential or the database; the schema and the filter are the only two
 * things between a delivery and a run that are pure, and they are the two
 * that have broken. Authentication is out of scope too — it needs the real
 * secret, and a rejection there is loud already.
 *
 * Layout: the samples for `workflows/<folder>/<file>.ts` live in
 * `workflows/<folder>/__fixtures__/<file>/*.json`. The loader and the reload
 * watcher only read .ts, so they never see them. Each one is
 *
 *   { "expect": "run" | "ignore" | "reject", "note": "why this shape exists",
 *     "reason": "the filter's exact reason — ignore only, optional",
 *     "body": { … } }
 *
 * **Made-up values only.** Copy a real payload's structure, never its names,
 * numbers or message text — a fixture is committed, and git history is
 * forever. See AGENTS.md.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Importing a workflow imports the core, and the core opens the database at
// import. Pointed somewhere disposable before the first import, so a test run
// never touches the real file — the dynamic imports below are what make this
// ordering possible; a static import would be hoisted above it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "automator-test-")), "test.db");

const root = resolve(import.meta.dir, "../workflows");
const sources = (await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: root }))).sort();

// A signature checker refuses to be built without its secret, at import — the
// right call for the server, where a check keyed on nothing is a check anyone
// passes. Nothing here checks a signature, so every key a workflow declares
// with defineSecrets gets a placeholder, *overriding* whatever the local .env
// holds: the test then runs the same on a fresh clone as on a laptop with
// every credential, and a real secret never enters the process to leak.
for (const file of sources) {
  const text = await Bun.file(join(root, file)).text();
  for (const block of text.matchAll(/defineSecrets\(\{([\s\S]*?)\}\)/g)) {
    for (const [, key] of block[1]!.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)) {
      process.env[key!] = `test-placeholder-${"x".repeat(48)}`;
    }
  }
}

type Expect = "run" | "ignore" | "reject";

interface Fixture {
  expect: Expect;
  note: string;
  reason?: string;
  body: unknown;
}

/** Every workflow file the loader would load, by its path under workflows/. */
const files = sources.filter(
  (f) => !basename(f).startsWith("_") && !/\.(test|spec|d)\.ts$/.test(f),
);

type Webhook = {
  name: string;
  file: string;
  schema?: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: unknown } };
  filter?: (input: unknown) => unknown;
};

const webhooks = new Map<string, Webhook>();
for (const file of files) {
  const mod = await import(join(root, file));
  const def = mod.default;
  if (def?.trigger?.kind !== "webhook") continue;
  webhooks.set(file.replace(/\.ts$/, ""), {
    name: def.name,
    file,
    schema: def.trigger.schema,
    filter: def.trigger.filter,
  });
}

const fixtures = (await Array.fromAsync(new Bun.Glob("**/__fixtures__/*/*.json").scan({ cwd: root })))
  .sort()
  .map((path) => {
    // workflows/<folder>/__fixtures__/<file>/<sample>.json → <folder>/<file>
    const owner = join(dirname(dirname(dirname(path))), basename(dirname(path)));
    return { path, owner };
  });

/** Shortens a zod error to the fields it names, which is all a failure needs. */
function issues(error: unknown): string {
  const list = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> })?.issues;
  if (!list) return String(error);
  return list.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

describe("webhook fixtures", () => {
  for (const { path, owner } of fixtures) {
    test(`${owner} › ${basename(path, ".json")}`, async () => {
      const where = `workflows/${path}`;
      const wf = webhooks.get(owner);
      // A folder that matches no webhook is a typo or a renamed file, and a
      // sample nobody runs is worse than none: it reads as coverage.
      if (!wf) throw new Error(`${where}: no webhook workflow at workflows/${owner}.ts`);

      const fixture = (await Bun.file(join(root, path)).json()) as Fixture;
      if (!["run", "ignore", "reject"].includes(fixture.expect)) {
        throw new Error(`${where}: "expect" must be run, ignore or reject`);
      }
      if (!fixture.note?.trim()) throw new Error(`${where}: say why this shape exists in "note"`);

      // The route's order: schema, then filter. See app.ts.
      let input = fixture.body;
      if (wf.schema) {
        const parsed = wf.schema.safeParse(fixture.body);
        if (fixture.expect === "reject") {
          expect(parsed.success, `${where} was accepted, but should be rejected`).toBe(false);
          return;
        }
        if (!parsed.success) {
          throw new Error(`${where}: the schema rejected it — ${issues(parsed.error)}`);
        }
        input = parsed.data;
      } else if (fixture.expect === "reject") {
        throw new Error(`${where}: expects a rejection, but ${wf.file} has no schema`);
      }

      // The route runs a delivery whose filter throws, so a throw would not
      // lose it in production — but it is still a bug, and this is where it
      // is cheap to find.
      const decision = wf.filter ? await wf.filter(input) : true;
      if (fixture.expect === "run") {
        expect(decision, `${where} was ignored, but should run`).toBe(true);
      } else {
        expect(decision, `${where} ran, but should be ignored`).not.toBe(true);
        if (fixture.reason !== undefined) expect(decision).toBe(fixture.reason);
      }
    });
  }

  // Coverage, not correctness: every webhook has at least one shape it must
  // run. A route with no sample is the one whose schema can drift unnoticed.
  test("every webhook has a sample it runs", async () => {
    const running = new Set<string>();
    for (const { path, owner } of fixtures) {
      const fixture = (await Bun.file(join(root, path)).json()) as Fixture;
      if (fixture.expect === "run") running.add(owner);
    }
    const missing = [...webhooks.keys()].filter((owner) => !running.has(owner));
    expect(missing, `no "run" sample under __fixtures__ for: ${missing.join(", ")}`).toEqual([]);
  });
});
