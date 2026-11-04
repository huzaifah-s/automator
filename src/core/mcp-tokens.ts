/**
 * Tokens an MCP client authenticates with — minting, checking, and the record
 * of when each one was last used.
 *
 * Three decisions worth knowing before changing anything here.
 *
 * **Only the digest is stored.** A token is shown once, at the moment it is
 * created, and never again — not on the dashboard, not over the API. This
 * matches the rule the Credentials tab already follows ("no route returns a
 * value") and it means a copy of the database is not a set of working keys.
 * The cost is that losing one means replacing it, which is the correct trade
 * for a credential that takes two seconds to reissue.
 *
 * **Scope is per token, not global.** The reason to have several tokens is
 * that they are not equally trusted: the one on a phone can be `read`, the one
 * on a laptop `full`. A read token is refused the write tools *and never sees
 * them listed*, which is both safer and cheaper — a tool list is a cost paid
 * on every turn whether or not anything calls it.
 *
 * **`MCP_TOKEN` in the environment still works, and is always full scope.** It
 * is the bootstrap: the dashboard form that mints the first stored token is
 * itself reachable only if you can already get in, and a deployment that has
 * lost every token needs a way back that does not require one.
 */

import { createHash, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { store } from "./db.ts";
import { log } from "./logger.ts";
import type { McpTokenRecord } from "./types.ts";

export type McpScope = "read" | "full";

/**
 * Which endpoint a token is for.
 *
 * `scope` and this are orthogonal and it is worth being clear about the
 * difference, because "full" sounds like it covers both and does not:
 *
 *   audience — *which* server this token may talk to at all
 *   scope    — whether it may change anything once it is there
 *
 * A finance token is `tables` + `full`: it can add and correct rows in its own
 * tables, and it is refused by `/mcp` entirely, so it cannot trigger a
 * workflow or pause one. Before this existed, a token minted to write expenses
 * could do both — the table scope narrowed what it saw on `/mcp/tables` and
 * said nothing about `/mcp`, which is not what anybody minting it intended.
 */
export type McpAudience = "ops" | "tables" | "assistant" | "connections";

export const AUDIENCES: readonly McpAudience[] = ["ops", "tables", "assistant", "connections"];

/**
 * One connection a "connections" token may use: a credential from the
 * Credentials tab, how far it may go, and the connector's own limits on what
 * it may touch (src/connectors/). Which tools a grant brings, and what its
 * limits mean, is code; the grant only picks among them.
 *
 * Stored as JSON on the token's row. Validated against the connector when the
 * token is minted, and again when it is used — a connector can change shape
 * in a deploy, and a grant that no longer fits is refused rather than read
 * loosely.
 */
export interface McpGrant {
  /** The credential's platform — a key of PROVIDERS that has a connector. */
  provider: string;
  /** The credential's name on the Credentials tab. */
  credential: string;
  /** `read` gets the connector's read tools; `full` its write tools as well. */
  access: McpScope;
  /** The connector's limits, in the shape its `limits.schema` accepts. */
  limits: Record<string, unknown>;
}

export function isAudience(value: unknown): value is McpAudience {
  return AUDIENCES.includes(value as McpAudience);
}

/** Where each audience connects, for messages that send a token elsewhere. */
export const AUDIENCE_PATH: Record<McpAudience, string> = {
  ops: "/mcp",
  tables: "/mcp/tables",
  assistant: "/mcp/assistant",
  // The one endpoint everything is meant to end up on: a connections token is
  // served at /mcp next to the operations tools, not on a path of its own.
  connections: "/mcp",
};

const AUDIENCE_NAME: Record<McpAudience, string> = {
  ops: "an operations token",
  tables: "a data-table token",
  assistant: "an assistant token",
  connections: "a connections token",
};

/**
 * The refusal an endpoint gives a token minted for a different one: what it
 * is, and where it does work. Shared so three endpoints cannot drift into
 * three wordings, one of them wrong.
 */
export function wrongEndpoint(identity: McpIdentity, here: string): string {
  const its = identity.audiences[0] ?? "ops";
  return (
    `"${identity.label}" is ${AUDIENCE_NAME[its]}. This endpoint is ${here} — ` +
    `connect this token to ${identity.id ? tokenPath(identity.id) : AUDIENCE_PATH[its]} instead, ` +
    "or create one for this endpoint on the dashboard's MCP tab."
  );
}

/**
 * A stored token's own URL path: `/mcp/<id>`, whatever the token is for.
 *
 * This is the address to give a client. Every token gets a URL of its own,
 * which is what lets claude.ai hold one connector per token (it refuses two
 * connectors with the same URL), and the server serves at it whatever the
 * token is for. The shared paths — /mcp, /mcp/tables, /mcp/assistant — keep
 * working for existing clients.
 *
 * The id is not a secret. It is the same id as the dashboard's
 * /mcp-tokens/<id>, so the URL can sit in a log line, a screenshot or an
 * organisation's connector list. The token itself still travels only in the
 * Authorization header, and must be the token the path names.
 */
export function tokenPath(id: string): string {
  return `/mcp/${id}`;
}

/** Recognisable in a log line or a config file as this and nothing else. */
const PREFIX = "amcp_";

/** How much of the plaintext is kept so a row can be told from its siblings. */
const HINT_LENGTH = PREFIX.length + 6;

export function isScope(value: unknown): value is McpScope {
  return value === "read" || value === "full";
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mints a token, stores its digest, and returns the plaintext **once**. The
 * caller is the only thing that will ever see it.
 */
export function createMcpToken(
  name: string,
  scope: McpScope,
  opts: {
    /** Which endpoint it is for. Defaults to "ops", the original behaviour. */
    audience?: McpAudience;
    /**
     * Data tables this token may reach on /mcp/tables. Empty or undefined
     * means every table.
     *
     * Narrower than `scope` and orthogonal to it: scope answers "may this
     * token change things", this answers "which things does it know about at
     * all". A token for a personal ledger has no business seeing — or being
     * told about — tables belonging to something else, and a tool list is a
     * cost paid on every turn of every conversation whether or not anything
     * calls it.
     */
    tables?: string[];
    /**
     * For a "connections" token: what it may use. Validated by the caller
     * (src/connectors/ knows what a grant's limits mean; this file does not).
     */
    grants?: McpGrant[];
  } = {},
): { token: string; id: string } {
  const { audience = "ops", tables, grants } = opts;
  if (audience === "connections" && !grants?.length) {
    throw new Error("A connections token needs at least one connection");
  }
  const token = PREFIX + randomBytes(24).toString("hex");
  const id = randomBytes(4).toString("hex");
  store.insertMcpToken({
    id,
    name,
    scope,
    hash: digest(token),
    prefix: token.slice(0, HINT_LENGTH),
    tables: tables && tables.length ? tables : null,
    audience,
    grants: audience === "connections" ? grants : null,
  });
  log.info(
    `MCP token "${name}" created (${audience}, ${scope} scope, ${id}` +
      `${tables && tables.length ? `, tables: ${tables.join(", ")}` : ""}` +
      // Which credentials, never the limits: a folder or chat name says more
      // about somebody's life than a log line needs to.
      `${audience === "connections" && grants ? `, connections: ${grants.map((g) => `${g.provider}:${g.credential}`).join(", ")}` : ""})`,
  );
  return { token, id };
}

export function deleteMcpToken(id: string): boolean {
  const gone = store.deleteMcpToken(id);
  if (gone) log.info(`MCP token ${id} deleted — any client using it is now refused`);
  return gone;
}

/**
 * Changes a token's access — read or full, and which tables — in place, so
 * the client using it keeps working with the new limits from its next call.
 * The audience is not changeable: a token for another endpoint is a new
 * token, pasted into a different config.
 */
export function updateMcpTokenAccess(
  id: string,
  scope: McpScope,
  tables: string[] | null,
): boolean {
  const done = store.updateMcpTokenAccess(id, scope, tables);
  if (done) {
    log.info(
      `MCP token ${id} changed to ${scope} scope` +
        `${tables && tables.length ? `, tables: ${tables.join(", ")}` : ""}`,
    );
  }
  return done;
}

/**
 * Replaces a connections token's grants in place — a changed access, or
 * folders added — so the client keeps its token. Validated by the caller,
 * like createMcpToken's. Logged by credential, never by limit.
 */
export function updateMcpTokenGrants(id: string, grants: McpGrant[]): boolean {
  if (grants.length === 0) throw new Error("A connections token needs at least one connection");
  const done = store.updateMcpTokenGrants(id, grants);
  if (done) {
    log.info(
      `MCP token ${id} connections changed: ` +
        grants.map((g) => `${g.provider}:${g.credential} (${g.access})`).join(", "),
    );
  }
  return done;
}

export function mcpTokenById(id: string): McpTokenRecord | null {
  return store.mcpTokenById(id);
}

export function listMcpTokens(): McpTokenRecord[] {
  return store.mcpTokens();
}

/** Who a request is, once its token has been recognised. */
export interface McpIdentity {
  scope: McpScope;
  /** What to call this in a log line or on the dashboard. */
  label: string;
  /** Absent for the environment token, which has no row to update. */
  id?: string;
  /**
   * Data tables this token may reach, or null for all of them. Read by
   * /mcp/tables and meaningless to /mcp, which serves no table data.
   */
  tables: string[] | null;
  /**
   * Endpoints this token may talk to. The environment token gets both, being
   * the documented way back in; a stored token gets exactly the one it was
   * minted for.
   */
  audiences: McpAudience[];
  /**
   * The connections this token may use on /mcp, each with its own access and
   * limits. Empty for every token that is not a "connections" token —
   * including the environment one, which is the way back in and has no
   * business carrying somebody's chats into an operations conversation.
   */
  grants: McpGrant[];
  /**
   * The only tools this identity may list or call, when set. Only an
   * in-process token has one (`mintProcessToken`): live Maria is given the
   * assistant's tools minus the hourly run's own.
   */
  tools?: readonly string[];
}

/** Tokens minted by this process for itself, by digest. Never stored, gone on restart. */
const processTokens = new Map<string, McpIdentity>();

/**
 * A token for a client this process starts itself and talks to over
 * 127.0.0.1 — live Maria's Claude Code, which reaches /mcp/assistant like the
 * routine does. Kept in memory only: nothing to leak from the database or
 * the dashboard, nothing to rotate, and it dies with the process. Not shown
 * on the MCP tab, because it is not anybody's to manage.
 */
export function mintProcessToken(identity: Omit<McpIdentity, "id">): string {
  const token = randomBytes(32).toString("hex");
  processTokens.set(digest(token), identity);
  return token;
}

/**
 * Whether this token may talk to an endpoint at all.
 *
 * Checked before anything else, and separately from `scope`: being refused
 * here means "wrong server", which is a different sentence from "read-only"
 * and needs to read like one, or the first thing somebody does is mint a
 * full-scope token and get refused identically.
 */
export function mayUseEndpoint(identity: McpIdentity, audience: McpAudience): boolean {
  return identity.audiences.includes(audience);
}

/**
 * Whether an identity may see a given data table.
 *
 * Null is "everything", so the environment token and every pre-existing stored
 * token keep working unchanged. A list is a closed set — a table added to
 * `tables/` later does *not* appear to a token that named its tables, which is
 * the correct direction for a permission to drift in.
 */
export function mayUseTable(identity: McpIdentity, name: string): boolean {
  return identity.tables === null || identity.tables.includes(name);
}

/**
 * Resolves a presented token to an identity, or null.
 *
 * The environment token is compared in constant time because it is compared
 * byte by byte. The stored ones are looked up by digest instead — the index
 * key is already a hash of the secret, so there is no prefix to walk and
 * nothing useful for a timing difference to leak.
 */
export function identify(presented: string): McpIdentity | null {
  if (!presented) return null;

  const fromEnv = process.env.MCP_TOKEN;
  if (fromEnv && constantTimeEqual(presented, fromEnv)) {
    // Every endpoint: this is the bootstrap credential, and a way back in that
    // only reaches part of the server is not one.
    return {
      scope: "full",
      label: "MCP_TOKEN (environment)",
      tables: null,
      audiences: [...AUDIENCES],
      grants: [],
    };
  }

  const own = processTokens.get(digest(presented));
  if (own) return own;

  const row = store.mcpTokenByHash(digest(presented));
  if (!row) return null;
  return {
    scope: isScope(row.scope) ? row.scope : "full",
    label: row.name,
    id: row.id,
    tables: parseTables(row.tables),
    // NULL reads as "ops" rather than as both: a token minted before the
    // endpoints were separate was minted for the only one that existed, and
    // widening it here would hand out an access its creator never chose.
    audiences: [isAudience(row.audience) ? row.audience : "ops"],
    grants: row.audience === "connections" ? parseGrants(row.grants) : [],
  };
}

/** Notes that a token was used, and by what. No-op for the environment token. */
export function noteUse(identity: McpIdentity, client: string | null): void {
  if (identity.id) store.touchMcpToken(identity.id, client);
}

/** Whether anything at all can authenticate — the endpoint is closed if not. */
export function mcpEnabled(): boolean {
  return Boolean(process.env.MCP_TOKEN) || processTokens.size > 0 || store.mcpTokenCount() > 0;
}

/**
 * The stored table list, defensively.
 *
 * A row whose JSON cannot be read falls back to `null` — every table — rather
 * than to the empty list. That is the deliberate direction: the alternative is
 * a token that silently stops working and reports "no tables exist", which
 * reads as a broken server rather than as a corrupt column. This value is not
 * a security boundary on its own (the token still had to be valid to get
 * here); it decides which of this server's own tables a legitimate client is
 * shown.
 */
function parseTables(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed.length ? parsed : null;
    }
  } catch {
    /* falls through */
  }
  log.warn(`An MCP token has an unreadable table list — treating it as every table`);
  return null;
}

/**
 * The stored grants, defensively — and in the opposite direction from the
 * table list above. An unreadable grant is dropped, not widened: a table list
 * picks among this server's own tables, while a grant reaches somebody's
 * account somewhere else, so the failure that reads as "this token can see
 * nothing" is the right one here.
 */
function parseGrants(raw: string | null): McpGrant[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (g): g is McpGrant =>
          g !== null &&
          typeof g === "object" &&
          typeof g.provider === "string" &&
          typeof g.credential === "string" &&
          isScope(g.access) &&
          g.limits !== null &&
          typeof g.limits === "object",
      );
    }
  } catch {
    /* falls through */
  }
  log.warn(`An MCP token has an unreadable grant list — treating it as no connections`);
  return [];
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return nodeTimingSafeEqual(ba, bb);
}
