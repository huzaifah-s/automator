/**
 * Agents — a project's own AI agent, declared in code beside its workflows.
 *
 * An agent is an application built on the runner, not one more thing the
 * runner offers. The operations tools, the data tables and a Telegram
 * account are capabilities: a client is granted some of them. An agent is
 * a user of capabilities like those, with an API of its own — a set of
 * tools whose rules are the point ("a draft is only saved for a chat we
 * know", "nothing here can send"). Handing a model the raw tables instead
 * would delete the rules, so the tools are code, and the model only picks
 * among them.
 *
 * A file anywhere under `workflows/` whose default export is
 * `defineAgent(...)` declares one. The loader picks it up with the
 * workflows and swaps it on a reload, so editing the agent file is live
 * without a restart (its `_` helpers are not — see reload.ts).
 *
 * What the runner does with an agent:
 *
 * - **Serves it over MCP**, at the token's own `/mcp/<id>` and at
 *   `/mcp/<agent name>`, through the same router as everything else. A
 *   token minted for an agent carries one grant, the agent's, and gets
 *   exactly its tools — never the operations tools beside them.
 * - **Lets a workflow drive it in-process** (`agentTools`), for code that
 *   is its own loop and calls the tools directly.
 * - **Hands a client this process starts itself a connection**
 *   (`agentConnection`): a URL on 127.0.0.1 and a token kept in memory, for
 *   a CLI agent such as Claude Code spawned by a workflow.
 *
 * The loop that decides what to call is never here. It is whatever
 * connects: a person's Claude, a CLI a workflow spawns, or a workflow's own
 * code. This file only says what the agent can do.
 */

import { log, type Logger, createLogger } from "./logger.ts";
import { mintProcessToken } from "./mcp-tokens.ts";

/** One tool an agent offers. */
export interface AgentTool {
  /** MCP's rule: letters, digits, `_` and `-`, at most 64. Served as written. */
  name: string;
  /** One line. Every description is paid for on every turn of every chat. */
  description: string;
  /**
   * `read` tools come with any token for the agent; `write` tools only with
   * a full one, and a read token is not even shown them.
   */
  access: "read" | "write";
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: false;
  };
  run(args: Record<string, unknown>, call: AgentCall): string | Promise<string>;
}

/** What a tool is handed when it is called. */
export interface AgentCall {
  /** Who is calling — the token's label. A write records it as its author. */
  label: string;
  /** For the tool's own log lines. Never log a tool's arguments: they are often somebody's words. */
  log: Logger;
  /** Aborted when the request gives up. */
  signal: AbortSignal;
}

/**
 * A named subset of an agent's tools, for one of the things that drive it:
 * the names it may use, or every tool except some. Declared once, on the
 * agent, so the CLI's allow-list and the server's agree.
 */
export type AgentProfile = readonly string[] | { exclude: readonly string[] };

export interface AgentDef {
  /**
   * Lowercase letters, digits and dashes. It is the grant's name, and the
   * agent is also served at `/mcp/<name>`.
   */
  name: string;
  /** What the MCP tab calls it. */
  label: string;
  /** One line under the label. Say what it reads — a token for it is handed to a model. */
  description: string;
  /** The MCP server's `instructions`, sent on every handshake. */
  instructions: string;
  tools: AgentTool[];
  profiles?: Record<string, AgentProfile>;
}

export interface LoadedAgent extends AgentDef {
  /** The file it came from, relative to `workflows/`. */
  file: string;
}

/** What `defineAgent` returns — tagged so the loader can tell it from a workflow. */
export type AgentExport = AgentDef & { readonly kind: "agent" };

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Declares an agent. The default export of its file, the way
 * `defineWorkflow` is a workflow's. Checked here, so a typo in a tool name
 * or a profile stops the load rather than surfacing as "Unknown tool" in a
 * model's transcript.
 */
