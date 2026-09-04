import type { WebhookVerifier } from "./types.ts";

/**
 * Constant-time compare so a wrong secret or digest can't be recovered byte
 * by byte. Shared by the shared-secret check and every verifier below.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Length alone is not secret enough to be worth leaking through an early exit.
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < Math.max(ba.length, bb.length); i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

type Algorithm = "SHA-1" | "SHA-256" | "SHA-512";
type Encoding = "base64" | "hex";

async function hmac(
  algorithm: Algorithm,
  secret: string,
  body: string,
  encoding: Encoding,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const bytes = new Uint8Array(signed);
  return encoding === "hex"
    ? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    : btoa(String.fromCharCode(...bytes));
}

/**
 * The shape nearly every provider signs with: an HMAC of the raw body, sent
 * in a header. Wire up an unlisted provider by reading its docs for the four
 * things that differ — which header, which hash, base64 or hex, and whether
 * the value carries a prefix.
 *
 *   verify: hmacSignature({
 *     header: "x-hub-signature-256",   // GitHub
 *     secret: () => secrets.GITHUB_WEBHOOK_SECRET,
 *     encoding: "hex",
 *     prefix: "sha256=",
 *   })
 *
 * A trigger is built once, at import — so `secret: secrets.X` captures the
 * value that existed at boot and rotating it in the secret store would not
 * reach this verifier. Passing a getter defers the read to each request, which
 * is why it is the documented form.
 */
export function hmacSignature(opts: {
  /** Header carrying the digest. Matched case-insensitively. */
  header: string;
  /** A getter is re-read per request; a bare string is fixed at import. */
  secret: string | (() => string);
  /** Default SHA-256. */
  algorithm?: Algorithm;
  /** How the digest is encoded in the header. Default base64. */
  encoding?: Encoding;
  /** Stripped before comparing, e.g. "sha256=". */
  prefix?: string;
}): WebhookVerifier {
  const { header, secret, algorithm = "SHA-256", encoding = "base64", prefix } = opts;
  const resolve = typeof secret === "function" ? secret : () => secret;

  // Checked at import, so a deploy missing the key stops rather than starting
  // up with a check that anyone can satisfy: an HMAC keyed on nothing is
  // computable by the caller too.
  if (!resolve()) {
    throw new Error(`hmacSignature for "${header}" was given no secret`);
  }

  return async ({ body, headers }) => {
    const provided = headers.get(header);
    if (!provided) return false;

    // Re-read per request rather than closed over, so a rotated credential
    // reaches the route without a restart. An emptied one fails closed.
    const key = resolve();
    if (!key) return false;

    const digest =
      prefix && provided.startsWith(prefix) ? provided.slice(prefix.length) : provided;
    return timingSafeEqual(digest, await hmac(algorithm, key, body, encoding));
  };
}

/**
 * Tally's signing secret — a base64 HMAC-SHA256 of the raw body in
 * `tally-signature`. Tally never sends the secret itself, which is why the
 * shared-secret check can't be made to match it.
 */
export function tallySignature(secret: string | (() => string)): WebhookVerifier {
  return hmacSignature({ header: "tally-signature", secret });
}
