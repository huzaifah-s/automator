import { z, type ZodTypeAny } from "zod";
import { defineSecrets } from "../core/secrets.ts";
import { registerSecret } from "../core/redact.ts";
import { createState } from "../core/state.ts";
import { createCipher, decodeKey } from "../core/crypto.ts";
import { log } from "../core/logger.ts";

/**
 * OAuth2 refresh-token credentials, for the providers that only issue
 * short-lived access tokens against a user's consent — Notion, HubSpot,
 * Salesforce, Xero, Google-as-a-person.
 *
 * There is no browser consent flow here and there is not meant to be one: you
 * obtain a refresh token once, out of band, and paste it into the environment.
 * What this owns is everything after that — refreshing before expiry, keeping
 * the rotated token, and making sure two concurrent runs don't both spend it.
 *
 *   const notion = defineOAuth("notion", {
 *     tokenUrl: "https://api.notion.com/v1/oauth/token",
 *     auth: "basic",
 *   });
 *
 *   await ctx.http.get(url, {
 *     headers: { authorization: `Bearer ${await notion.accessToken()}` },
 *   });
 *
 * Reads OAUTH_NOTION_CLIENT_ID, OAUTH_NOTION_CLIENT_SECRET and
 * OAUTH_NOTION_REFRESH_TOKEN, all validated at boot like any other secret.
 *
 * `flow: "self"` covers the other family — Meta's long-lived tokens, where
 * there is no client secret and no separate refresh token, just one token that
 * you trade for a later-expiring copy of itself:
 *
 *   const threads = defineOAuth("threads-the-mantra", {
 *     tokenUrl: "https://graph.threads.net/refresh_access_token",
 *     flow: "self",
 *     grantType: "th_refresh_token",
 *   });
 *
 * Those tokens live for weeks rather than an hour, so nothing calls
 * accessToken() often enough to keep one alive on its own — that needs a
 * scheduled refresh(), and status() is how such a workflow reports what is
 * left without ever touching the token.
 */

/**
 * Refresh this long before the provider's expiry, to cover a slow request —
 * but never more than half the token's life. A provider handing out tokens
 * that live for less than the skew would otherwise be refreshed on every
 * single call, and against one that rotates its refresh token that is a loop
 * spending a credential per API request.
 */
const REFRESH_SKEW_MS = 60_000;
/** Ceiling on one token-endpoint call. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** What a provider that omits expires_in is assumed to mean. */
const DEFAULT_TTL_SECONDS = 3_600;
/** Reserved in the shared namespace, like "@poll:" and "@webhook:". */
const KEY_PREFIX = "@oauth:";
/** Where the master key lives. 32 bytes, base64 or hex. */
const KEY_ENV = "OAUTH_ENCRYPTION_KEY";

export interface OAuthConfig {
  /** The provider's token endpoint, e.g. https://oauth2.googleapis.com/token. */
  tokenUrl: string;
  /**
   * Which refresh shape the provider speaks.
   *
   * "oauth2" (default) is RFC 6749 §6: POST the refresh token as a form,
   * authenticated with the client credentials, and get a short-lived access
   * token back.
   *
   * "self" is the long-lived-token shape Meta uses for Threads and Instagram.
   * There is no client secret and no separate refresh token — you GET the
   * endpoint with the token you already hold and receive a later-expiring
   * replacement, and *that* is what you send next time. Only
   * OAUTH_<NAME>_REFRESH_TOKEN is read, and it holds the long-lived token.
   *
   * Both are stored, encrypted and locked identically. The flow only decides
   * how the exchange is spelled.
   */
  flow?: "oauth2" | "self";
  /**
   * The grant_type sent with a refresh. Defaults to "refresh_token"; Meta
   * wants "th_refresh_token" for Threads and "ig_refresh_token" for Instagram.
   */
  grantType?: string;
  /**
   * How the client credentials are sent. "body" (default) puts client_id and
   * client_secret in the form; "basic" sends them as HTTP Basic, which some
   * providers require and others reject. Ignored by "self", which has no
   * client credentials to send.
   */
  auth?: "body" | "basic";
  /** Sent with every refresh, for the providers that want it repeated. */
  scope?: string;
  /** Anything else this provider requires in the refresh body. */
  extraParams?: Record<string, string>;
  /** Env prefix override. Default OAUTH_<NAME>. */
  env?: string;
  /**
   * What to assume when the provider omits expires_in. Default 3600, which is
   * right for an hourly access token and badly wrong for a 60-day one — so a
   * "self" credential should say what its tokens are actually worth. Getting
   * this wrong does not break the refresh; it makes the stored expiry, and
   * therefore anything reporting on it, lie.
   */
  defaultTtlSeconds?: number;
  /** Ceiling on the token call. Default 15_000. */
  timeoutMs?: number;
}

