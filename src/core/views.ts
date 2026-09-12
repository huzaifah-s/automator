/**
 * Views — read-only pages built from the data this runner already holds.
 *
 * A view is a file under `views/`, exactly the way a workflow is a file under
 * `workflows/` and a table is a file under `tables/`. It default-exports
 * `defineView()`, the loader finds it, and it hot-reloads on a file change
 * without a restart. Nothing about a view is editable from a browser, and that
 * is the same decision as everywhere else in this project: the page's
 * structure is code, its data is the database.
 *
 * Three things worth knowing before changing anything in here.
 *
 * **A view is a pure read and that is what makes reloading it free.** It has
 * no trigger, no schedule, no state and no write path — `load()` is called
 * while a request is in flight and its result is thrown away. So unlike data
 * tables, which own DDL and therefore load exactly once at boot, a view can be
 * swapped in mid-flight with nothing to be half-applied.
 *
 * **Where this file sits relative to `src/server/views.ts`.** That one is the
 * dashboard's HTML — every page in this application. This one is the Views
 * feature. They share a word and nothing else; the panels declared here are
 * rendered by `src/server/view-render.ts`.
 *
 * **`shareable` is the only thing that can grant a public link, and it lives
 * in the file.** The dashboard mints and revokes the link itself, but it can
 * never mint one for a view whose file did not opt in, and flipping the flag
 * back to false kills every existing link on the next request. Same asymmetry
 * as pausing a workflow: the database may only ever subtract from what the
 * repository says.
 */

import { Database } from "bun:sqlite";
import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { databasePath, store } from "./db.ts";
import { log } from "./logger.ts";
import {
  allTables,
  getTable,
  physicalTableName,
  table as dataTable,
  type AggregateOptions,
  type LoadedTable,
  type QueryOptions,
  type Row,
} from "./tables.ts";

/* ----------------------------------------------------------------- panels */

/** The tone a number is read in. `plain` is the default and says nothing. */
export type Tone = "plain" | "good" | "bad" | "warn";

export interface StatItem {
  label: string;
  /** Already formatted — the renderer prints it verbatim. */
  value: string;
  /** One line under the number: a comparison, a count, a caveat. */
  sub?: string;
  tone?: Tone;
}

export interface BarRow {
  label: string;
  /** Sizes the bar. Negative values are clamped to zero for width only. */
  value: number;
  /** What to print at the end of the row. Defaults to the value. */
  display?: string;
  sub?: string;
  tone?: Tone;
}

export interface SeriesPoint {
  label: string;
  /** One number per entry in the panel's `legend`, in that order. */
  values: number[];
  /** Printed in the tooltip instead of the raw numbers, same order. */
  displays?: string[];
}

export interface RowColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  /** Renders the cell in the monospace face — ids, dates, amounts. */
  mono?: boolean;
}

export type RowDatum = Record<string, string | number | null | undefined>;

export type Panel =
  | { kind: "stats"; items: StatItem[] }
  | { kind: "bars"; title?: string; note?: string; rows: BarRow[]; empty?: string }
  | {
      kind: "series";
      title?: string;
      note?: string;
      legend: string[];
      points: SeriesPoint[];
      /** Prefix on the axis ticks, e.g. "RM". The values are in display units. */
      unit?: string;
      empty?: string;
    }
  | {
      kind: "rows";
      title?: string;
      note?: string;
      columns: RowColumn[];
      data: RowDatum[];
      empty?: string;
    }
  | { kind: "note"; title?: string; body: string };

/** A row of KPI tiles. */
export function stats(items: StatItem[]): Panel {
  return { kind: "stats", items };
}

/** A ranked breakdown — one labelled bar per row, widths relative to the largest. */
export function bars(args: {
  title?: string;
  note?: string;
  rows: BarRow[];
  empty?: string;
}): Panel {
  return { kind: "bars", ...args };
}

/**
 * A grouped column chart over time. `legend` names the series and every
 * point's `values` must line up with it — a mismatch is caught at render.
 */
export function series(args: {
  title?: string;
  note?: string;
  legend: string[];
  points: SeriesPoint[];
  /**
   * Prefix on the axis ticks, e.g. "RM".
   *
   * Note what this implies about `values`: they are in the units you want
   * *displayed*, not the units the column is stored in. A money column holds
   * whole cents, so a view converts before it gets here — otherwise the axis
   * reads "120k" for a twelve-hundred-ringgit month.
   */
  unit?: string;
  empty?: string;
}): Panel {
  return { kind: "series", ...args };
}

