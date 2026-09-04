export interface HttpOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  /** Extra attempts on network errors, 429, and 5xx. Default 2. */
  retries?: number;
  /** How to read the body. Default "json", falling back to text if unparseable. */
  as?: "json" | "text" | "buffer" | "none";
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} ${url} — ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export interface HttpClient {
  get<T = any>(url: string, opts?: HttpOptions): Promise<T>;
  post<T = any>(url: string, body?: unknown, opts?: HttpOptions): Promise<T>;
  put<T = any>(url: string, body?: unknown, opts?: HttpOptions): Promise<T>;
  patch<T = any>(url: string, body?: unknown, opts?: HttpOptions): Promise<T>;
  delete<T = any>(url: string, opts?: HttpOptions): Promise<T>;
  /** Escape hatch: the raw Response, no status check, no body parsing. */
  raw(url: string, init?: RequestInit & HttpOptions): Promise<Response>;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export type CallRecorder = (call: {
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  request: unknown;
  response: unknown;
}) => void;

export function createHttp(runSignal: AbortSignal, record?: CallRecorder): HttpClient {
  async function request<T>(
    method: string,
    url: string,
    body: unknown,
    opts: HttpOptions = {},
  ): Promise<T> {
    const target = withQuery(url, opts.query);
    const maxAttempts = (opts.retries ?? 2) + 1;
    let lastError: Error = new Error("request never ran");

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      try {
        const res = await send(method, target, body, opts, runSignal);

        if (!res.ok) {
          const text = await res.text();
          record?.({
            method,
            url: target,
            status: res.status,
            durationMs: Date.now() - startedAt,
            request: body,
            response: text,
          });
          const err = new HttpError(res.status, target, text);
          if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
            lastError = err;
            await sleep(backoff(attempt, res.headers.get("retry-after")));
            continue;
          }
          throw err;
        }

        const parsed = (await parse(res, opts.as ?? "json")) as T;
        record?.({
          method,
          url: target,
          status: res.status,
          durationMs: Date.now() - startedAt,
          request: body,
          response: parsed,
        });
        return parsed;
      } catch (err) {
        // A cancelled run must abort immediately, not burn through retries.
        if (runSignal.aborted) throw err;
        if (err instanceof HttpError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        record?.({
          method,
          url: target,
          status: null,
          durationMs: Date.now() - startedAt,
          request: body,
          response: lastError.message,
        });
        if (attempt >= maxAttempts) throw lastError;
        await sleep(backoff(attempt, null));
      }
    }

    throw lastError;
  }

  return {
    get: (url, opts) => request("GET", url, undefined, opts),
    post: (url, body, opts) => request("POST", url, body, opts),
    put: (url, body, opts) => request("PUT", url, body, opts),
    patch: (url, body, opts) => request("PATCH", url, body, opts),
    delete: (url, opts) => request("DELETE", url, undefined, opts),
    raw: (url, init = {}) =>
      fetch(withQuery(url, init.query), {
        ...init,
        signal: combineSignals(runSignal, init.timeoutMs ?? 30_000),
      }),
  };
}

async function send(
  method: string,
  url: string,
  body: unknown,
  opts: HttpOptions,
  runSignal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  let payload: BodyInit | undefined;

  if (body !== undefined) {
    if (typeof body === "string" || body instanceof FormData || body instanceof URLSearchParams) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      headers["content-type"] ??= "application/json";
    }
  }

  return fetch(url, {
    method,
    headers,
    body: payload,
    signal: combineSignals(runSignal, opts.timeoutMs ?? 30_000),
  });
}

async function parse(res: Response, as: NonNullable<HttpOptions["as"]>) {
  if (as === "none" || res.status === 204) return undefined;
  if (as === "text") return res.text();
  if (as === "buffer") return res.arrayBuffer();

  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function withQuery(
  url: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** The run's own abort signal ANDed with this request's timeout. */
function combineSignals(runSignal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)]);
}

function backoff(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  }
  return Math.round(500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