export interface OAuthCredential {
  readonly name: string;
  /**
   * A usable access token, refreshed first if the stored one is within a
   * minute of expiry. Concurrent callers share one refresh.
   */
  accessToken(): Promise<string>;
  /**
   * Forces a refresh even if the stored token still looks valid — for the
   * provider that returns 401 on a token it told you was good for an hour.
   * Retry the call once with this; do not loop on it.
   */
  refresh(): Promise<string>;
  /**
   * What is stored, minus the token itself. Nothing in here is a credential,
   * which is the point: a workflow whose whole job is keeping a long-lived
   * token alive has to be able to report how long is left without ever
   * holding the token, let alone putting it in a step result.
   *
   * `undefined` before the first refresh has ever stored anything, and also
   * when the stored value could not be decrypted.
   */
  status(): Promise<TokenStatus | undefined>;
}

/** The dates behind a stored token. Deliberately carries no credential. */
export interface TokenStatus {
  expiresAt: Date;
  /** Absent on a token stored before this was recorded. */
  refreshedAt?: Date;
}

/** What we keep per credential, encrypted, in shared state. */
interface Token {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /**
   * When the last successful refresh landed. Absent on tokens written before
   * this field existed. Threads refuses to refresh a token younger than 24
   * hours, so a keep-alive workflow has to be able to ask.
   */
  refreshedAt?: number;
  /** How early to refresh this particular token — see REFRESH_SKEW_MS. */
  skewMs: number;
  /**
   * Hash of the refresh token from the environment that started this chain.
   * When it stops matching, the operator has pasted a new one deliberately and
   * the stored chain — which may well be dead, which is why they pasted it —
   * has to be abandoned rather than preferred.
   */
  seed: string;
}

interface Envelope {
  v: 1;
  /** base64(iv ‖ AES-256-GCM ciphertext) over the JSON of Token. */
  data: string;
}

interface Resolved {
  name: string;
  config: OAuthConfig;
  prefix: string;
  clientId: string;
  clientSecret: string;
  seedToken: string;
  seedHash: string;
}

/**
 * One refresh per credential at a time. We are single-process by design, so an
 * in-process map is a sufficient lock — and it has to exist: most providers
 * invalidate the old refresh token the moment it is used, so two runs
 * refreshing at once means the second one stores a token the provider has
 * already killed.
 */
const inflight = new Map<string, Promise<Token>>();

/** Credentials declared so far, to catch two files disagreeing about one name. */
const declared = new Map<string, string>();

/**
 * Conditions already reported, so a state problem doesn't print once per
 * caller — twenty concurrent runs hitting one unreadable token is one fact,
 * not twenty. Cleared when a refresh succeeds, so a recurrence is heard again.
 */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(message);
}

const state = createState("@shared");

export function defineOAuth(name: string, config: OAuthConfig): OAuthCredential {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `OAuth credential "${name}" must be lowercase letters, digits, and dashes`,
    );
  }

  const prefix = config.env ?? `OAUTH_${name.toUpperCase().replace(/-/g, "_")}`;

  // Declaring the same credential from two workflows is normal and shares one
  // stored token. Declaring it against two different providers is a bug that
  // would otherwise show up as one workflow silently clobbering the other's.
  const seen = declared.get(name);
  if (seen !== undefined && seen !== config.tokenUrl) {
    throw new Error(
      `OAuth credential "${name}" is declared twice with different token URLs ` +
        `(${seen} and ${config.tokenUrl}) — they would share one stored token`,
    );
  }
  declared.set(name, config.tokenUrl);

  // Validated and registered for redaction at import time, exactly like every
  // other secret: a missing key stops the deploy, not the 3am run.
  const shape: Record<string, ZodTypeAny> = {
    [`${prefix}_REFRESH_TOKEN`]: z.string().min(1),
    [KEY_ENV]: z
      .string()
      .refine((raw) => decodeKey(raw) !== undefined, {
        message: "must be 32 bytes, base64 or hex — generate with: openssl rand -base64 32",
      }),
  };
  // A "self" credential has no client keys, and declaring them anyway would
  // abort the boot over two variables nobody can fill in.
  if (config.flow !== "self") {
    shape[`${prefix}_CLIENT_ID`] = z.string().min(1);
    shape[`${prefix}_CLIENT_SECRET`] = z.string().min(1);
  }
  const env = defineSecrets(shape) as Record<string, string | undefined>;

  const seedToken = env[`${prefix}_REFRESH_TOKEN`] ?? "";
  const cred: Resolved = {
    name,
    config,
    prefix,
    clientId: env[`${prefix}_CLIENT_ID`] ?? "",
    clientSecret: env[`${prefix}_CLIENT_SECRET`] ?? "",
    seedToken,
    seedHash: sha256(seedToken),
  };

  return {
    name,
    async accessToken() {
      const stored = await load(cred);
      if (isFresh(stored)) return stored.accessToken;
      return (await withLock(name, () => refreshNow(cred, false))).accessToken;
    },
    async refresh() {
      return (await withLock(name, () => refreshNow(cred, true))).accessToken;
    },
    async status() {
      const stored = await load(cred);
      if (!stored) return undefined;
      return {
        expiresAt: new Date(stored.expiresAt),
        refreshedAt:
          stored.refreshedAt === undefined ? undefined : new Date(stored.refreshedAt),
      };
    },
  };
}

