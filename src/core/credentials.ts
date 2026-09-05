import type { ZodTypeAny } from "zod";
import { store } from "./db.ts";
import { log } from "./logger.ts";
import { redact, registerSecret } from "./redact.ts";
import {
  deleteSecret,
  onSecretsChanged,
  secretValue,
  setRedactionPolicy,
  setSecret,
  storedSecretKeys,
} from "./secret-store.ts";
import type { CredentialRow } from "./types.ts";
import { PROVIDERS, isProviderId, type Provider, type ProviderId } from "./providers.ts";

/**
 * A credential is several secrets that are only meaningful together — an
 * access id and an access key, or the five values an SMTP connection needs.
 *
 * There is no second store. Every field is an ordinary row in the encrypted
 * `secrets` table under a derived name, so the redaction, the env mirroring,
 * the master-key handling and the cross-process refresh that were already
 * proven for secrets apply to credentials for free. The `credentials` table
 * holds only the grouping — which provider, which folder, when it was last
 * tested — and never a value.
 *
 *   provider "smtp" + credential "primary" + field "pass"  →  SMTP_PRIMARY_PASS
 *
 * Two things read a credential:
 *
 *   - `defineCredential("smtp", "primary")` in a workflow, which returns a live
 *     proxy over those derived keys;
 *   - the built-in integrations, which read bare names like SMTP_HOST for
 *     themselves. A credential marked *primary* is mirrored into those, which
 *     is what makes connecting a platform on the dashboard reach `ctx.email`
 *     and not only `defineCredential`.
 */

/** Slug rules match workflow names: both end up in a URL. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Folders are for the eye, so the only rule is that they stay readable. */
const FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _\-/]*$/;

/** A connection test is a liveness probe, not a job. */
const TEST_TIMEOUT_MS = 15_000;

export interface CredentialStatus {
  row: CredentialRow;
  provider: Provider | undefined;
  /** Required fields with no value. Non-empty means the credential is unusable. */
  missing: string[];
  /** Optional fields with no value — worth showing, not worth blocking on. */
  unset: string[];
}

/* ------------------------------------------------------------ derivation */

/** The stored secret name for one field of one credential. */
export function fieldKey(provider: string, id: string, field: string): string {
  return [provider, id, field].map((part) => part.toUpperCase().replace(/-/g, "_")).join("_");
}

/** Every key a credential owns, whether or not it currently has a value. */
export function fieldKeys(provider: string, id: string): { field: string; key: string }[] {
  const def = PROVIDERS[provider as ProviderId] as Provider | undefined;
  if (!def) return [];
  return Object.keys(def.fields).map((field) => ({ field, key: fieldKey(provider, id, field) }));
}

/** `provider:id` — the owner stamp on each secret row, and the URL segment. */
export function credentialRef(provider: string, id: string): string {
  return `${provider}:${id}`;
}

/* ---------------------------------------------------------------- status */

export function credentialStatus(row: CredentialRow): CredentialStatus {
  const provider = PROVIDERS[row.provider as ProviderId] as Provider | undefined;
  const missing: string[] = [];
  const unset: string[] = [];

  for (const { field, key } of fieldKeys(row.provider, row.id)) {
    if (secretValue(key) !== undefined) continue;
    (provider?.fields[field]?.optional ? unset : missing).push(field);
  }
  return { row, provider, missing, unset };
}

export function listCredentials(): CredentialStatus[] {
  return store.credentialRows().map(credentialStatus);
}

export function getCredential(provider: string, id: string): CredentialStatus | undefined {
  const row = store.credentialRow(provider, id);
  return row ? credentialStatus(row) : undefined;
}

/** Usable means: it exists, its provider is still known, and nothing is missing. */
export function credentialReady(provider: string, id: string): boolean {
  const status = getCredential(provider, id);
  return status !== undefined && status.provider !== undefined && status.missing.length === 0;
}

/* ----------------------------------------------------------------- write */

