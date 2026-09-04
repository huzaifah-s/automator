import { store } from "./db.ts";

/**
 * Ceiling for a single state value. Generous compared to a captured log line —
 * state is operational data a workflow reads back and acts on, not a preview.
 */
export const MAX_STATE_BYTES = Number(process.env.STATE_MAX_BYTES ?? 262_144);

/** Longest key we'll store. Keys are identifiers, not payloads. */
const MAX_KEY_LENGTH = 255;

/**
 * The namespace behind ctx.state.shared. Workflow names match
 * /^[a-z0-9][a-z0-9-]*$/, so "@shared" can never collide with one.
 */
const SHARED_NAMESPACE = "@shared";

export interface StateSetOptions {
  /** Forget the key this many seconds from now. Omit to keep it indefinitely. */
  ttlSeconds?: number;
}

export interface StateStore {
  /** The stored value, or undefined if the key is absent or expired. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, opts?: StateSetOptions): Promise<void>;
  /**
   * Read-modify-write as one indivisible operation. The whole body runs
   * synchronously before the promise yields, so two concurrent runs cannot
   * interleave on the same key — which is what makes this the right tool for
   * counters and polling cursors. `fn` must be synchronous for that to hold,
   * and the signature enforces it.
   */
  update<T>(
    key: string,
    fn: (current: T | undefined) => T,
    opts?: StateSetOptions,
  ): Promise<T>;
  /** True if a key was actually removed. */
  delete(key: string): Promise<boolean>;
  /** Every live key, optionally filtered by prefix, sorted. */
  keys(prefix?: string): Promise<string[]>;
}

export interface StateClient extends StateStore {
  /**
   * The same store in a namespace every workflow shares — for handing data
   * between workflows, like a webhook resolving an approval that a cron
   * workflow created. Keys here are global, so prefix them.
   */
  shared: StateStore;
}

/** Builds the per-run `ctx.state`, scoped to the workflow that owns it. */
export function createState(workflow: string): StateClient {
  const own = namespaced(workflow);
  // Plain methods, no lazy getters — unlike the integrations object, this one
  // is safe to spread.
  return { ...own, shared: namespaced(SHARED_NAMESPACE) };
}

function namespaced(namespace: string): StateStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return read<T>(namespace, checkKey(key));
    },

    async set<T>(key: string, value: T, opts: StateSetOptions = {}): Promise<void> {
      write(namespace, checkKey(key), value, opts);
    },

    async update<T>(
      key: string,
      fn: (current: T | undefined) => T,
      opts: StateSetOptions = {},
    ): Promise<T> {
      const k = checkKey(key);
      const next = fn(read<T>(namespace, k));
      write(namespace, k, next, opts);
      return next;
    },

    async delete(key: string): Promise<boolean> {
      return store.stateDelete(namespace, checkKey(key));
    },

    async keys(prefix = ""): Promise<string[]> {
      return store.stateKeys(namespace, prefix);
    },
  };
}

function read<T>(namespace: string, key: string): T | undefined {
  const raw = store.stateGet(namespace, key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Only reachable if the row was written by something other than write().
    throw new Error(`state key "${key}" does not hold valid JSON`);
  }
}

function write(
  namespace: string,
  key: string,
  value: unknown,
  opts: StateSetOptions,
): void {
  if (value === undefined) {
    throw new Error(
      `state.set("${key}", undefined) — undefined has no JSON form. ` +
        `Use state.delete("${key}") to remove a key.`,
    );
  }

  // Strict, unlike capture(): a value that can't round-trip is a bug worth
  // failing on, not something to quietly store a placeholder for.
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new Error(
      `state key "${key}" is not JSON-serialisable: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (json === undefined) {
    throw new Error(`state key "${key}" holds a ${typeof value}, which has no JSON form`);
  }
  if (json.length > MAX_STATE_BYTES) {
    throw new Error(
      `state key "${key}" is ${json.length} bytes, over the ${MAX_STATE_BYTES} limit (STATE_MAX_BYTES)`,
    );
  }

  const ttl = opts.ttlSeconds;
  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
    throw new Error(`ttlSeconds for state key "${key}" must be a positive number, got ${ttl}`);
  }

  store.stateSet(namespace, key, json, ttl === undefined ? null : Date.now() + ttl * 1_000);
}

function checkKey(key: string): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("state keys must be a non-empty string");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`state key is ${key.length} characters, over the ${MAX_KEY_LENGTH} limit`);
  }
  return key;
}
