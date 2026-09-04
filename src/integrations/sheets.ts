import type { HttpClient } from "./http.ts";

export interface SheetsClient {
  /** Reads a range, e.g. read("1AbC...", "Sheet1!A1:D100"). */
  read(spreadsheetId: string, range: string): Promise<string[][]>;
  /** Reads a range and maps rows onto the header row. */
  readObjects<T = Record<string, string>>(spreadsheetId: string, range: string): Promise<T[]>;
  /** Appends rows to the end of a range's table. */
  append(spreadsheetId: string, range: string, rows: (string | number)[][]): Promise<void>;
  /** Overwrites a range. */
  update(spreadsheetId: string, range: string, rows: (string | number)[][]): Promise<void>;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
let cached: CachedToken | undefined;

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Talks to the Sheets REST API directly with a service-account JWT signed via
 * WebCrypto. That avoids pulling in googleapis (~50MB) for four calls.
 *
 * Set GOOGLE_SERVICE_ACCOUNT_JSON to the full service-account JSON, and share
 * the spreadsheet with that account's client_email.
 */
export function createSheets(http: HttpClient): SheetsClient {
  const enc = (range: string) => encodeURIComponent(range);

  return {
    async read(spreadsheetId, range) {
      const res = await http.get<{ values?: string[][] }>(
        `${BASE}/${spreadsheetId}/values/${enc(range)}`,
        { headers: { authorization: `Bearer ${await accessToken()}` } },
      );
      return res.values ?? [];
    },

    async readObjects(spreadsheetId, range) {
      const rows = await this.read(spreadsheetId, range);
      const [header, ...body] = rows;
      if (!header) return [];
      return body.map((row) =>
        Object.fromEntries(header.map((key, i) => [key, row[i] ?? ""])),
      ) as any;
    },

    async append(spreadsheetId, range, rows) {
      await http.post(
        `${BASE}/${spreadsheetId}/values/${enc(range)}:append`,
        { values: rows },
        {
          headers: { authorization: `Bearer ${await accessToken()}` },
          query: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
        },
      );
    },

    async update(spreadsheetId, range, rows) {
      await http.put(
        `${BASE}/${spreadsheetId}/values/${enc(range)}`,
        { values: rows },
        {
          headers: { authorization: `Bearer ${await accessToken()}` },
          query: { valueInputOption: "USER_ENTERED" },
        },
      );
    },
  };
}

/** Signs a JWT with the service account key and exchanges it for a token. */
async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");

  let creds: { client_email: string; private_key: string };
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
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
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
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