export interface CredentialInput {
  provider: string;
  id: string;
  folder?: string | null;
  primary?: boolean;
  /**
   * Field values. A field left out keeps whatever is stored, which is what
   * makes an edit form that shows "••••" for a password work: submitting it
   * unchanged must not blank the value out.
   */
  values: Record<string, string | undefined>;
}

/**
 * Creates or updates a credential. Validates every field against the provider's
 * own schema first, so a bad paste fails here rather than inside a run.
 */
export async function saveCredential(input: CredentialInput): Promise<CredentialRow> {
  const { provider: providerId, id } = input;

  if (!isProviderId(providerId)) {
    throw new Error(`Unknown platform "${providerId}"`);
  }
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Name "${id}" must be lowercase letters, digits, and dashes`);
  }
  if (input.folder && !FOLDER_PATTERN.test(input.folder)) {
    throw new Error(`Folder "${input.folder}" has characters that are not allowed`);
  }

  const provider = PROVIDERS[providerId] as Provider;
  const existing = store.credentialRow(providerId, id);
  const ref = credentialRef(providerId, id);

  // Two credentials whose derived keys overlap would silently share a value.
  // It takes an unlucky pair of names — smtp/"main-a" field "host" against
  // smtp/"main" field "a_host" — but the failure is invisible, so it is
  // cheaper to refuse the name than to explain the symptom later.
  if (!existing) {
    const owned = new Map(
      store.secretMeta().map((r) => [r.key, r.owner] as const),
    );
    for (const { key } of fieldKeys(providerId, id)) {
      const owner = owned.get(key);
      if (owner === undefined) continue;
      throw new Error(
        owner === null
          ? `Name "${id}" collides with the stored secret ${key}`
          : `Name "${id}" collides with credential ${owner}, which already owns ${key}`,
      );
    }
  }

  // Validate everything before writing anything: a half-applied credential
  // that failed on its fourth field is worse than a rejected one.
  const writes: { key: string; value: string }[] = [];
  const clears: string[] = [];

  for (const [field, def] of Object.entries(provider.fields)) {
    const key = fieldKey(providerId, id, field);
    const given = input.values[field];

    if (given === undefined) continue; // untouched — keep what is stored
    const value = given.trim();

    if (value === "") {
      // Reaching here at all means the caller sent an empty value, which is a
      // request to clear the field. "Leave the password box blank to keep it"
      // is handled one layer up, by not sending the field at all — folding the
      // two into one meaning here would make clearing a value impossible.
      if (!def.optional) throw new Error(`${def.label} is required`);
      clears.push(key);
      continue;
    }

    const parsed = (def.schema as ZodTypeAny).safeParse(value);
    if (!parsed.success) {
      throw new Error(`${def.label}: ${parsed.error.issues[0]?.message ?? "is invalid"}`);
    }
    writes.push({ key, value });
  }

  // Required fields must end up with a value, counting what is already stored.
  for (const [field, def] of Object.entries(provider.fields)) {
    if (def.optional) continue;
    const key = fieldKey(providerId, id, field);
    if (writes.some((w) => w.key === key)) continue;
    if (secretValue(key) === undefined) throw new Error(`${def.label} is required`);
  }

  const now = Date.now();
  store.credentialPut({
    provider: providerId,
    id,
    folder: input.folder?.trim() || null,
    is_primary: input.primary ? 1 : (existing?.is_primary ?? 0),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });

  // Exactly one credential per provider feeds the built-in integration. Two
  // claiming it would make "which one is live" a coin toss.
  if (input.primary) store.credentialClearPrimary(providerId, id);

  for (const { key, value } of writes) {
    await setSecret(key, value, { owner: ref, folder: input.folder?.trim() || null });
  }
  for (const key of clears) deleteSecret(key);

  // Values changed and possibly the primary flag: re-derive the env mirror.
  syncPrimaryEnv();

  log.info(`Credential ${ref} was saved`);
  return store.credentialRow(providerId, id)!;
}

/** Removes a credential and every secret it owns. */
export function deleteCredential(provider: string, id: string): boolean {
  const row = store.credentialRow(provider, id);
  if (!row) return false;

  for (const { key } of fieldKeys(provider, id)) deleteSecret(key);
  // Fields belonging to a provider that has since been removed from the code
  // would not appear in fieldKeys(), so sweep by owner as well.
  store.secretDropByOwner(credentialRef(provider, id));
  store.credentialDrop(provider, id);

  syncPrimaryEnv();
  log.info(`Credential ${credentialRef(provider, id)} was deleted`);
  return true;
}

/** Moves a credential between folders without touching its values. */
export function setCredentialFolder(provider: string, id: string, folder: string | null): boolean {
  const row = store.credentialRow(provider, id);
  if (!row) return false;
  if (folder && !FOLDER_PATTERN.test(folder)) {
    throw new Error(`Folder "${folder}" has characters that are not allowed`);
  }
  store.credentialPut({ ...row, folder: folder || null, updated_at: Date.now() });
  store.secretSetFolderByOwner(credentialRef(provider, id), folder || null);
  return true;
}

/* ------------------------------------------------------------------ test */

export interface TestResult {
  ok: boolean;
  detail: string;
  at: number;
}

/**
 * Calls the platform with the stored values and records the answer.
 *
 * The detail line is redacted on the way out. That is not belt-and-braces: a
 * Telegram URL carries the bot token, so an unredacted fetch failure would
 * print the credential onto the dashboard and into the database.
 */
export async function testCredential(provider: string, id: string): Promise<TestResult> {
  const status = getCredential(provider, id);
  if (!status) throw new Error(`No credential ${credentialRef(provider, id)}`);
  if (!status.provider) throw new Error(`Platform "${provider}" is no longer known to this build`);
  if (status.missing.length > 0) {
    return record(provider, id, false, `Not connected — ${status.missing.join(", ")} not set`);
  }

  const values: Record<string, string> = {};
  for (const { field, key } of fieldKeys(provider, id)) {
    const value = secretValue(key);
    if (value !== undefined) values[field] = value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const detail = await status.provider.test(values, controller.signal);
    return record(provider, id, true, detail);
  } catch (err) {
    const message = controller.signal.aborted
      ? `No answer within ${TEST_TIMEOUT_MS / 1000}s`
      : err instanceof Error
        ? err.message
        : String(err);
    return record(provider, id, false, message);
  } finally {
    clearTimeout(timer);
  }
}

function record(provider: string, id: string, ok: boolean, detail: string): TestResult {
  // Trimmed as well as redacted — a provider that answers with a stack trace
  // should not turn a table cell into a page.
  const safe = redact(detail).slice(0, 500);
  const at = Date.now();
  store.credentialRecordTest(provider, id, ok, safe, at);
  log[ok ? "info" : "warn"](`Credential ${credentialRef(provider, id)}: ${safe}`);
  return { ok, detail: safe, at };
}

/* ------------------------------------------------------------- redaction */

/**
 * Which stored keys are credentials and which are configuration.
 *
 * Every value in the secret store is scrubbed from logs by default, because
 * the store cannot tell one from the other. A credential can: its provider
 * declared `secret: false` on the fields that are a hostname, a port, a
 * from-address. Registering those with the redactor would replace them with
 * «redacted» in every log line and every test result that mentions them — the
 * connection test's own "Connected to smtp.gmail.com" included.
 *
 * Installed at import, which is before loadSecretStore() applies the first
 * value. Doing it inside initCredentials() would be too late: the whole store
 * is already loaded by then, and a hostname registered once cannot be
 * unregistered.
 */
let plainKeys = new Set<string>();
let indexedAt = { count: -1, latest: -1 };

/**
 * Rebuilt whenever the credentials table has moved, rather than when something
 * remembers to ask. The ordering is what makes that necessary: values are
 * applied one at a time and the policy is consulted for each, so an index
 * refreshed *after* the batch — or only on a local write — would miss the very
 * first field of a new credential, including one written by another process
 * and picked up by the refresh tick. A registration cannot be undone, so
 * getting it right once matters more than the cost of one aggregate query
 * over a table with tens of rows.
 */
function currentPlainKeys(): Set<string> {
  const now = store.credentialWatermark();
  if (now.count === indexedAt.count && now.latest === indexedAt.latest) return plainKeys;

  const plain = new Set<string>();
  for (const row of store.credentialRows()) {
    const provider = PROVIDERS[row.provider as ProviderId] as Provider | undefined;
    if (!provider) continue;
    for (const [field, def] of Object.entries(provider.fields)) {
      if (def.secret === false) plain.add(fieldKey(row.provider, row.id, field));
    }
  }
  plainKeys = plain;
  indexedAt = now;
  return plain;
}

setRedactionPolicy((key) => !currentPlainKeys().has(key));

/* --------------------------------------------------------- env mirroring */

/**
 * What process.env held for a mapped name before a primary credential took it
 * over, so clearing the primary flag puts the deploy-time value back rather
 * than leaving a credential nobody claims.
 */
const mirrored = new Map<string, string | undefined>();
const shadowed = new Set<string>();

/**
 * Recomputes the whole mapping from scratch rather than tracking changes
 * incrementally. There are tens of rows and this runs on a secret write or a
 * refresh tick; being obviously correct is worth more than being clever.
 */
export function syncPrimaryEnv(): void {
  const wanted = new Map<string, string>();

  for (const row of store.credentialRows()) {
    if (!row.is_primary) continue;
    const provider = PROVIDERS[row.provider as ProviderId] as Provider | undefined;
    if (!provider?.envMap) continue;
    for (const [field, envName] of Object.entries(provider.envMap)) {
      const value = secretValue(fieldKey(row.provider, row.id, field));
      if (value !== undefined) wanted.set(envName, value);
    }
  }

  for (const [envName, before] of [...mirrored]) {
    if (wanted.has(envName)) continue;
    if (before === undefined) delete process.env[envName];
    else process.env[envName] = before;
    mirrored.delete(envName);
    shadowed.delete(envName);
  }

  for (const [envName, value] of wanted) {
    if (!mirrored.has(envName)) {
      const before = process.env[envName];
      mirrored.set(envName, before);
      // Said once, because it is a real ambiguity: the same name is set two
      // ways and the credential is the one that wins.
      if (before && before !== value && !shadowed.has(envName)) {
        shadowed.add(envName);
        log.warn(
          `${envName} is set in the environment and by a primary credential — ` +
            `the credential wins`,
        );
      }
    }
    if (process.env[envName] !== value) process.env[envName] = value;
  }
}

/** Names currently supplied by a primary credential, for the dashboard. */
export function mirroredEnvNames(): string[] {
  return [...mirrored.keys()].sort();
}

/* --------------------------------------------------- workflow requirements */

export interface CredentialRequirement {
  provider: string;
  id: string;
  /** The workflow file that declared it, when the loader was the importer. */
  file: string | null;
}

const requirements: CredentialRequirement[] = [];
let loadingFile: string | null = null;

/**
 * The loader names the file it is about to import, so a credential declared at
 * module scope can be attributed to it. defineCredential() is called during
 * that import and has no other way to know who asked.
 */
export function setLoadingFile(file: string | null): void {
  loadingFile = file;
}

export function credentialRequirements(): CredentialRequirement[] {
  return requirements;
}

/**
 * Declares the credential a workflow needs and returns a live view of it.
 *
 *   const smtp = defineCredential("smtp", "primary");
 *   await ctx.http.post(url, { auth: smtp.pass });
 *
 * Every property read resolves the current stored value, exactly like
 * defineSecrets — so rotating a credential on the dashboard reaches the next
 * run without a restart, and a value captured at module scope is frozen and
 * cannot. Values are always strings, because that is what an environment
 * variable is; `Number(smtp.port)` is the workflow's job.
 *
 * **A credential that is not connected yet does not stop the boot**, unlike a
 * missing `defineSecrets` key. It cannot: the dashboard is where you would go
 * to connect it, and a server that refuses to start never serves the page that
 * would fix it. The workflow is marked blocked instead, refuses to run with a
 * clear error, and says so on the dashboard.
 *
 * An unknown platform *does* stop the boot — that is a typo in code, and no
 * amount of dashboard work will fix it.
 */
export function defineCredential<P extends ProviderId>(
  provider: P,
  id: string,
): CredentialValues<P> {
  if (!isProviderId(provider)) {
    throw new Error(
      `defineCredential: unknown platform "${provider}" — ` +
        `known platforms are ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  if (!ID_PATTERN.test(id)) {
    throw new Error(
      `defineCredential("${provider}", "${id}"): the name must be lowercase ` +
        `letters, digits, and dashes`,
    );
  }

  if (!requirements.some((r) => r.provider === provider && r.id === id)) {
    requirements.push({ provider, id, file: loadingFile });
  }

  return liveCredential(provider, id) as CredentialValues<P>;
}

