/**
 * AES-256-GCM at rest.
 *
 * Two things in this project store a credential rather than observe one: the
 * rotated half of an OAuth token (`@oauth:` keys in state) and the secret
 * store. Both encrypt with this, so there is one wire format and one place to
 * get the nonce handling right.
 *
 * The packed form is base64(iv ‖ ciphertext), 12-byte iv. That is exactly what
 * OAuth wrote before this file existed — the format is load-bearing for
 * databases already in the field, so don't change it without a version byte.
 */

export interface Cipher {
  /** The env var the key was read from, for error messages. */
  readonly keyEnv: string;
  /** Whether a usable key is configured right now. */
  ready(): boolean;
  /** base64(iv ‖ AES-256-GCM ciphertext). */
  encrypt(plaintext: string): Promise<string>;
  /** Throws on a wrong key, a truncated value, or a tampered tag. */
  decrypt(packed: string): Promise<string>;
}

/**
 * A cipher keyed from the first of `envNames` that holds a usable key. The
 * list is a fallback chain, not a merge: it exists so a deployment that
 * already set one key name doesn't have to set a second.
 *
 * The key is re-read on every use and only re-imported when its bytes change,
 * so rotating it takes effect without a restart.
 */
export function createCipher(envNames: readonly string[]): Cipher {
  if (envNames.length === 0) throw new Error("createCipher needs at least one env var name");

  let cachedKey: Promise<CryptoKey> | undefined;
  let cachedFrom: string | undefined;

  const raw = (): string => {
    for (const name of envNames) {
      const value = process.env[name];
      if (value && decodeKey(value)) return value;
    }
    // Nothing usable — return whatever the primary holds so the error below
    // complains about the name the operator is most likely to have set.
    return process.env[envNames[0]!] ?? "";
  };

  const key = (): Promise<CryptoKey> => {
    const value = raw();
    if (cachedKey && cachedFrom === value) return cachedKey;

    const bytes = decodeKey(value);
    if (!bytes) throw new Error(keyProblem(envNames));

    cachedFrom = value;
    cachedKey = crypto.subtle.importKey("raw", detach(bytes), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    return cachedKey;
  };

  return {
    keyEnv: envNames[0]!,

    ready: () => decodeKey(raw()) !== undefined,

    async encrypt(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await key(),
        new TextEncoder().encode(plaintext),
      );
      return Buffer.concat([iv, new Uint8Array(ciphertext)]).toString("base64");
    },

    async decrypt(packed) {
      const bytes = Buffer.from(packed, "base64");
      if (bytes.length <= 12) throw new Error("ciphertext is too short to hold an iv");
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: detach(bytes.subarray(0, 12)) },
        await key(),
        detach(bytes.subarray(12)),
      );
      return new TextDecoder().decode(plaintext);
    },
  };
}

/** The message every caller should use, so the fix is always spelled out. */
export function keyProblem(envNames: readonly string[]): string {
  const names = envNames.join(" or ");
  return `${names} must be 32 bytes, base64 or hex — generate with: openssl rand -base64 32`;
}

/** Accepts the two encodings people actually paste. */
export function decodeKey(raw: string): Uint8Array | undefined {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return new Uint8Array(Buffer.from(value, "hex"));
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 ? new Uint8Array(decoded) : undefined;
}

/**
 * WebCrypto's types insist on a view over a plain ArrayBuffer, which a Buffer
 * (a view into a pooled one) is not. Copying is cheaper than fighting it.
 */
function detach(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}
