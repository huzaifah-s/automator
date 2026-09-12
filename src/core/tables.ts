import { randomBytes } from "node:crypto";
import { z, type ZodTypeAny } from "zod";
import { db } from "./db.ts";
import { log } from "./logger.ts";

/**
 * Data tables — rows the runner stores on behalf of the things it automates,
 * as opposed to the rows it stores *about itself*.
 *
 * Everything else in `db.ts` is the runner's own bookkeeping: runs, steps,
 * inbox deliveries, pauses. This is the first table in the file that holds
 * something a person cares about directly — an expense, an invoice, a reading
 * — and that difference drives every decision below.
 *
 * ## The shape of the trade
 *
 * n8n grew a Data Tables feature where the schema is rows in a database and
 * the columns are edited in a browser. That is the same drift this project
 * left n8n to avoid, so the split here is:
 *
 *   **structure is code, data is data.**
 *
 * A table is a file under `tables/`, default-exporting `defineTable()`,
 * discovered at boot exactly the way workflows are. The dashboard's Tables tab
 * edits *rows*; it has no button that creates a table, changes a column, or
 * drops one. Adding a table is a commit, which means it is reviewable,
 * revertable, and visible to whoever reads the repo — the same three
 * properties that made workflows files in the first place.
 *
 * ## Why this is not `ctx.state`
 *
 * State is a key/value store that is deliberately never rendered, so a
 * rotating OAuth token can live in it. That makes it exactly wrong here: you
 * cannot ask it "what did I spend on groceries in March", because answering
 * that is a `GROUP BY` and state has no columns to group by. A data table has
 * a schema precisely so the aggregating happens in SQL and an agent gets eight
 * lines back instead of two thousand rows — the same argument `server/mcp.ts`
 * makes at length about run history.
 *
 * ## The invariant that is new here, and it is a real one
 *
 * Row values are **not** passed through `redact()`. They cannot be: redaction
 * destroys the value, and unlike a run page — which is observational, so
 * scrubbing it is free — a table row is the thing you stored. That much is
 * shared with `ctx.state`.
 *
 * What is *not* shared is that state is invisible and a table row is not: it
 * renders on the dashboard and it is served over MCP. So this is the one place
 * in the codebase holding data that is simultaneously un-redacted and
 * displayed, and the rule that follows is short:
 *
 *   **Never put a credential in a data table.**
 *
 * That is what `secrets` and the credential store are for. There is no
 * heuristic guarding this the way `variables.ts` guards its own store, because
 * a table's columns are declared in code and reviewed — the guard is the
 * review, not a regex.
 *
 * ## Reloading
 *
 * Tables load once, at boot. `reload.ts` does not touch them. A schema change
 * is a restart, on purpose: hot-swapping a column definition underneath rows
 * that already exist is a migration, and a migration that happens because a
 * file watcher fired is not one anybody chose to run.
 */

/* --------------------------------------------------------------- columns */

export type ColumnKind =
  | "text"
  | "int"
  | "real"
  | "money"
  | "bool"
  | "date"
  | "datetime"
  | "json"
  | "enum";

export interface ColumnDef {
  kind: ColumnKind;
  /** Null is allowed. Columns are required by default — say so to relax it. */
  nullable?: boolean;
  /** Applied when the field is absent from an insert. Not a SQL DEFAULT. */
  default?: string | number | boolean | null;
  /** `enum` only: the closed set of accepted values. */
  values?: readonly string[];
  /** Header on the dashboard. Defaults to the column name. */
  label?: string;
  /** One line describing the column, shown on the dashboard and over MCP. */
  help?: string;
}

const column =
  <K extends ColumnKind>(kind: K) =>
  (opts: Omit<ColumnDef, "kind" | "values"> = {}): ColumnDef => ({ kind, ...opts });

