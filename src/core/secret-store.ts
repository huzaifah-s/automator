import type { ZodTypeAny } from "zod";
import { store } from "./db.ts";
import { createCipher, keyProblem } from "./crypto.ts";
import { registerSecret } from "./redact.ts";
import { log } from "./logger.ts";

/**
 * Credentials that live in the database instead of the environment, so adding
 * or rotating one is a write rather than a redeploy.
 *
 * The environment is still the base layer and still the only place the master
 * key can live. This store sits on top of it:
 *
 *   store value  →  environment value  →  missing
 *
 * The store wins deliberately. If the environment won, changing a credential
 * that a deploy had already set would need another deploy, which is the whole
 * thing this exists to avoid.
 *
 * Two consumers, both covered:
 *
 *   - defineSecrets() reads through secretValue() on every property access,
 *     so a workflow picks up a new value on its next run;
 *   - integrations read process.env directly inside their factories, so every
 *     loaded value is mirrored into process.env as well.
 *
 * Values are AES-256-GCM encrypted with SECRETS_ENCRYPTION_KEY (falling back
 * to OAUTH_ENCRYPTION_KEY, so an existing deployment needs no new variable).
 * With no key set at all this is inert and everything falls through to the
 * environment, exactly as it did before the store existed.
 */

const KEY_ENVS = ["SECRETS_ENCRYPTION_KEY", "OAUTH_ENCRYPTION_KEY"] as const;
const cipher = createCipher(KEY_ENVS);

/** Env-var shape. Anything else would never be readable from process.env. */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** A single credential is never megabytes; a typo that is, shouldn't commit. */
const MAX_VALUE_BYTES = 64 * 1024;

/** How often to notice a write made by another process (the CLI). 0 disables. */
const REFRESH_MS = Number(process.env.SECRET_REFRESH_MS ?? 10_000);

/** Decrypted, live. The authoritative answer for every read. */
const values = new Map<string, string>();

/**
 * What process.env held for a key before the store overwrote it. Deleting a
 * stored value has to put the deploy-time one back, not leave the store's
 * value behind in an environment that no longer claims it.
 */
const envBaseline = new Map<string, string | undefined>();

/** Schemas contributed by defineSecrets(), so a write can be rejected early. */
const schemas = new Map<string, ZodTypeAny>();

/** The same, for defineSecretGroup — one schema covering PREFIX_<ANYTHING>. */
const prefixSchemas = new Map<string, ZodTypeAny>();

/** Keys whose stored value wouldn't decrypt, so the warning is said once. */
const undecryptable = new Set<string>();

let watermark = { count: -1, latest: -1 };
let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Called after anything changes what secretValue() would answer. One listener
 * today: src/core/credentials.ts re-derives the env vars a primary credential
 * supplies. A callback rather than a direct import because credentials.ts
 * imports this file, and the cycle would be real at runtime, not just in the
 * types.
 */
const listeners: (() => void)[] = [];

export function onSecretsChanged(fn: () => void): void {
  listeners.push(fn);
}

/**
 * Whether a stored value should be scrubbed from logs. Everything is, by
 * default — this store cannot tell a token from a hostname.
 *
 * Credentials can. A provider declares which of its fields are configuration
 * rather than secrets, and registering a hostname or a from-address with the
 * redactor would mangle every log line that legitimately mentions it. The
 * policy is installed by src/core/credentials.ts at import, which is before
 * loadSecretStore() runs and therefore before the first value is applied.
 */
let redactable: (key: string) => boolean = () => true;

export function setRedactionPolicy(fn: (key: string) => boolean): void {
  redactable = fn;
}

