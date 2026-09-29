/**
 * Practice runs — n8n's "execute node", for a runner whose workflows are files.
 *
 * `bun run try` runs a workflow on the laptop against the real services: every
 * *read* goes out for real, so the run sees real data, and every *write* is
 * held back and reported instead of sent. Nothing needs deploying first, and
 * nothing a practice run does can be seen by anybody else.
 *
 * **It gates `globalThis.fetch`, not `ctx.http`.** A gate on the HTTP client
 * would be tidier and would miss things: the Contents notifier sends its
 * Telegram with a bare `fetch`, and Drive, S3, OAuth and the alert channel all
 * call it directly too. Patching the one function every one of those ends in
 * is what makes "held back" a promise about every connection rather than
 * about the ones that happen to go through the client. The two outbound paths
 * that are not HTTP — SMTP and Postgres — are guarded where their clients are
 * built, in `src/integrations/index.ts`.
 *
 * **When a request cannot be classified, it is held.** A read wrongly held is
 * a practice run that shows a placeholder where data should be, and says so.
 * A write wrongly sent is a customer message, a Monday update, a Notion page —
 * the thing this whole mode exists to prevent. So `classify` names the reads
 * it knows (every GET; the POSTs that only look things up) and everything else
 * is a write.
 *
 * A held request answers 200 with a placeholder body. Code that reads the
 * reply of a write — a created page's id — sees `practice_run: true` and no
 * id; that is the cost, and the report says which call it was.
 */

export interface HeldCall {
  method: string;
  url: string;
  body: unknown;
  /** Why it was held — shown next to it in the report. */
  why: string;
}

let active = false;
const held: HeldCall[] = [];

/** Whether this process is a practice run. Only `bun run try` turns it on. */
export function isPractice(): boolean {
  return active;
}

/** Every write held back so far, in the order they were attempted. */
export function heldCalls(): readonly HeldCall[] {
  return held;
}

/** Records a write that never reached the network — SMTP, for one. */
export function holdBack(call: HeldCall): void {
  held.push(call);
}

/** The body a held request answers with. */
export const PLACEHOLDER = {
  practice_run: true,
  note: "Held back: this was a practice run, and nothing was sent.",
} as const;

/**
 * Switches the process into practice mode. Called once, before anything has a
 * chance to make a request — the top of `src/index.ts` — and never undone:
 * a process that was practising stays practising until it exits.
 */
export function startPractice(): void {
  if (active) return;
  active = true;
  const real = globalThis.fetch;

  const gated = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const url = request ? request.url : String(input);
    const text = await bodyText(init?.body ?? (request ? await request.clone().text() : undefined));

    const verdict = classify(method, url, text);
    if (verdict.send) return real(input, init);

    held.push({ method, url, body: parseMaybe(text), why: verdict.why });
    return new Response(JSON.stringify(PLACEHOLDER), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  globalThis.fetch = Object.assign(gated, { preconnect: real.preconnect }) as typeof fetch;
}

/**
 * Whether a request may leave the machine during a practice run.
 *
 * Exported for the report, which shows the rule next to every held call, and
 * so the list below is the one place a new read-only POST is taught.
 */
export function classify(
  method: string,
  url: string,
  body: string | undefined,
): { send: boolean; why: string } {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return { send: true, why: "read" };
  }

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { send: false, why: "unreadable URL" };
  }
  const host = u.hostname;
  const path = u.pathname;

  if (method === "POST") {
    // GraphQL is POST for reads and writes alike, and the operation says
    // which. Monday is the one in this repo; the rule is not Monday's.
    const gql = graphqlOperation(body);
    if (gql === "query") return { send: true, why: "GraphQL query" };
    if (gql === "mutation") return { send: false, why: "GraphQL mutation" };

    if (host === "api.notion.com") {
      if (/^\/v1\/(databases|data_sources)\/[^/]+\/query$/.test(path) || path === "/v1/search") {
        return { send: true, why: "Notion query" };
      }
    }
    // getMe, getUpdates, getChat, getFile, getWebhookInfo — Telegram's reads
    // are all named get*, and every one of its writes is not.
    if (host === "api.telegram.org" && /^\/bot[^/]+\/get[A-Z]\w*$/.test(path)) {
      return { send: true, why: "Telegram read" };
    }
    // A model call costs money and changes nothing. Holding it would make
    // every AI workflow's practice run meaningless.
    if (host === "api.anthropic.com" && path === "/v1/messages") {
      return { send: true, why: "model call" };
    }
    if (
      host === "api.openai.com" &&
      /^\/v1\/(chat\/completions|responses|embeddings)$/.test(path)
    ) {
      return { send: true, why: "model call" };
    }
    // Minting an access token from something that does not rotate. A
    // refresh_token grant is deliberately *not* here: some providers retire
    // the refresh token they were sent, and the laptop would then hold the
    // only live copy — the server's would be dead on its next refresh.
    const grant = formField(body, "grant_type");
    if (grant === "client_credentials" || grant === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      return { send: true, why: "token exchange" };
    }
    if (grant === "refresh_token") {
      return {
        send: false,
        why: "token refresh — may retire the server's refresh token; use --live if you mean it",
      };
    }
  }

  return { send: false, why: "changes something" };
}

/** "query", "mutation", or null when the body is not a GraphQL request. */
function graphqlOperation(body: string | undefined): "query" | "mutation" | null {
  if (!body) return null;
  let query: unknown;
  try {
    query = (JSON.parse(body) as { query?: unknown })?.query;
  } catch {
    return null;
  }
  if (typeof query !== "string") return null;
  // A document can hold a query *and* a mutation and pick one with
  // `operationName`, so the first keyword proves nothing: any mention of
  // `mutation` or `subscription` holds it. A query that merely says the word
  // in a string is held too — the safe direction to be wrong in.
  const doc = query.replace(/#[^\n]*/g, "");
  if (/\b(mutation|subscription)\b/.test(doc)) return "mutation";
  return "query";
}

function formField(body: string | undefined, name: string): string | null {
  if (!body || body.trimStart().startsWith("{")) {
    try {
      const v = body ? (JSON.parse(body) as Record<string, unknown>)[name] : undefined;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }
  return new URLSearchParams(body).get(name);
}

async function bodyText(body: unknown): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return body.text();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `(${byteLength(body)} bytes)`;
  if (body instanceof FormData) {
    const parts: Record<string, string> = {};
    for (const [k, v] of body.entries()) parts[k] = typeof v === "string" ? v : "(file)";
    return JSON.stringify(parts);
  }
  return "(stream)";
}

function byteLength(body: ArrayBuffer | ArrayBufferView): number {
  return body instanceof ArrayBuffer ? body.byteLength : body.byteLength;
}

function parseMaybe(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
