import { z, type ZodTypeAny } from "zod";

/**
 * What the runner knows about each platform you can connect to: which fields
 * it wants, and one cheap call that proves the values work.
 *
 * This lives in code rather than in the database on purpose. "Which URL do I
 * hit to test this" is a request the server executes, and a request the server
 * executes that came out of a browser form is configuration-as-code stored as
 * data — the n8n shape this project exists to avoid. Adding a platform is a
 * few lines here and a deploy; it is not a thing the dashboard can invent.
 *
 * A test must be read-only, free, and fast. It exists to answer "are these
 * credentials live", not to exercise the integration.
 */

export interface ProviderField {
  label: string;
  /** Validated on write, so a bad paste fails at the form and not at 3am. */
  schema: ZodTypeAny;
  /**
   * Whether this value is a credential. Secret fields are masked in the
   * dashboard and registered with the log redactor; the rest — a hostname, a
   * port, a from-address — are configuration, and scrubbing "smtp.gmail.com"
   * out of every log line would be actively unhelpful.
   */
  secret?: boolean;
  /** Absent is allowed; the field's own default applies downstream. */
  optional?: boolean;
  placeholder?: string;
  help?: string;
}

export interface Provider<
  F extends Record<string, ProviderField> = Record<string, ProviderField>,
> {
  label: string;
  /** One line, shown under the platform name when you pick it. */
  blurb: string;
  /** Where to go and get the credential. Rendered as a link on the form. */
  docs?: string;
  fields: F;
  /**
   * The bare environment variables the matching built-in integration reads for
   * itself — `ctx.email` reads SMTP_HOST, not SMTP_PRIMARY_HOST. A credential
   * marked primary is mirrored into these, which is what makes connecting a
   * platform on the dashboard actually reach `ctx.email` rather than only
   * `defineCredential`. Absent means the provider has no built-in client.
   */
  envMap?: Record<string, string>;
  /**
   * Proves the values work. Returns a short human line for the dashboard —
   * "Authenticated as @mybot" — and throws with a readable message otherwise.
   *
   * The message is redacted before it is stored or shown, which matters more
   * here than anywhere else: Telegram puts the bot token in the URL, so a
   * bare fetch failure would otherwise print the credential back at you.
   */
  test(values: Record<string, string>, signal: AbortSignal): Promise<string>;
}

/* ------------------------------------------------------------------ http */

/**
 * A required field, as a plain string. `test` only ever runs on a credential
 * whose required fields are all present — credentials.ts checks that first —
 * so this is a type narrowing with a safety net, not a real branch.
 */
function need(values: Record<string, string>, field: string): string {
  const value = values[field];
  if (value === undefined) throw new Error(`${field} is not set`);
  return value;
}

/** One JSON GET with a deadline, and an error that names the status. */
async function probe(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  label: string,
): Promise<any> {
  const res = await fetch(url, { ...init, signal });
  const body = await res.text();

  if (!res.ok) {
    // The body is where a provider says *why* — "invalid_auth", "token
    // revoked". Truncated because an HTML error page is not worth storing.
    const detail = body.trim().slice(0, 300);
    throw new Error(`${label} answered ${res.status}${detail ? ` — ${detail}` : ""}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} answered ${res.status} with something that is not JSON`);
  }
}

/* ------------------------------------------------------------- providers */

