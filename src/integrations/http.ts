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

/** One page, as `next` sees it. */
export interface PageInfo {
  /** The parsed body of the page just fetched. */
  body: any;
  /** The items extracted from it. */
  items: unknown[];
  /** The URL that produced it, after redirects. */
  url: string;
  response: { status: number; headers: Headers };
  /** 1 for the first page. */
  page: number;
}

/**
 * How to reach the page after this one. Omit it and pagination auto-detects
 * the two unambiguous shapes: an RFC 5988 `Link: <…>; rel="next"` header, and
 * a body field holding an absolute URL (`next`, `next_url`, `links.next`, …).
 *
 * An opaque cursor token needs the parameter name spelled out — nothing in the
 * response says what to call it — as do page and offset counters.
 */
export type NextPage =
  /** Read a token from the body, send it back as a query parameter. */
  | { cursor: string; param: string }
  /** Increment a page-number query parameter. `from` is the first page, default 1. */
  | { page: string; from?: number }
  /** Advance an offset query parameter by the number of items received. */
  | { offset: string; from?: number }
  /** Anything else. Return an absolute or relative URL, or nothing to stop. */
  | ((info: PageInfo) => string | null | undefined);

export interface PaginateOptions<T = any> extends Omit<HttpOptions, "as"> {
  /**
   * Where the items live in the body: a dotted path ("data.items") or a
   * function. Default: the body itself when it is an array, otherwise its one
   * array-valued property.
   */
  items?: string | ((body: any) => T[] | undefined);
  next?: NextPage;
  /**
   * Hard ceiling on pages fetched. Exceeding it throws rather than returning a
   * short answer that looks complete. Default 100.
   */
  maxPages?: number;
  /** Stop cleanly once this many items have been yielded. */
  maxItems?: number;
}

