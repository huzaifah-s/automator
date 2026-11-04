import type { z } from "zod";
import type { ProviderId } from "../core/providers.ts";
import type { McpGrant } from "../core/mcp-tokens.ts";

/**
 * A connector is what one platform on the Credentials tab offers an MCP
 * client: a few tools, and the limits a token's grant may put on them.
 *
 * It is the MCP half of a platform, the way `src/core/providers.ts` is the
 * credentials half. A provider says "these fields, and this call proves they
 * work"; a connector says "with that credential, a client may call these
 * tools, narrowed by these limits". Both live in code for the same reason:
 * what the server does with a credential is a decision for a commit, not a
 * browser form. A token only *picks* — this credential, this access, these
 * limits — and never describes a call the server would make.
 *
 * One file per platform in this folder, registered in `index.ts`.
 */
export interface Connector<L = unknown> {
  /** The platform this works with — its credentials come from the Credentials tab. */
  provider: ProviderId;
  /** What it is called on the dashboard. */
  label: string;
  /**
   * The start of every tool name, `<prefix>_<tool>`. Short and lowercase:
   * MCP clients show tool names to the model, and a name is a cost on every
   * turn like a description is.
   */
  prefix: string;
  /** One or two sentences for the server's `instructions`, when a token has this connector. */
  instructions: string;
  limits: ConnectorLimits<L>;
  tools: ConnectorTool<L>[];
}

/**
 * How a grant narrows a connector — "only these folders", "only these
 * databases". Every limit field is a list, because every useful limit so far
 * has been "only these". A grant whose limits fail the schema is refused when
 * the token is minted and again when it is used.
 */
export interface ConnectorLimits<L> {
  /** Parses what a grant stores. Throws with a readable message. */
  schema: z.ZodType<L>;
  /** The form's inputs, one per list. */
  fields: LimitField[];
  /** One line for the MCP tab and the server instructions: "folders REKA · 2 chats". */
  describe(limits: L): string;
}

export interface LimitField {
  /** Key in the grant's `limits`. */
  name: string;
  label: string;
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
   * and are left out of a read grant's tool list rather than refused.
   */
  access: "read" | "write";
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  run(args: Record<string, unknown>, ctx: ConnectorCall<L>): Promise<string>;
}

/** What a tool is handed when it is called. */
export interface ConnectorCall<L> {
  /** The grant's limits, parsed by the connector's schema. */
  limits: L;
  /** The credential's values, read from the store for this call. */
  credential: Record<string, string>;
  /** The grant itself — for a cache key, or a message naming the credential. */
  grant: McpGrant;
  /** Aborted when the request gives up. */
  signal: AbortSignal;
}
