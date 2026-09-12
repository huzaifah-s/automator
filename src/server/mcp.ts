/**
 * The MCP endpoint — what an AI agent sees of this runner.
 *
 * Mounted at POST /mcp, speaking JSON-RPC over plain HTTP. There is no SDK
 * behind it and no session state: an MCP request is a JSON-RPC object in a
 * POST body and a JSON-RPC object back, and the block at the bottom of this
 * file is the whole of that. A dependency would buy SSE streaming and
 * server-initiated messages, neither of which a read-mostly query surface has
 * any use for.
 *
 * ── The thing this file is actually about: tokens ──────────────────────────
 *
 * Every byte a tool returns is a byte in a model's context window, paid for on
 * that request and on every request after it in the same conversation. The n8n
 * MCP this replaces was unusable for exactly four reasons, and each one has a
 * countermeasure here:
 *
 *   1. It returned workflow graphs. Node positions, typeVersions, connection
 *      maps — thousands of tokens of canvas layout per workflow, none of it
 *      actionable. Nothing here returns a workflow's definition at all: the
 *      definition is a TypeScript file, and an agent that needs to read one
 *      reads the repository.
 *
 *   2. It returned whole executions. Every node's input and output, in full,
 *      to report a 401. Here the run *list* is one line per run and the run
 *      *detail* is a separate, deliberate call — see `run` below.
 *
 *   3. Its tool list was enormous. Forty tools with paragraph descriptions is
 *      a fixed cost paid on every turn of every conversation, before a single
 *      call is made. There are ten tools here and each description is one
 *      line, which is roughly a tenth of that standing cost.
 *
 *   4. It made the model do the aggregating. "What is failing?" meant pulling
 *      two hundred executions into context and counting them there. `failures`
 *      does the grouping in SQL and TypeScript and returns eight lines.
 *
 * The formatting rules that follow from this: compact text tables rather than
 * JSON (JSON repeats every key on every row, which on a twenty-row list is
 * most of the payload); relative ages rather than timestamps; abbreviated run
 * ids, resolved back by prefix; and a byte ceiling on every result, enforced
 * here rather than hoped for.
 *
 * ── Access ─────────────────────────────────────────────────────────────────
 *
 * MCP_TOKEN, as a bearer token. Unlike the dashboard, which warns and stays
 * open when DASHBOARD_USER/PASS are unset, an unset MCP_TOKEN closes this
 * endpoint entirely. The dashboard can be left public because it is read-only
 * about what a workflow *is*; this endpoint can start a run, replay a webhook
 * delivery and pause a workflow, so the failure mode of leaving it open is
 * someone else's Instagram post.
 */

import { Hono } from "hono";
import { store } from "../core/db.ts";
import { isTruncated } from "../core/capture.ts";
import { log } from "../core/logger.ts";
import { queuedCount, runningCount, runWorkflow } from "../core/runner.ts";
import { allPauses, isEnabled, isPaused, pause, resume } from "../core/pause.ts";
import { nextRunFor, scheduleWorkflow, unscheduleWorkflow } from "../core/scheduler.ts";
import { identify, mayUseEndpoint, mcpEnabled, noteUse, type McpIdentity } from "../core/mcp-tokens.ts";
import { listCredentials, testCredential, credentialRef } from "../core/credentials.ts";
import { secretStoreReady, storedSecretKeys } from "../core/secret-store.ts";
import { listVariables, setVariable } from "../core/variables.ts";
import { planReplay, workflowsBlockedBy } from "./inspect.ts";
import type { Registry } from "../core/loader.ts";
import type { RunRecord } from "../core/types.ts";

/* ------------------------------------------------------------- budgets */

/**
 * The ceiling on a single tool result, in bytes. Roughly four bytes to the
 * token, so the default is about six thousand tokens — enough for a run with
 * its payloads, small enough that one runaway response cannot take a
 * conversation's context with it.
 *
 * `run` takes a `max_bytes` argument to raise it per call, because the one
 * legitimate reason to want more is reading a captured body whole, and
 * CAPTURE_MAX_BYTES already bounds how big that can be.
 */
const DEFAULT_MAX_BYTES = Number(process.env.MCP_MAX_BYTES ?? 24_000);

/** The most a single call may ask for, however large `max_bytes` is set. */
const HARD_MAX_BYTES = 200_000;

/* ---------------------------------------------------------- formatting */

/** `3m`, `4h`, `2d` — a duration a reader can compare without doing sums. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** The same scale, forwards — for a schedule's next tick. */
function until(ms: number): string {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function duration(ms: number | null): string {
  if (ms === null) return "-";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** UTC, matching the dashboard — the day you read has to be the day it shows. */
function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/**
 * The first eight characters of a run id. A UUID is thirty-six, and a
 * twenty-row list spends more on ids than on anything else in it; every tool
 * that takes a run id resolves a prefix back through `store.resolveRunId`, so
 * the short form is not a display-only convenience.
 */
function short(id: string): string {
  return id.slice(0, 8);
}

function firstLine(text: string, max: number): string {
  const line = (text.split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** Left-aligned columns, two spaces apart. The last column is never padded. */
function table(rows: string[][], indent = "  "): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map(
      (row) =>
        indent +
        row
          .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
          .join("  ")
          .trimEnd(),
    )
    .join("\n");
}

/**
 * Cuts a string to a byte budget and says so. The marker names the way out —
 * a truncated payload that does not say it was truncated is worse than no
 * payload, because it reads as the whole answer.
 */
function clip(text: string, budget: number, hint = "raise max_bytes"): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= budget) return text;
  const cut = Buffer.from(text).subarray(0, Math.max(0, budget)).toString("utf8");
  return `${cut}\n... [+${bytes - budget} bytes cut - ${hint}]`;
}

/** A captured payload, marked when `capture()` already shortened it. */
function payload(value: string | null): string {
  if (value === null) return "(not captured)";
  return isTruncated(value) ? `${value}  [truncated by CAPTURE_MAX_BYTES]` : value;
}

/**
 * Collapses a URL to the endpoint it is. Query strings go entirely, and any
 * path segment that is a number or a long id becomes a placeholder — otherwise
 * every Monday item and every Notion page is its own "endpoint" and the
 * aggregate says nothing.
 */
function normaliseUrl(url: string): string {
  const noQuery = url.split("?", 1)[0] ?? url;
  return noQuery
    .split("/")
    .map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || seg.length > 24 ? "{id}" : seg,
    )
    .join("/");
}

