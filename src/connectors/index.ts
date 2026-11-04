import { z } from "zod";
import { credentialRef, credentialValues, getCredential } from "../core/credentials.ts";
import { log } from "../core/logger.ts";
import { isScope, type McpGrant, type McpIdentity } from "../core/mcp-tokens.ts";
import { agentByName, agentLog, allAgents, type LoadedAgent } from "../core/agents.ts";
import type { Connector, ConnectorPrompt, ConnectorTool } from "./types.ts";
import { telegramUser } from "./telegram-user.ts";

/**
 * Every connector this build has. Platform connectors are listed here; the
 * runner's own (operations, data tables) are added at boot with
 * `registerConnector`, because they are built from the loaded workflows.
 * The token form, grant validation and `/mcp`'s tool list all derive from
 * this list.
 */
const connectors: Connector<any>[] = [];

/** MCP's own rule for a tool name. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Adds a connector — the built-in ones, at boot. Replaces one with the same id. */
export function registerConnector(c: Connector<any>): void {
  for (const t of c.tools) {
    const name = c.prefix ? `${c.prefix}_${t.name}` : t.name;
    if (!TOOL_NAME.test(name)) throw new Error(`Connector "${c.id}": "${name}" is not a valid MCP tool name`);
  }
  const others = connectors.filter((k) => k.id !== c.id);
  // Bare names are a shared namespace: two built-ins that both had a `rows`
  // would make one of them unreachable on a token holding both.
  const bare = new Set(others.filter((k) => !k.prefix).flatMap((k) => k.tools.map((t) => t.name)));
  if (!c.prefix) {
    const clash = c.tools.find((t) => bare.has(t.name));
    if (clash) throw new Error(`Connector "${c.id}": tool "${clash.name}" is already another connector's`);
  }
  connectors.splice(0, connectors.length, ...others, c);
}

registerConnector(telegramUser);

/**
 * Every connector a token can pick among, built-in first, in the order the
 * token form shows them. Agents are not among them — see `agentConnectors`.
 */
export function allConnectors(): readonly Connector<any>[] {
  return [...connectors].sort((a, b) => Number(Boolean(a.provider)) - Number(Boolean(b.provider)));
}

/**
 * A loaded agent as a connector: its tools under their own names, no limits,
 * no credential. Built per loaded agent object, so a reload — which loads a
 * new one — is served from its next request.
 */
const asConnector = new WeakMap<LoadedAgent, Connector<Record<string, never>>>();
function agentConnector(agent: LoadedAgent): Connector<Record<string, never>> {
  let c = asConnector.get(agent);
  if (c) return c;
  const log = agentLog(agent.name);
  c = {
    id: agent.name,
    label: agent.label,
    blurb: agent.description,
    prefix: "",
    agent: true,
    // An agent reads somebody's data; its errors can quote it. A tool that
    // has something safe to say throws a ToolRefusal, whose logAs is logged.
    logErrors: false,
    instructions: agent.instructions,
    limits: {
      schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
      fields: [],
      describe: () => "",
    },
    tools: agent.tools.map((t) => ({
      name: t.name,
      description: t.description,
      access: t.access,
      inputSchema: t.inputSchema,
      run: (args, call) => t.run(args, { label: call.token.label, log, signal: call.signal }),
    })),
  };
  asConnector.set(agent, c);
  return c;
}

/** The loaded agents, as connectors — what an agent token can be for. */
export function agentConnectors(): Connector<any>[] {
  return allAgents()
    .filter((a) => !connectors.some((k) => k.id === a.name))
    .map(agentConnector);
}

export function connectorFor(id: string): Connector<any> | undefined {
  const own = connectors.find((c) => c.id === id);
  if (own) return own;
  const agent = agentByName(id);
  return agent ? agentConnector(agent) : undefined;
}

/** `ops`, or `telegram_user:me` — how a grant is named on the tab and in a log line. */
export function grantRef(grant: Pick<McpGrant, "connector" | "credential">): string {
  return grant.credential ? credentialRef(grant.connector, grant.credential) : grant.connector;
}

