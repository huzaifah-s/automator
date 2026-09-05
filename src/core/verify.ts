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

/**
 * Notion's webhook signature — a **hex** HMAC-SHA256 of the raw body in
 * `x-notion-signature`, prefixed `sha256=` and keyed on the subscription's
 * verification token.
 *
 * The token is awkward in a way no other provider's is: Notion mints it,
 * POSTs it exactly once to the endpoint being subscribed, and never shows it
 * again — the only recovery is the "Resend token" button in the verification
 * modal. So this verifier lets the *unsigned* handshake through. Rejecting it
 * would reject the one delivery that could ever tell you the key, and there
 * would be no key to verify anything with, ever.
 *
 * That is a narrow hole and it is bounded on purpose: `isNotionHandshake`
 * accepts a body that is *nothing but* a verification token, so the only thing
 * an unauthenticated caller can do here is hand us a string. Everything else
 * fails closed, including every real event that arrives before the token has
 * been stored — a workflow that has not been given its token is not one that
 * should be acting on events.
 *
 *   verify: notionSignature(() => secrets.NOTION_WEBHOOK_TOKEN)
 *
 * A getter, for the same reason as hmacSignature: the trigger is built once at
 * import, and the token is typically stored *after* the first deploy.
 */
export function notionSignature(
  secret: string | (() => string | undefined),
): WebhookVerifier {
  const resolve = typeof secret === "function" ? secret : () => secret;

  return async ({ body, headers }) => {
    if (isNotionHandshake(body)) return true;

    // Trimmed, and this is not defensive noise. The token reaches the operator
    // through a chat message and is pasted into a web form that stores what it
    // is given, so a trailing newline is the single most likely way to get this
    // wrong — and it fails as a signature mismatch, indistinguishable from a
    // forged request, on a route where nothing else says why. Whitespace around
    // an HMAC key is never intentional.
    const key = resolve()?.trim();
    // Thrown rather than returned false: app.ts logs the reason, and "no token
    // yet" is a different thing to be told than "that signature is wrong".
    if (!key) {
      throw new Error(
        "Notion webhook verification token is not set — cannot check a signature",
      );
    }

    const provided = headers.get("x-notion-signature");
    if (!provided) return false;
    const digest = provided.startsWith("sha256=") ? provided.slice(7) : provided;
    return timingSafeEqual(digest, await hmac("SHA-256", key, body, "hex"));
  };
}

/**
 * The one-time `{"verification_token": "…"}` POST Notion sends when a
 * subscription is created — the only request on the route that can legitimately
 * arrive unsigned.
 *
 * Deliberately strict: exactly one key, and it is the token. A body that
 * carries anything else is an event, and an event has to be signed like one.
 */
export function isNotionHandshake(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return false;
    const keys = Object.keys(parsed);
    return (
      keys.length === 1 &&
      keys[0] === "verification_token" &&
      typeof (parsed as { verification_token: unknown }).verification_token === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Telegram's webhook secret token — the string handed to `setWebhook` as
 * `secret_token`, which Telegram then echoes back verbatim in
 * `x-telegram-bot-api-secret-token` on every delivery.
 *
 * Not an HMAC, and deliberately not dressed up as one: Telegram signs nothing.
 * It is a bearer token in a header, so this is a constant-time equality check
 * and nothing more. That is enough here because the value never travels
 * anywhere except from this process to Telegram over TLS and back — unlike
 * `WEBHOOK_SECRET`, which the shared-secret path also accepts from a query
 * string, where it lands in access logs.
 *
 * It cannot be `secret:` on the trigger for exactly that reason: the header
 * Telegram sends is not one of the three that path reads, and a bot cannot be
 * told to send a different one.
 *
 *   verify: telegramSecretToken(() => secrets.TELEGRAM_WEBHOOK_SECRET)
 *
 * A getter, for the same reason as hmacSignature: the trigger is built once at
 * import, so a bare string would freeze the value that existed at boot.
 */
export function telegramSecretToken(
  secret: string | (() => string | undefined),
): WebhookVerifier {
  const resolve = typeof secret === "function" ? secret : () => secret;

  return async ({ headers }) => {
    // Trimmed for the same reason Notion's is: this value is generated with
    // `openssl rand` and pasted into a form, and a trailing newline fails as an
    // authentication mismatch with nothing on the route to say why.
    const key = resolve()?.trim();
    // Thrown rather than false: "the secret is not set" and "that token is
    // wrong" are the same 401 to Telegram and completely different problems to
    // whoever is reading the rejected-deliveries box.
    if (!key) {
      throw new Error("Telegram webhook secret token is not set — cannot check a delivery");
    }
    const provided = headers.get("x-telegram-bot-api-secret-token");
    if (!provided) return false;
    return timingSafeEqual(provided, key);
  };
}