/* --------------------------------------------------------- aggregation */

/**
 * Collapses an error message to the thing that makes two failures the same
 * failure. Ids and long numbers vary run to run and would otherwise scatter
 * one recurring fault across twenty groups; HTTP status codes are three
 * digits and survive, which is deliberate — a 429 and a 500 are not the same
 * problem.
 */
function signature(error: string | null): string {
  return firstLine(error ?? "(no message)", 160)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b\d[\d.,:_-]{3,}\b/g, "<n>");
}

interface FailureGroup {
  workflow: string;
  signature: string;
  count: number;
  first: number;
  last: number;
  samples: string[];
}

/** Failed runs in a window, grouped by workflow and error, worst first. */
function groupFailures(since: number): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const run of store.failedRunsSince(since)) {
    const sig = signature(run.error);
    const key = `${run.workflow} :: ${sig}`;
    const found = groups.get(key);
    if (found) {
      found.count++;
      found.first = Math.min(found.first, run.started_at);
      found.last = Math.max(found.last, run.started_at);
      if (found.samples.length < 3) found.samples.push(short(run.id));
    } else {
      groups.set(key, {
        workflow: run.workflow,
        signature: sig,
        count: 1,
        first: run.started_at,
        last: run.started_at,
        samples: [short(run.id)],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.last - a.last);
}

/* --------------------------------------------------------------- args */

function num(
  args: Record<string, unknown>,
  key: string,
  def: number,
  min: number,
  max: number,
): number {
  const raw = args[key];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const raw = args[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

function bool(args: Record<string, unknown>, key: string, def: boolean): boolean {
  const raw = args[key];
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return def;
}

/* -------------------------------------------------------------- tools */

interface Tool {
  name: string;
  description: string;
  /**
   * "read" tools are listed for, and callable by, every token. "write" tools
   * are hidden from a read-scoped token entirely rather than merely refused:
   * a tool a caller may not use is a description it should not be paying for
   * on every turn.
   */
  scope: "read" | "write";
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  run(args: Record<string, unknown>): Promise<string> | string;
}

const HOURS = { type: "number", description: "Hours back. Default 24, max 720." };

const RUN_ID = { type: "string", description: "Run id, or a unique prefix." };

function buildTools(registry: Registry): Tool[] {
  /** The one workflow a tool was asked about, or a refusal that names it. */
  const needWorkflow = (args: Record<string, unknown>) => {
    const name = str(args, "workflow");
    if (!name) throw new Error("`workflow` is required.");
    const wf = registry.get(name);
    if (!wf) throw new Error(`No workflow named "${name}". Call \`workflows\` for the list.`);
    return wf;
  };

  /** The one run a tool was asked about, from a short id or a whole one. */
  const needRun = (args: Record<string, unknown>): RunRecord => {
    const given = str(args, "run_id");
    if (!given) throw new Error("`run_id` is required.");
    const id = store.resolveRunId(given);
    if (!id) {
      throw new Error(
        `No single run matches "${given}" - it is unknown, ambiguous, or pruned ` +
          `(RUN_RETENTION_DAYS). Call \`runs\` for current ids.`,
      );
    }
    return store.getRun(id)!;
  };

  const outcomeLine = (verb: string, runId: string, status: string, error: string | null) =>
    `${verb} -> run ${short(runId)} (${runId})\nstatus: ${status}` +
    (error ? `\nerror: ${firstLine(error, 300)}` : "") +
    `\n\nCall \`run\` with run_id "${short(runId)}" for steps, HTTP calls and logs.`;

  return [
    {
      name: "overview",
      scope: "read",
      description:
        "Start here. Counts, in-flight work, run totals, and everything failing, rejecting, " +
        "blocked or paused.",
      inputSchema: {
        type: "object",
        properties: { hours: HOURS },
        additionalProperties: false,
      },
      run(args) {
        const hours = num(args, "hours", 24, 1, 720);
        const since = Date.now() - hours * 3_600_000;
        const all = registry.all();
        const blocked = workflowsBlockedBy(registry);
        const paused = allPauses();
        const counts = store.statusCounts({ since });
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const failures = groupFailures(since);
        const rejections = store.rejectionTotals();

        const out: string[] = [];
        // "armed" rather than "active", because `blocked` is a subset of it
        // and not a fourth state: a workflow whose credential is missing still
        // has its triggers up, it just fails the moment one fires.
        out.push(
          `automator - ${all.length} workflows: ` +
            `${all.filter((w) => isEnabled(w)).length} armed ` +
            `(${blocked.size} of them blocked on a credential), ${paused.size} paused`,
        );
        out.push(
          `now: ${runningCount()} running, ${queuedCount()} queued, ` +
            `${store.pendingDeliveryCount()} webhook deliveries pending, ` +
            `up ${ago(Date.now() - process.uptime() * 1000)}`,
        );
        out.push(
          `last ${hours}h: ${total} runs - ` +
            ["success", "failed", "skipped", "running"]
              .map((s) => `${counts[s] ?? 0} ${s}`)
              .join(", "),
        );

        if (failures.length > 0) {
          out.push(`\nFAILING (${failures.length} distinct causes)`);
          out.push(
            table(
              failures
                .slice(0, 8)
                .map((f) => [`${f.count}x`, f.workflow, firstLine(f.signature, 70), ago(f.last)]),
            ),
          );
          if (failures.length > 8) {
            out.push(`  ... ${failures.length - 8} more - call \`failures\``);
          }
        }

        if (rejections.size > 0) {
          out.push("\nWEBHOOKS REJECTED AT THE DOOR (unresolved)");
          out.push(table([...rejections].map(([name, r]) => [`${r.count}x`, name, ago(r.last_at)])));
        }

        if (blocked.size > 0) {
          out.push("\nBLOCKED (a declared credential is not connected)");
          out.push(table([...blocked].map(([name, refs]) => [name, refs.join(", ")])));
        }

        if (paused.size > 0) {
          out.push("\nPAUSED");
          out.push(table([...paused].map(([name, p]) => [name, ago(p.paused_at), p.note ?? ""])));
        }

        if (failures.length === 0 && rejections.size === 0 && blocked.size === 0) {
          out.push("\nNothing failing, rejecting or blocked in this window.");
        }
        return out.join("\n");
      },
    },

    {
      name: "workflows",
      scope: "read",
      description:
        "Workflows with trigger, state, 7-day success rate, last outcome. Not their source.",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["all", "active", "paused", "blocked", "failing"],
            description: "Default all. `failing` means the last run failed.",
          },
          contains: { type: "string", description: "Substring match on the name." },
        },
        additionalProperties: false,
      },
      run(args) {
        const filter = str(args, "filter") ?? "all";
        if (!["all", "active", "paused", "blocked", "failing"].includes(filter)) {
          throw new Error(
            `Unknown filter "${filter}". Use all, active, paused, blocked or failing.`,
          );
        }
        const contains = str(args, "contains")?.toLowerCase();
        const blocked = workflowsBlockedBy(registry);

        // One scan of the last seven days, tallied here rather than a query
        // per workflow: thirty round trips to answer one list is the shape of
        // problem this whole file exists to avoid.
        const window = Date.now() - 7 * 86_400_000;
        const recent = new Map<string, { ok: number; total: number; last?: RunRecord }>();
        for (const run of store.filteredRuns({ since: window }, 5000)) {
          const seen = recent.get(run.workflow) ?? { ok: 0, total: 0 };
          seen.total++;
          if (run.status === "success") seen.ok++;
          // filteredRuns is newest first, so the first one seen is the last run.
          if (!seen.last) seen.last = run;
          recent.set(run.workflow, seen);
        }

        const rows: string[][] = [];
        for (const w of registry.all()) {
          if (contains && !w.name.toLowerCase().includes(contains)) continue;
          const stats = recent.get(w.name);
          const state = blocked.has(w.name)
            ? "blocked"
            : isPaused(w.name)
              ? "paused"
              : w.enabled === false
                ? "off"
                : "active";

          if (filter === "active" && state !== "active") continue;
          if (filter === "paused" && state !== "paused") continue;
          if (filter === "blocked" && state !== "blocked") continue;
          if (filter === "failing" && stats?.last?.status !== "failed") continue;

          const next = nextRunFor(w.name);
          rows.push([
            w.name,
            w.trigger.kind,
            state,
            stats ? `${stats.ok}/${stats.total}` : "-",
            stats?.last ? `${stats.last.status} ${ago(stats.last.started_at)}` : "never ran",
            next ? `next in ${until(next.getTime())}` : "",
          ]);
        }
        if (rows.length === 0) return `No workflows match filter="${filter}".`;
        return (
          `${rows.length} workflows - columns: name, trigger, state, 7d ok/total, last run\n` +
          table(rows)
        );
      },
    },

    {
      name: "runs",
      scope: "read",
      description:
        "Runs newest first: id, age, status, duration, workflow, error. `contains` searches " +
        "errors and log lines.",
      inputSchema: {
        type: "object",
        properties: {
          workflow: { type: "string" },
          status: { type: "string", enum: ["success", "failed", "running", "skipped"] },
          contains: { type: "string", description: "Free text in the error or any log line." },
          hours: HOURS,
          limit: { type: "number", description: "Default 20, max 100." },
        },
        additionalProperties: false,
      },
      run(args) {
        const hours = num(args, "hours", 24, 1, 720);
        const limit = num(args, "limit", 20, 1, 100);
        const status = str(args, "status");
        if (status && !["success", "failed", "running", "skipped"].includes(status)) {
          throw new Error(
            `Unknown status "${status}". Use success, failed, running or skipped.`,
          );
        }
        const contains = str(args, "contains");
        const filter = {
          workflow: str(args, "workflow"),
          status,
          since: Date.now() - hours * 3_600_000,
        };
        // Folded into this tool rather than given its own: a search is a run
        // list with one more condition, and a separate tool would be a second
        // description charged on every turn to say the same thing.
        const runs = contains
          ? store.searchRuns(contains, filter, limit)
          : store.filteredRuns(filter, limit);
        if (runs.length === 0) {
          return contains ? `No runs mention "${contains}" in the last ${hours}h.` : "No runs match.";
        }
        return (
          `${runs.length} runs in the last ${hours}h` +
          (contains ? ` mentioning "${contains}"` : "") +
          `, newest first\n` +
          table(
            runs.map((r) => [
              short(r.id),
              ago(r.started_at),
              r.status,
              duration(r.duration_ms),
              r.workflow,
              r.error ? firstLine(r.error, 70) : "",
            ]),
          ) +
          "\n\nPass a short id to `run` for full detail."
        );
      },
    },

    {
      name: "run",
      scope: "read",
      description:
        "One run whole: steps, HTTP calls with bodies, logs. The expensive call - narrow with " +
        "`section`. Bodies carry customer data.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: RUN_ID,
          section: {
            type: "string",
            enum: ["all", "input", "steps", "calls", "logs"],
            description: "Default all.",
          },
          max_bytes: {
            type: "number",
            description: `Result ceiling. Default ${DEFAULT_MAX_BYTES}, max ${HARD_MAX_BYTES}.`,
          },
        },
        required: ["run_id"],
        additionalProperties: false,
      },
      run(args) {
        const r = needRun(args);
        const section = str(args, "section") ?? "all";
        const budget = num(args, "max_bytes", DEFAULT_MAX_BYTES, 1000, HARD_MAX_BYTES);
        const want = (s: string) => section === "all" || section === s;

        const out: string[] = [];
        out.push(`run ${r.id}  ${r.workflow}  ${r.status}`);
        out.push(
          `trigger ${r.trigger}, attempt ${r.attempts}, started ${when(r.started_at)}, ` +
            `took ${duration(r.duration_ms)}`,
        );
        const lineage = [
          r.checkpoint_key !== r.id ? `checkpoint ${short(r.checkpoint_key)}` : "",
          r.resumed_from ? `resumed from ${short(r.resumed_from)}` : "",
          r.replayed_from ? `replayed from ${short(r.replayed_from)}` : "",
          r.parent_run ? `called by ${short(r.parent_run)}` : "",
        ].filter(Boolean);
        if (lineage.length > 0) out.push(lineage.join(", "));
        if (r.error) out.push(`\nerror:\n${r.error}`);
        if (r.result) out.push(`\nresult: ${r.result}`);

        if (want("input")) out.push(`\ninput:\n${payload(r.input)}`);

        if (want("steps")) {
          const steps = store.stepsForKey(r.checkpoint_key ?? r.id);
          out.push(`\nsteps (${steps.length}):`);
          for (const s of steps) {
            out.push(`  [${s.status} ${duration(s.duration_ms)}] ${s.name}`);
            if (s.error) out.push(`    error: ${s.error}`);
            if (s.input) out.push(`    in:  ${payload(s.input)}`);
            if (s.output) out.push(`    out: ${payload(s.output)}`);
          }
        }

        if (want("calls")) {
          const calls = store.callsForRun(r.id);
          out.push(`\nhttp calls (${calls.length}):`);
          for (const c of calls) {
            out.push(`  [${c.status ?? "-"} ${duration(c.duration_ms)}] ${c.method} ${c.url}`);
            if (c.request) out.push(`    req: ${payload(c.request)}`);
            if (c.response) out.push(`    res: ${payload(c.response)}`);
          }
        }

        if (want("logs")) {
          const logs = store.logsForRun(r.id);
          out.push(`\nlogs (${logs.length}):`);
          for (const l of logs) {
            out.push(`  ${when(l.ts).slice(11)} ${l.level} ${l.msg}` + (l.data ? ` ${l.data}` : ""));
          }
        }

        const children = store.childRuns(r.id);
        if (children.length > 0) {
          out.push(`\ncalled workflows (${children.length}):`);
          out.push(table(children.map((c) => [short(c.id), c.status, c.workflow])));
        }

        return clip(
          out.join("\n"),
          budget,
          "raise max_bytes, or pass section=steps|calls|logs|input",
        );
      },
    },

    {
      name: "failures",
      scope: "read",
      description:
        "What is failing and how often, grouped by workflow and error. Ask before listing runs.",
      inputSchema: {
        type: "object",
        properties: { hours: HOURS, limit: { type: "number", description: "Default 15, max 50." } },
        additionalProperties: false,
      },
      run(args) {
        const hours = num(args, "hours", 24, 1, 720);
        const limit = num(args, "limit", 15, 1, 50);
        const groups = groupFailures(Date.now() - hours * 3_600_000);
        if (groups.length === 0) return `No failed runs in the last ${hours}h.`;
        return (
          `${groups.reduce((a, g) => a + g.count, 0)} failed runs in ${hours}h, ` +
          `${groups.length} distinct causes\n` +
          `columns: count, workflow, error, first seen, last seen, sample ids\n` +
          table(
            groups
              .slice(0, limit)
              .map((g) => [
                `${g.count}x`,
                g.workflow,
                firstLine(g.signature, 90),
                ago(g.first),
                ago(g.last),
                g.samples.join(","),
              ]),
          ) +
          (groups.length > limit ? `\n  ... ${groups.length - limit} more causes` : "")
        );
      },
    },

    {
      name: "rejections",
      scope: "read",
      description:
        "Deliveries turned away at the door, and ones a workflow's filter declined. Neither " +
        "appears in `runs`.",
      inputSchema: {
        type: "object",
        properties: { workflow: { type: "string", description: "Default: every workflow." } },
        additionalProperties: false,
      },
      run(args) {
        const only = str(args, "workflow");
        const names = only ? [only] : registry.all().map((w) => w.name);

        const rejected: string[][] = [];
        const ignored: string[][] = [];
        const ignoredTotals = store.ignoredTotals();
        for (const name of names) {
          for (const r of store.rejectionsFor(name)) {
            const live = r.resolved_at === null || r.resolved_at < r.last_at;
            rejected.push([
              `${r.count}x`,
              name,
              r.reason,
              firstLine(r.detail ?? "", 60),
              ago(r.last_at),
              live ? "unresolved" : "resolved since",
            ]);
          }
          if (ignoredTotals.has(name)) {
            for (const i of store.ignoredFor(name)) {
              ignored.push([`${i.count}x`, name, firstLine(i.reason, 70), ago(i.last_at)]);
            }
          }
        }

        const out: string[] = [];
        if (rejected.length > 0) {
          out.push("REJECTED (never reached a run)");
          out.push("columns: count, workflow, reason, detail, last, state");
          out.push(table(rejected));
        }
        if (ignored.length > 0) {
          out.push("\nIGNORED (the workflow's own filter declined - not a fault)");
          out.push(table(ignored));
        }
        return out.length > 0 ? out.join("\n") : "No rejected or ignored deliveries recorded.";
      },
    },

    {
      name: "hotspots",
      scope: "read",
      description:
        "Where time and retries go: slowest steps, slowest endpoints, workflows burning attempts.",
      inputSchema: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Window in hours (default 168, max 720)." },
          limit: { type: "number", description: "Rows per section. Default 8, max 25." },
        },
        additionalProperties: false,
      },
      run(args) {
        const hours = num(args, "hours", 168, 1, 720);
        const limit = num(args, "limit", 8, 1, 25);
        const since = Date.now() - hours * 3_600_000;

        const steps = store.stepHotspots(since, limit);
        const retries = store.retryRates(since, limit);

        // Two calls to /items/1 and /items/2 are one endpoint. Collapsed here
        // rather than in SQL because it needs a regex, and grouping on the raw
        // URL first keeps the row count down on the way out of the database.
        const endpoints = new Map<
          string,
          { workflow: string; label: string; calls: number; total: number; worst: number; errors: number }
        >();
        for (const c of store.callHotspots(since)) {
          const label = `${c.method} ${normaliseUrl(c.url)}`;
          const key = `${c.workflow} ${label}`;
          const found = endpoints.get(key);
          if (found) {
            found.calls += c.calls;
            found.total += c.total;
            found.worst = Math.max(found.worst, c.worst);
            found.errors += c.errors;
          } else {
            endpoints.set(key, {
              workflow: c.workflow,
              label,
              calls: c.calls,
              total: c.total,
              worst: c.worst,
              errors: c.errors,
            });
          }
        }
        const top = [...endpoints.values()].sort((a, b) => b.total - a.total).slice(0, limit);

        const out: string[] = [`hotspots over ${hours}h`];
        if (steps.length > 0) {
          out.push("\nSLOWEST STEPS by total time (count, total, avg, worst, failed)");
          out.push(
            table(
              steps.map((h) => [
                h.workflow,
                h.name,
                `${h.runs}x`,
                duration(h.total),
                duration(Math.round(h.total / h.runs)),
                duration(h.worst),
                h.failed > 0 ? `${h.failed} failed` : "",
              ]),
            ),
          );
        }
        if (top.length > 0) {
          out.push("\nSLOWEST HTTP ENDPOINTS by total time (count, total, avg, worst, errors)");
          out.push(
            table(
              top.map((e) => [
                e.workflow,
                firstLine(e.label, 60),
                `${e.calls}x`,
                duration(e.total),
                duration(Math.round(e.total / e.calls)),
                duration(e.worst),
                e.errors > 0 ? `${e.errors} 4xx/5xx` : "",
              ]),
            ),
          );
        }
        if (retries.length > 0) {
          out.push("\nRETRIES (invisible in the run list — a run that failed twice then");
          out.push("succeeded is one green row; `extra` is the attempts that cost you)");
          out.push(
            table(
              retries.map((r) => [
                r.workflow,
                `${r.retried}/${r.runs} runs retried`,
                `${r.extra} extra attempts`,
                r.avg_ms === null ? "" : `avg ${duration(Math.round(r.avg_ms))}`,
              ]),
            ),
          );
        }
        return out.length === 1 ? `Nothing recorded in the last ${hours}h.` : out.join("\n");
      },
    },

    {
      name: "trend",
      scope: "read",
      description:
        "Runs per day, and which workflows went quiet - the failure no error reports.",
      inputSchema: {
        type: "object",
        properties: {
          workflow: { type: "string", description: "One workflow, or omit for all." },
          days: { type: "number", description: "Default 14, max 90." },
        },
        additionalProperties: false,
      },
      run(args) {
        const days = num(args, "days", 14, 2, 90);
        const only = str(args, "workflow");
        const since = Date.now() - days * 86_400_000;
        const rows = store.dailyCounts(since, only);
        if (rows.length === 0) return `No runs in the last ${days} days.`;

        const today = Math.floor(Date.now() / 86_400_000);
        const perDay = new Map<number, { ok: number; failed: number; other: number }>();
        const perWorkflow = new Map<string, Map<number, number>>();
        for (const r of rows) {
          const day = perDay.get(r.day) ?? { ok: 0, failed: 0, other: 0 };
          if (r.status === "success") day.ok += r.count;
          else if (r.status === "failed") day.failed += r.count;
          else day.other += r.count;
          perDay.set(r.day, day);

          const wf = perWorkflow.get(r.workflow) ?? new Map<number, number>();
          wf.set(r.day, (wf.get(r.day) ?? 0) + r.count);
          perWorkflow.set(r.workflow, wf);
        }

        const out: string[] = [
          only ? `${only}, last ${days} days (UTC)` : `all workflows, last ${days} days (UTC)`,
        ];
        const dayRows: string[][] = [];
        for (let d = today - days + 1; d <= today; d++) {
          const v = perDay.get(d);
          dayRows.push([
            new Date(d * 86_400_000).toISOString().slice(0, 10),
            v ? String(v.ok + v.failed + v.other) : "0",
            v && v.failed > 0 ? `${v.failed} failed` : "",
          ]);
        }
        out.push(table(dayRows));

        // The half-over-half comparison is the whole point of this tool. A
        // workflow that stopped being called does not fail, does not alert and
        // does not appear anywhere else — it simply goes quiet, and quiet is
        // indistinguishable from healthy in every other view here.
        if (!only && days >= 4) {
          const half = today - Math.floor(days / 2);
          const dropped: string[][] = [];
          for (const [name, byDay] of perWorkflow) {
            let before = 0;
            let after = 0;
            for (const [day, n] of byDay) (day < half ? (before += n) : (after += n));
            if (before >= 4 && after * 2 < before) {
              dropped.push([
                name,
                `${before} -> ${after}`,
                after === 0 ? "stopped entirely" : `down ${Math.round((1 - after / before) * 100)}%`,
              ]);
            }
          }
          if (dropped.length > 0) {
            out.push("\nDROPPED OFF (first half of the window vs second)");
            out.push(table(dropped));
          }
        }
        return out.join("\n");
      },
    },

    {
      name: "config",
      scope: "read",
      description:
        "Secrets, variables and credentials: which are set, connected, and how each last tested. " +
        "Never returns secret values.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run() {
        const out: string[] = [];

        const creds = listCredentials();
        if (creds.length > 0) {
          out.push("CREDENTIALS (platform, state, last test)");
          out.push(
            table(
              creds.map((c) => {
                const ref = credentialRef(c.row.provider, c.row.id);
                const state =
                  c.provider === undefined
                    ? "provider gone"
                    : c.missing.length > 0
                      ? `missing ${c.missing.join(", ")}`
                      : "connected";
                const test =
                  c.row.tested_at === null
                    ? "never tested"
                    : `${c.row.test_ok ? "ok" : "FAILED"} ${ago(c.row.tested_at)}` +
                      (c.row.test_ok ? "" : `: ${firstLine(c.row.test_detail ?? "", 50)}`);
                return [ref, state, test];
              }),
            ),
          );
        }

        // Names and sources only. The value side of this store has no read
        // route anywhere in the app, and an MCP tool is not the place to open
        // the first one.
        const stored = new Set(storedSecretKeys());
        const rows = store.secretMeta();
        if (rows.length > 0) {
          out.push(`\nSECRETS (${rows.length} in the store, encryption ${secretStoreReady() ? "ready" : "NOT READY"})`);
          out.push(
            table(
              rows.map((r) => [
                r.key,
                stored.has(r.key) ? "readable" : "UNREADABLE — wrong master key?",
                r.owner ? `field of ${r.owner}` : "",
                ago(r.updated_at),
              ]),
            ),
          );
        }

        // Variables, unlike secrets, are shown with their values — that is the
        // entire reason the two stores are separate, and src/core/variables.ts
        // refuses anything that looks like a credential at the door.
        const vars = listVariables();
        if (vars.length > 0) {
          out.push("\nVARIABLES (configuration, deliberately not secret)");
          out.push(
            table(
              vars.map((v) => [v.key, firstLine(v.value, 40), firstLine(v.note ?? "", 40)]),
            ),
          );
        }

        return out.length > 0 ? out.join("\n").trimStart() : "Nothing configured in the store.";
      },
    },

    {
      name: "test_credential",
      scope: "read",
      description:
        "Run a credential's connection test and report what the platform said.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", description: "e.g. notion, telegram, monday." },
          id: { type: "string", description: "The credential's name, e.g. the-mantra." },
        },
        required: ["provider", "id"],
        additionalProperties: false,
      },
      async run(args) {
        const provider = str(args, "provider");
        const id = str(args, "id");
        if (!provider || !id) throw new Error("`provider` and `id` are both required.");
        const result = await testCredential(provider, id);
        return (
          `${credentialRef(provider, id)}: ${result.ok ? "OK" : "FAILED"}\n` +
          (result.detail ?? "(no detail)")
        );
      },
    },

    {
      name: "inbox",
      scope: "read",
      description:
        "Webhook deliveries accepted but never finished. Steady state is empty.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Default 20, max 100." } },
        additionalProperties: false,
      },
      run(args) {
        const limit = num(args, "limit", 20, 1, 100);
        const counts = store.inboxCounts();
        const out = [
          "inbox: " +
            (["pending", "done", "abandoned"] as const)
              .map((k) => `${counts[k] ?? 0} ${k}`)
              .join(", "),
        ];
        for (const status of ["pending", "abandoned"] as const) {
          const rows = store.inboxByStatus(status, limit);
          if (rows.length === 0) continue;
          out.push(`\n${status.toUpperCase()} (${rows.length})`);
          out.push(
            table(
              rows.map((d) => [
                short(d.id),
                d.workflow,
                ago(d.received_at),
                d.run_id ? `run ${short(d.run_id)}` : "no run",
              ]),
            ),
          );
        }
        return out.length === 1 ? out[0]! + " — nothing stuck." : out.join("\n");
      },
    },

    /* ------------------------------------------------------------ writes */

    {
      name: "set_variable",
      scope: "write",
      description:
        "Set a configuration variable (board ids, thresholds). Refuses anything secret-shaped.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "UPPER_SNAKE_CASE." },
          value: { type: "string" },
          note: { type: "string", description: "What it is for." },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
      run(args) {
        const key = str(args, "key");
        const value = args["value"];
        if (!key || typeof value !== "string") {
          throw new Error("`key` and `value` (a string) are both required.");
        }
        // setVariable throws on a name or value that reads like a credential.
        // That guard is the reason this tool can exist at all, so the message
        // is passed straight through rather than reworded.
        setVariable(key, value, str(args, "note") ?? null);
        return `${key} set. It overrides any .env value of the same name, with no restart.`;
      },
    },

    {
      name: "clear_rejections",
      scope: "write",
      description: "Zero a workflow's rejection counters, once the cause is fixed.",
      inputSchema: {
        type: "object",
        properties: { workflow: { type: "string" } },
        required: ["workflow"],
        additionalProperties: false,
      },
      run(args) {
        const wf = needWorkflow(args);
        const gone = store.clearRejections(wf.name);
        return gone > 0
          ? `Cleared ${gone} rejection row(s) for ${wf.name}.`
          : `${wf.name} had no rejections to clear.`;
      },
    },



    {
      name: "trigger",
      scope: "write",
      description:
        "SIDE EFFECTS: runs a workflow now, for real - it sends whatever it sends.",
      inputSchema: {
        type: "object",
        properties: {
          workflow: { type: "string" },
          input: { type: "object", description: "Trigger payload. Default {}." },
        },
        required: ["workflow"],
        additionalProperties: false,
      },
      async run(args) {
        const wf = needWorkflow(args);
        const given = args["input"];
        const input = typeof given === "object" && given !== null ? given : {};
        const outcome = await runWorkflow(wf, { trigger: "manual", input });
        return outcomeLine(
          `triggered ${wf.name}`,
          outcome.runId,
          outcome.status,
          outcome.error?.message ?? null,
        );
      },
    },

    {
      name: "replay",
      scope: "write",
      description:
        "SIDE EFFECTS: re-runs a past run on its original input with a FRESH checkpoint key - " +
        "every step runs again, so whatever it posted or sent, it posts or sends again.",
      inputSchema: {
        type: "object",
        properties: { run_id: RUN_ID },
        required: ["run_id"],
        additionalProperties: false,
      },
      async run(args) {
        const target = needRun(args);
        const plan = planReplay(registry, target.id);
        if ("error" in plan) throw new Error(plan.error);
        const outcome = await runWorkflow(plan.wf, {
          trigger: "manual",
          input: plan.input,
          replayedFrom: plan.run.id,
        });
        return outcomeLine(
          `replayed ${short(plan.run.id)} (${plan.wf.name})`,
          outcome.runId,
          outcome.status,
          outcome.error?.message ?? null,
        );
      },
    },

    {
      name: "resume",
      scope: "write",
      description:
        "SIDE EFFECTS, fewer than replay: the run's own input again, but the same checkpoint " +
        "key, so steps that already succeeded are reused not repeated. The tool for a run " +
        "that died halfway.",
      inputSchema: {
        type: "object",
        properties: { run_id: RUN_ID },
        required: ["run_id"],
        additionalProperties: false,
      },
      async run(args) {
        const target = needRun(args);
        const wf = registry.get(target.workflow);
        if (!wf) throw new Error(`Workflow "${target.workflow}" no longer exists`);
        const outcome = await runWorkflow(wf, {
          trigger: "manual",
          checkpointKey: target.checkpoint_key ?? target.id,
          resumedFrom: target.id,
        });
        return outcomeLine(
          `resumed ${short(target.id)} (${wf.name})`,
          outcome.runId,
          outcome.status,
          outcome.error?.message ?? null,
        );
      },
    },

    {
      name: "set_paused",
      scope: "write",
      description:
        "Stop or restart a workflow's triggers. Only ever subtracts: resuming one whose file says " +
        "enabled:false leaves it off - the file is the authority.",
      inputSchema: {
        type: "object",
        properties: {
          workflow: { type: "string" },
          paused: { type: "boolean", description: "true pauses, false resumes." },
          note: { type: "string", description: "Why - shown on the dashboard." },
        },
        required: ["workflow", "paused"],
        additionalProperties: false,
      },
      run(args) {
        const wf = needWorkflow(args);
        if (bool(args, "paused", true)) {
          if (!pause(wf, str(args, "note") ?? null)) {
            return (
              `${wf.name} is already disabled in workflows/${wf.file} (enabled: false). ` +
              `There is nothing for a pause to subtract from.`
            );
          }
          unscheduleWorkflow(wf.name);
          return `${wf.name} paused. Its triggers are down until it is resumed.`;
        }
        resume(wf.name);
        if (!isEnabled(wf)) {
          return (
            `${wf.name} unpaused, but it stays off: workflows/${wf.file} says enabled: false. ` +
            `Change the file to turn it on.`
          );
        }
        scheduleWorkflow(wf);
        const next = nextRunFor(wf.name);
        return `${wf.name} resumed.` + (next ? ` Next run in ${until(next.getTime())}.` : "");
      },
    },
  ];
}