export const text = column("text");
export const int = column("int");
export const real = column("real");
export const bool = column("bool");
/** `YYYY-MM-DD`. Stored as text so date maths stays readable in `sqlite3`. */
export const date = column("date");
/** Epoch milliseconds. */
export const datetime = column("datetime");
/** An object or array, stored as JSON text and handed back parsed. */
export const json = column("json");

/**
 * A whole number of minor units — cents, sen. Never a float: `0.1 + 0.2` is
 * not `0.3`, and a ledger that is out by a fraction of a cent is a ledger
 * nobody trusts.
 *
 * The validator **refuses** a fractional value rather than rounding it, and
 * says so in the message. That is the important half: the thing writing to
 * this column is frequently a model that has been handed "RM 42.50", and a
 * silent `Math.round` turns a 100× error into a stored number. A refusal it
 * can read and retry from does not.
 */
export const money = column("money");

/** A closed set. The reason a category column does not collect four spellings. */
export function enumOf(values: readonly string[], opts: Omit<ColumnDef, "kind" | "values"> = {}): ColumnDef {
  if (values.length === 0) throw new Error("enumOf() needs at least one value");
  return { kind: "enum", values, ...opts };
}

/* ---------------------------------------------------------------- tables */

export interface TableDef {
  /** Lowercase, digits and underscores. Becomes the physical table name. */
  name: string;
  /** One line, shown on the dashboard and in the MCP table list. */
  description?: string;
  columns: Record<string, ColumnDef>;
  /**
   * Columns whose combined value must be unique among live rows.
   *
   * This is what makes an insert idempotent, and it is the difference between
   * "filed this receipt" and "filed this receipt four times because the tool
   * call timed out and the model retried". Enforced by a partial unique index
   * that ignores soft-deleted rows, so deleting a row frees its key again.
   */
  dedupe?: string | string[];
  /** Default ordering for listings. Defaults to newest first. */
  order?: { column: string; direction?: "asc" | "desc" };
}

/** A table definition plus where it was found. */
export interface LoadedTable extends TableDef {
  /** Path relative to the tables directory, e.g. `personal-finance/expenses.ts`. */
  file: string;
  /** The subdirectory it lives in, which is how the dashboard groups them. */
  folder: string | null;
}

/**
 * Columns every table has, which a definition may not redeclare.
 *
 * `written_by` is here rather than optional because the whole point of letting
 * a chat model write rows is being able to see afterwards which of them it
 * wrote. A column that only some tables have would be a column no listing can
 * rely on.
 */
export const IMPLICIT_COLUMNS = [
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
  "written_by",
] as const;

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Bounds a listing that forgot to ask for one. */
export const DEFAULT_LIMIT = 50;
/** The most rows one query may return, however large a limit is asked for. */
export const MAX_LIMIT = 1000;

export function defineTable(def: TableDef): TableDef {
  if (!NAME_PATTERN.test(def.name)) {
    throw new Error(
      `table name "${def.name}" must be lowercase letters, digits and underscores, starting with a letter`,
    );
  }
  const names = Object.keys(def.columns);
  if (names.length === 0) throw new Error(`table "${def.name}" declares no columns`);

  for (const col of names) {
    if (!NAME_PATTERN.test(col)) {
      throw new Error(`${def.name}.${col}: column names must be lowercase letters, digits and underscores`);
    }
    if ((IMPLICIT_COLUMNS as readonly string[]).includes(col)) {
      throw new Error(`${def.name}.${col}: every table already has a ${col} column`);
    }
    const c = def.columns[col]!;
    if (c.kind === "enum" && (!c.values || c.values.length === 0)) {
      throw new Error(`${def.name}.${col}: an enum column needs values — use enumOf([...])`);
    }
  }

  for (const key of dedupeColumns(def)) {
    if (!names.includes(key)) {
      throw new Error(`${def.name}: dedupe names "${key}", which is not one of its columns`);
    }
  }

  if (def.order && !names.includes(def.order.column) && !(IMPLICIT_COLUMNS as readonly string[]).includes(def.order.column)) {
    throw new Error(`${def.name}: order names "${def.order.column}", which is not one of its columns`);
  }

  return def;
}

