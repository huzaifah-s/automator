import type { Sql } from "postgres";
import { createHttp, type HttpClient } from "./http.ts";
import { store } from "../core/db.ts";
import { capture, captureEnabled } from "../core/capture.ts";
import { registerSecret } from "../core/redact.ts";
import {
  createSlack,
  createTelegram,
  createDiscord,
  type SlackClient,
  type TelegramClient,
  type DiscordClient,
} from "./messaging.ts";
import { createAi, type AiClient } from "./ai.ts";
import { createEmail, type EmailClient } from "./email.ts";
import { createSql } from "./sql.ts";
import { createSheets, type SheetsClient } from "./sheets.ts";
import { createDrive, type DriveClient } from "./drive.ts";
import { createS3, type S3Client } from "./s3.ts";
import { createScrape, type ScrapeClient } from "./scrape.ts";

/** Everything hanging off `ctx` besides the run metadata. */
export interface Integrations {
  http: HttpClient;
  slack: SlackClient;
  telegram: TelegramClient;
  discord: DiscordClient;
  ai: AiClient;
  email: EmailClient;
  sql: Sql;
  sheets: SheetsClient;
  drive: DriveClient;
  s3: S3Client;
  scrape: ScrapeClient;
}

/**
 * Every client but `http` is a lazy getter, so a workflow that only makes an
 * HTTP call never opens a Postgres pool or reads an unrelated env var. The
 * clients that hold connections cache globally; the rest are cheap.
 */
export function buildIntegrations(signal: AbortSignal, runId?: string): Integrations {
  // Every ctx.http call lands in the run's request/response log unless capture
  // is switched off. Recording must never break the call it is observing.
  const record =
    runId && captureEnabled
      ? (call: Parameters<NonNullable<Parameters<typeof createHttp>[1]>>[0]) => {
          try {
            store.recordCall({
              runId,
              method: call.method,
              url: call.url,
              status: call.status,
              durationMs: call.durationMs,
              request: capture(call.request).json,
              response: capture(call.response).json,
            });
          } catch {
            /* observability is never worth failing a run over */
          }
        }
      : undefined;

  const http = createHttp(signal, record);

  let slack: SlackClient | undefined;
  let telegram: TelegramClient | undefined;
  let discord: DiscordClient | undefined;
  let ai: AiClient | undefined;
  let email: EmailClient | undefined;
  let sheets: SheetsClient | undefined;
  let drive: DriveClient | undefined;
  let s3: S3Client | undefined;
  let scrape: ScrapeClient | undefined;

  return {
    http,
    get slack() {
      return (slack ??= createSlack(http));
    },
    get telegram() {
      return (telegram ??= createTelegram(http));
    },
    get discord() {
      return (discord ??= createDiscord(http));
    },
    get ai() {
      return (ai ??= createAi(signal));
    },
    get email() {
      return (email ??= createEmail());
    },
    get sql() {
      return createSql();
    },
    get sheets() {
      return (sheets ??= createSheets(http));
    },
    get drive() {
      return (drive ??= createDrive());
    },
    get s3() {
      return (s3 ??= createS3());
    },
    get scrape() {
      return (scrape ??= createScrape(http));
    },
  };
}

export { closeSql } from "./sql.ts";
export { HttpError } from "./http.ts";

/**
 * Environment variables the built-in integrations read for themselves. A
 * workflow never declares these through defineSecrets, so without this they
 * would be the only credentials the logger doesn't know to scrub.
 */
const INTEGRATION_SECRET_ENV = [
  "SLACK_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_WEBHOOK_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "SMTP_PASS",
  "POSTGRES_URL",
  "DATABASE_URL",
  "WEBHOOK_SECRET",
  "DASHBOARD_PASS",
  "ALERT_WEBHOOK_URL",
  // ctx.s3. The endpoint, bucket, region and public URL are configuration and
  // stay readable; only the two that authenticate are here.
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  // Declared through defineSecrets by every defineOAuth() call, so this only
  // covers the case where the key is set before any credential uses it.
  "OAUTH_ENCRYPTION_KEY",
] as const;

/**
 * Teaches the log redactor about every credential this process holds, so the
 * guarantee is the same whether a secret was declared by a workflow or read
 * straight from the environment by an integration. Called once at boot.
 */
export function registerIntegrationSecrets(): number {
  let count = 0;

  for (const key of INTEGRATION_SECRET_ENV) {
    const value = process.env[key];
    if (!value) continue;
    registerSecret(value);
    count++;

    // A connection URL is usually logged whole, but the password inside it can
    // also surface on its own in a driver error — register both forms.
    if (key === "POSTGRES_URL" || key === "DATABASE_URL") {
      try {
        const password = new URL(value).password;
        if (password) registerSecret(decodeURIComponent(password));
      } catch {
        /* not a parseable URL; the whole string is already registered */
      }
    }
  }

  // The service-account blob is too large to ever appear verbatim in a log —
  // the private key inside it is the part worth scrubbing.
  const google = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (google) {
    try {
      const { private_key } = JSON.parse(google) as { private_key?: string };
      if (private_key) {
        registerSecret(private_key);
        count++;
      }
    } catch {
      /* validated properly when sheets is first used */
    }
  }

  return count;
}
