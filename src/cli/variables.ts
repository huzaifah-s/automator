import {
  deleteVariable,
  listVariables,
  loadVariables,
  setVariable,
  variableValue,
} from "../core/variables.ts";

/**
 * `bun run variable -- <command>` — the write side of the variable store.
 *
 * Before workflows are imported, for the same reason the secret CLI is:
 * setting a board id for a workflow you have not deployed yet is exactly what
 * the loader would abort on.
 *
 * A write here goes to the database, not to the running server. The server
 * notices within VARIABLE_REFRESH_MS — see startVariableRefresh().
 *
 * Unlike `secret get`, this prints values in full and does not mask. That is
 * the whole distinction between the two stores: if a value needs hiding, it is
 * in the wrong one, and the setters refuse the obvious cases.
 */

const USAGE = `Usage: bun run variable -- <command>

  list                       Every variable and its value
  get <KEY>                  One value, or the environment's if unset here
  set <KEY>[=<VALUE>] [-m]   Value from stdin when not given inline
  rm  <KEY>                  Delete, restoring the environment's value if any

  -m, --note <text>          A line saying what the variable is for

Variables are for configuration that is NOT a credential — board ids, chat
ids, sheet ids, phone numbers, thresholds. They are stored in plaintext and
are never scrubbed from logs or run pages, which is the point: a redacted
board id makes "which board did this come from" unanswerable. Anything that
authenticates belongs in \`bun run secret\` instead, and this refuses the
obvious cases.

Examples:
  bun run variable -- set STUDENTQR_BOARD_BADGES=1844357900
  bun run variable -- set STUDENTQR_SUPPORT_PHONE=601114356132 -m "gets a copy of everything"
  bun run variable -- list`;

export async function runVariableCli(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  loadVariables();

  switch (command) {
    case "list":
      return list();
    case "get":
      return get(rest);
    case "set":
      return await set(rest);
    case "rm":
      return remove(rest);
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

function list(): number {
  const rows = listVariables();
  if (rows.length === 0) {
    console.log("No variables set. Everything is coming from the environment.");
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.key.length));
  for (const row of rows) {
    const note = row.note ? `   # ${row.note}` : "";
    console.log(`${row.key.padEnd(width)}  ${row.value}${note}`);
  }
  console.log(`\n${rows.length} variable(s).`);
  return 0;
}

function get(args: string[]): number {
  const key = args[0];
  if (!key) {
    console.error("Which variable? bun run variable -- get <KEY>");
    return 1;
  }
  const value = variableValue(key);
  if (value === undefined) {
    console.error(`${key} is not set here or in the environment.`);
    return 1;
  }
  console.log(value);
  return 0;
}

async function set(args: string[]): Promise<number> {
  let note: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-m" || arg === "--note") {
      note = args[++i] ?? null;
    } else {
      positional.push(arg);
    }
  }

  const first = positional[0];
  if (!first) {
    console.error("Which variable? bun run variable -- set <KEY>[=<VALUE>]");
    return 1;
  }

  const eq = first.indexOf("=");
  const key = eq === -1 ? first : first.slice(0, eq);
  // Read from stdin when no value was given inline, so a value never has to
  // appear in shell history.
  const value = eq === -1 ? (await Bun.stdin.text()).replace(/\r?\n$/, "") : first.slice(eq + 1);

  if (value === "") {
    console.error(`No value given for ${key}. Use \`rm\` to delete it.`);
    return 1;
  }

  try {
    setVariable(key, value, note);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  console.log(`${key} set.`);
  return 0;
}

function remove(args: string[]): number {
  const key = args[0];
  if (!key) {
    console.error("Which variable? bun run variable -- rm <KEY>");
    return 1;
  }
  if (!deleteVariable(key)) {
    console.error(`${key} was not stored here.`);
    return 1;
  }
  console.log(`${key} removed.`);
  return 0;
}