function dedupeColumns(def: TableDef): string[] {
  if (!def.dedupe) return [];
  return Array.isArray(def.dedupe) ? def.dedupe : [def.dedupe];
}

/* -------------------------------------------------------------- registry */

const registry = new Map<string, LoadedTable>();

export function registerTable(table: LoadedTable): void {
  registry.set(table.name, table);
}

/** Every loaded table, ordered by folder then name — the dashboard's order. */
export function allTables(): LoadedTable[] {
  return [...registry.values()].sort(
    (a, b) => (a.folder ?? "").localeCompare(b.folder ?? "") || a.name.localeCompare(b.name),
  );
}

export function getTable(name: string): LoadedTable | undefined {
  return registry.get(name);
}

/** Boot loads once; this exists so a test or a CLI can start from empty. */
export function resetTables(): void {
  registry.clear();
}

/* ------------------------------------------------------------ SQL schema */

/** The physical table. Prefixed so it can never collide with a runner table. */
function physical(name: string): string {
  return `t_${name}`;
}

const SQL_TYPE: Record<ColumnKind, string> = {
  text: "TEXT",
  int: "INTEGER",
  real: "REAL",
  money: "INTEGER",
  bool: "INTEGER",
  date: "TEXT",
  datetime: "INTEGER",
  json: "TEXT",
  enum: "TEXT",
};

/**
 * Brings the database in line with a definition, and is the only thing that
 * ever writes DDL for these tables.
 *
 * Three cases, and the asymmetry between them is deliberate:
 *
 *   - **A column in the definition that the database lacks** is added. This is
 *     the common change and it is lossless, so it happens silently.
 *   - **A column in the database that the definition lacks** is left alone and
 *     warned about. Dropping it would destroy rows to tidy a schema, which is
 *     never the right default; it simply stops being read or rendered. If you
 *     really want it gone, write the migration.
 *   - **A column whose declared type no longer matches** stops the boot.
 *     Reading an INTEGER column as JSON does not fail, it returns nonsense,
 *     and nonsense that boots is worse than a process that does not.
 */
