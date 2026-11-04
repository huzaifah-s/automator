import type { z } from "zod";
import type { ProviderId } from "../core/providers.ts";
import type { McpGrant } from "../core/mcp-tokens.ts";

/**
 * A connector is one set of MCP tools a token can be granted: the runner's
 * own (operations, data tables) or a platform's from the Credentials tab
 * (Telegram), each with the limits a grant may put on it.
 *
 * A token picks among connectors — this one, this access, these limits — and
 * never describes a call the server would make. What a connector does is
 * code, for the same reason a provider's connection test is: what the server
 * does on a client's behalf is a decision for a commit, not a browser form.
 *
 * A platform connector is one file in this folder. The built-in ones live
 * beside the tools they wrap (`server/mcp.ts`, `server/mcp-tables.ts`) and
 * are registered at boot, because they need the loaded workflows.
 */
export interface Connector<L = unknown> {
  /** What a grant names it by: `ops`, `tables`, `telegram_user`. */
  id: string;
  /**
   * The Credentials-tab platform whose credential a grant must name. Absent
   * for the runner's own tools, which need no credential.
   */
  provider?: ProviderId;
  /** What it is called on the dashboard. */
  label: string;
  /** One line under the label on the token form. */
  blurb: string;
  /**
   * The start of every tool name, `<prefix>_<tool>`. Empty for the built-in
   * connectors, whose tools keep the bare names every existing client and
   * prompt already uses (`overview`, `rows`). Bare names are checked at
   * registration for collisions across connectors.
   */
  prefix: string;
  /** For the server's `instructions`, when a token has this connector. */
  instructions: string | ((limits: L) => string);
  limits: ConnectorLimits<L>;
  tools: ConnectorTool<L>[];
  /**
   * Whether a failed tool's message may go to the log. True for the runner's
   * own tools, whose errors are about runs; false for anything that reads
   * somebody's data, where an error can carry a chat name or a search phrase.
   */
  logErrors?: boolean;
  /** MCP prompts this connector brings — only the operations one has any. */
  prompts?: readonly ConnectorPrompt[];
}

export interface ConnectorPrompt {
  name: string;
  description: string;
  arguments?: { name: string; description: string; required: boolean }[];
  render(args: Record<string, string>): string;
}

/**
 * How a grant narrows a connector — "only these folders", "only these
 * tables". A grant whose limits fail the schema is refused when the token is
 * minted and again when it is used.
 */
export interface ConnectorLimits<L> {
  /** Parses what a grant stores. Throws with a readable message. */
  schema: z.ZodType<L>;
  /**
   * Checks the parsed limits against the server as it is now — a table name
   * that is not loaded. Run when a token is minted or changed, not on use,
   * because what exists can change after.
   */
  check?(limits: L): void;
  /** The form's inputs. */
  fields: LimitField[];
  /** One line for the MCP tab: "folders REKA · 2 chats", "all tables". Empty for none. */
  describe(limits: L): string;
}

export interface LimitField {
  /** Key in the grant's `limits`. */
  name: string;
  label: string;
  /**
   * `list` (default) is a comma-separated text input. `tables` is the boxes
   * for the loaded data tables, with "all of them" — stored as null.
   */
  kind?: "list" | "tables";
  placeholder?: string;
  help: string;
}

export interface ConnectorTool<L> {
  /** Without the prefix — `history`, served as `telegram_history`. */
  name: string;
  /** One line. Every description is paid for on every turn. */
  description: string;
  /**
   * `read` tools come with a read grant; `write` tools only with a full one,
   * and are left out of a read grant's tool list as well as refused.
   */
  access: "read" | "write";
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: false;
  };
  run(args: Record<string, unknown>, ctx: ConnectorCall<L>): Promise<string> | string;
}

/** What a tool is handed when it is called. */
export interface ConnectorCall<L> {
  /** The grant's limits, parsed by the connector's schema. */
  limits: L;
  /** The credential's values, read from the store for this call. Empty for a built-in. */
  credential: Record<string, string>;
  /** The grant itself — for a cache key, or a message naming the credential. */
  grant: McpGrant;
  /** Who is calling — a write records the token's label. */
  token: { label: string; id?: string };
  /** Aborted when the request gives up. */
  signal: AbortSignal;
}