/**
 * Runs `fn` alone per credential; everyone else awaits the same promise rather
 * than starting a second refresh.
 */
function withLock(name: string, fn: () => Promise<Token>): Promise<Token> {
  const pending = inflight.get(name);
  if (pending) return pending;

  // Created and registered in one synchronous tick, so nothing can slip
  // between the check above and the map entry below.
  const run = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(name);
    }
  })();
  inflight.set(name, run);
  return run;
}

/**
 * The refresh itself, always under the lock. Re-reads state first: a caller
 * that queued behind another refresh must not spend the token that one has
 * already rotated away.
 */
async function refreshNow(cred: Resolved, force: boolean): Promise<Token> {
  const stored = await load(cred);
  if (!force && isFresh(stored)) return stored;

  const refreshToken = stored?.refreshToken ?? cred.seedToken;
  const fresh = await exchange(cred, refreshToken);
  await save(cred, fresh);

  log.info(
    `oauth: refreshed "${cred.name}", valid for ${Math.round((fresh.expiresAt - Date.now()) / 1000)}s` +
      (fresh.refreshToken === refreshToken ? "" : " (provider rotated the refresh token)"),
  );
  return fresh;
}

function isFresh(token: Token | undefined): token is Token {
  if (!token) return false;
  return token.expiresAt > Date.now() + (token.skewMs ?? REFRESH_SKEW_MS);
}

/**
 * Deliberately plain fetch rather than ctx.http: the token endpoint's response
 * body is a credential, and ctx.http records request and response into the run
 * page. This call is not something you want to see there.
 */