function syncSchema(table: LoadedTable): void {
  const t = physical(table.name);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${t} (
      id          TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      deleted_at  INTEGER,
      written_by  TEXT
    )
  `);

  const existing = new Map(
    (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string }[]).map((r) => [
      r.name,
      r.type.toUpperCase(),
    ]),
  );

  for (const [name, col] of Object.entries(table.columns)) {
    const want = SQL_TYPE[col.kind];
    const have = existing.get(name);

    if (have === undefined) {
      // Always nullable at the SQL level even when the column is required:
      // rows written before the column existed have nothing to put in it, and
      // NOT NULL would make adding a required column impossible without a
      // rewrite. Requiredness is enforced by the validator on the way in,
      // where it can produce a message instead of a constraint violation.
      db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${want}`);
      log.info(`table ${table.name}: added column ${name} (${col.kind})`);
      continue;
    }

    if (have !== want) {
      throw new Error(
        `table ${table.name}: column ${name} is ${have} in the database but the definition ` +
          `says ${col.kind} (${want}) — SQLite cannot change a column's type in place, ` +
          `so this needs a migration rather than an edit`,
      );
    }
  }

  for (const name of existing.keys()) {
    if (name in table.columns) continue;
    if ((IMPLICIT_COLUMNS as readonly string[]).includes(name)) continue;
    log.warn(
      `table ${table.name}: column ${name} exists in the database but not in ${table.file} — ` +
        `left in place and ignored`,
    );
  }

  // Partial, so a soft-deleted row stops reserving its key. Rebuilt from
  // scratch each boot because the set of dedupe columns can change, and an
  // index over the old set would keep enforcing a rule the file no longer
  // states.
  const keys = dedupeColumns(table);
  db.exec(`DROP INDEX IF EXISTS idx_${t}_dedupe`);
  if (keys.length > 0) {
    db.exec(
      `CREATE UNIQUE INDEX idx_${t}_dedupe ON ${t} (${keys.join(", ")}) WHERE deleted_at IS NULL`,
    );
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_live ON ${t} (deleted_at, created_at DESC)`);
}

/* ------------------------------------------------------------ validation */

/** The zod schema for one column's accepted input. */
function columnSchema(table: string, name: string, col: ColumnDef): ZodTypeAny {
  const where = `${table}.${name}`;
  let schema: ZodTypeAny;

  switch (col.kind) {
    case "text":
      schema = z.string();
      break;
    case "int":
      schema = z.number().int({ message: `${where} is a whole number` });
      break;
    case "money":
      schema = z.number().int({
        message:
          `${where} is a whole number of minor units (cents/sen), not a decimal — ` +
          `42.50 is 4250`,
      });
      break;
    case "real":
      schema = z.number();
      break;
    case "bool":
      schema = z.boolean();
      break;
    case "date":
      schema = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, `${where} is a date as YYYY-MM-DD`)
        .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), `${where} is not a real date`);
      break;
    case "datetime":
      schema = z.number().int(`${where} is epoch milliseconds`);
      break;
    case "json":
      schema = z.unknown();
      break;
    case "enum":
      schema = z.enum(col.values as [string, ...string[]]);
      break;
  }

  return col.nullable ? schema.nullable() : schema;
}

/** Insert schema: required columns required, defaults filled, extras refused. */
function insertSchema(table: TableDef): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, col] of Object.entries(table.columns)) {
    const base = columnSchema(table.name, name, col);
    shape[name] =
      col.default !== undefined
        ? base.optional().default(col.default as never)
        : col.nullable
          ? base.optional().default(null as never)
          : base;
  }
  // Strict, so a misspelt field is an error rather than a value that silently
  // never arrives. This matters most for the caller that cannot see the
  // schema failing — a model writing rows over MCP.
  return z.object(shape).strict();
}

/** Update schema: every column optional, nothing else accepted. */
function updateSchema(table: TableDef): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, col] of Object.entries(table.columns)) {
    shape[name] = columnSchema(table.name, name, col).optional();
  }
  return z.object(shape).strict();
}

const schemaCache = new Map<string, { insert: ZodTypeAny; update: ZodTypeAny }>();

function schemasFor(table: TableDef): { insert: ZodTypeAny; update: ZodTypeAny } {
  let cached = schemaCache.get(table.name);
  if (!cached) {
    cached = { insert: insertSchema(table), update: updateSchema(table) };
    schemaCache.set(table.name, cached);
  }
  return cached;
}

/** A zod failure as one readable line, which is what a tool result needs. */
function explain(err: z.ZodError): string {
  return err.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/* ------------------------------------------------------ value conversion */

/** A validated JS value on its way into SQLite. */
function toSql(col: ColumnDef, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  switch (col.kind) {
    case "bool":
      return value ? 1 : 0;
    case "json":
      return JSON.stringify(value);
    default:
      return value as string | number;
  }
}

/** A SQLite value on its way back out. */
function fromSql(col: ColumnDef, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (col.kind) {
    case "bool":
      return value === 1 || value === true;
    case "json":
      try {
        return JSON.parse(value as string);
      } catch {
        // A column that was something else before it was JSON, or a row written
        // by hand in sqlite3. Handing back the raw text beats throwing on a
        // listing and taking the whole page with it.
        return value;
      }
    default:
      return value;
  }
}

export interface Row {
  id: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  written_by: string | null;
  [column: string]: unknown;
}

function hydrate(table: TableDef, raw: Record<string, unknown>): Row {
  const row: Record<string, unknown> = {
    id: raw.id,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    deleted_at: raw.deleted_at ?? null,
    written_by: raw.written_by ?? null,
  };
  for (const [name, col] of Object.entries(table.columns)) row[name] = fromSql(col, raw[name]);
  return row as Row;
}

/**
 * Fifteen characters: a base-36 millisecond, then six hex of randomness.
 *
 * Sortable, so `ORDER BY id` is chronological and two rows written in the same
 * millisecond still have a stable order — which is what makes it a usable
 * tiebreaker for paging through a column full of duplicate dates.
 *
 * Short on purpose, and this is the part that had to be got right: an id that
 * needs abbreviating to fit in a listing has to be abbreviated to something
 * still *unique*, and a prefix of a timestamp-first id is not — every row
 * written in the same half-minute shares its leading characters. So rather
 * than print eight characters that collide, the whole thing is fifteen and is
 * printed whole. The randomness is six hex (16 million) against a collision
 * window of one millisecond in one table, which is the primary key doing the
 * checking anyway.
 */
function newId(): string {
  return Date.now().toString(36).padStart(9, "0") + randomBytes(3).toString("hex");
}

/* ----------------------------------------------------------------- query */

export type WhereOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "in" | "is null" | "is not null";

const WHERE_OPS: WhereOp[] = ["=", "!=", "<", "<=", ">", ">=", "like", "in", "is null", "is not null"];

export interface WhereClause {
  column: string;
  op: WhereOp;
  value?: unknown;
}

export interface QueryOptions {
  where?: WhereClause[];
  /** Case-insensitive substring across every text-ish column. */
  search?: string;
  order?: { column: string; direction?: "asc" | "desc" };
  limit?: number;
  offset?: number;
  /** Soft-deleted rows are hidden unless this is set. */
  includeDeleted?: boolean;
}

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

export interface AggregateOptions {
  /** `count` with no column counts rows. */
  select: { fn: AggregateFn; column?: string; as?: string }[];
  groupBy?: string[];
  where?: WhereClause[];
  order?: { column: string; direction?: "asc" | "desc" };
  limit?: number;
  includeDeleted?: boolean;
}

/**
 * Resolves a caller-supplied name to a column that actually exists.
 *
 * This is the only thing standing between a query argument and a SQL
 * identifier, and identifiers cannot be parameterised — so nothing reaches the
 * string except a name that matched a declaration. Values always go through
 * placeholders; names always go through here.
 */
function columnOrThrow(table: TableDef, name: string): { name: string; col: ColumnDef | null } {
  if ((IMPLICIT_COLUMNS as readonly string[]).includes(name)) return { name, col: null };
  const col = table.columns[name];
  if (!col) {
    throw new Error(
      `${table.name} has no column "${name}" — it has ${Object.keys(table.columns).join(", ")}`,
    );
  }
  return { name, col };
}

function buildWhere(
  table: TableDef,
  clauses: WhereClause[] | undefined,
  search: string | undefined,
  includeDeleted: boolean,
): { sql: string; params: (string | number | null)[] } {
  const parts: string[] = [];
  const params: (string | number | null)[] = [];

  if (!includeDeleted) parts.push("deleted_at IS NULL");

  for (const clause of clauses ?? []) {
    if (!WHERE_OPS.includes(clause.op)) {
      throw new Error(`unsupported operator "${clause.op}" — use one of ${WHERE_OPS.join(", ")}`);
    }
    const { name, col } = columnOrThrow(table, clause.column);

    if (clause.op === "is null" || clause.op === "is not null") {
      parts.push(`${name} ${clause.op.toUpperCase()}`);
      continue;
    }

    if (clause.op === "in") {
      const values = Array.isArray(clause.value) ? clause.value : [clause.value];
      if (values.length === 0) {
        // An empty IN () is a syntax error in SQLite and, read literally, means
        // "match nothing" — which is what this says, without the error.
        parts.push("0 = 1");
        continue;
      }
      parts.push(`${name} IN (${values.map(() => "?").join(", ")})`);
      for (const v of values) params.push(col ? toSql(col, v) : (v as string | number));
      continue;
    }

    parts.push(`${name} ${clause.op.toUpperCase()} ?`);
    params.push(col ? toSql(col, clause.value) : (clause.value as string | number));
  }

  if (search) {
    const searchable = Object.entries(table.columns)
      .filter(([, c]) => c.kind === "text" || c.kind === "enum" || c.kind === "date")
      .map(([n]) => n);
    if (searchable.length > 0) {
      parts.push(`(${searchable.map((n) => `${n} LIKE ? COLLATE NOCASE`).join(" OR ")})`);
      for (const _ of searchable) params.push(`%${search}%`);
    }
  }

  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

function buildOrder(table: TableDef, order: QueryOptions["order"]): string {
  const chosen = order ?? table.order ?? { column: "created_at", direction: "desc" };
  const { name } = columnOrThrow(table, chosen.column);
  const direction = chosen.direction === "asc" ? "ASC" : "DESC";
  // `id` breaks ties so paging cannot repeat or skip a row when several share
  // an ordering value — which for a date column is most of them.
  return `ORDER BY ${name} ${direction}, id ${direction}`;
}

/* ---------------------------------------------------------------- client */

export interface InsertResult {
  row: Row;
  /** False when `ifExists: "ignore"` found a live row with the same key. */
  created: boolean;
}

export interface WriteOptions {
  /** Recorded on the row, so a listing can say which agent or workflow wrote it. */
  writtenBy?: string | null;
}

export interface InsertOptions extends WriteOptions {
  /**
   * What to do when the dedupe key is already taken by a live row.
   * `"ignore"` hands back the existing row with `created: false` — which is
   * what makes a retried tool call safe. `"error"` throws. Default `"ignore"`
   * when the table declares a dedupe key, and irrelevant when it does not.
   */
  ifExists?: "ignore" | "error";
}

export interface TableClient {
  readonly def: LoadedTable;
  insert(values: Record<string, unknown>, opts?: InsertOptions): InsertResult;
  update(id: string, patch: Record<string, unknown>, opts?: WriteOptions): Row;
  get(id: string): Row | null;
  query(opts?: QueryOptions): Row[];
  count(opts?: Pick<QueryOptions, "where" | "search" | "includeDeleted">): number;
  aggregate(opts: AggregateOptions): Record<string, unknown>[];
  /** Soft delete — the row stays, stops being listed, and frees its dedupe key. */
  remove(id: string): boolean;
  /** Puts a soft-deleted row back, if its dedupe key is still free. */
  restore(id: string): boolean;
}

export function table(name: string): TableClient {
  const def = registry.get(name);
  if (!def) {
    const known = allTables().map((t) => t.name);
    throw new Error(
      `no table named "${name}"` + (known.length ? ` — loaded tables are ${known.join(", ")}` : ""),
    );
  }
  return clientFor(def);
}

function clientFor(def: LoadedTable): TableClient {
  const t = physical(def.name);
  const schemas = schemasFor(def);
  const columns = Object.entries(def.columns);

  const findByDedupe = (values: Record<string, unknown>): Row | null => {
    const keys = dedupeColumns(def);
    if (keys.length === 0) return null;
    // A null in the key means "this row opts out of deduping", matching what
    // the unique index itself does — SQLite treats NULLs as distinct, so the
    // index would allow these rows and a lookup that matched `IS NULL` would
    // refuse them. The two have to agree, and the index is the one that is
    // actually enforcing. This is what lets an idempotency key be optional:
    // supply one and a retry is free, leave it out and every insert is a row.
    if (keys.some((k) => values[k] === null || values[k] === undefined)) return null;
    const where = keys.map((k) => `${k} IS ?`).join(" AND ");
    const params = keys.map((k) => toSql(def.columns[k]!, values[k]));
    const raw = db
      .prepare(`SELECT * FROM ${t} WHERE ${where} AND deleted_at IS NULL LIMIT 1`)
      .get(...params) as Record<string, unknown> | null;
    return raw ? hydrate(def, raw) : null;
  };

  return {
    def,

    insert(values, opts = {}) {
      const parsed = schemas.insert.safeParse(values);
      if (!parsed.success) throw new Error(`${def.name}: ${explain(parsed.error)}`);
      const clean = parsed.data as Record<string, unknown>;

      const existing = findByDedupe(clean);
      if (existing) {
        if ((opts.ifExists ?? "ignore") === "error") {
          throw new Error(
            `${def.name}: a row with the same ${dedupeColumns(def).join(" + ")} already exists (${existing.id})`,
          );
        }
        return { row: existing, created: false };
      }

      const now = Date.now();
      const id = newId();
      const names = ["id", "created_at", "updated_at", "written_by", ...columns.map(([n]) => n)];
      const params: (string | number | null)[] = [
        id,
        now,
        now,
        opts.writtenBy ?? null,
        ...columns.map(([n, col]) => toSql(col, clean[n])),
      ];

      db.prepare(
        `INSERT INTO ${t} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      ).run(...params);

      return { row: this.get(id)!, created: true };
    },

    update(id, patch, opts = {}) {
      const parsed = schemas.update.safeParse(patch);
      if (!parsed.success) throw new Error(`${def.name}: ${explain(parsed.error)}`);
      const clean = parsed.data as Record<string, unknown>;

      const current = this.get(id);
      if (!current) throw new Error(`${def.name}: no row with id ${id}`);

      const fields = Object.keys(clean);
      if (fields.length === 0) return current;

      const sets = [...fields.map((f) => `${f} = ?`), "updated_at = ?"];
      const params: (string | number | null)[] = [
        ...fields.map((f) => toSql(def.columns[f]!, clean[f])),
        Date.now(),
      ];
      if (opts.writtenBy !== undefined) {
        sets.push("written_by = ?");
        params.push(opts.writtenBy);
      }
      params.push(id);

      db.prepare(`UPDATE ${t} SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      return this.get(id)!;
    },

    get(id) {
      const raw = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id) as Record<
        string,
        unknown
      > | null;
      return raw ? hydrate(def, raw) : null;
    },

    query(opts = {}) {
      const { sql, params } = buildWhere(def, opts.where, opts.search, opts.includeDeleted ?? false);
      const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
      const offset = Math.max(0, opts.offset ?? 0);
      const rows = db
        .prepare(`SELECT * FROM ${t} ${sql} ${buildOrder(def, opts.order)} LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as Record<string, unknown>[];
      return rows.map((r) => hydrate(def, r));
    },

    count(opts = {}) {
      const { sql, params } = buildWhere(def, opts.where, opts.search, opts.includeDeleted ?? false);
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t} ${sql}`).get(...params) as { n: number };
      return row.n;
    },

    aggregate(opts) {
      if (opts.select.length === 0) throw new Error(`${def.name}: aggregate needs something to select`);

      const selects = opts.select.map(({ fn, column: col, as }) => {
        if (!["count", "sum", "avg", "min", "max"].includes(fn)) {
          throw new Error(`unsupported aggregate "${fn}"`);
        }
        const alias = as ?? (col ? `${fn}_${col}` : fn);
        if (!NAME_PATTERN.test(alias)) throw new Error(`invalid alias "${alias}"`);
        if (fn === "count" && !col) return `COUNT(*) AS ${alias}`;
        if (!col) throw new Error(`${fn} needs a column`);
        return `${fn.toUpperCase()}(${columnOrThrow(def, col).name}) AS ${alias}`;
      });

      const groups = (opts.groupBy ?? []).map((g) => columnOrThrow(def, g).name);
      const { sql, params } = buildWhere(def, opts.where, undefined, opts.includeDeleted ?? false);

      // Grouping columns come back alongside the aggregates, because a total
      // with no label attached to it is not an answer.
      const projection = [...groups, ...selects].join(", ");
      const groupSql = groups.length ? `GROUP BY ${groups.join(", ")}` : "";

      let orderSql = "";
      if (opts.order) {
        const alias = opts.order.column;
        const known = [...groups, ...opts.select.map((s) => s.as ?? (s.column ? `${s.fn}_${s.column}` : s.fn))];
        if (!known.includes(alias)) {
          throw new Error(`cannot order by "${alias}" — the result has ${known.join(", ")}`);
        }
        orderSql = `ORDER BY ${alias} ${opts.order.direction === "asc" ? "ASC" : "DESC"}`;
      }

      const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
      return db
        .prepare(`SELECT ${projection} FROM ${t} ${sql} ${groupSql} ${orderSql} LIMIT ?`)
        .all(...params, limit) as Record<string, unknown>[];
    },

    remove(id) {
      const res = db
        .prepare(`UPDATE ${t} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
        .run(Date.now(), Date.now(), id);
      return res.changes > 0;
    },

    restore(id) {
      const row = this.get(id);
      if (!row || row.deleted_at === null) return false;
      if (findByDedupe(row)) {
        throw new Error(
          `${def.name}: cannot restore ${id} — a live row already holds the same ` +
            `${dedupeColumns(def).join(" + ")}`,
        );
      }
      const res = db
        .prepare(`UPDATE ${t} SET deleted_at = NULL, updated_at = ? WHERE id = ?`)
        .run(Date.now(), id);
      return res.changes > 0;
    },
  };
}

