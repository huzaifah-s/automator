import { redact } from "./redact.ts";

/** Ceiling for observational payloads (step inputs, HTTP bodies). */
export const MAX_BYTES = Number(process.env.CAPTURE_MAX_BYTES ?? 32_768);
/** Ceiling for step outputs, which resume replays — functional, so more room. */
export const MAX_CHECKPOINT_BYTES = Number(process.env.CHECKPOINT_MAX_BYTES ?? 262_144);

export const captureEnabled = process.env.CAPTURE_DATA !== "false";

/**
 * Marks a payload that was stored as a readable prefix rather than whole.
 * Exported because replay has to refuse a truncated input — feeding the
 * placeholder back into a workflow would be worse than not replaying.
 */
export const TRUNCATED_KEY = "«truncated»";

export interface Captured {
  json: string | null;
  truncated: boolean;
}

/**
 * Serialises a value for storage: redacted first, then capped. Anything that
 * can't be represented (a DB handle, a stream, a circular graph) degrades to a
 * short type label rather than throwing — capture must never fail a run.
 */
export function capture(
  value: unknown,
  opts: { limit?: number; force?: boolean } = {},
): Captured {
  const limit = opts.limit ?? MAX_BYTES;
  // `force` is for step outputs: resume needs them even when observational
  // capture is switched off to save disk.
  if ((!captureEnabled && !opts.force) || value === undefined) {
    return { json: null, truncated: false };
  }

  let json: string;
  try {
    json = JSON.stringify(redact(value), replacer) ?? String(value);
  } catch {
    return { json: JSON.stringify({ "«unserialisable»": describe(value) }), truncated: false };
  }

  if (json.length <= limit) return { json, truncated: false };

  // Store a readable prefix rather than invalid JSON: the viewer shows it raw.
  return {
    json: JSON.stringify({
      [TRUNCATED_KEY]: `${json.length} bytes, showing first ${limit}`,
      preview: json.slice(0, limit),
    }),
    truncated: true,
  };
}

function replacer(_key: string, value: unknown) {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "«function»";
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type !== "object") return type;
  return (value as object).constructor?.name ?? "object";
}

/** Whether a stored payload is the truncated placeholder rather than the value. */
export function isTruncated(json: string | null): boolean {
  if (!json) return false;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && TRUNCATED_KEY in parsed;
  } catch {
    return false;
  }
}
