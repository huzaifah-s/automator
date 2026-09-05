import { createHmac, createHash } from "node:crypto";

export interface S3Client {
  /**
   * Uploads bytes under `key` and returns the public URL they can be fetched
   * from — which is the only reason this integration exists, so it is the
   * return value rather than something the caller has to assemble.
   */
  put(key: string, body: Uint8Array<ArrayBuffer>, opts?: { contentType?: string }): Promise<string>;
  /** Removes an object. S3 answers 204 for a key that was never there. */
  delete(key: string): Promise<void>;
  /** The public URL for a key, without uploading anything. */
  publicUrl(key: string): string;
}

/**
 * S3-compatible object storage, signed with SigV4 and nothing else — no
 * `@aws-sdk/*`, which is tens of megabytes for two verbs.
 *
 * Written for Cloudflare R2 and works against S3 proper. R2's endpoint is
 * `https://<account-id>.r2.cloudflarestorage.com` and its region is the
 * literal string `auto`; both are the defaults below.
 *
 *   S3_ENDPOINT           https://<account-id>.r2.cloudflarestorage.com
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 *   S3_BUCKET             media
 *   S3_PUBLIC_URL         https://pub-<hash>.r2.dev   (the bucket's public URL)
 *   S3_REGION             optional, defaults to "auto"
 *
 * **The bucket has to be publicly readable**, because the whole point is
 * handing Meta a URL it can fetch with no credentials. That is why uploads are
 * expected to be deleted again the moment the fetch is done — see the
 * cross-poster, which does exactly that.
 *
 * This deliberately does not go through `ctx.http`: that client JSON-encodes
 * anything that is not a string, retries, and records request and response
 * bodies onto the run page. None of those is right for a 200MB video.
 */
export function createS3(): S3Client {
  return {
    publicUrl(key) {
      return `${config().publicUrl}/${encodeKey(key)}`;
    },

    async put(key, body, opts = {}) {
      const cfg = config();
      const contentType = opts.contentType || "application/octet-stream";

      const res = await signedFetch(cfg, "PUT", objectPath(cfg, key), "", body, {
        "content-type": contentType,
      });
      if (!res.ok) throw new Error(await explain(res, "upload", key));

      return `${cfg.publicUrl}/${encodeKey(key)}`;
    },

    async delete(key) {
      const cfg = config();
      const res = await signedFetch(cfg, "DELETE", objectPath(cfg, key), "", new Uint8Array(0), {});
      // 204 is the success; 404 means it is already gone, which is the state
      // the caller wanted anyway.
      if (!res.ok && res.status !== 404) throw new Error(await explain(res, "delete", key));
    },
  };
}

/* ----------------------------------------------------------------- config */

export interface S3Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  publicUrl: string;
}

/**
 * Read per call rather than captured at import, so a key rotated into the
 * store reaches a running process — the same reason `defineSecrets` returns a
 * live proxy instead of a snapshot.
 */
function config(): S3Config {
  const endpoint = need("S3_ENDPOINT").replace(/\/+$/, "");
  return {
    endpoint,
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    bucket: need("S3_BUCKET"),
    // R2 ignores the region but still requires it in the signature, and "auto"
    // is what it expects to see there.
    region: process.env.S3_REGION || "auto",
    publicUrl: need("S3_PUBLIC_URL").replace(/\/+$/, ""),
  };
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/* -------------------------------------------------------------- signing */

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

async function signedFetch(
  cfg: S3Config,
  method: "GET" | "PUT" | "DELETE",
  /** Already percent-encoded, leading slash included. */
  path: string,
  /** Canonical query string: sorted, encoded, no leading "?". Empty for none. */
  query: string,
  body: Uint8Array<ArrayBuffer>,
  extraHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const url = new URL(`${cfg.endpoint}${path}${query ? `?${query}` : ""}`);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const headers: Record<string, string> = {
    ...extraHeaders,
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  // Every header we send is signed. Sorted by name, values trimmed: both are
  // part of the canonical form, not tidiness. Every key above is already
  // lowercase, which is the form the canonical request wants.
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((h) => `${h}:${headers[h]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${cfg.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");

  const signature = hmac(signingKey(cfg, dateStamp), stringToSign).toString("hex");

  headers.authorization =
    `${ALGORITHM} Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, {
    method,
    headers,
    // A zero-length body must be absent, not an empty buffer: sending one is
    // what makes fetch add a content-length header we did not sign.
    body: body.byteLength > 0 ? body : undefined,
    signal,
  });
}

/** `/<bucket>/<key>`, encoded once, which is the form SigV4 signs for S3. */
function objectPath(cfg: S3Config, key: string): string {
  return `/${encodeKey(cfg.bucket)}/${encodeKey(key)}`;
}

/**
 * Lists one key. Not useful as data — it exists so the Credentials tab can
 * prove the endpoint, the keys, the region and the bucket name all at once,
 * which is more than any per-field validation can do, while reading nothing
 * and costing nothing.
 */
export async function listBucket(cfg: S3Config, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    // Canonical query strings are sorted by key, and these already are.
    res = await signedFetch(
      cfg,
      "GET",
      `/${encodeKey(cfg.bucket)}`,
      "list-type=2&max-keys=1",
      new Uint8Array(0),
      {},
      signal,
    );
  } catch (err) {
    // A wrong endpoint fails at the TLS or DNS layer, and what fetch says about
    // it ("unknown certificate verification error") names nothing you can act
    // on. The endpoint is configuration, not a credential, so it is safe — and
    // necessary — to put it in the message.
    throw new Error(
      `Could not reach ${cfg.endpoint} — ${err instanceof Error ? err.message : String(err)}. ` +
        "Check the endpoint: for R2 it is https://<account-id>.r2.cloudflarestorage.com",
    );
  }
  if (!res.ok) throw new Error(await explain(res, "list", cfg.bucket));
}

/** The date/region/service/aws4_request HMAC chain, in that order. */
function signingKey(cfg: S3Config, dateStamp: string): Buffer {
  const kDate = hmac(Buffer.from(`AWS4${cfg.secretAccessKey}`, "utf8"), dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Percent-encodes a key for both the URL and the signature, keeping `/` so a
 * nested key stays nested.
 *
 * `encodeURIComponent` leaves `!'()*` alone and SigV4 does not, so those are
 * finished by hand. A signature computed over a different spelling of the same
 * key fails as an opaque 403.
 */
function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

/**
 * S3 errors are XML, and the `<Message>` in them is the only useful part. The
 * raw body is kept as a fallback but truncated — an access-denied page is not
 * worth putting on a run page whole.
 */
async function explain(res: Response, what: string, key: string): Promise<string> {
  const body = (await res.text().catch(() => "")).trim();
  const message = body.match(/<Message>([^<]+)<\/Message>/)?.[1];
  const detail = message ?? body.slice(0, 300);
  return `S3 ${what} of "${key}" failed: ${res.status}${detail ? ` — ${detail}` : ""}`;
}