export function defineAgent(def: AgentDef): AgentExport {
  if (!NAME.test(def.name)) {
    throw new Error(`Agent name "${def.name}" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  // A token's own URL is /mcp/<8 hex>; an agent with a name like that would
  // shadow one.
  if (/^[0-9a-f]{8}$/.test(def.name)) throw new Error(`Agent name "${def.name}" looks like a token id`);
  const seen = new Set<string>();
  for (const t of def.tools) {
    if (!TOOL_NAME.test(t.name)) throw new Error(`Agent "${def.name}": "${t.name}" is not a valid MCP tool name`);
    if (seen.has(t.name)) throw new Error(`Agent "${def.name}": two tools are called "${t.name}"`);
    seen.add(t.name);
  }
  for (const [profile, spec] of Object.entries(def.profiles ?? {})) {
    const names = Array.isArray(spec) ? spec : (spec as { exclude: readonly string[] }).exclude;
    const unknown = names.filter((n) => !seen.has(n));
    if (unknown.length) {
      throw new Error(`Agent "${def.name}", profile "${profile}": no tool called ${unknown.join(", ")}`);
    }
  }
  return { ...def, kind: "agent" };
}

export function isAgentExport(value: unknown): value is AgentExport {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "agent";
}

/* ------------------------------------------------------------ registry */

let agents: LoadedAgent[] = [];

/** Swapped in by the loader once a whole load has succeeded — never half a set. */
export function setAgents(next: LoadedAgent[]): void {
  agents = next;
}

export function allAgents(): readonly LoadedAgent[] {
  return agents;
}

export function agentByName(name: string): LoadedAgent | undefined {
  return agents.find((a) => a.name === name);
}

/** The tool names a profile allows, or every tool when none is named. */
export function profileTools(agent: AgentDef, profile?: string): string[] {
  const all = agent.tools.map((t) => t.name);
  if (profile === undefined) return all;
  const spec = agent.profiles?.[profile];
  if (!spec) throw new Error(`Agent "${agent.name}" has no profile "${profile}"`);
  if (Array.isArray(spec)) return all.filter((n) => spec.includes(n));
  const { exclude } = spec as { exclude: readonly string[] };
  return all.filter((n) => !exclude.includes(n));
}

function loaded(name: string): LoadedAgent {
  const agent = agentByName(name);
  if (!agent) throw new Error(`No agent "${name}" is loaded`);
  return agent;
}

/* ------------------------------------------------------------- calling */

/**
 * A tool error that holds somebody's words. The model is given the whole
 * message; the log gets `logAs`, which must hold none. Any other error a
 * tool throws is logged by tool name alone.
 */
export class ToolRefusal extends Error {
  constructor(
    message: string,
    readonly logAs: string,
  ) {
    super(message);
  }
}

/** The log line for a failed agent tool: its name, who called, and a refusal's safe text — never the arguments. */
export function toolFailureLine(tool: string, label: string, err: unknown): string {
  const safe = err instanceof ToolRefusal ? `: ${err.logAs}` : "";
  return `MCP tool ${tool} failed (token "${label}")${safe}`;
}

const agentLogs = new Map<string, Logger>();
/** One logger per agent, scoped by its name. */
export function agentLog(name: string): Logger {
  let l = agentLogs.get(name);
  if (!l) agentLogs.set(name, (l = createLogger(`agent:${name}`)));
  return l;
}

/** One tool as a model is shown it. */
export interface AgentToolSpec {
  name: string;
  description: string;
  inputSchema: object;
}

/**
 * An agent's tools in-process, for a workflow that is its own loop: the
 * same functions MCP serves, with the same rule for what is logged, and
 * full access. `label` is who the rows it writes say wrote them. Resolved
 * against the agent as loaded now, so a reload is picked up on the next
 * call to this, not mid-loop.
 */
export function agentTools(
  name: string,
  opts: { label: string; profile?: string },
): {
  specs: AgentToolSpec[];
  call(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
} {
  const agent = loaded(name);
  const allowed = new Set(profileTools(agent, opts.profile));
  const tools = agent.tools.filter((t) => allowed.has(t.name));
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    specs: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    async call(tool, args) {
      const t = byName.get(tool);
      if (!t) return { text: `Unknown tool "${tool}"`, isError: true };
      try {
        const text = await t.run(args, { label: opts.label, log: agentLog(name), signal: AbortSignal.timeout(60_000) });
        return { text, isError: false };
      } catch (err) {
        log.warn(toolFailureLine(tool, opts.label, err));
        return { text: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}

const connections = new Map<string, { url: string; token: string; tools: string[]; agent: string; label: string; profile: string | null }>();

/**
 * The in-process connections minted for an agent since boot — who and with
 * which profile, never the token. For the Agents tab: they are not stored
 * anywhere else, so this is the only way to see that a workflow drives it.
 */
export function processConnections(name: string): { label: string; profile: string | null; tools: number }[] {
  return [...connections.values()]
    .filter((c) => c.agent === name)
    .map((c) => ({ label: c.label, profile: c.profile, tools: c.tools.length }));
}

/**
 * How a client this process starts itself reaches an agent over MCP: a URL
 * on 127.0.0.1 and a token minted in memory (`mintProcessToken` — never
 * stored, gone on restart), limited to the profile's tools. The limit is
 * the server's, on `tools/list` and `tools/call`, not only the client's
 * allow-list. One token per agent, label and profile for the life of the
 * process.
 */
export function agentConnection(
  name: string,
  opts: { label: string; profile?: string },
): { url: string; token: string; tools: string[] } {
  const agent = loaded(name);
  const tools = profileTools(agent, opts.profile);
  const key = `${name}\n${opts.label}\n${tools.join(",")}`;
  let conn = connections.get(key);
  if (!conn) {
    conn = {
      url: `http://127.0.0.1:${process.env.PORT ?? 3000}/mcp/${name}`,
      tools,
      agent: name,
      label: opts.label,
      profile: opts.profile ?? null,
      token: mintProcessToken({
        scope: "full",
        label: opts.label,
        tables: null,
        audiences: ["agent"],
        grants: [{ connector: name, access: "full", limits: {} }],
        tools,
      }),
    };
    connections.set(key, conn);
  }
  return { url: conn.url, token: conn.token, tools: conn.tools };
}
