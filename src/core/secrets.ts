import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { registerSecret } from "./redact.ts";

const problems: string[] = [];

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
 */
export function defineSecrets<T extends ZodRawShape>(shape: T): z.infer<z.ZodObject<T>> {
  const parsed = z.object(shape).safeParse(pick(Object.keys(shape)));

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "?");
      problems.push(
        issue.code === "invalid_type" && process.env[key] === undefined
          ? `${key} is not set`
          : `${key}: ${issue.message}`,
      );
    }
    // Boot aborts before anything reads this, so a partial object is fine.
    return {} as z.infer<z.ZodObject<T>>;
  }

  for (const value of Object.values(parsed.data)) registerSecret(value);
  return parsed.data as z.infer<z.ZodObject<T>>;
}

/** Same validation for a single optional key, with a default. */
export function optionalSecret<T extends ZodTypeAny>(
  key: string,
  schema: T,
  fallback: z.infer<T>,
): z.infer<T> {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    problems.push(`${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return fallback;
  }
  registerSecret(parsed.data);
  return parsed.data;
}

/** Reads just the declared keys out of the environment. */
function pick(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
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
 *   Object.entries(github)           // iterate every account
 *
 * A bare GITHUB_TOKEN (no suffix) lands under the key "default". Every value is
 * validated at boot and registered for log redaction, exactly like defineSecrets.
 */
export function defineSecretGroup<T extends ZodTypeAny>(
  prefix: string,
  schema: T,
  opts: { required?: boolean } = {},
): Record<string, z.infer<T>> {
  const out: Record<string, z.infer<T>> = {};

  for (const [key, raw] of Object.entries(process.env)) {
    if (raw === undefined || raw === "") continue;

    let account: string;
    if (key === prefix) account = "default";
    else if (key.startsWith(`${prefix}_`)) account = key.slice(prefix.length + 1).toLowerCase();
    else continue;

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      continue;
    }
    registerSecret(parsed.data);
    out[account] = parsed.data;
  }

  if (opts.required !== false && Object.keys(out).length === 0) {
    problems.push(`${prefix}_* — no accounts found (set at least ${prefix}_<NAME>)`);
  }
  return out;
}
