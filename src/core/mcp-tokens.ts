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
export type McpAudience = "ops" | "tables";

export function isAudience(value: unknown): value is McpAudience {
  return value === "ops" || value === "tables";
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
  } = {},
): { token: string; id: string } {
  const { audience = "ops", tables } = opts;
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
  });
  log.info(
    `MCP token "${name}" created (${audience}, ${scope} scope, ${id}` +
      `${tables && tables.length ? `, tables: ${tables.join(", ")}` : ""})`,
  );
  return { token, id };
}

export function deleteMcpToken(id: string): boolean {
  const gone = store.deleteMcpToken(id);
  if (gone) log.info(`MCP token ${id} deleted — any client using it is now refused`);
  return gone;
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
    // Both endpoints: this is the bootstrap credential, and a way back in that
    // only reaches half the server is not one.
    return {
      scope: "full",
      label: "MCP_TOKEN (environment)",
      tables: null,
      audiences: ["ops", "tables"],
    };
  }

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
  };
}

/** Notes that a token was used, and by what. No-op for the environment token. */
export function noteUse(identity: McpIdentity, client: string | null): void {
  if (identity.id) store.touchMcpToken(identity.id, client);
}

/** Whether anything at all can authenticate — the endpoint is closed if not. */
export function mcpEnabled(): boolean {
  return Boolean(process.env.MCP_TOKEN) || store.mcpTokenCount() > 0;
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

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return nodeTimingSafeEqual(ba, bb);
}