/* ----------------------------------------------------------------- boot */

/**
 * Imports every file under the tables directory, validates the definitions,
 * and brings the schema in line with them.
 *
 * Deliberately the same shape as `loadWorkflows`: subdirectories group,
 * `_`-prefixed files are shared code and skipped, and everything else must
 * default-export or it is an error rather than a quiet skip. Two directories
 * that behave differently would be two things to remember.
 */
export async function loadTables(dir = "./tables"): Promise<LoadedTable[]> {
  const { existsSync } = await import("node:fs");
  const { basename, resolve } = await import("node:path");

  const root = resolve(dir);
  resetTables();
  if (!existsSync(root)) return [];

  const glob = new Bun.Glob("**/*.{ts,js}");
  const files = (await Array.fromAsync(glob.scan({ cwd: root, absolute: true })))
    .filter((f) => !/\.(test|spec|d)\.(ts|js)$/.test(f))
    .filter((f) => !basename(f).startsWith("_"))
    .sort();

  const loaded: LoadedTable[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const rel = file.slice(root.length + 1);
    let mod: { default?: TableDef };
    try {
      mod = await import(file);
    } catch (err) {
      errors.push(`${rel}: failed to import — ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const def = mod.default;
    if (!def || typeof def !== "object" || !def.columns) {
      errors.push(`${rel}: no default export from defineTable()`);
      continue;
    }

    const first = seen.get(def.name);
    if (first) {
      errors.push(`${rel}: duplicate table name "${def.name}" (already in ${first})`);
      continue;
    }
    seen.set(def.name, rel);

    const slash = rel.lastIndexOf("/");
    const table: LoadedTable = {
      ...def,
      file: rel,
      folder: slash === -1 ? null : rel.slice(0, slash),
    };

    try {
      syncSchema(table);
    } catch (err) {
      errors.push(`${rel}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    registerTable(table);
    loaded.push(table);
  }

  if (errors.length) {
    for (const e of errors) log.error(e);
    throw Object.assign(new Error(`${errors.length} problem(s) found while loading tables`), {
      problems: errors,
    });
  }

  if (loaded.length) log.info(`Loaded ${loaded.length} data table(s)`);
  return loaded;
}