/* ------------------------------------------------------------ prompts */

/**
 * Prompts are the other half of MCP that clients actually use: each one shows
 * up in Claude Code as a slash command. They are canned *questions*, not tools
 * — the text below is handed to the model as if you had typed it, and the
 * model then calls whichever tools it needs.
 *
 * They are cheap in a way tools are not. A tool description is re-sent on
 * every turn; a prompt is fetched only when somebody runs it. So the routines
 * worth writing down go here rather than becoming another tool.
 */
interface McpPrompt {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  render(args: Record<string, string>): string;
}

const PROMPTS: McpPrompt[] = [
  {
    name: "triage",
    description: "Morning check: what broke, what is stuck, what needs a person.",
    arguments: [
      { name: "hours", description: "Window in hours. Default 24.", required: false },
    ],
    render: (a) => {
      const hours = a["hours"] ?? "24";
      return (
        `Triage the automator runner over the last ${hours} hours.\n\n` +
        `1. Call \`overview\` with hours=${hours}.\n` +
        `2. For anything failing, call \`failures\` and then read the worst run with \`run\`.\n` +
        `3. Call \`inbox\` to check nothing was accepted and never finished.\n` +
        `4. If a workflow is blocked, call \`config\` to see which credential, and ` +
        `\`test_credential\` to find out what the platform actually says.\n\n` +
        `Then tell me, in plain language: what is broken, what it is costing, and what ` +
        `needs me specifically. Do not trigger, replay or resume anything without asking.`
      );
    },
  },
  {
    name: "diagnose",
    description: "Work out why one workflow is failing, end to end.",
    arguments: [{ name: "workflow", description: "The workflow name.", required: true }],
    render: (a) => {
      const wf = a["workflow"] ?? "";
      return (
        `Work out why "${wf}" is failing.\n\n` +
        `Start with \`failures\`, then \`runs\` with workflow="${wf}", then \`run\` on the ` +
        `most recent failure — read its steps and HTTP calls, not just the error. Check ` +
        `\`rejections\` in case deliveries are being turned away before a run exists, and ` +
        `\`config\` in case a credential is the cause.\n\n` +
        `The workflow's source is in this repository under workflows/ — read the file. ` +
        `Then tell me the cause and the smallest fix. Do not change anything yet.`
      );
    },
  },
  {
    name: "improve",
    description: "Find what is worth fixing: slow steps, wasted retries, workflows gone quiet.",
    arguments: [
      { name: "days", description: "How far back to look. Default 14.", required: false },
    ],
    render: (a) => {
      const days = a["days"] ?? "14";
      const hours = String(Number(days) * 24 || 336);
      return (
        `Find what is worth improving in the automator runner.\n\n` +
        `1. \`hotspots\` with hours=${hours} — where time and retries actually go.\n` +
        `2. \`trend\` with days=${days} — pay attention to the DROPPED OFF section, ` +
        `a workflow that went quiet is a failure nothing else reports.\n` +
        `3. \`failures\` over the same window, for recurring causes rather than one-offs.\n\n` +
        `Read the relevant workflow files in workflows/ before suggesting anything. ` +
        `Rank what you find by what it costs me, not by how easy it is to fix, and say ` +
        `plainly when something is not worth fixing.`
      );
    },
  },
];

