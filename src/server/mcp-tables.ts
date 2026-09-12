/**
 * The data-table MCP endpoint — what an agent sees of the rows this runner
 * keeps, as opposed to `mcp.ts`, which is what it sees of the runner itself.
 *
 * Mounted at POST /mcp/tables, same transport as its sibling: JSON-RPC in a
 * POST body, no SDK, no session.
 *
 * ## Why this is a second endpoint and not six more tools on the first one
 *
 * `mcp.ts` answers about runs, and the rule above it is that adding a tool
 * there means adding to a cost paid on every turn of every conversation,
 * whether or not it is called. A personal ledger and a production incident are
 * not the same conversation and almost never the same person's afternoon, so
 * making every "what is failing" chat carry six ledger tools — and every
 * ledger chat carry ten operational ones — is a bill nobody gets value from.
 *
 * Two endpoints, two tokens, two tool lists. A client connects to the one it
 * needs.
 *
 * ## Scope
 *
 * A token carries the set of tables it may reach (`mcp-tokens.ts`). Tables
 * outside that set are not listed, not readable, and not writable — in that
 * order of importance, because the listing is what an agent decides from.
 *
 * ## Writes
 *
 * This endpoint lets a model write rows, which is the point of it and also the
 * thing to be careful about. Four properties do the work, and none of them is
 * a prompt:
 *
 *   1. **Validation refuses rather than coerces.** A decimal in a money column
 *      is an error that says "42.50 is 4250", not a silent hundredfold
 *      mistake. See `core/tables.ts`.
 *   2. **Inserts are idempotent when given a key.** A tool call that times out
 *      and is retried writes one row, not two.
 *   3. **Nothing is hard-deleted.** `delete_row` is a soft delete, visible and
 *      restorable on the dashboard.
 *   4. **Every write is attributed.** The row records the token's label, so
 *      "which of these did the agent write" is a column and not a guess.
 */

import { Hono } from "hono";
import { log } from "../core/logger.ts";
import {
  allTables,
  getTable,
  table as dataTable,
  type ColumnDef,
  type LoadedTable,
  type Row,
  type WhereClause,
} from "../core/tables.ts";
import {
  identify,
  mayUseEndpoint,
  mayUseTable,
  mcpEnabled,
  noteUse,
  type McpIdentity,
} from "../core/mcp-tokens.ts";

/** Roughly four bytes to the token, so the default is about six thousand. */
const DEFAULT_MAX_BYTES = Number(process.env.MCP_MAX_BYTES ?? 24_000);
const HARD_MAX_BYTES = 200_000;

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/* ------------------------------------------------------------ formatting */

function clip(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  return `${bytes.subarray(0, max).toString("utf8")}\n… truncated at ${max} bytes`;
}

/**
 * A value as one cell of a text table.
 *
 * Money renders as a decimal, because that is what gets relayed to a person
 * and a model asked to report "RM 42.50" should not have to divide. Writing it
 * back still takes cents, and the validator says so on the way in — a refusal
 * the model can read beats a conversion it has to remember.
 */
