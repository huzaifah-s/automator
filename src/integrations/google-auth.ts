/**
 * Service-account access tokens for the Google APIs, signed with WebCrypto.
 *
 * Extracted from `sheets.ts`, which minted its own and hard-coded the
 * spreadsheets scope into the claim. Drive needs a different scope against the
 * same key, and a second private copy of the JWT signing would have been the
 * third place `GOOGLE_SERVICE_ACCOUNT_JSON` is parsed and the second place a
 * PEM is turned into a key.
 *
 * Signing our own JWT rather than pulling in `googleapis` (~50MB) is the same
 * trade sheets.ts already made and AGENTS.md records: image size is a core
 * goal, and this is four calls' worth of code.
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Keyed by scope, because a token is only valid for the scopes it was minted
 * with. One cache for everything would hand a Sheets token to Drive, and the
 * failure — a 403 on a file that is definitely shared — says nothing about
 * why.
 */
const cache = new Map<string, CachedToken>();

/** Refresh this long before expiry so a slow call can't land on a dead token. */
const SKEW_MS = 60_000;

/**
 * A token for `scope`, minted if there isn't a live one cached.
 *
 * Throws a sentence naming the environment variable, because "invalid_grant"
 * is what Google says when the JSON is missing and that helps nobody.
 */
export async function googleAccessToken(scope: string): Promise<string> {
  const hit = cache.get(scope);
  if (hit && hit.expiresAt > Date.now() + SKEW_MS) return hit.token;

  const creds = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: creds.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify(claim),
  )}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(creds.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(new Uint8Array(signature))}`,
    }),
  });

  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { access_token: string; expires_in: number };
  cache.set(scope, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

/** The service account's own address — what a Drive folder has to be shared with. */
export function googleClientEmail(): string {
  return serviceAccount().client_email;
}

function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  try {
    return JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
}

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return Buffer.from(bytes).toString("base64url");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64").buffer as ArrayBuffer;
}