export const PROVIDERS = {
  /*
   * The multi-field case, and the reason the whole thing is shaped around a
   * bundle rather than a key: an SMTP credential is five values that are only
   * meaningful together, and every one of them can be individually right while
   * the connection is still refused.
   */
  smtp: {
    label: "SMTP (email)",
    blurb: "Any mail provider that speaks SMTP — Gmail app passwords, Resend, Postmark, SES.",
    fields: {
      host: {
        label: "Host",
        schema: z.string().min(3),
        secret: false,
        placeholder: "smtp.gmail.com",
      },
      port: {
        label: "Port",
        schema: z.string().regex(/^\d{1,5}$/, "must be a port number"),
        secret: false,
        optional: true,
        placeholder: "587",
        help: "465 is implicit TLS, 587 upgrades with STARTTLS. Defaults to 587.",
      },
      user: {
        label: "Username",
        schema: z.string().min(1),
        secret: false,
        placeholder: "you@example.com",
      },
      pass: {
        label: "Password",
        schema: z.string().min(1),
        placeholder: "app password",
      },
      from: {
        label: "From address",
        schema: z.string().min(3),
        secret: false,
        optional: true,
        help: "Used when a workflow does not pass one. Defaults to the username.",
      },
    },
    envMap: {
      host: "SMTP_HOST",
      port: "SMTP_PORT",
      user: "SMTP_USER",
      pass: "SMTP_PASS",
      from: "SMTP_FROM",
    },
    async test(v, signal) {
      // Imported here rather than at the top: nodemailer is the heaviest
      // dependency in the project and a dashboard that never tests SMTP
      // should never pay for it.
      const { createTransport } = await import("nodemailer");
      const port = Number(v.port || 587);

      const transport = createTransport({
        host: need(v, "host"),
        port,
        secure: port === 465,
        auth: v.user ? { user: v.user, pass: need(v, "pass") } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
      });

      // verify() opens the connection and authenticates, then hangs up without
      // sending anything — the whole failure surface of an SMTP config except
      // "the recipient bounced".
      const abort = () => transport.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await transport.verify();
      } finally {
        signal.removeEventListener("abort", abort);
        transport.close();
      }
      return `Connected to ${need(v, "host")}:${port} and authenticated as ${v.user}`;
    },
  },

  notion: {
    label: "Notion",
    blurb: "An internal integration token, for reading and writing databases.",
    docs: "https://www.notion.so/my-integrations",
    fields: {
      token: {
        label: "Internal integration token",
        schema: z.string().min(20),
        placeholder: "ntn_…",
      },
    },
    async test(v, signal) {
      const me = await probe(
        "https://api.notion.com/v1/users/me",
        {
          headers: {
            authorization: `Bearer ${need(v, "token")}`,
            "notion-version": "2022-06-28",
          },
        },
        signal,
        "Notion",
      );
      const name = me?.bot?.owner?.workspace_name ?? me?.name ?? "the integration";
      return `Authenticated as ${name}`;
    },
  },

  telegram: {
    label: "Telegram",
    blurb: "A bot token from @BotFather, for sending messages to a chat.",
    docs: "https://core.telegram.org/bots#botfather",
    fields: {
      token: {
        label: "Bot token",
        schema: z.string().min(20),
        placeholder: "123456:ABC-DEF…",
      },
      chat_id: {
        label: "Default chat id",
        schema: z.string().min(1),
        secret: false,
        optional: true,
        help: "Where messages go when a workflow does not name a chat.",
      },
    },
    envMap: { token: "TELEGRAM_BOT_TOKEN", chat_id: "TELEGRAM_CHAT_ID" },
    async test(v, signal) {
      const me = await probe(
        `https://api.telegram.org/bot${need(v, "token")}/getMe`,
        {},
        signal,
        "Telegram",
      );
      return `Authenticated as @${me?.result?.username ?? "the bot"}`;
    },
  },

  slack: {
    label: "Slack",
    blurb: "A bot user token (xoxb-) with chat:write, for posting to channels.",
    docs: "https://api.slack.com/apps",
    fields: {
      token: {
        label: "Bot user token",
        schema: z.string().startsWith("xoxb-"),
        placeholder: "xoxb-…",
      },
    },
    envMap: { token: "SLACK_BOT_TOKEN" },
    async test(v, signal) {
      const me = await probe(
        "https://slack.com/api/auth.test",
        { method: "POST", headers: { authorization: `Bearer ${need(v, "token")}` } },
        signal,
        "Slack",
      );
      // Slack answers 200 with ok:false for a dead token, so the status alone
      // proves nothing.
      if (!me?.ok) throw new Error(`Slack refused the token — ${me?.error ?? "unknown reason"}`);
      return `Authenticated as ${me.user} in ${me.team}`;
    },
  },

  discord: {
    label: "Discord",
    blurb: "An incoming webhook URL for one channel.",
    fields: {
      webhook_url: {
        label: "Webhook URL",
        schema: z.string().url().includes("discord"),
        placeholder: "https://discord.com/api/webhooks/…",
      },
    },
    envMap: { webhook_url: "DISCORD_WEBHOOK_URL" },
    async test(v, signal) {
      // GETting a webhook URL returns its own metadata and posts nothing.
      const hook = await probe(need(v, "webhook_url"), {}, signal, "Discord");
      return `Webhook "${hook?.name ?? "unnamed"}" is live`;
    },
  },

  brevo: {
    label: "Brevo",
    blurb: "A transactional email API key (xkeysib-).",
    docs: "https://app.brevo.com/settings/keys/api",
    fields: {
      api_key: {
        label: "API key",
        schema: z.string().startsWith("xkeysib-"),
        placeholder: "xkeysib-…",
      },
    },
    envMap: { api_key: "BREVO_API_KEY" },
    async test(v, signal) {
      const account = await probe(
        "https://api.brevo.com/v3/account",
        { headers: { "api-key": need(v, "api_key"), accept: "application/json" } },
        signal,
        "Brevo",
      );
      return `Authenticated as ${account?.email ?? account?.companyName ?? "the account"}`;
    },
  },
} satisfies Record<string, Provider>;

export type ProviderId = keyof typeof PROVIDERS;

export function isProviderId(id: string): id is ProviderId {
  return Object.hasOwn(PROVIDERS, id);
}

export function providerIds(): ProviderId[] {
  return Object.keys(PROVIDERS) as ProviderId[];
}

/**
 * A mapped env var that names a field this provider does not have would mirror
 * nothing, silently, and the symptom would be "the integration ignores my
 * credential". Cheaper to catch at import.
 */
for (const [id, provider] of Object.entries(PROVIDERS as Record<string, Provider>)) {
  for (const field of Object.keys(provider.envMap ?? {})) {
    if (!Object.hasOwn(provider.fields, field)) {
      throw new Error(`Provider "${id}" maps an env var for unknown field "${field}"`);
    }
  }
}
