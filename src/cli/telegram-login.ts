import { createInterface } from "node:readline";
import { loadSecretStore, secretStoreReady, secretValue } from "../core/secret-store.ts";
import {
  fieldKey,
  getCredential,
  initCredentials,
  saveCredential,
  testCredential,
} from "../core/credentials.ts";
import { registerSecret } from "../core/redact.ts";
import { closeTelegramUsers } from "../integrations/telegram-user.ts";

/**
 * `bun run telegram-login -- <name>` — logs a Telegram user account in and
 * saves the session as the `telegram_user` credential `<name>`.
 *
 * This is the only way a session should come to exist here, for two reasons.
 * The session is the account — anyone holding it is logged in as you — so it
 * goes from Telegram straight into the encrypted store and is never printed:
 * no terminal scrollback, no chat transcript, no `.env`. And it makes "one
 * login per machine" the easy path. Telegram revokes a session used from two
 * places at once, and the way that happens is somebody copying a working one
 * from the server to a laptop; with nothing printed, there is nothing to copy.
 *
 * Interactive by necessity: Telegram texts a code to the account's other
 * devices, and asks for the 2FA password if one is set. Like the secret CLI it
 * runs before the loader, because the workflow that needs this credential is
 * exactly the one that would otherwise be blocked.
 */

const USAGE = `Usage: bun run telegram-login -- <name> [--primary] [--folder <folder>]

  Logs in to Telegram as a user and saves the session as the credential
  telegram_user:<name>. Asks for the API ID and hash (my.telegram.org › API
  development tools), the phone number, the code Telegram sends, and the 2FA
  password if the account has one.

  --primary   Use it for ctx.telegramUser without naming it in a workflow
  --folder    File it under a folder on the Credentials tab

Run it where the credential should live. For the deployment, open a shell in
the running container — Coolify's Terminal tab — and run it there, or from the
host:
  docker exec -it <automator container> bun run telegram-login -- <name> --primary
A login on a laptop is a separate device on the account, with its own session,
which is what keeps the two from revoking each other.`;

const PROVIDER = "telegram_user";
const ATTEMPTS = 3;

export async function runTelegramLoginCli(args: string[]): Promise<number> {
  const name = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--folder");
  const primary = args.includes("--primary");
  const folderAt = args.indexOf("--folder");
  const folder = folderAt >= 0 ? args[folderAt + 1] : undefined;

  if (!name || args.includes("--help") || (folderAt >= 0 && !folder)) {
    console.error(USAGE);
    return name ? 0 : 1;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error(`Name "${name}" must be lowercase letters, digits, and dashes`);
    return 1;
  }
  if (!process.stdin.isTTY) {
    console.error("telegram-login needs a terminal — Telegram sends a code that has to be typed in.");
    console.error(`In Docker, pass -it: docker exec -it <container> bun run telegram-login -- ${name}`);
    return 1;
  }

  await loadSecretStore();
  initCredentials();
  if (!secretStoreReady()) {
    console.error(
      "The secret store is not set up, so there is nowhere safe to put the session.\n" +
        "Set SECRETS_ENCRYPTION_KEY (openssl rand -base64 32) and run this again.",
    );
    return 1;
  }

  // A re-login keeps the app's id and hash; only the session is new.
  const existing = getCredential(PROVIDER, name);
  const stored = (field: string) =>
    existing ? secretValue(fieldKey(PROVIDER, name, field)) : undefined;

  let client: import("@mtcute/bun").TelegramClient | undefined;
  try {
    const apiId = stored("api_id") ?? (await ask("API ID: "));
    if (!/^\d+$/.test(apiId)) throw new Error("An API ID is digits only");
    const apiHash = stored("api_hash") ?? (await askHidden("API hash (hidden): "));
    if (!/^[0-9a-f]{32}$/i.test(apiHash)) throw new Error("An API hash is 32 hex characters");
    registerSecret(apiHash);
    if (existing) console.log(`Re-using the API ID and hash already stored for ${PROVIDER}:${name}.`);

    const phone = (await ask("Phone number, with country code (+60…): ")).replace(/[^\d+]/g, "");
    if (!/^\+?\d{6,}$/.test(phone)) throw new Error("That does not look like a phone number");

    const { TelegramClient, MemoryStorage } = await import("@mtcute/bun");
    client = new TelegramClient({
      apiId: Number(apiId),
      apiHash,
      // In memory, like the pool: the store is where the session goes, and the
      // default would leave a plaintext `client.session` file in this directory.
      storage: new MemoryStorage(),
      updates: false,
      logLevel: 1,
    });

    const sent = await client.sendCode({ phone });
    if (!("phoneCodeHash" in sent)) throw new Error("Telegram answered the code request unexpectedly");
    console.log(
      sent.type === "app"
        ? "Telegram sent a login code to the account's Telegram app."
        : `Telegram sent a login code (${sent.type}).`,
    );

    let user: Awaited<ReturnType<typeof client.signIn>> | undefined;
    let needsPassword = false;
    for (let attempt = 1; attempt <= ATTEMPTS && !user && !needsPassword; attempt++) {
      const code = (await ask("Code: ")).replace(/\s/g, "");
      try {
        user = await client.signIn({ phone, phoneCodeHash: sent.phoneCodeHash, phoneCode: code });
      } catch (err) {
        const message = String((err as Error)?.message);
        if (/SESSION_PASSWORD_NEEDED/.test(message)) needsPassword = true;
        else if (/PHONE_CODE_INVALID/.test(message) && attempt < ATTEMPTS) console.log("That code is wrong — try again.");
        else throw err;
      }
    }

    for (let attempt = 1; attempt <= ATTEMPTS && !user && needsPassword; attempt++) {
      const password = await askHidden("Two-step verification password (hidden): ");
      registerSecret(password);
      try {
        user = await client.checkPassword(password);
      } catch (err) {
        if (/PASSWORD_HASH_INVALID/.test(String((err as Error)?.message)) && attempt < ATTEMPTS) {
          console.log("That password is wrong — try again.");
        } else throw err;
      }
    }
    if (!user) throw new Error("Not logged in");

    const session = await client.exportSession();
    registerSecret(session);
    // Disconnected before the test below opens its own connection on the same
    // session: two at once is what Telegram revokes sessions for.
    await client.destroy();
    client = undefined;

    await saveCredential({
      provider: PROVIDER,
      id: name,
      folder,
      primary,
      values: { api_id: apiId, api_hash: apiHash, session },
    });

    const test = await testCredential(PROVIDER, name);
    console.log(
      `\nLogged in as ${user.displayName}${user.username ? ` (@${user.username})` : ""} ` +
        `and saved as credential ${PROVIDER}:${name}${primary ? ", primary" : ""}.`,
    );
    console.log(test.ok ? `Connection test: ${test.detail}` : `Connection test FAILED: ${test.detail}`);
    if (existing) {
      console.log(
        "The session this replaced is still a logged-in device on the account — end it under " +
          "Telegram › Settings › Devices if nothing else uses it.",
      );
    }
    console.log("A running server picks this up within SECRET_REFRESH_MS; no restart needed.");
    return test.ok ? 0 : 1;
  } catch (err) {
    console.error(`\nLogin failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await client?.destroy().catch(() => {});
    await closeTelegramUsers().catch(() => {});
  }
}

/** One visible line from the terminal. */
function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** One line with nothing echoed — the API hash and the 2FA password. */
function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
