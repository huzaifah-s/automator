import { googleAccessToken, googleClientEmail } from "./google-auth.ts";

/** One file's bytes, plus the two things a downstream upload needs to know. */
export interface DriveFile {
  bytes: Uint8Array<ArrayBuffer>;
  /** Drive's own record of the type. "application/octet-stream" if it has none. */
  mimeType: string;
  /** The file's name in Drive, which is where the extension comes from. */
  name: string;
  size: number;
}

export interface DriveClient {
  /** Metadata only — name, mimeType, size. One cheap call, no bytes. */
  meta(fileId: string): Promise<Omit<DriveFile, "bytes">>;
  /** The file's bytes. `maxBytes` refuses anything larger before reading it. */
  download(fileId: string, opts?: { maxBytes?: number }): Promise<DriveFile>;
  /** Parses a Drive file id out of any of the URL shapes people paste. */
  fileId(url: string): string | null;
}

const API = "https://www.googleapis.com/drive/v3/files";

/**
 * Read-only. This account never needs to write to Drive, and a token that
 * cannot delete a file is one fewer thing a bug can do.
 */
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Default ceiling on one download, so a stray 4GB file can't take the process. */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Downloads files from Google Drive with the service account in
 * GOOGLE_SERVICE_ACCOUNT_JSON.
 *
 * **The files must be shared with the service account.** It is its own
 * identity — not the person whose Drive the folder lives in — so a file nobody
 * shared with it is a 404, and a 404 here means "not shared" far more often
 * than it means "not there". `explain()` below says so, because the alternative
 * is somebody checking that the id is right for twenty minutes.
 *
 * This does not go through `ctx.http`. That client parses bodies, retries, and
 * records every call for the run page — none of which you want wrapped around
 * a 200MB video. The bytes are fetched here and only the outcome is captured.
 */
export function createDrive(): DriveClient {
  return {
    fileId,

    async meta(id) {
      const res = await fetch(
        `${API}/${encodeURIComponent(id)}?fields=name,mimeType,size&supportsAllDrives=true`,
        { headers: { authorization: `Bearer ${await googleAccessToken(SCOPE)}` } },
      );
      if (!res.ok) throw new Error(await explain(res, id));

      const body = (await res.json()) as { name?: string; mimeType?: string; size?: string };
      return {
        name: body.name ?? id,
        mimeType: body.mimeType ?? "application/octet-stream",
        // Drive sends size as a string, and omits it for Google-native docs.
        size: Number(body.size ?? 0),
      };
    },

    async download(id, opts = {}) {
      const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
      const info = await this.meta(id);

      // Checked before the body is read, not after: the point is to never hold
      // the bytes at all. Drive omits `size` for its own native formats, and
      // those are exports rather than files — 0 falls through to the download,
      // which then fails with Drive's own explanation.
      if (info.size > max) {
        throw new Error(
          `Drive file "${info.name}" is ${mb(info.size)}MB, over the ${mb(max)}MB limit`,
        );
      }

      const res = await fetch(
        `${API}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
        { headers: { authorization: `Bearer ${await googleAccessToken(SCOPE)}` } },
      );
      if (!res.ok) throw new Error(await explain(res, id));

      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > max) {
        throw new Error(
          `Drive file "${info.name}" turned out to be ${mb(bytes.byteLength)}MB, ` +
            `over the ${mb(max)}MB limit`,
        );
      }

      return { bytes, mimeType: info.mimeType, name: info.name, size: bytes.byteLength };
    },
  };
}

/**
 * The id out of a Drive URL. Handles `/file/d/<id>/view`, `?id=<id>`, and
 * `/d/<id>` — and returns null for a *folder* link, which is a different
 * mistake and gets its own message from the caller.
 */
function fileId(url: string): string | null {
  const text = String(url).trim();
  if (/\/folders\//.test(text)) return null;
  const match =
    text.match(/\/file\/d\/([A-Za-z0-9_-]+)/) ??
    text.match(/[?&]id=([A-Za-z0-9_-]+)/) ??
    text.match(/\/d\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

/**
 * Google's status, plus the sentence it does not say. A 404 on a file id that
 * is definitely correct is what "you did not share it" looks like from here.
 */
async function explain(res: Response, id: string): Promise<string> {
  const detail = (await res.text().catch(() => "")).trim().slice(0, 300);

  if (res.status === 404 || res.status === 403) {
    let who = "the service account";
    try {
      who = googleClientEmail();
    } catch {
      /* the JSON is unreadable, which the token mint already complained about */
    }
    return (
      `Drive answered ${res.status} for file ${id} — most often this means the file is ` +
      `not shared with ${who}. Share the file or its folder with that address ` +
      `(Viewer is enough).${detail ? ` Google said: ${detail}` : ""}`
    );
  }

  return `Drive answered ${res.status} for file ${id}${detail ? ` — ${detail}` : ""}`;
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}
