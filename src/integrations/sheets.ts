import type { HttpClient } from "./http.ts";
import { googleAccessToken } from "./google-auth.ts";

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

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Talks to the Sheets REST API directly with a service-account token — see
 * `google-auth.ts`, which signs the JWT. That avoids pulling in googleapis
 * (~50MB) for four calls.
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

/**
 * Read/write access to spreadsheets, and nothing else. Narrower than the
 * account's own grants on purpose: a Drive token minted from the same key
 * carries `drive.readonly`, and the two must not be interchangeable.
 */
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function accessToken(): Promise<string> {
  return googleAccessToken(SCOPE);
}
