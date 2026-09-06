import { store } from "./db.ts";
import { log } from "./logger.ts";
import { secretSchema } from "./secret-store.ts";

/**
 * Configuration that is deliberately not a secret, kept in the database so
 * changing it is a write rather than a redeploy.
 *
 * The same layering as the secret store, over the same base:
 *
 *   variable  →  environment value  →  missing
 *
 * and mirrored into `process.env`, so a workflow reads one with a plain
 * `process.env.STUDENTQR_BOARD_BADGES ?? "…"` and needs to know nothing about
 * this file.
 *
 * ## Why this is a separate table and not "a secret that isn't secret"
 *
 * `secret-store.ts` registers every value it holds with the log redactor,
 * because it cannot tell a token from a hostname. That is a safety property.
 * Putting a board id in there would scrub the board id out of every run page
 * and log line, and "which board did this come from" is the first question
 * when a notification goes to the wrong school.
 *
 * ## The cost, and what is done about it
 *
 * This store's default is the opposite one: nothing here is protected. A
 * credential pasted into the wrong tab would be rendered on every run page and
 * written to disk in plaintext, with nothing to catch it — which is a footgun
 * the rest of this codebase does not have.
 *
 * So the guard is at the door, and it is three things:
 *
 *   1. A **name** that reads like a credential is refused. This is the one
 *      that matters, because the mistake people actually make is calling
 *      something FOO_TOKEN and not thinking about it again.
 *   2. A **value** that is unmistakably a credential is refused — a JWT, a PEM
 *      block, a provider-prefixed key. Deliberately a short, high-confidence
 *      list: a heuristic that rejects legitimate configuration is a heuristic
 *      people work around.
 *   3. A key that already exists as a **secret** is refused, and vice versa.
 *      One key lives in one store. There is no precedence rule between them
 *      because there is never a contest.
 *
 * And one thing that cannot be a refusal, because it happens after the fact:
 * a workflow declaring `defineSecrets({ FOO })` when FOO is already a
 * variable. That is caught at boot and warned about loudly — see
 * `warnAboutSecretLookalikes`.
 */

/** Env-var shape. Anything else would never be readable from process.env. */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Configuration is short. A value this size is a mistake worth stopping. */
const MAX_VALUE_BYTES = 16 * 1024;

/** How often to notice a write made by another process (the CLI). 0 disables. */
const REFRESH_MS = Number(process.env.VARIABLE_REFRESH_MS ?? process.env.SECRET_REFRESH_MS ?? 10_000);

/**
 * Words that make a name a credential's name. Matched as whole underscore-
 * separated parts, so `TOKEN_BOARD_ID` and `MONDAY_API_TOKEN` are both caught
 * while `KEYWORDS` and `PASSPORT_FIELD` are not.
 */
const SECRET_WORDS = new Set([
  "TOKEN", "SECRET", "SECRETS", "PASSWORD", "PASSWD", "PASS",
  "CREDENTIAL", "CREDENTIALS", "APIKEY", "PRIVATE", "SIGNATURE", "SIGNING",
]);

/**
 * A trailing `_KEY` is a credential; a leading or middle `KEY` often is not
 * (`KEY_PREFIX`, `SORT_KEY`). Checked separately for that reason.
 */
const SECRET_SUFFIXES = ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD"];

/** Values that are a credential and cannot be anything else. */
const SECRET_VALUE_SHAPES: [RegExp, string][] = [
  [/^eyJ[A-Za-z0-9_-]{10,}\./, "a JSON Web Token"],
  [/^-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/^-----BEGIN /, "a PEM block"],
  [/^xkeysib-[A-Za-z0-9]/, "a Brevo API key"],
  [/^sk-[A-Za-z0-9_-]{16,}/, "an OpenAI-style API key"],
  [/^sk_live_|^sk_test_/, "a Stripe secret key"],
  [/^ghp_|^github_pat_/, "a GitHub token"],
  [/^xox[baprs]-/, "a Slack token"],
  [/^EAA[A-Za-z0-9]{20,}/, "a Meta access token"],
];

/** The live answer for every read. */
const values = new Map<string, string>();

/**
 * What process.env held before a variable overwrote it. Deleting one has to
 * put the deploy-time value back rather than leaving ours behind in an
 * environment that no longer claims it.
 */
const envBaseline = new Map<string, string | undefined>();

let watermark = { count: -1, latest: -1 };
let timer: ReturnType<typeof setInterval> | undefined;

/* ------------------------------------------------------------- the guards */

/** Why this name may not be a variable, or undefined if it may. */
export function nameProblem(key: string): string | undefined {
  if (!KEY_PATTERN.test(key)) {
    return `Variable name "${key}" must be uppercase letters, digits, and underscores`;
  }

  const parts = key.split("_");
  const word = parts.find((p) => SECRET_WORDS.has(p));
  const suffix = SECRET_SUFFIXES.find((sfx) => key.endsWith(sfx));

  if (word || suffix) {
    return (
      `"${key}" reads like a credential${word ? ` (${word})` : ""}, and variables are ` +
      `stored in plaintext and never redacted from logs or run pages. ` +
      `Put it in Secrets instead. If it genuinely is not a credential, name it ` +
      `something that does not say it is.`
    );
  }
  return undefined;
}

