/**
 * Every value that comes out of defineSecrets() is registered here, and the
 * logger scrubs all of them from anything it writes. A stray ctx.log("config",
 * cfg) then can't leak a token into the run history or into stdout.
 */
const secrets = new Set<string>();

export function registerSecret(value: unknown): void {
  // Below 6 chars the odds of matching innocent text are too high to be worth it.
  if (typeof value === "string" && value.length >= 6) secrets.add(value);
}

export function redact<T>(input: T): T {
  if (secrets.size === 0) return input;
  if (typeof input === "string") return redactString(input) as T;
  if (input === null || typeof input !== "object") return input;
  try {
    return JSON.parse(redactString(JSON.stringify(input))) as T;
  } catch {
    return input;
  }
}

function redactString(s: string): string {
  let out = s;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join("«redacted»");
  }
  return out;
}