function cell(col: ColumnDef | null, value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (!col) return String(value);
  switch (col.kind) {
    case "money":
      return (Number(value) / 100).toFixed(2);
    case "bool":
      return value ? "yes" : "no";
    case "datetime":
      return new Date(Number(value)).toISOString().replace("T", " ").slice(0, 16);
    case "json":
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/**
 * Rows as a padded text table.
 *
 * Deliberately not JSON: JSON repeats every key on every row, which on a
 * twenty-row result is most of the payload and all of it redundant. The same
 * reasoning as `mcp.ts`, and the same reason the column header is printed once.
 */
function asTable(headers: string[], rows: string[][], max: number): string {
  if (rows.length === 0) return "No rows.";
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((v, i) => (v ?? "").padEnd(widths[i]!)).join("  ").trimEnd();
  return clip([line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n"), max);
}

/* ------------------------------------------------------------- arguments */

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Resolves the `table` argument against what this token is allowed to see. */
function resolve(identity: McpIdentity, args: Record<string, unknown>): LoadedTable {
  const name = str(args, "table");
  if (!name) throw new Error("Which table? Call `tables` to see the ones this token can reach.");
  const def = getTable(name);
  // A table that exists but is out of scope is reported exactly like one that
  // does not exist. Saying "that table exists but is not yours" tells a caller
  // something about a table it was not given, for no operational benefit.
  if (!def || !mayUseTable(identity, name)) {
    const visible = visibleTables(identity).map((t) => t.name);
    throw new Error(
      `No table "${name}" on this token` + (visible.length ? ` — it can reach ${visible.join(", ")}` : ""),
    );
  }
  return def;
}

function visibleTables(identity: McpIdentity): LoadedTable[] {
  return allTables().filter((t) => mayUseTable(identity, t.name));
}

/** The `where` argument, checked into the shape core/tables.ts expects. */
function whereFrom(args: Record<string, unknown>): WhereClause[] | undefined {
  const raw = args["where"];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("`where` is an array of {column, op, value}");
  return raw.map((clause, i) => {
    if (!clause || typeof clause !== "object") {
      throw new Error(`where[${i}] is not an object — each one is {column, op, value}`);
    }
    const c = clause as Record<string, unknown>;
    const column = typeof c["column"] === "string" ? c["column"] : undefined;
    const op = typeof c["op"] === "string" ? c["op"] : "=";
    if (!column) throw new Error(`where[${i}] needs a column`);
    return { column, op, value: c["value"] } as WhereClause;
  });
}

/** A row as `key=value` pairs — what a write hands back to confirm itself. */
function describeRow(def: LoadedTable, row: Row): string {
  const parts = Object.entries(def.columns)
    .map(([name, col]) => `${name}=${cell(col, row[name])}`)
    .join("  ");
  return `${row.id}  ${parts}`;
}

/* ----------------------------------------------------------------- tools */

interface Tool {
  name: string;
  description: string;
  scope: "read" | "write";
  inputSchema: object;
  run(args: Record<string, unknown>, identity: McpIdentity): string;
}

const TABLE_ARG = { table: { type: "string", description: "Table name." } };

const WHERE_ARG = {
  where: {
    type: "array",
    description:
      'Filters, ANDed. Each is {column, op, value}; op is one of =, !=, <, <=, >, >=, ' +
      'like, in, "is null", "is not null". Dates are YYYY-MM-DD strings, so a month is ' +
      '>= the 1st and <= the last.',
    items: {
      type: "object",
      properties: {
        column: { type: "string" },
        op: { type: "string" },
        value: {},
      },
      required: ["column"],
    },
  },
};

const TOOLS: Tool[] = [
  {
    name: "tables",
    description: "The tables this token can reach, with their columns. Call this first.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string", description: "Just this one, in full." } },
    },
    run(args, identity) {
      const only = str(args, "table");
      const tables = only ? [resolve(identity, args)] : visibleTables(identity);
      if (tables.length === 0) return "This token can reach no tables.";

      const out: string[] = [];
      for (const def of tables) {
        const client = dataTable(def.name);
        out.push(`## ${def.name} — ${def.description ?? "no description"} (${client.count()} rows)`);
        for (const [name, col] of Object.entries(def.columns)) {
          const bits: string[] = [col.kind];
          if (col.nullable) bits.push("optional");
          if (col.default !== undefined) bits.push(`default ${JSON.stringify(col.default)}`);
          if (col.kind === "enum") bits.push(`one of: ${(col.values ?? []).join(", ")}`);
          out.push(`  ${name} (${bits.join(", ")})${col.help ? ` — ${col.help}` : ""}`);
        }
        if (def.dedupe) {
          const keys = Array.isArray(def.dedupe) ? def.dedupe.join(" + ") : def.dedupe;
          out.push(`  dedupe: ${keys} — supply it and re-adding the same row is a no-op.`);
        }
        out.push("");
      }
      return clip(out.join("\n").trimEnd(), DEFAULT_MAX_BYTES);
    },
  },

  {
    name: "rows",
    description:
      "Rows from one table, filtered. Prefer `totals` for anything you would otherwise " +
      "add up yourself — this returns rows, and rows cost context.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        ...TABLE_ARG,
        ...WHERE_ARG,
        search: { type: "string", description: "Case-insensitive substring over the text columns." },
        order: { type: "string", description: "Column to sort by. Defaults to the table's own order." },
        direction: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "number", description: "Default 25." },
        offset: { type: "number" },
        include_deleted: { type: "boolean", description: "Include soft-deleted rows." },
      },
      required: ["table"],
    },
    run(args, identity) {
      const def = resolve(identity, args);
      const client = dataTable(def.name);
      const order = str(args, "order");

      const rows = client.query({
        where: whereFrom(args),
        search: str(args, "search"),
        order: order
          ? { column: order, direction: args["direction"] === "asc" ? "asc" : "desc" }
          : undefined,
        limit: num(args, "limit") ?? 25,
        offset: num(args, "offset"),
        includeDeleted: args["include_deleted"] === true,
      });

      const total = client.count({
        where: whereFrom(args),
        search: str(args, "search"),
        includeDeleted: args["include_deleted"] === true,
      });

      const columns = Object.entries(def.columns);
      const headers = ["id", ...columns.map(([n]) => n)];
      const body = rows.map((r) => [
        String(r.id),
        ...columns.map(([n, col]) => cell(col, r[n])),
      ]);

      const shown = `${rows.length} of ${total} row(s)`;
      return `${shown}\n\n${asTable(headers, body, DEFAULT_MAX_BYTES)}`;
    },
  },

  {
    name: "totals",
    description:
      "Sums, counts and averages, grouped — the tool for 'how much did I spend on X', " +
      "because the arithmetic happens in SQL and you get a handful of lines instead of " +
      "every row.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        ...TABLE_ARG,
        ...WHERE_ARG,
        sum: {
          description:
            "Numeric column to total, or several. Pass an array to get them side by side " +
            'in one result — ["amount_cents", "reimbursed_cents"] is how you read gross ' +
            "spending and what came back without asking twice.",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        average: { type: "string", description: "Numeric column to average." },
        group_by: {
          type: "array",
          items: { type: "string" },
          description: "Columns to group by, e.g. [\"category\"].",
        },
        limit: { type: "number", description: "Default 50." },
      },
      required: ["table"],
    },
    run(args, identity) {
      const def = resolve(identity, args);
      const raw = args["sum"];
      const sums = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim());
      const average = str(args, "average");

      const groupBy = Array.isArray(args["group_by"])
        ? (args["group_by"] as unknown[]).filter((g): g is string => typeof g === "string")
        : [];

      /*
       * Summing a money column across currencies produces a number that is not
       * an amount of anything, and it looks exactly like one. So a currency
       * column is added to the grouping whenever it exists and the caller did
       * not already ask for it: the answer becomes two lines instead of one
       * wrong line, and stays one line in the overwhelmingly common case where
       * everything is in the same currency.
       */
      const anyMoney = sums.some((c) => def.columns[c]?.kind === "money");
      if (anyMoney && def.columns.currency && !groupBy.includes("currency")) {
        groupBy.push("currency");
      }

      /*
       * One sum keeps the alias `total`, several are named after their columns.
       * The single-column case is overwhelmingly the common one and "total" is
       * what it should be called; naming it `sum_amount_cents` to be
       * consistent with the rare case would make every ordinary answer worse.
       */
      const alias = (column: string) => (sums.length === 1 ? "total" : `sum_${column}`);

      /** Which source column each output alias came from, for rendering units. */
      const units = new Map<string, ColumnDef | undefined>();
      const select: { fn: "count" | "sum" | "avg"; column?: string; as?: string }[] = [
        { fn: "count", as: "rows" },
      ];
      for (const column of sums) {
        select.push({ fn: "sum", column, as: alias(column) });
        units.set(alias(column), def.columns[column]);
      }
      if (average) {
        select.push({ fn: "avg", column: average, as: "average" });
        units.set("average", def.columns[average]);
      }

      const results = dataTable(def.name).aggregate({
        select,
        groupBy,
        where: whereFrom(args),
        // Ordered by the first sum, which is the one the caller led with.
        order: sums.length ? { column: alias(sums[0]!), direction: "desc" } : undefined,
        limit: num(args, "limit") ?? 50,
      });

      if (results.length === 0) return "Nothing matched.";

      const headers = Object.keys(results[0]!);
      const body = results.map((r) =>
        headers.map((h) => {
          // An aggregate inherits the units of the column it came from, so a
          // money column's total renders the way its cells do. Anything else
          // is printed as it came back.
          const unit = units.get(h) ?? def.columns[h];
          return cell(unit ?? null, r[h]);
        }),
      );
      return asTable(headers, body, DEFAULT_MAX_BYTES);
    },
  },

  {
    name: "add_row",
    description:
      "SIDE EFFECTS. Adds one row. Pass the table's own columns as `values`. Supply the " +
      "table's dedupe column with a stable key and calling this twice writes one row.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        ...TABLE_ARG,
        values: { type: "object", description: "Column name to value. Call `tables` for the shape." },
      },
      required: ["table", "values"],
    },
    run(args, identity) {
      const def = resolve(identity, args);
      const values = args["values"];
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new Error("`values` is an object of column name to value");
      }
      const { row, created } = dataTable(def.name).insert(values as Record<string, unknown>, {
        writtenBy: identity.label,
      });
      return created
        ? `Added to ${def.name}:\n${describeRow(def, row)}`
        : `Already there — nothing written. ${def.name}:\n${describeRow(def, row)}`;
    },
  },

  {
    name: "edit_row",
    description: "SIDE EFFECTS. Changes the named columns of one row, by id, leaving the rest.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        ...TABLE_ARG,
        id: { type: "string", description: "The row's id, as `rows` returned it." },
        values: { type: "object", description: "Only the columns to change." },
      },
      required: ["table", "id", "values"],
    },
    run(args, identity) {
      const def = resolve(identity, args);
      const id = str(args, "id");
      if (!id) throw new Error("Which row? Pass the id `rows` gave you.");
      const values = args["values"];
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new Error("`values` is an object of column name to value");
      }
      const row = dataTable(def.name).update(resolveId(def, id), values as Record<string, unknown>, {
        writtenBy: identity.label,
      });
      return `Updated ${def.name}:\n${describeRow(def, row)}`;
    },
  },

  {
    name: "delete_row",
    description:
      "SIDE EFFECTS. Soft-deletes one row: it stops being listed and can be restored from " +
      "the dashboard. Nothing here removes data permanently.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { ...TABLE_ARG, id: { type: "string" } },
      required: ["table", "id"],
    },
    run(args, identity) {
      const def = resolve(identity, args);
      const id = str(args, "id");
      if (!id) throw new Error("Which row? Pass the id `rows` gave you.");
      const full = resolveId(def, id);
      return dataTable(def.name).remove(full)
        ? `Deleted ${full} from ${def.name}. Restore it on the dashboard if that was wrong.`
        : `${full} was already deleted.`;
    },
  },
];