function announce(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      log.error(`Secret listener failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/* ------------------------------------------------------------------ read */

/**
 * The current value of a credential: the store first, the environment second.
 * This is the single read path — nothing should reach into either directly.
 */
export function secretValue(key: string): string | undefined {
  const stored = values.get(key);
  if (stored !== undefined) return stored;
  const fromEnv = envBaseline.has(key) ? envBaseline.get(key) : process.env[key];
  return fromEnv === "" ? undefined : fromEnv;
}

/** Every key the store holds. Names only — this feeds a dashboard and an API. */
export function storedSecretKeys(): string[] {
  return [...values.keys()].sort();
}

/** Whether encryption is configured. Without it the store cannot be used. */
export function secretStoreReady(): boolean {
  return cipher.ready();
}

/**
 * Teaches the store what a key is allowed to look like, so `secret set` is
 * checked against the same zod schema the workflow declared rather than
 * accepting a typo that will only surface at 3am.
 */
export function registerSecretSchema(key: string, schema: ZodTypeAny): void {
  schemas.set(key, schema);
}

/** The group form: one schema for every account under a prefix. */
export function registerSecretSchemaPrefix(prefix: string, schema: ZodTypeAny): void {
  prefixSchemas.set(prefix, schema);
}

/**
 * The schema a write to `key` must satisfy, if any workflow declared one. An
 * exact declaration wins over a prefix; the longest prefix wins over a shorter
 * one, so GITHUB_TOKEN_ENTERPRISE is checked against GITHUB_TOKEN_ENTERPRISE
 * rather than GITHUB when both are declared.
 */
export function secretSchema(key: string): ZodTypeAny | undefined {
  const exact = schemas.get(key);
  if (exact) return exact;

  let best: { prefix: string; schema: ZodTypeAny } | undefined;
  for (const [prefix, schema] of prefixSchemas) {
    if (key !== prefix && !key.startsWith(`${prefix}_`)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, schema };
  }
  return best?.schema;
}

/* ------------------------------------------------------------------ load */

/**
 * Reads and decrypts every stored credential into memory.
 *
 * Must complete **before the first workflow file is imported**: defineSecrets
 * validates at import time, and a key that only exists in the store has to be
 * visible by then or the boot fails on a credential that is actually present.
 */
export async function loadSecretStore(): Promise<number> {
  const rows = store.secretRows();
  if (rows.length === 0) {
    watermark = store.secretWatermark();
    return 0;
  }

  if (!cipher.ready()) {
    log.warn(
      `${rows.length} stored secret(s) cannot be read — ${keyProblem(KEY_ENVS)}. ` +
        `Falling back to the environment.`,
    );
    return 0;
  }

  let loaded = 0;
  for (const row of rows) {
    let plaintext: string;
    try {
      plaintext = await cipher.decrypt(row.value);
    } catch {
      // A rotated or wrong master key. Same recovery as OAuth takes: warn and
      // fall through to whatever the environment has, rather than throwing and
      // making an unreadable row stop the boot.
      warnUndecryptable(row.key);
      continue;
    }
    apply(row.key, plaintext);
    loaded++;
  }

  watermark = store.secretWatermark();
  return loaded;
}

/**
 * Installs a value: in memory, in process.env for the integrations, and in the
 * redactor. Capturing the environment baseline on first touch is what lets a
 * later delete put the deploy-time value back.
 */
function apply(key: string, value: string): void {
  if (!envBaseline.has(key)) envBaseline.set(key, process.env[key]);
  values.set(key, value);
  process.env[key] = value;
  if (redactable(key)) registerSecret(value);
  undecryptable.delete(key);
}

function unapply(key: string): void {
  values.delete(key);
  const original = envBaseline.get(key);
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
  envBaseline.delete(key);
  // The old value stays registered with the redactor on purpose: it is still a
  // live credential somewhere until it is revoked, and scrubbing it costs
  // nothing.
}

function warnUndecryptable(key: string): void {
  if (undecryptable.has(key)) return;
  undecryptable.add(key);
  log.warn(
    `secret "${key}" could not be decrypted with ${cipher.keyEnv} — ` +
      `falling back to the environment`,
  );
}

/* ----------------------------------------------------------------- write */

/**
 * Stores a credential and makes it live in this process immediately. Other
 * processes pick it up on their next refresh tick.
 *
 * Validated against the declaring workflow's schema when there is one, so the
 * failure lands here rather than in a run.
 */
export async function setSecret(
  key: string,
  value: string,
  meta: { owner?: string | null; folder?: string | null } = {},
): Promise<void> {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `Secret name "${key}" must be uppercase letters, digits, and underscores`,
    );
  }
  if (value === "") throw new Error(`Secret "${key}" cannot be empty — delete it instead`);
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) {
    throw new Error(`Secret "${key}" is over ${MAX_VALUE_BYTES} bytes`);
  }
  if (!cipher.ready()) throw new Error(keyProblem(KEY_ENVS));

  const schema = secretSchema(key);
  if (schema) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Secret "${key}" is invalid: ${parsed.error.issues[0]?.message}`);
    }
  }

  store.secretPut(key, await cipher.encrypt(value), meta);
  apply(key, value);
  watermark = store.secretWatermark();
  announce();
}

/** Removes a stored credential, restoring the environment's value if it had one. */
export function deleteSecret(key: string): boolean {
  const existed = store.secretDrop(key);
  unapply(key);
  watermark = store.secretWatermark();
  announce();
  return existed;
}

/* --------------------------------------------------------------- refresh */

/**
 * Notices writes made by another process — `bun run secret set` talks to the
 * database, not to the running server, so without this the server would hold
 * a stale value until its next restart. The probe is one aggregate over a
 * table with tens of rows; the reload only happens when it moves.
 */
export function startSecretRefresh(): void {
  if (timer || REFRESH_MS <= 0) return;
  timer = setInterval(() => {
    void refreshSecrets().catch((err) =>
      log.error(`Secret refresh failed: ${err instanceof Error ? err.message : err}`),
    );
  }, REFRESH_MS);
  timer.unref?.();
}

export function stopSecretRefresh(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Exported for the refresh timer and for tests-by-hand; safe to call often. */
export async function refreshSecrets(): Promise<boolean> {
  const now = store.secretWatermark();
  if (now.count === watermark.count && now.latest === watermark.latest) return false;

  const rows = store.secretRows();
  const seen = new Set<string>();
  const changed: string[] = [];

  for (const row of rows) {
    seen.add(row.key);
    let plaintext: string;
    try {
      plaintext = await cipher.decrypt(row.value);
    } catch {
      warnUndecryptable(row.key);
      continue;
    }
    if (values.get(row.key) === plaintext) continue;
    apply(row.key, plaintext);
    changed.push(row.key);
  }

  for (const key of [...values.keys()]) {
    if (seen.has(key)) continue;
    unapply(key);
    changed.push(key);
  }

  watermark = now;
  // Names only. The point of the store is that the values never get printed.
  if (changed.length > 0) log.info(`Secrets updated: ${changed.sort().join(", ")}`);
  // Announced even when no value moved: the watermark also covers the
  // credentials table, so another process flipping which credential is primary
  // has to reach this one's env mapping.
  announce();
  return true;
}