/** A plain table. Cells are printed as given; format before you get here. */
export function rows(args: {
  title?: string;
  note?: string;
  columns: RowColumn[];
  data: RowDatum[];
  empty?: string;
}): Panel {
  return { kind: "rows", ...args };
}

/** A paragraph. For the sentence that explains what the panel above means. */
export function note(args: { title?: string; body: string }): Panel {
  return { kind: "note", ...args };
}

/* --------------------------------------------------------------- controls */

/**
 * The periods a `period` control offers. A closed set, because each one has to
 * mean the same thing everywhere it is used — "last month" is a calendar month
 * and not thirty days, and a view that decided that for itself would make two
 * panels on the same page disagree.
 */
export const PERIOD_KEYS = [
  "today",
  "7d",
  "30d",
  "90d",
  "this-month",
  "last-month",
  "3m",
  "6m",
  "12m",
  "ytd",
  "all",
] as const;

export type PeriodKey = (typeof PERIOD_KEYS)[number];

/**
 * Exported because the dashboard's control row labels the same keys, and a
 * second copy of this map there is a copy that can be — and was — forgotten:
 * a period added here rendered as its own key ("today") in the select until
 * the two were joined. One map, and `Record<PeriodKey, …>` makes forgetting an
 * entry a type error rather than a lowercase word in a dropdown.
 */
export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "this-month": "This month",
  "last-month": "Last month",
  "3m": "Last 3 months",
  "6m": "Last 6 months",
  "12m": "Last 12 months",
  ytd: "This year",
  all: "All time",
};

export interface Period {
  key: PeriodKey;
  label: string;
  /** Inclusive start as YYYY-MM-DD, or null for "no lower bound". */
  from: string | null;
  /** Inclusive end as YYYY-MM-DD. Always today for the relative periods. */
  to: string;
  /** The same lower bound as epoch milliseconds, for anything time-stamped. */
  since: number | null;
}

export type ControlDef =
  | { kind: "period"; label?: string; default?: PeriodKey; options?: readonly PeriodKey[] }
  | {
      kind: "select";
      label?: string;
      options: readonly string[] | readonly { value: string; label: string }[];
      default?: string;
      /** Label for the empty choice. Omit to make the control mandatory. */
      all?: string;
    }
  | { kind: "search"; label?: string; placeholder?: string };

/**
 * Resolves a period key against the clock.
 *
 * Deliberately computed in the server's local timezone rather than UTC: the
 * dates in a ledger are the dates on the receipts, written by somebody living
 * in one place, and "this month" on the 1st at 07:00 in Kuala Lumpur must not
 * still mean last month because UTC has not caught up.
 */
export function periodRange(key: PeriodKey, now = new Date()): Period {
  const label = PERIOD_LABELS[key];
  const to = isoDate(now);

  const daysAgo = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d;
  };
  const monthsAgo = (n: number) => {
    const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
    return d;
  };

  let fromDate: Date | null;
  let end = to;
  switch (key) {
    // The one period whose two ends are the same day. `daysAgo(0)` rather than
    // a bare `now` so it reads as the zero of the same run as "7d" is six of.
    case "today":
      fromDate = daysAgo(0);
      break;
    case "7d":
      fromDate = daysAgo(6);
      break;
    case "30d":
      fromDate = daysAgo(29);
      break;
    case "90d":
      fromDate = daysAgo(89);
      break;
    case "this-month":
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "last-month": {
      fromDate = monthsAgo(1);
      // The last day of the previous month, which is day zero of this one.
      end = isoDate(new Date(now.getFullYear(), now.getMonth(), 0));
      break;
    }
    case "3m":
      fromDate = monthsAgo(2);
      break;
    case "6m":
      fromDate = monthsAgo(5);
      break;
    case "12m":
      fromDate = monthsAgo(11);
      break;
    case "ytd":
      fromDate = new Date(now.getFullYear(), 0, 1);
      break;
    case "all":
      fromDate = null;
      break;
  }

  return {
    key,
    label,
    from: fromDate ? isoDate(fromDate) : null,
    to: end,
    since: fromDate ? new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()).getTime() : null,
  };
}

