import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  deleteSecret,
  loadSecretStore,
  secretSchema,
  secretStoreReady,
  secretValue,
  setSecret,
  storedSecretKeys,
} from "../core/secret-store.ts";
import { store } from "../core/db.ts";
import { initCredentials, listCredentials } from "../core/credentials.ts";

/**
 * `bun run secret -- <command>` — the write side of the secret store.
 *
 * This runs *before* workflows are imported, deliberately. Setting a
 * credential for a workflow you haven't deployed yet is the main reason the
 * store exists, and loadWorkflows() would abort on that workflow's missing key
 * before you ever got the chance.
 *
 * A write here goes to the database, not to the running server. The server
 * notices within SECRET_REFRESH_MS — see startSecretRefresh().
 */

const USAGE = `Usage: bun run secret -- <command>

  list                   Every stored secret and credential, names only
  get <KEY> [--reveal]   Masked by default
  set <KEY>[=<VALUE>]    Value from stdin when not given inline
  rm  <KEY>              Delete, restoring the environment's value if it has one

Examples:
  bun run secret -- list
  bun run secret -- set BREVO_API_KEY            # then paste, then Ctrl-D
  echo -n "$TOKEN" | bun run secret -- set SLACK_BOT_TOKEN
  bun run secret -- rm OLD_API_KEY`;

export async function runSecretCli(args: string[]): Promise<number> {
  const [command, ...rest] = args;

  await loadSecretStore();
  // So `list` can tell a credential's field from a loose secret, and so the
  // primary env mapping is in place for the tolerant import pass below.
  initCredentials();

  switch (command) {
    case "list":
      return list();
    case "get":
      return get(rest);
    case "set":
      return await set(rest);
    case "rm":
    case "delete":
      return remove(rest);
    default:
      console.error(command ? `Unknown command "${command}"\n` : "");
      console.error(USAGE);
      return command ? 1 : 0;
  }
}

function list(): number {
  const keys = storedSecretKeys();
  const credentials = listCredentials();

  if (keys.length === 0) {
    console.log("No stored secrets. Everything is coming from the environment.");
    if (!secretStoreReady()) console.log(keyHint());
    return 0;
  }

  const meta = new Map(store.secretMeta().map((r) => [r.key, r]));

  if (credentials.length > 0) {
    console.log("Credentials");
    for (const { row, missing } of credentials) {
      const state =
        missing.length > 0
          ? `incomplete (${missing.join(", ")})`
          : row.test_ok === null
            ? "untested"
            : row.test_ok === 1
              ? "connected"
              : "failing";
      console.log(
        `  ${`${row.provider}:${row.id}`.padEnd(30)} ${state.padEnd(24)}` +
          `${row.folder ? `[${row.folder}]` : ""}${row.is_primary ? " primary" : ""}`,
      );
    }
    console.log("");
  }

  // Fields belonging to a credential are listed above as one thing; repeating
  // them here as five loose names is what the grouping exists to stop.
  const loose = keys.filter((key) => !meta.get(key)?.owner);
  if (loose.length > 0) {
    console.log("Secrets");
    for (const key of loose) {
      const row = meta.get(key);
      console.log(
        `  ${key.padEnd(34)} ${row ? new Date(row.updated_at).toISOString() : ""}` +
          `${row?.folder ? `  [${row.folder}]` : ""}`,
      );
    }
    console.log("");
  }

  console.log(
    `${loose.length} secret(s) and ${credentials.length} credential(s) stored. ` +
      `Values are never printed by list.`,
  );
  return 0;
}

function get(args: string[]): number {
  const key = args[0];
  if (!key) {
    console.error("Usage: bun run secret -- get <KEY> [--reveal]");
    return 1;
  }

  const value = secretValue(key);
  if (value === undefined) {
    console.error(`${key} is not set, in the store or the environment`);
    return 1;
  }

  const source = storedSecretKeys().includes(key) ? "store" : "environment";
  // Revealing is an explicit act. The default has to be safe because the
  // obvious way to look at a key is over a shared terminal.
  const shown = args.includes("--reveal") ? value : mask(value);
  console.log(`${key}=${shown}    (${source})`);
  return 0;
}

