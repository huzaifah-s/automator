import { credentialRef, credentialValues, getCredential } from "../core/credentials.ts";
import { log } from "../core/logger.ts";
import { isScope, type McpGrant, type McpIdentity } from "../core/mcp-tokens.ts";
import type { Connector, ConnectorTool } from "./types.ts";
import { telegramUser } from "./telegram-user.ts";

/**
 * Every connector this build has. Adding a platform's MCP tools is a file in
 * this folder and a line here — the dashboard's form, the token's validation
 * and `/mcp`'s tool list are all derived from it.
 */
export const CONNECTORS: readonly Connector<any>[] = [telegramUser];

/** MCP's own rule for a tool name. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

for (const c of CONNECTORS) {
  for (const t of c.tools) {
    if (!TOOL_NAME.test(`${c.prefix}_${t.name}`)) {
      throw new Error(`Connector "${c.provider}": "${c.prefix}_${t.name}" is not a valid MCP tool name`);
    }
  }
}

export function connectorFor(provider: string): Connector<any> | undefined {
  return CONNECTORS.find((c) => c.provider === provider);
}

/**
 * Checks a grant someone is about to mint and returns it normalised: the
 * connector exists, the credential exists on the Credentials tab, and the
 * limits parse. Throws a sentence that can go straight onto the form.
 */
export function validateGrant(input: {
  provider: unknown;
  credential: unknown;
  access?: unknown;
  limits?: unknown;
}): McpGrant {
  const provider = String(input.provider ?? "");
  const credential = String(input.credential ?? "");
  const connector = connectorFor(provider);
  if (!connector) {
    throw new Error(
      `"${provider}" has no MCP tools — connections exist for ${CONNECTORS.map((c) => c.provider).join(", ")}`,
    );
  }
  if (!getCredential(provider, credential)) {
    throw new Error(`No credential ${credentialRef(provider, credential)} on the Credentials tab`);
  }
  const access = input.access ?? "read";
  if (!isScope(access)) throw new Error("A connection's access is read or full");
  const parsed = connector.limits.schema.safeParse(input.limits ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${credentialRef(provider, credential)}: ${issue?.path.length ? `${issue.path.join(".")} — ` : ""}` +
        (issue?.message ?? "limits are not valid"),
    );
  }
  return { provider, credential, access, limits: parsed.data as Record<string, unknown> };
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
  const connector = connectorFor(grant.provider);
  const parsed = connector?.limits.schema.safeParse(grant.limits);
  const limits = parsed?.success ? connector!.limits.describe(parsed.data) : "limits no longer valid";
  return `${credentialRef(grant.provider, grant.credential)} · ${grant.access} · ${limits}`;
}

/** A tool as /mcp serves it — already named, already bound to its grant. */
export interface GrantTool {
  name: string;
  description: string;
  scope: "read" | "write";
  inputSchema: ConnectorTool<unknown>["inputSchema"];
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

/**
 * The tools a token's grants bring, named and bound.
 *
 * Named `<prefix>_<tool>` — `telegram_history`. When one token holds two
 * grants of the same platform (two Telegram accounts), the credential's name
 * goes in the middle, `telegram_work_history`, so the model picks the account
 * by the tool it calls and no tool needs a "which account" argument.
 *
 * A grant that no longer fits its connector — the connector was removed, or
 * its limits changed shape in a deploy — brings no tools and a warning,
 * rather than being read loosely. Write tools come only with `full` access.
 */
export function grantTools(identity: McpIdentity): GrantTool[] {
  const tools: GrantTool[] = [];
  const perPrefix = new Map<string, number>();
  for (const g of identity.grants) {
    const c = connectorFor(g.provider);
    if (c) perPrefix.set(c.prefix, (perPrefix.get(c.prefix) ?? 0) + 1);
  }

  for (const grant of identity.grants) {
    const connector = connectorFor(grant.provider);
    if (!connector) {
      log.warn(`MCP token "${identity.label}": no connector for ${grant.provider} — that grant is ignored`);
      continue;
    }
    const parsed = connector.limits.schema.safeParse(grant.limits);
    if (!parsed.success) {
      log.warn(
        `MCP token "${identity.label}": ${credentialRef(grant.provider, grant.credential)} has limits ` +
          `this build cannot read — that grant is ignored until the token is replaced`,
      );
      continue;
    }
    const prefix =
      (perPrefix.get(connector.prefix) ?? 0) > 1
        ? `${connector.prefix}_${grant.credential.replace(/[^a-zA-Z0-9]+/g, "_")}`
        : connector.prefix;

    for (const tool of connector.tools) {
      if (tool.access === "write" && grant.access !== "full") continue;
      const name = `${prefix}_${tool.name}`.slice(0, 64);
      tools.push({
        name,
        description: tool.description,
        scope: tool.access,
        inputSchema: tool.inputSchema,
        run: (args, signal) =>
          tool.run(args, {
            limits: parsed.data,
            // Read per call, so a re-login on the Credentials tab is picked
            // up without a restart, and a deleted credential stops at once.
            credential: credentialValues(grant.provider, grant.credential),
            grant,
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
export function grantInstructions(identity: McpIdentity): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const grant of identity.grants) {
    const connector = connectorFor(grant.provider);
    if (!connector || seen.has(connector.provider)) continue;
    seen.add(connector.provider);
    lines.push(connector.instructions);
  }
  return lines.join(" ");
}