/** Why this value may not be a variable, or undefined if it may. */
export function valueProblem(key: string, value: string): string | undefined {
  if (value === "") return `Variable "${key}" cannot be empty — delete it instead`;
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) {
    return `Variable "${key}" is over ${MAX_VALUE_BYTES} bytes — that is not configuration`;
  }
  const shape = SECRET_VALUE_SHAPES.find(([re]) => re.test(value.trim()));
  if (shape) {
    return (
      `That value looks like ${shape[1]}. Variables are stored in plaintext and ` +
      `never redacted — put it in Secrets instead.`
    );
  }
  return undefined;
}

/* --------------------------------------------------------------- the read */

/** The current value: variable first, environment second. */
export function variableValue(key: string): string | undefined {
  return values.get(key) ?? process.env[key];
}

export function storedVariableKeys(): string[] {
  return [...values.keys()].sort();
}

/** Everything about every variable. Values included — that is the point. */
export function listVariables(): { key: string; value: string; note: string | null; updated_at: number }[] {
  return store.variableRows();
}

/* --------------------------------------------------------------- the load */

/** Reads the table into memory and into process.env. Returns how many. */
export function loadVariables(): number {
  const rows = store.variableRows();
  const seen = new Set<string>();

  for (const row of rows) {
    seen.add(row.key);
    apply(row.key, row.value);
  }

  // A row deleted by another process has to be un-applied, not just left.
  for (const key of [...values.keys()]) {
    if (!seen.has(key)) unapply(key);
  }

  watermark = store.variableWatermark();
  return values.size;
}

function apply(key: string, value: string): void {
  if (!envBaseline.has(key)) envBaseline.set(key, process.env[key]);
  values.set(key, value);
  process.env[key] = value;
  // Deliberately NOT registerSecret(value). See the header.
}

function unapply(key: string): void {
  values.delete(key);
  const original = envBaseline.get(key);
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
  envBaseline.delete(key);
}

/* -------------------------------------------------------------- the write */

export function setVariable(key: string, value: string, note?: string | null): void {
  const bad = nameProblem(key) ?? valueProblem(key, value);
  if (bad) throw new Error(bad);

  // One key, one store. Refusing here rather than defining a precedence is the
  // whole reason there is nothing to reason about at read time.
  //
  // Read straight out of the table rather than through storedSecretKeys(),
  // which answers from memory and is therefore empty until loadSecretStore()
  // has run. The CLI is exactly the caller that had not run it, so the guard
  // silently passed everything — the check has to be true regardless of what
  // this process happens to have loaded.
  if (store.secretRows().some((r) => r.key === key)) {
    throw new Error(
      `"${key}" already exists as a secret. Delete it there first if it really is ` +
        `configuration — a key lives in one store or the other, never both.`,
    );
  }

  store.variablePut(key, value, note ?? null);
  apply(key, value);
  watermark = store.variableWatermark();
}

export function deleteVariable(key: string): boolean {
  const existed = store.variableDrop(key);
  unapply(key);
  watermark = store.variableWatermark();
  return existed;
}

/**
 * The one unsafe case that cannot be refused at the door: a variable named
 * FOO already exists, and then a workflow is deployed that declares FOO with
 * `defineSecrets`. The value is now a declared credential living unencrypted
 * in a table that is never redacted.
 *
 * Called after the loader, because that is when the declarations exist. A
 * warning rather than a boot failure: the deployment is already running on
 * this value, and refusing to start would not un-store it.
 */
export function warnAboutSecretLookalikes(): void {
  for (const key of values.keys()) {
    if (!secretSchema(key)) continue;
    log.warn(
      `Variable ${key} is also declared as a secret by a workflow. It is stored ` +
        `in plaintext and is NOT redacted from logs or run pages. Move it: ` +
        `bun run secret -- set ${key}, then bun run variable -- rm ${key}`,
    );
  }
}

/* ------------------------------------------------------------- the refresh */

/**
 * Notices writes made by another process — `bun run variable set` talks to the
 * database, not to the running server. Same probe as the secret store's, over
 * a table with tens of rows.
 */
export function startVariableRefresh(): void {
  if (timer || REFRESH_MS <= 0) return;
  timer = setInterval(() => {
    try {
      const now = store.variableWatermark();
      if (now.count === watermark.count && now.latest === watermark.latest) return;
      const n = loadVariables();
      log.debug(`Reloaded ${n} variable(s) after an outside write`);
    } catch (err) {
      log.error(`Variable refresh failed: ${err instanceof Error ? err.message : err}`);
    }
  }, REFRESH_MS);
  timer.unref?.();
}

export function stopVariableRefresh(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
