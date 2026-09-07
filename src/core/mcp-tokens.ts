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
export function createMcpToken(name: string, scope: McpScope): { token: string; id: string } {
  const token = PREFIX + randomBytes(24).toString("hex");
  const id = randomBytes(4).toString("hex");
  store.insertMcpToken({
    id,
    name,
    scope,
    hash: digest(token),
    prefix: token.slice(0, HINT_LENGTH),
  });
  log.info(`MCP token "${name}" created (${scope} scope, ${id})`);
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
    return { scope: "full", label: "MCP_TOKEN (environment)" };
  }

  const row = store.mcpTokenByHash(digest(presented));
  if (!row) return null;
  return { scope: isScope(row.scope) ? row.scope : "full", label: row.name, id: row.id };
}

/** Notes that a token was used, and by what. No-op for the environment token. */
export function noteUse(identity: McpIdentity, client: string | null): void {
  if (identity.id) store.touchMcpToken(identity.id, client);
}

/** Whether anything at all can authenticate — the endpoint is closed if not. */
export function mcpEnabled(): boolean {
  return Boolean(process.env.MCP_TOKEN) || store.mcpTokenCount() > 0;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return nodeTimingSafeEqual(ba, bb);
}