/**
 * Accepts a leading fragment of an id as well as the whole thing.
 *
 * Ids are fifteen characters and `rows` prints them whole, so this is not load
 * bearing for the normal path — it is here because a person reading a result
 * back to a model, or a model reconstructing one from an earlier turn, will
 * sometimes hand over part of it, and "no such row" is a worse answer than
 * either resolving it or saying which ones it matched.
 */
function resolveId(def: LoadedTable, given: string): string {
  if (given.length >= 15) return given;
  const matches = dataTable(def.name)
    .query({ limit: 1000, includeDeleted: true })
    .filter((r) => String(r.id).startsWith(given));
  if (matches.length === 0) throw new Error(`No row in ${def.name} starting with "${given}"`);
  if (matches.length > 1) {
    throw new Error(`"${given}" matches ${matches.length} rows in ${def.name} — use the full id`);
  }
  return String(matches[0]!.id);
}

/* ------------------------------------------------------------- transport */

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

/** Mounted at /mcp/tables, with its own bearer check like its sibling. */
export function createTableMcpRouter(): Hono<{ Variables: { mcp: McpIdentity } }> {
  const app = new Hono<{ Variables: { mcp: McpIdentity } }>();
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  app.use("*", async (c, next) => {
    if (!mcpEnabled()) {
      return c.json(
        rpcError(null, -32001, "MCP is disabled on this server: no token exists."),
        503,
      );
    }
    const presented =
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      c.req.header("x-mcp-token") ??
      "";
    const identity = identify(presented);
    if (!identity) {
      return c.json(rpcError(null, -32001, "Unauthorized"), 401, { "WWW-Authenticate": "Bearer" });
    }
    // The mirror of the check on /mcp. An operations token reaches runs and
    // workflows and stops there; the ledger is not an extra thing it gets.
    if (!mayUseEndpoint(identity, "tables")) {
      return c.json(
        rpcError(
          null,
          -32001,
          `"${identity.label}" is an operations token. This endpoint serves data tables — ` +
            "create a token for them on the dashboard's MCP tab, or connect this one to /mcp.",
        ),
        403,
      );
    }
    c.set("mcp", identity);
    noteUse(identity, null);
    return next();
  });

  const visibleTo = (identity: McpIdentity) =>
    identity.scope === "full" ? TOOLS : TOOLS.filter((t) => t.scope === "read");

  function dispatch(msg: Rpc, identity: McpIdentity): object | null {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize": {
        const asked = String(params?.["protocolVersion"] ?? "");
        const info = params?.["clientInfo"] as { name?: string; version?: string } | undefined;
        noteUse(
          identity,
          info?.name ? `${info.name}${info.version ? ` ${info.version}` : ""}`.slice(0, 80) : null,
        );
        const reach = visibleTables(identity).map((t) => t.name);
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "automator-tables", version: "0.1.0" },
            instructions:
              `Data tables kept by an automation runner: ${reach.join(", ") || "none on this token"}. ` +
              "Call `tables` first for the columns. Use `totals` for anything you would " +
              "otherwise add up yourself — it groups in SQL and returns a few lines, where " +
              "`rows` returns rows. Money columns are stored as whole cents and displayed as " +
              "decimals; write them back as cents (42.50 is 4250) or the write is refused. " +
              "Tools marked SIDE EFFECTS change stored data — confirm with the user first.",
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

        // Hidden from the list is not the same as refused: a client may have
        // cached a list taken with a different token.
        if (tool.scope === "write" && identity.scope !== "full") {
          return {
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              content: [
                {
                  type: "text",
                  text: `"${name}" needs a full-scope token. This one ("${identity.label}") is read-only.`,
                },
              ],
              isError: true,
            },
          };
        }

        const args = (params?.["arguments"] as Record<string, unknown> | undefined) ?? {};
        try {
          return {
            jsonrpc: "2.0",
            id: id ?? null,
            result: { content: [{ type: "text", text: clip(tool.run(args, identity), HARD_MAX_BYTES) }] },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`MCP table tool ${name} failed: ${message}`);
          // A refused write is a result the model has to be able to read and
          // correct from — "amount is in cents" is the whole point of it.
          return {
            jsonrpc: "2.0",
            id: id ?? null,
            result: { content: [{ type: "text", text: message }], isError: true },
          };
        }
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
      const replies = body
        .map((m) => dispatch(m as Rpc, identity))
        .filter((r): r is object => r !== null);
      return replies.length === 0 ? c.body(null, 202) : c.json(replies);
    }
    const reply = dispatch(body as Rpc, identity);
    return reply === null ? c.body(null, 202) : c.json(reply);
  });

  app.get("/", (c) => c.json(rpcError(null, -32000, "This endpoint is POST-only"), 405));
  app.delete("/", (c) => c.json(rpcError(null, -32000, "Stateless: no session to end"), 405));

  return app;
}