type FieldsOf<P extends ProviderId> = (typeof PROVIDERS)[P]["fields"];
type FieldValue<F> = F extends { optional: true } ? string | undefined : string;

export type CredentialValues<P extends ProviderId> = {
  [K in keyof FieldsOf<P>]: FieldValue<FieldsOf<P>[K]>;
};

/** Warned-about fields, so a bad value is one line and not one line per run. */
const warned = new Set<string>();

function liveCredential(provider: string, id: string): Record<string, string | undefined> {
  const def = PROVIDERS[provider as ProviderId] as Provider;
  const cache = new Map<string, { raw: string; value: string }>();

  return new Proxy({} as Record<string, string | undefined>, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      const field = def.fields[prop];
      if (!field) return undefined;

      const key = fieldKey(provider, id, prop);
      const last = cache.get(prop);
      const raw = secretValue(key);
      if (raw === undefined) return last?.value;
      if (last?.raw === raw) return last.value;

      // Same bargain defineSecrets strikes: a value that stops matching its
      // schema keeps the last good one rather than breaking the run, because
      // an operator's typo should not take a workflow down.
      const parsed = (field.schema as ZodTypeAny).safeParse(raw);
      if (!parsed.success) {
        warnOnce(
          key,
          `credential ${credentialRef(provider, id)}.${prop}: ` +
            `${parsed.error.issues[0]?.message ?? "invalid"} — keeping the previous value`,
        );
        return last?.value;
      }

      if (field.secret !== false) registerSecret(raw);
      cache.set(prop, { raw, value: raw });
      warned.delete(key);
      return raw;
    },

    has: (_t, prop) => typeof prop === "string" && Object.hasOwn(def.fields, prop),
    ownKeys: () => Object.keys(def.fields),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(message);
}

/* ------------------------------------------------------------------ boot */

/**
 * Registers every stored credential value with the log redactor and installs
 * the primary env mapping. Runs straight after loadSecretStore(), before a
 * single workflow file is imported.
 */
export function initCredentials(): number {
  let count = 0;
  const stored = new Set(storedSecretKeys());

  for (const row of store.credentialRows()) {
    const provider = PROVIDERS[row.provider as ProviderId] as Provider | undefined;
    if (!provider) {
      log.warn(
        `Credential ${credentialRef(row.provider, row.id)} is for platform ` +
          `"${row.provider}", which this build does not know about`,
      );
      continue;
    }
    for (const { field, key } of fieldKeys(row.provider, row.id)) {
      if (!stored.has(key)) continue;
      if (provider.fields[field]?.secret !== false) registerSecret(secretValue(key));
      count++;
    }
  }

  syncPrimaryEnv();

  // A write from another process — the CLI, or a second container — arrives
  // through the same refresh tick that carries secrets.
  onSecretsChanged(syncPrimaryEnv);
  return count;
}