async function set(args: string[]): Promise<number> {
  const first = args[0];
  if (!first) {
    console.error("Usage: bun run secret -- set <KEY>[=<VALUE>]");
    return 1;
  }

  const eq = first.indexOf("=");
  const key = eq === -1 ? first : first.slice(0, eq);
  let value = eq === -1 ? undefined : first.slice(eq + 1);

  if (value === undefined) {
    // Off the command line by default: an inline value lands in shell history
    // and in the process list of every other user on the box.
    if (process.stdin.isTTY) {
      process.stderr.write(`Value for ${key} (end with Ctrl-D):\n`);
    }
    value = (await Bun.stdin.text()).replace(/\r?\n$/, "");
  }

  if (!value) {
    console.error(`No value given for ${key}`);
    return 1;
  }

  // Editing one field of a credential from here would go around the bundle's
  // own validation and leave its "connected" state claiming something that is
  // no longer true.
  const owner = store.secretMeta().find((r) => r.key === key)?.owner;
  if (owner) {
    console.error(
      `${key} is a field of credential ${owner}. Edit it on the Credentials tab, ` +
        `or with PUT /api/credentials/${owner.replace(":", "/")}.`,
    );
    return 1;
  }

  // Schemas only exist once the declaring workflow has been imported, and this
  // command runs before the loader on purpose. Collect them tolerantly instead,
  // so `set` is checked against the same zod schema the workflow declared.
  const schemas = await collectSchemas();
  const checked = secretSchema(key) !== undefined;

  try {
    await setSecret(key, value);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!checked) {
    console.warn(
      `Warning: nothing declares ${key}, so the value was not validated` +
        (schemas.skipped.length > 0
          ? ` (${schemas.skipped.length} workflow file(s) could not be read for schemas)`
          : ""),
    );
  }

  const refresh = Number(process.env.SECRET_REFRESH_MS ?? 10_000);
  console.log(
    `Set ${key}.` +
      (refresh > 0
        ? ` A running server picks it up within ${Math.round(refresh / 1000)}s — no restart.`
        : " SECRET_REFRESH_MS is 0, so a running server needs a restart."),
  );
  return 0;
}

function remove(args: string[]): number {
  const key = args[0];
  if (!key) {
    console.error("Usage: bun run secret -- rm <KEY>");
    return 1;
  }

  const owner = store.secretMeta().find((r) => r.key === key)?.owner;
  if (owner) {
    console.error(
      `${key} is a field of credential ${owner}. Delete the credential instead, ` +
        `so its other fields do not outlive it.`,
    );
    return 1;
  }

  if (!deleteSecret(key)) {
    console.error(`${key} was not in the store (nothing deleted)`);
    return 1;
  }

  // Worth saying explicitly: deleting from the store is not the same as
  // unsetting the credential, and the difference is invisible otherwise.
  const fallback = secretValue(key);
  console.log(
    `Deleted ${key}.` +
      (fallback === undefined
        ? ""
        : " The environment still sets it, so that value is live again."),
  );
  return 0;
}

/**
 * Imports every workflow purely for the side effect of defineSecrets()
 * registering its schemas, and swallows every failure.
 *
 * A workflow whose credentials are missing is exactly the one being set up, and
 * its module scope may well throw on the way past — hmacSignature refuses an
 * empty secret at import, for one. That file simply contributes no schema; it
 * must not stop the write, which is the whole reason this command runs outside
 * the loader.
 */
async function collectSchemas(): Promise<{ skipped: string[] }> {
  const root = resolve(process.env.WORKFLOWS_DIR ?? "./workflows");
  const skipped: string[] = [];
  if (!existsSync(root)) return { skipped };

  const glob = new Bun.Glob("**/*.{ts,js}");
  const files = (await Array.fromAsync(glob.scan({ cwd: root, absolute: true }))).filter(
    (f) => !/\.(test|spec|d)\.(ts|js)$/.test(f),
  );

  for (const file of files) {
    try {
      await import(file);
    } catch {
      skipped.push(file.slice(root.length + 1));
    }
  }
  return { skipped };
}

function mask(value: string): string {
  if (value.length <= 12) return "•".repeat(8);
  return `${value.slice(0, 4)}${"•".repeat(8)}${value.slice(-2)}`;
}

function keyHint(): string {
  return (
    "\nSECRETS_ENCRYPTION_KEY is not set, so nothing can be stored yet.\n" +
    "Generate one with: openssl rand -base64 32"
  );
}