/**
 * Checks a grant someone is about to mint and returns it normalised: the
 * connector exists, its credential exists when it needs one, the limits parse
 * and fit the server as it is. Throws a sentence that can go onto the form.
 */
export function validateGrant(input: {
  connector?: unknown;
  /** The old name for `connector`, still accepted from the API. */
  provider?: unknown;
  credential?: unknown;
  access?: unknown;
  limits?: unknown;
}): McpGrant {
  const id = String(input.connector ?? input.provider ?? "");
  const connector = connectorFor(id);
  if (!connector) {
    const known = [...connectors.map((c) => c.id), ...agentConnectors().map((c) => c.id)];
    throw new Error(`No connection called "${id}" — there are ${known.join(", ")}`);
  }
  let credential: string | undefined;
  if (connector.provider) {
    credential = String(input.credential ?? "");
    if (!credential) throw new Error(`${connector.label} needs a credential — which one on the Credentials tab?`);
    if (!getCredential(connector.provider, credential)) {
      throw new Error(`No credential ${credentialRef(connector.provider, credential)} on the Credentials tab`);
    }
  }
  const access = input.access ?? "read";
  if (!isScope(access)) throw new Error("A connection's access is read or full");
  const ref = grantRef({ connector: id, credential });
  const parsed = connector.limits.schema.safeParse(input.limits ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${ref}: ${issue?.path.length ? `${issue.path.join(".")} — ` : ""}${issue?.message ?? "limits are not valid"}`,
    );
  }
  try {
    connector.limits.check?.(parsed.data);
  } catch (err) {
    throw new Error(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    connector: id,
    ...(credential ? { credential } : {}),
    access,
    limits: parsed.data as Record<string, unknown>,
  };
}

/**
 * Checks a whole token's worth of grants: each one by `validateGrant`, and
 * that a token for an agent is for that agent alone. An agent is an
 * application with its own rules, not a capability to mix with operations
 * or an account: a chat that holds its tools and the runner's would carry
 * both on every turn, and its tool names are not prefixed, so two in one
 * token could collide.
 */
export function validateGrants(inputs: Parameters<typeof validateGrant>[0][]): McpGrant[] {
  const grants = inputs.map(validateGrant);
  if (grants.length === 0) throw new Error("Tick at least one thing this token can use.");
  const agents = grants.filter((g) => connectorFor(g.connector)?.agent);
  if (agents.length && grants.length > 1) {
    throw new Error(
      `A token for an agent (${agents.map((g) => g.connector).join(", ")}) is for that agent alone — ` +
        "make a separate token for anything else.",
    );
  }
  return grants;
}

/** Whether a token's grants make it an agent's token — and which agent. */
export function agentOf(grants: McpGrant[]): string | null {
  return grants.length === 1 && connectorFor(grants[0]!.connector)?.agent ? grants[0]!.connector : null;
}

/**
 * A limit list as a person types it: comma- or newline-separated. Not spaces,
 * because a folder called "Client work" is one name.
 */
export function splitList(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[,\n]/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** One line for the MCP tab: "telegram_user:me · read · folder REKA". */
export function describeGrant(grant: McpGrant): string {
  const connector = connectorFor(grant.connector);
  const parsed = connector?.limits.schema.safeParse(grant.limits);
  const limits = !connector
    ? "not in this build"
    : parsed?.success
      ? connector.limits.describe(parsed.data)
      : "limits no longer valid";
  return [grantRef(grant), grant.access, limits].filter(Boolean).join(" · ");
}

/** A tool as /mcp serves it — already named, already bound to its grant. */
export interface GrantTool {
  name: string;
  description: string;
  scope: "read" | "write";
  inputSchema: ConnectorTool<unknown>["inputSchema"];
  /** The connector it came from. */
  connector: string;
  /**
   * False for a write tool on a read grant: left out of the tool list, and
   * refused with a sentence if a client calls it from a list it cached.
   */
  allowed: boolean;
  /** Whether its failures may be logged with their message. */
  logErrors: boolean;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

/**
 * The tools a token's grants bring, named and bound.
 *
 * Named `<prefix>_<tool>` — `telegram_history` — or bare for a built-in.
 * When one token holds two grants of the same connector (two Telegram
 * accounts), the credential's name goes in the middle,
 * `telegram_work_history`, so the model picks the account by the tool it
 * calls. A grant that no longer fits its connector brings no tools and a
 * warning rather than being read loosely.
 *
 * `only` narrows to one connector — what the old /mcp/tables path serves.
 */
export function grantTools(identity: McpIdentity, only?: string): GrantTool[] {
  const tools: GrantTool[] = [];
  const grants = only ? identity.grants.filter((g) => g.connector === only) : identity.grants;
  const perConnector = new Map<string, number>();
  for (const g of grants) perConnector.set(g.connector, (perConnector.get(g.connector) ?? 0) + 1);

  for (const grant of grants) {
    const connector = connectorFor(grant.connector);
    if (!connector) {
      log.warn(`MCP token "${identity.label}": no connector "${grant.connector}" — that grant is ignored`);
      continue;
    }
    const parsed = connector.limits.schema.safeParse(grant.limits);
    if (!parsed.success) {
      log.warn(
        `MCP token "${identity.label}": ${grantRef(grant)} has limits this build cannot read — ` +
          "that grant is ignored until the token is changed",
      );
      continue;
    }
    const twice = (perConnector.get(grant.connector) ?? 0) > 1 && grant.credential;
    const prefix = twice
      ? `${connector.prefix || connector.id}_${grant.credential!.replace(/[^a-zA-Z0-9]+/g, "_")}`
      : connector.prefix;

    for (const tool of connector.tools) {
      // An in-process token (an agent's profile) may list and call only its
      // own tools: left out here, a call to another is "Unknown tool".
      const name = (prefix ? `${prefix}_${tool.name}` : tool.name).slice(0, 64);
      if (identity.tools && !identity.tools.includes(name)) continue;
      tools.push({
        name,
        description: tool.description,
        scope: tool.access,
        inputSchema: tool.inputSchema,
        connector: connector.id,
        allowed: tool.access === "read" || grant.access === "full",
        logErrors: connector.logErrors === true,
        run: async (args, signal) =>
          tool.run(args, {
            limits: parsed.data,
            // Read per call, so a re-login on the Credentials tab is picked
            // up without a restart, and a deleted credential stops at once.
            credential:
              connector.provider && grant.credential ? credentialValues(connector.provider, grant.credential) : {},
            grant,
            token: { label: identity.label, id: identity.id },
            signal,
          }),
      });
    }
  }
  return tools;
}

/** The tools a set of grants brings, for the dashboard's token page. */
export function grantToolList(grants: McpGrant[]): { name: string; description: string; write: boolean }[] {
  return grantTools({ scope: "full", label: "dashboard", tables: null, audiences: ["connections"], grants }).map(
    (t) => ({ name: t.name, description: t.description, write: t.scope === "write" }),
  );
}

/** What the server tells the client about its connections, for `initialize`. */
export function grantInstructions(identity: McpIdentity, only?: string): string {
  const lines: string[] = [];
  for (const grant of identity.grants) {
    if (only && grant.connector !== only) continue;
    const connector = connectorFor(grant.connector);
    if (!connector) continue;
    const parsed = connector.limits.schema.safeParse(grant.limits);
    if (!parsed.success) continue;
    const text =
      typeof connector.instructions === "function" ? connector.instructions(parsed.data) : connector.instructions;
    if (!lines.includes(text)) lines.push(text);
  }
  return lines.join(" ");
}

/** The prompts a token's grants bring — the operations routines, for an operations grant. */
export function grantPrompts(identity: McpIdentity, only?: string): ConnectorPrompt[] {
  const ids = new Set(identity.grants.filter((g) => !only || g.connector === only).map((g) => g.connector));
  return [...ids].flatMap((id) => connectorFor(id)?.prompts ?? []);
}