/** The result of `paginate()`: iterate it, or take the whole thing. */
export interface Paged<T> extends AsyncIterable<T> {
  /** Every item in one array, under the same maxPages / maxItems ceilings. */
  all(): Promise<T[]>;
  /** One array per page, if the page boundaries matter to you. */
  pages(): AsyncIterable<T[]>;
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
  /**
   * Walks a paginated GET endpoint, one item at a time.
   *
   *   for await (const repo of ctx.http.paginate("https://api.github.com/user/repos")) …
   *   const all = await ctx.http.paginate(url, { next: { cursor: "next_cursor", param: "cursor" } }).all();
   *
   * Every page is an ordinary request: same retries, same 429 handling, same
   * run-page capture. Stops on an empty page, a missing next link, or
   * `maxItems`; throws on `maxPages` or a next link that doesn't advance.
   */
  paginate<T = any>(url: string, opts?: PaginateOptions<T>): Paged<T>;
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

interface Meta<T> {
  body: T;
  status: number;
  headers: Headers;
  /** The URL that actually served the response, after redirects. */
  url: string;
}

export function createHttp(runSignal: AbortSignal, record?: CallRecorder): HttpClient {
  /**
   * The full request, response headers included. Only pagination needs them —
   * a `Link: rel="next"` header is invisible from the parsed body — so every
   * other caller goes through `request()` and gets the body alone.
   */
  async function requestWithMeta<T>(
    method: string,
    url: string,
    body: unknown,
    opts: HttpOptions = {},
  ): Promise<Meta<T>> {
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
        return { body: parsed, status: res.status, headers: res.headers, url: res.url || target };
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

  async function request<T>(
    method: string,
    url: string,
    body: unknown,
    opts: HttpOptions = {},
  ): Promise<T> {
    return (await requestWithMeta<T>(method, url, body, opts)).body;
  }

  return {
    get: (url, opts) => request("GET", url, undefined, opts),
    post: (url, body, opts) => request("POST", url, body, opts),
    put: (url, body, opts) => request("PUT", url, body, opts),
    patch: (url, body, opts) => request("PATCH", url, body, opts),
    delete: (url, opts) => request("DELETE", url, undefined, opts),
    paginate: (url, opts = {}) => paginate(requestWithMeta, url, opts),
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

/* --------------------------------------------------------------- pagination */

const DEFAULT_MAX_PAGES = 100;

/**
 * Body fields that hold the link to the next page, in priority order. Only the
 * first one present decides — scanning past it would make the behaviour depend
 * on which fields an endpoint happens to have.
 */
const NEXT_FIELDS = [
  "next",
  "next_url",
  "nextUrl",
  "next_page_url",
  "nextPageUrl",
  "links.next.href",
  "links.next",
  "_links.next.href",
  "paging.next",
  "pagination.next_url",
  "pagination.next",
];

/** Body fields that hold the page's items, in priority order. */
const ITEM_FIELDS = [
  "data",
  "items",
  "results",
  "records",
  "values",
  "entries",
  "objects",
  "list",
  "rows",
  "elements",
];

type Send = <B>(
  method: string,
  url: string,
  body: unknown,
  opts?: HttpOptions,
) => Promise<Meta<B>>;

/**
 * Page-walking on top of the ordinary request path, so every page keeps the
 * retries, 429 handling, abort signal, and run-page capture of a normal call.
 *
 * The two failure modes worth designing against are the infinite loop and the
 * short answer that looks complete. Hence: a hard page cap and a repeated-URL
 * guard that both *throw*, while the ordinary ends — an empty page, no next
 * link, `maxItems` — return quietly.
 */
function paginate<T>(send: Send, url: string, opts: PaginateOptions<T>): Paged<T> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  // Only the first request takes `query`; after that it is part of the next URL.
  const reqOpts: HttpOptions = {
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  };

  async function* pages(): AsyncGenerator<T[]> {
    let target = withQuery(url, opts.query);
    const fetched = new Set<string>();
    let yielded = 0;

    for (let page = 1; page <= maxPages; page++) {
      fetched.add(target);
      const res = await send<any>("GET", target, undefined, reqOpts);
      const items = extractItems(res.body, opts.items, target, page) as T[];

      if (items.length === 0) return;

      if (opts.maxItems !== undefined && yielded + items.length >= opts.maxItems) {
        yield items.slice(0, opts.maxItems - yielded);
        return;
      }
      yield items;
      yielded += items.length;

      const info: PageInfo = {
        body: res.body,
        items,
        url: res.url,
        response: { status: res.status, headers: res.headers },
        page,
      };
      const next = nextLink(info, opts.next);
      if (!next) return;

      let resolved: string;
      try {
        resolved = new URL(next, res.url).toString();
      } catch {
        // A next link that isn't a URL ends the walk instead of looping on it.
        return;
      }
      if (fetched.has(resolved)) {
        throw new Error(
          `paginate: ${resolved} was already fetched — the next-page link is not advancing`,
        );
      }
      target = resolved;
    }

    throw new Error(
      `paginate: hit the ${maxPages}-page ceiling on ${url}. Raise maxPages if the ` +
        `endpoint really is that long, or fix the next-page extractor — returning ` +
        `what we have would look like a complete answer.`,
    );
  }

  async function* items(): AsyncGenerator<T> {
    for await (const batch of pages()) yield* batch;
  }

  return {
    [Symbol.asyncIterator]: items,
    pages: () => ({ [Symbol.asyncIterator]: pages }),
    async all() {
      const out: T[] = [];
      for await (const batch of pages()) out.push(...batch);
      return out;
    },
  };
}

function nextLink(info: PageInfo, spec: NextPage | undefined): string | undefined {
  if (typeof spec === "function") return spec(info) ?? undefined;

  if (spec && "cursor" in spec) {
    const token = pick(info.body, spec.cursor);
    if (token === null || token === undefined || token === "" || token === false) return undefined;
    const u = new URL(info.url);
    u.searchParams.set(spec.param, String(token));
    return u.toString();
  }

  // Counters: the response says nothing about where it is, so the URL is the
  // only state. Absent means we were on the first page.
  if (spec && "page" in spec) {
    return step(info.url, spec.page, 1, spec.from ?? 1);
  }
  if (spec && "offset" in spec) {
    return step(info.url, spec.offset, info.items.length, spec.from ?? 0);
  }

  return autoNext(info);
}

/**
 * Auto-detection covers only what a response says unambiguously: an RFC 5988
 * `Link` header, and a body field holding an actual URL. An opaque cursor
 * token is a hard error rather than a silent stop — nothing in the response
 * says what query parameter to send it back as, and quietly returning page one
 * is exactly the kind of "complete-looking" wrong answer to avoid.
 */
function autoNext(info: PageInfo): string | undefined {
  const link = linkRelNext(info.response.headers.get("link"));
  if (link) return link;

  for (const path of NEXT_FIELDS) {
    const value = pick(info.body, path);
    if (value === undefined) continue;
    if (value === null || value === "" || value === false) return undefined;
    if (typeof value === "string" && /^(https?:\/\/|\/)/i.test(value)) return value;
    if (typeof value === "object") {
      const href = (value as any).href ?? (value as any).url;
      if (typeof href === "string") return href;
      continue;
    }
    throw new Error(
      `paginate: "${path}" is ${JSON.stringify(value)}, not a URL — it looks like a ` +
        `cursor, so say where it goes: next: { cursor: "${path}", param: "<query-param>" } ` +
        `(or next: { page: "<query-param>" } for a page counter).`,
    );
  }
  return undefined;
}

/** `Link: <https://…?page=2>; rel="next", <https://…?page=9>; rel="last"` */
function linkRelNext(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(/,\s*(?=<)/)) {
    const m = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    if (m && /\brel\s*=\s*"?next"?/i.test(m[2]!)) return m[1];
  }
  return undefined;
}

/** Advances a numeric query parameter, defaulting it when the URL has none. */
function step(url: string, param: string, by: number, from: number): string {
  const u = new URL(url);
  const raw = u.searchParams.get(param);
  const current = raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : from;
  u.searchParams.set(param, String(current + by));
  return u.toString();
}

function extractItems(
  body: unknown,
  spec: PaginateOptions<any>["items"],
  url: string,
  page: number,
): unknown[] {
  let found: unknown;

  if (typeof spec === "function") found = spec(body);
  else if (typeof spec === "string") found = pick(body, spec);
  else if (Array.isArray(body)) return body;
  else if (body && typeof body === "object") {
    for (const field of ITEM_FIELDS) {
      const value = (body as Record<string, unknown>)[field];
      if (Array.isArray(value)) return value;
    }
    const arrays = Object.entries(body).filter(([, v]) => Array.isArray(v));
    if (arrays.length === 1) return arrays[0]![1] as unknown[];
    if (arrays.length > 1) {
      throw new Error(
        `paginate: ${url} returned several array fields (${arrays.map(([k]) => k).join(", ")}) — ` +
          `say which one holds the items with items: "<field>"`,
      );
    }
  }

  if (spec === undefined) {
    throw new Error(
      `paginate: no array of items in the response from ${url} — point at it with ` +
        `items: "<path>" or items: (body) => …`,
    );
  }
  // Missing on a later page reads as "this page has none", which is how a last
  // page often looks. Missing on the *first* page is a wrong path, and
  // returning nothing there would look exactly like an empty collection.
  if (found === undefined || found === null) {
    if (page === 1) {
      throw new Error(
        `paginate: items ${typeof spec === "string" ? `"${spec}"` : "extractor"} found ` +
          `nothing in the first response from ${url} — check the path against the body`,
      );
    }
    return [];
  }
  if (!Array.isArray(found)) {
    throw new Error(
      `paginate: items ${typeof spec === "string" ? `"${spec}"` : "extractor"} on ${url} ` +
        `gave ${describeValue(found)}, not an array`,
    );
  }
  return found;
}

function pick(body: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<any>((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), body);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : typeof value;
}