async function exchange(cred: Resolved, refreshToken: string): Promise<Token> {
  const self = (cred.config.flow ?? "oauth2") === "self";
  const grantType = cred.config.grantType ?? "refresh_token";
  const url = new URL(cred.config.tokenUrl);
  const headers: Record<string, string> = { accept: "application/json" };
  let init: RequestInit;

  if (self) {
    // Meta refreshes a long-lived token over GET, with the token itself as a
    // query parameter. That puts a live credential in a URL — which is the
    // second reason this call is a plain fetch and never ctx.http: the
    // recorded request on the run page *would be* the token.
    for (const [key, value] of Object.entries(cred.config.extraParams ?? {})) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("grant_type", grantType);
    url.searchParams.set("access_token", refreshToken);
    init = { method: "GET", headers };
  } else {
    const body = new URLSearchParams({
      grant_type: grantType,
      refresh_token: refreshToken,
      ...(cred.config.scope ? { scope: cred.config.scope } : {}),
      ...cred.config.extraParams,
    });

    headers["content-type"] = "application/x-www-form-urlencoded";

    if ((cred.config.auth ?? "body") === "basic") {
      // RFC 6749 §2.3.1: form-encode each half before base64.
      const pair = `${encodeURIComponent(cred.clientId)}:${encodeURIComponent(cred.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    } else {
      body.set("client_id", cred.clientId);
      body.set("client_secret", cred.clientSecret);
    }

    init = { method: "POST", headers, body };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(cred.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `OAuth refresh for "${cred.name}" could not reach ${cred.config.tokenUrl}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    // A rejected refresh token is the one failure an operator has to act on,
    // and no retry will fix it — say what to do instead of just the status.
    const dead = res.status === 400 || res.status === 401;
    throw new Error(
      `OAuth refresh for "${cred.name}" failed: ${res.status} ${text.slice(0, 300)}` +
        (dead
          ? ` — if this says invalid_grant the refresh token is spent or revoked; ` +
            `obtain a new one and set ${cred.prefix}_REFRESH_TOKEN, which replaces the stored one on next use`
          : ""),
    );
  }

  let parsed: { access_token?: string; refresh_token?: string; expires_in?: number | string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `OAuth refresh for "${cred.name}" returned a non-JSON body: ${text.slice(0, 200)}`,
    );
  }

  if (!parsed.access_token) {
    throw new Error(`OAuth refresh for "${cred.name}" returned no access_token`);
  }

  // A rotated refresh token never came from the environment, so the redactor
  // has never seen it. Register both halves before anything can log them.
  registerSecret(parsed.access_token);
  if (parsed.refresh_token) registerSecret(parsed.refresh_token);

  const seconds = Number(parsed.expires_in);
  const fallback = cred.config.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
  const lifetimeMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : fallback) * 1_000;
  const now = Date.now();
  return {
    accessToken: parsed.access_token,
    // A "self" provider returns no refresh_token because the token it just
    // issued *is* the next one. Keeping the one we sent would pin the chain to
    // a token still counting down on the original clock, which is the one
    // thing refreshing exists to prevent.
    // Providers that don't rotate simply omit it; the one we sent stays valid.
    refreshToken: self ? parsed.access_token : (parsed.refresh_token ?? refreshToken),
    expiresAt: now + lifetimeMs,
    refreshedAt: now,
    skewMs: Math.min(REFRESH_SKEW_MS, Math.floor(lifetimeMs / 2)),
    seed: cred.seedHash,
  };
}

async function load(cred: Resolved): Promise<Token | undefined> {
  const envelope = await state.get<Envelope>(KEY_PREFIX + cred.name);
  if (!envelope) return undefined;

  let token: Token;
  try {
    token = await decrypt(envelope);
  } catch {
    // Wrong or rotated master key. Falling back to the environment's refresh
    // token is the only path that can recover without a hand-edited database,
    // and it fails loudly at the provider if that one is spent too.
    warnOnce(
      `${cred.name}:undecryptable`,
      `oauth: stored token for "${cred.name}" could not be decrypted with ${KEY_ENV} — ` +
        `falling back to ${cred.prefix}_REFRESH_TOKEN`,
    );
    return undefined;
  }

  if (token.seed !== cred.seedHash) {
    warnOnce(
      `${cred.name}:reseeded`,
      `oauth: ${cred.prefix}_REFRESH_TOKEN changed — discarding the token chain stored for "${cred.name}"`,
    );
    return undefined;
  }

  // Every process that reads a stored token has to teach its own redactor
  // about it. Registering only inside exchange() covers the process that did
  // the refresh and nothing after a restart — verified the hard way: a second
  // process reused the token from state and wrote it, unredacted, straight
  // onto the run page.
  registerSecret(token.accessToken);
  registerSecret(token.refreshToken);
  return token;
}

async function save(cred: Resolved, token: Token): Promise<void> {
  await state.set<Envelope>(KEY_PREFIX + cred.name, await encrypt(token));
  warned.delete(`${cred.name}:undecryptable`);
  warned.delete(`${cred.name}:reseeded`);
}

/* ── Encryption at rest ──────────────────────────────────────────────────
 *
 * Only these keys are encrypted, not the whole of ctx.state. State otherwise
 * holds cursors and dedupe marks, where "open the database file" is the
 * documented way to look at it — worth keeping. A live refresh token for a
 * dozen services is a different thing to leave in a backup in the clear.
 *
 * Losing OAUTH_ENCRYPTION_KEY costs the stored tokens, not access: the seeds
 * in the environment still work, and load() falls back to them.
 *
 * The wire format lives in core/crypto.ts, shared with the secret store. It is
 * unchanged from when this file owned it — base64(iv ‖ ciphertext) — because
 * databases in the field already hold tokens written that way.
 */

const cipher = createCipher([KEY_ENV]);

async function encrypt(token: Token): Promise<Envelope> {
  return { v: 1, data: await cipher.encrypt(JSON.stringify(token)) };
}

async function decrypt(envelope: Envelope): Promise<Token> {
  return JSON.parse(await cipher.decrypt(envelope.data)) as Token;
}

/** Identifies which env seed a stored chain grew from, without storing it twice. */
function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
