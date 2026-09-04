import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { registerSecret } from "./redact.ts";
import {
  registerSecretSchema,
  registerSecretSchemaPrefix,
  secretValue,
} from "./secret-store.ts";
import { log } from "./logger.ts";

const problems: string[] = [];

/** Rejected live values, so twenty runs hitting one bad key is one line. */
const warned = new Set<string>();

/**
 * Declares the environment variables a workflow needs, validates them the
 * moment the file is imported, and registers the values for log redaction.
 *
 * Because every workflow is imported at boot, a missing or malformed key stops
 * the process on deploy — not at 3am, halfway through the run that needed it.
 *
 *   const secrets = defineSecrets({
 *     SLACK_TOKEN: z.string().startsWith("xoxb-"),
 *     OPENAI_API_KEY: z.string().min(20),
 *   });
 *
 * The returned object reads through to the secret store on **every property
 * access**, so rotating a credential takes effect on the next run rather than
 * on the next deploy. That only holds where the property is read at call time:
 *
 *   run: () => fetch(url, { headers: { key: secrets.API_KEY } })   // live
 *   const key = secrets.API_KEY;                                   // frozen
 *
 * A value read at module scope is captured in a closure and this can't reach
 * it. Where a helper needs one at import time, pass a getter — see
 * hmacSignature in verify.ts.
 */
export function defineSecrets<T extends ZodRawShape>(shape: T): z.infer<z.ZodObject<T>> {
  const keys = Object.keys(shape);
  // Registered before validation: `secret set` should be checked against the
  // schema even for a key whose current value is missing or wrong.
  for (const key of keys) registerSecretSchema(key, shape[key] as ZodTypeAny);

  const parsed = z.object(shape).safeParse(pick(keys));

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "?");
      problems.push(
        issue.code === "invalid_type" && secretValue(key) === undefined
          ? `${key} is not set`
          : `${key}: ${issue.message}`,
      );
    }
    // Boot aborts before anything reads this, so a partial object is fine.
    return liveObject(shape, {}) as z.infer<z.ZodObject<T>>;
  }

  for (const value of Object.values(parsed.data)) registerSecret(value);
  return liveObject(shape, parsed.data as Record<string, unknown>) as z.infer<z.ZodObject<T>>;
}

/** Same validation for a single optional key, with a default. */
export function optionalSecret<T extends ZodTypeAny>(
  key: string,
  schema: T,
  fallback: z.infer<T>,
): z.infer<T> {
  registerSecretSchema(key, schema);
  const raw = secretValue(key);
  if (raw === undefined) return fallback;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    problems.push(`${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return fallback;
  }
  registerSecret(parsed.data);
  return parsed.data;
}

/** Reads just the declared keys, store first, environment second. */
function pick(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((k) => [k, secretValue(k)]));
}

/** Called by the loader once every workflow has been imported. */
export function collectSecretProblems(): string[] {
  return [...new Set(problems)];
}

/**
 * Declares a family of same-shaped secrets — several accounts for one service.
 *
 *   const github = defineSecretGroup("GITHUB_TOKEN", z.string().min(10));
 *   // reads GITHUB_TOKEN_PERSONAL and GITHUB_TOKEN_WORK from the environment
 *   // → { personal: "ghp_…", work: "ghp_…" }
 *
 *   github.work                      // typed access by account
 *   Object.entries(github)           // iterate over all — enumerated live, so
 *                                    // an account added after boot shows up
 *
 * A bare GITHUB_TOKEN (no suffix) lands under the key "default". Every value is
 * validated at boot and registered for log redaction, exactly like defineSecrets.
 */
export function defineSecretGroup<T extends ZodTypeAny>(
  prefix: string,
  schema: T,
  opts: { required?: boolean } = {},
): Record<string, z.infer<T>> {
  registerSecretSchemaPrefix(prefix, schema);

  // Validate what exists now, so a malformed account still stops the boot.
  const initial = scanGroup(prefix, schema, problems);
  if (opts.required !== false && Object.keys(initial).length === 0) {
    problems.push(`${prefix}_* — no accounts found (set at least ${prefix}_<NAME>)`);
  }

  return liveGroup(prefix, schema);
}

/**
 * Collects every account currently set for a prefix. `sink` is where malformed
 * values go: the boot pass sends them to `problems` and fails the deploy, the
 * live pass only warns, because a bad value arriving at runtime must not take
 * down a workflow whose other accounts are fine.
 */
function scanGroup<T extends ZodTypeAny>(
  prefix: string,
  schema: T,
  sink: string[] | null,
): Record<string, z.infer<T>> {
  const out: Record<string, z.infer<T>> = {};

  // process.env is the right source even with the store in play: every stored
  // value is mirrored into it, precisely so prefix scans like this one work.
  for (const [key, raw] of Object.entries(process.env)) {
    if (raw === undefined || raw === "") continue;

    let account: string;
    if (key === prefix) account = "default";
    else if (key.startsWith(`${prefix}_`)) account = key.slice(prefix.length + 1).toLowerCase();
    else continue;

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const message = `${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`;
      if (sink) sink.push(message);
      else warnOnce(key, `secret ${message} — ignoring this account`);
      continue;
    }
    registerSecret(parsed.data);
    warned.delete(key);
    out[account] = parsed.data;
  }
  return out;
}

/**
 * A view over one prefix that re-scans on access, so adding an account is a
 * `secret set` rather than a redeploy. Keys are enumerated live too — the
 * documented `Object.entries(group)` fan-out would otherwise iterate whatever
 * happened to exist at boot.
 */
function liveGroup<T extends ZodTypeAny>(
  prefix: string,
  schema: T,
): Record<string, z.infer<T>> {
  const current = () => scanGroup(prefix, schema, null);

  return new Proxy({} as Record<string, z.infer<T>>, {
    get: (_t, prop) => (typeof prop === "string" ? current()[prop] : undefined),
    has: (_t, prop) => typeof prop === "string" && prop in current(),
    ownKeys: () => Object.keys(current()),
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop !== "string") return undefined;
      const value = current()[prop];
      if (value === undefined) return undefined;
      return { value, enumerable: true, configurable: true, writable: false };
    },
  });
}

/**
 * The object defineSecrets hands back. Every read resolves the current value
 * and re-parses it through the declared schema, so `z.coerce.number()` keeps
 * giving a number and a value that stops matching its schema falls back to the
 * last good one instead of breaking the run that reads it.
 */
function liveObject(
  shape: ZodRawShape,
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  // Seeded with every declared key so enumeration and spread stay correct even
  // when boot validation failed and the snapshot is empty.
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) target[key] = snapshot[key];

  const cache = new Map<string, { raw: string; parsed: unknown }>();

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop !== "string" || !(prop in shape)) return Reflect.get(t, prop, receiver);

      const lastGood = cache.get(prop);
      const raw = secretValue(prop);
      if (raw === undefined) return lastGood ? lastGood.parsed : t[prop];
      if (lastGood?.raw === raw) return lastGood.parsed;

      const parsed = (shape[prop] as ZodTypeAny).safeParse(raw);
      if (!parsed.success) {
        warnOnce(
          prop,
          `secret ${prop}: ${parsed.error.issues[0]?.message ?? "invalid"} — ` +
            `keeping the previous value`,
        );
        return lastGood ? lastGood.parsed : t[prop];
      }

      registerSecret(parsed.data);
      cache.set(prop, { raw, parsed: parsed.data });
      warned.delete(prop);
      return parsed.data;
    },
  });
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(message);
}