/** YYYY-MM-DD in local time. `toISOString()` would answer in UTC. */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Whole minor units as a decimal — the one formatter every money column needs.
 *
 * Named `formatMoney` and not `money` because `money()` is already the column
 * builder a table file imports from the same barrel, and two things called
 * money in one import list is a bug waiting to be typed.
 */
export function formatMoney(cents: number | null | undefined, currency = "RM"): string {
  const value = Math.round(Number(cents ?? 0)) / 100;
  const text = Math.abs(value).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? "-" : ""}${currency}${currency ? " " : ""}${text}`;
}

/* -------------------------------------------------------------- the view */

export interface ViewDef {
  /** Lowercase, digits and dashes — it is a URL segment. */
  name: string;
  title: string;
  /** One line, shown on the Views tab and under the title. */
  description?: string;
  /**
   * Whether a share link may exist for this view at all.
   *
   * False by default, and that default is the important half: a view renders
   * real data, and a page that becomes publicly readable because somebody
   * forgot to say otherwise is the wrong way round. Set it to true and the
   * dashboard can mint an unguessable link; set it back to false and every
   * link that was ever minted stops resolving immediately.
   */
  shareable?: boolean;
  /** Seconds between background refreshes of the page. Null leaves it alone. */
  refresh?: number | null;
  /** Filters rendered above the panels and resolved from the querystring. */
  controls?: Record<string, ControlDef>;
  /** Builds the page. Called per request; must not write anything. */
  load(ctx: ViewCtx): Panel[] | Promise<Panel[]>;
}

export interface LoadedView extends ViewDef {
  /** Path relative to the views directory, e.g. `finance/overview.ts`. */
  file: string;
  /** The subdirectory it lives in, which is how the tab groups them. */
  folder: string | null;
  /** Content hash of the file, for the "updated" column. */
  hash: string;
}

/** The read side of a data table. A view gets no writes, by construction. */
export interface ReadOnlyTable {
  readonly def: LoadedTable;
  query(opts?: QueryOptions): Row[];
  count(opts?: Pick<QueryOptions, "where" | "search" | "includeDeleted">): number;
  aggregate(opts: AggregateOptions): Record<string, unknown>[];
  get(id: string): Row | null;
}

/** Operational data — the same numbers the Executions tab is built from. */
export interface RunReader {
  /** Runs by status since a moment, as `{ success: 12, failed: 1 }`. */
  counts(since: number): Record<string, number>;
  /** Runs matching a filter, newest first. */
  list(opts?: {
    status?: string;
    workflow?: string;
    since?: number;
    limit?: number;
  }): ReturnType<typeof store.filteredRuns>;
  /** The slowest and most-retried steps in a window. */
  stepHotspots(since: number, limit?: number): ReturnType<typeof store.stepHotspots>;
  /** The outbound HTTP calls costing the most time in a window. */
  callHotspots(since: number): ReturnType<typeof store.callHotspots>;
  /** Runs per workflow per UTC day, one row per status. */
  daily(since: number, workflow?: string): ReturnType<typeof store.dailyCounts>;
}

export interface ViewCtx {
  /** The read side of a data table, by the name in its `tables/` file. */
  table(name: string): ReadOnlyTable;
  /** Every loaded table, for a view that wants to iterate them. */
  tables(): LoadedTable[];
  /**
   * A read-only SELECT.
   *
   * This runs on a **separate, read-only handle** to the same database, so it
   * cannot write whatever it is asked to — the guard below is the error
   * message, the handle is the enforcement.
   *
   * Values go through placeholders and identifiers do not go through anything:
   * never interpolate a control value into the query string. Resolve a table's
   * physical name with `ctx.from("expenses")` rather than writing `t_expenses`,
   * so a query stops working loudly if the table is renamed.
   */
  sql<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T[];
  /** The physical name of a declared table, for use inside `ctx.sql`. */
  from(table: string): string;
  runs: RunReader;
  /** A control's resolved value — validated, or its default. */
  control(name: string): string;
  /** A `period` control, resolved against the clock. */
  period(name: string): Period;
  /** Every resolved control, for building links back to the same page. */
  controls: Record<string, string>;
  /** When this render started, so every panel agrees on "now". */
  now: number;
  /** True when this render is being served over a public share link. */
  isPublic: boolean;
}

export function defineView(def: ViewDef): ViewDef {
  if (!def.name?.trim()) throw new Error("View is missing a name");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(def.name)) {
    throw new Error(`View name "${def.name}" must be lowercase letters, digits, and dashes`);
  }
  if (!def.title?.trim()) throw new Error(`View "${def.name}" is missing a title`);
  if (typeof def.load !== "function") throw new Error(`View "${def.name}" has no load()`);

  for (const [key, control] of Object.entries(def.controls ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new Error(
        `View "${def.name}": control "${key}" must be lowercase letters, digits and underscores — it is a query parameter`,
      );
    }
    if (control.kind === "period") {
      const offered = control.options ?? PERIOD_KEYS;
      for (const opt of offered) {
        if (!PERIOD_KEYS.includes(opt)) {
          throw new Error(
            `View "${def.name}": control "${key}" offers "${opt}", which is not a period — use one of ${PERIOD_KEYS.join(", ")}`,
          );
        }
      }
      if (control.default && !offered.includes(control.default)) {
        throw new Error(
          `View "${def.name}": control "${key}" defaults to "${control.default}", which is not one of the periods it offers`,
        );
      }
    }
    if (control.kind === "select" && control.options.length === 0) {
      throw new Error(`View "${def.name}": control "${key}" is a select with no options`);
    }
  }
  return def;
}

/* ------------------------------------------------------------------- ctx */

/** The most rows one `ctx.sql` may hand back. See `sql` below for why it throws. */
export const MAX_SQL_ROWS = 5_000;

let reader: Database | undefined;

/**
 * The read-only handle.
 *
 * Opened lazily and kept, because opening one per request would be a file open
 * per page load. `readonly` is the actual guarantee that a view cannot write:
 * SQLite refuses the statement at the engine, whatever the string said.
 */
function readerDb(): Database {
  return (reader ??= new Database(databasePath, { readonly: true }));
}

/** Closes the read-only handle. Called from the shutdown path. */
export function closeViewReader(): void {
  reader?.close();
  reader = undefined;
}

function assertSelect(query: string): void {
  const trimmed = query.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error(
      "ctx.sql runs SELECT (or WITH … SELECT) and nothing else — a view never writes",
    );
  }
  // One statement per call. A semicolon inside a string literal is refused
  // along with the rest, which costs a view an awkward query and is the right
  // way round for the one guard standing in front of a raw query string.
  if (trimmed.includes(";")) {
    throw new Error("ctx.sql runs one statement per call — the query contains a ';'");
  }
}

function readOnlyTable(name: string): ReadOnlyTable {
  const client = dataTable(name);
  return {
    def: client.def,
    query: (opts) => client.query(opts),
    count: (opts) => client.count(opts),
    aggregate: (opts) => client.aggregate(opts),
    get: (id) => client.get(id),
  };
}

const runReader: RunReader = {
  counts: (since) => store.statusCountsSince(since),
  list: (opts = {}) =>
    store.filteredRuns(
      { status: opts.status, workflow: opts.workflow, since: opts.since },
      opts.limit ?? 50,
    ),
  stepHotspots: (since, limit) => store.stepHotspots(since, limit),
  callHotspots: (since) => store.callHotspots(since),
  daily: (since, workflow) => store.dailyCounts(since, workflow),
};

/**
 * Resolves the querystring against a view's declared controls.
 *
 * Anything unrecognised falls back to the default rather than being rejected:
 * a share link with a stale parameter on it should render the view, not a 400.
 * This is the same direction the Executions tab already takes with `?status=`.
 */
export function resolveControls(
  def: ViewDef,
  query: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, control] of Object.entries(def.controls ?? {})) {
    const given = (query[key] ?? "").trim();
    if (control.kind === "period") {
      const offered = control.options ?? PERIOD_KEYS;
      const fallback = control.default ?? offered[0]!;
      out[key] = (offered as readonly string[]).includes(given) ? given : fallback;
    } else if (control.kind === "select") {
      const values = control.options.map((o) => (typeof o === "string" ? o : o.value));
      const fallback = control.default ?? (control.all !== undefined ? "" : values[0]!);
      out[key] = values.includes(given) ? given : fallback;
    } else {
      // Free text. Capped so a control value cannot become a payload, and
      // views are handed it as data — never spliced into SQL.
      out[key] = given.slice(0, 120);
    }
  }
  return out;
}

export function buildViewCtx(
  def: ViewDef,
  controls: Record<string, string>,
  opts: { isPublic: boolean } = { isPublic: false },
): ViewCtx {
  const now = Date.now();
  return {
    table: readOnlyTable,
    tables: allTables,
    from(name) {
      if (!getTable(name)) {
        throw new Error(
          `no table named "${name}" — loaded tables are ${allTables()
            .map((t) => t.name)
            .join(", ")}`,
        );
      }
      return physicalTableName(name);
    },
    sql(query, ...params) {
      assertSelect(query);
      const result = readerDb().prepare(query).all(...params) as any[];
      if (result.length > MAX_SQL_ROWS) {
        // Throws rather than truncating, for the same reason ctx.http.paginate
        // does: a chart drawn from the first five thousand of something is
        // wrong in a way nobody looking at it can see.
        throw new Error(
          `a ctx.sql query in view "${def.name}" returned more than ${MAX_SQL_ROWS} rows — ` +
            `aggregate it in SQL or add a LIMIT`,
        );
      }
      return result;
    },
    runs: runReader,
    control(name) {
      if (!(name in (def.controls ?? {}))) {
        throw new Error(`View "${def.name}" has no control named "${name}"`);
      }
      return controls[name] ?? "";
    },
    period(name) {
      const control = def.controls?.[name];
      if (!control || control.kind !== "period") {
        throw new Error(`View "${def.name}" has no period control named "${name}"`);
      }
      return periodRange((controls[name] ?? control.default ?? "30d") as PeriodKey, new Date(now));
    },
    controls,
    now,
    isPublic: opts.isPublic,
  };
}

/* -------------------------------------------------------------- registry */

let views: LoadedView[] = [];

export const viewRegistry = {
  all: (): LoadedView[] => views,
  get: (name: string): LoadedView | undefined => views.find((v) => v.name === name),
  /** One assignment, so nothing can observe a half-swapped set. */
  replace: (next: LoadedView[]): void => {
    views = next;
  },
};

/**
 * Imports every view file and validates the set before anything is swapped in.
 *
 * Same shape as `loadWorkflows`, and for the same reasons: a duplicate name or
 * a missing default export is a problem at load rather than a surprise on the
 * first request, and `version` is what makes a reload re-import rather than
 * reuse the module already in memory.
 */
export async function loadViews(dir = "./views", version?: string): Promise<LoadedView[]> {
  const root = resolve(dir);
  if (!existsSync(root)) {
    log.debug(`No views directory at ${root} — the Views tab will be empty`);
    return [];
  }

  const loaded: LoadedView[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>();

  const glob = new Bun.Glob("**/*.{ts,js}");
  const files = (await Array.fromAsync(glob.scan({ cwd: root, absolute: true })))
    .filter((f) => !/\.(test|spec|d)\.(ts|js)$/.test(f))
    // Same rule as workflows/: an underscore prefix is shared code for a folder
    // of related views, and everything else must default-export one.
    .filter((f) => !basename(f).startsWith("_"))
    .sort();

  for (const file of files) {
    const rel = file.slice(root.length + 1);
    let mod: { default?: ViewDef };
    try {
      mod = await import(version === undefined ? file : `${file}?v=${version}`);
    } catch (err) {
      errors.push(`${rel}: failed to import — ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const def = mod.default;
    if (!def || typeof def.load !== "function") {
      errors.push(`${rel}: no default export from defineView()`);
      continue;
    }

    const first = seen.get(def.name);
    if (first) {
      errors.push(`${rel}: duplicate view name "${def.name}" (already in ${first})`);
      continue;
    }
    seen.set(def.name, rel);

    const slash = rel.lastIndexOf("/");
    loaded.push({
      ...def,
      file: rel,
      folder: slash === -1 ? null : rel.slice(0, slash),
      hash: new Bun.CryptoHasher("sha256").update(await Bun.file(file).text()).digest("hex"),
    });
  }

  if (errors.length) {
    for (const e of errors) log.error(e);
    throw Object.assign(new Error(`${errors.length} problem(s) found while loading views`), {
      problems: errors,
    });
  }

  if (loaded.length) {
    const shared = loaded.filter((v) => v.shareable).length;
    log.info(
      `Loaded ${loaded.length} view(s)` + (shared ? ` (${shared} can be shared publicly)` : ""),
    );
  }
  return loaded;
}