/* ----------------------------------------------------------- protocol */

/** Versions this speaks. An unknown one is answered with the newest of these. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface Rpc {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: Rpc["id"], code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
});

/**
 * The MCP router, mounted at /mcp. Registered before the dashboard's basic
 * auth and carrying its own bearer check, the same way /hooks does — an agent
 * authenticates as itself, not as whoever has the dashboard password.
 */
export function createMcpRouter(registry: Registry): Hono<{ Variables: { mcp: McpIdentity } }> {
  // The identity rides on the context rather than being resolved twice, so the
  // Hono instance is typed with it.
  const app = new Hono<{ Variables: { mcp: McpIdentity } }>();
  const tools = buildTools(registry);
  const byName = new Map(tools.map((t) => [t.name, t]));

  if (!mcpEnabled()) {
    log.warn(
      "No MCP token exists — /mcp is closed. Create one on the dashboard (MCP tab), " +
        "or set MCP_TOKEN.",
    );
  }

  app.use("*", async (c, next) => {
    // Re-checked per request rather than at boot: the first token is minted on
    // a running server, and an endpoint that stayed closed until a restart
    // would make the dashboard form look broken.
    if (!mcpEnabled()) {
      return c.json(
        rpcError(
          null,
          -32001,
          "MCP is disabled on this server: no token exists. Create one on the dashboard.",
        ),
        503,
      );
    }
    const presented =
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      c.req.header("x-mcp-token") ??
      "";
    const identity = identify(presented);
    if (!identity) {
      return c.json(rpcError(null, -32001, "Unauthorized"), 401, {
        "WWW-Authenticate": "Bearer",
      });
    }
    // A token minted for the data tables is refused here outright, rather than
    // being let in with a narrowed tool list. This endpoint can trigger and
    // replay production workflows; a credential created to write expense rows
    // has no business reaching it, and until the two audiences existed it
    // silently could.
    if (!mayUseEndpoint(identity, "ops")) {
      return c.json(
        rpcError(
          null,
          -32001,
          `"${identity.label}" is a data-table token. This endpoint is the runner's ` +
            "operations MCP — connect this token to /mcp/tables instead.",
        ),
        403,
      );
    }
    c.set("mcp", identity);
    // Every authenticated request, not just the handshake: "last used" is the
    // only thing standing in for a connection here, so it has to move whenever
    // the token actually does something.
    noteUse(identity, null);
    return next();
  });

  /** The tools this caller may see. A read token is not shown the write ones. */
  const visibleTo = (identity: McpIdentity) =>
    identity.scope === "full" ? tools : tools.filter((t) => t.scope === "read");

  async function dispatch(msg: Rpc, identity: McpIdentity): Promise<object | null> {
    const { id, method, params } = msg;
    // A notification carries no id and gets no reply — including
    // notifications/initialized, the only one a client sends here.
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize": {
        const asked = String(params?.["protocolVersion"] ?? "");
        // The handshake is the only message carrying a client name, so this is
        // the one chance to record who is on the other end of this token —
        // which is the whole of what the dashboard can say about "connected".
        const info = params?.["clientInfo"] as { name?: string; version?: string } | undefined;
        noteUse(
          identity,
          info?.name ? `${info.name}${info.version ? ` ${info.version}` : ""}`.slice(0, 80) : null,
        );
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { name: "automator", version: "0.1.0" },
            instructions:
              "Operational data for a code-first automation runner. Call `overview` first - it " +
              "answers 'what is wrong' in one result. Prefer `failures` over listing runs; " +
              "`run` is the only expensive call. Workflow source is not served here: the " +
              "workflows are TypeScript files in the repository. Tools marked SIDE EFFECTS run " +
              "production workflows for real - confirm with the user before calling one.",
          },
        };
      }
      case "ping":
        return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            tools: visibleTo(identity).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };
      case "tools/call": {
        const name = String(params?.["name"] ?? "");
        const tool = byName.get(name);
        if (!tool) return rpcError(id, -32602, `Unknown tool "${name}"`);
        // Hidden from the list is not the same as refused, and both are needed:
        // a client could have cached the list from a full-scope token.
        if (tool.scope === "write" && identity.scope !== "full") {
          return {
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              content: [
                {
                  type: "text",
                  text:
                    `"${name}" needs a full-scope token. This one ("${identity.label}") is ` +
                    `read-only — it can look at everything and change nothing.`,
                },
              ],
              isError: true,
            },
          };
        }
        const args = (params?.["arguments"] as Record<string, unknown> | undefined) ?? {};
        try {
          const text = await tool.run(args);
          return {
            jsonrpc: "2.0",
            id: id ?? null,
            // Capped even when the tool already capped itself: the ceiling is
            // a property of the transport, not a promise each tool remembers.
            result: { content: [{ type: "text", text: clip(text, HARD_MAX_BYTES) }] },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`MCP tool ${name} failed: ${message}`);
          // A tool error is a result, not a protocol error — the model has to
          // be able to read it and try something else.
          return {
            jsonrpc: "2.0",
            id: id ?? null,
            result: { content: [{ type: "text", text: message }], isError: true },
          };
        }
      }
      case "prompts/list":
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            prompts: PROMPTS.map((p) => ({
              name: p.name,
              description: p.description,
              arguments: p.arguments,
            })),
          },
        };
      case "prompts/get": {
        const name = String(params?.["name"] ?? "");
        const prompt = PROMPTS.find((p) => p.name === name);
        if (!prompt) return rpcError(id, -32602, `Unknown prompt "${name}"`);
        const given = (params?.["arguments"] as Record<string, string> | undefined) ?? {};
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            description: prompt.description,
            messages: [
              { role: "user", content: { type: "text", text: prompt.render(given) } },
            ],
          },
        };
      }
      default:
        return isNotification ? null : rpcError(id, -32601, `Unknown method "${method}"`);
    }
  }

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }

    const identity = c.get("mcp");
    if (Array.isArray(body)) {
      const replies = (
        await Promise.all(body.map((m) => dispatch(m as Rpc, identity)))
      ).filter((r): r is object => r !== null);
      return replies.length === 0 ? c.body(null, 202) : c.json(replies);
    }

    const reply = await dispatch(body as Rpc, identity);
    return reply === null ? c.body(null, 202) : c.json(reply);
  });

  // No server-initiated stream and no session to end. Both are optional in the
  // Streamable HTTP transport, and 405 is how it says "not offered here".
  app.get("/", (c) => c.json(rpcError(null, -32000, "This endpoint is POST-only"), 405));
  app.delete("/", (c) => c.json(rpcError(null, -32000, "Stateless: no session to end"), 405));

  return app;
}
