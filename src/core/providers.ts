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
  /*
   * Object storage, for the one job it does here: give Meta a public URL it
   * can fetch media from, then take it down again.
   *
   * Four of the six fields are `secret: false` on purpose. An endpoint, a
   * bucket name, a region and a *deliberately public* URL are all things you
   * want to read on a run page — and redacting the public URL would blank the
   * media link out of every captured Instagram call, which is exactly the
   * thing you go to the run page to look at.
   */
  r2: {
    label: "S3 / Cloudflare R2",
    blurb: "S3-compatible object storage. Used to host media at a public URL while it uploads.",
    docs: "https://developers.cloudflare.com/r2/api/s3/tokens/",
    fields: {
      endpoint: {
        label: "S3 endpoint",
        schema: z.string().url(),
        secret: false,
        placeholder: "https://<account-id>.r2.cloudflarestorage.com",
      },
      access_key_id: {
        label: "Access key ID",
        schema: z.string().min(10),
      },
      secret_access_key: {
        label: "Secret access key",
        schema: z.string().min(20),
      },
      bucket: {
        label: "Bucket",
        schema: z.string().min(1),
        secret: false,
        placeholder: "media",
      },
      public_url: {
        label: "Public bucket URL",
        schema: z.string().url(),
        secret: false,
        placeholder: "https://pub-<hash>.r2.dev",
        help: "The bucket must be publicly readable — this is the URL handed to Meta.",
      },
      region: {
        label: "Region",
        schema: z.string().min(1),
        secret: false,
        optional: true,
        placeholder: "auto",
        help: "R2 ignores it but still signs with it. Defaults to \"auto\".",
      },
    },
    envMap: {
      endpoint: "S3_ENDPOINT",
      access_key_id: "S3_ACCESS_KEY_ID",
      secret_access_key: "S3_SECRET_ACCESS_KEY",
      bucket: "S3_BUCKET",
      public_url: "S3_PUBLIC_URL",
      region: "S3_REGION",
    },
    async test(v, signal) {
      // A signed GET of the bucket listing one key. Read-only, free, and it
      // proves the endpoint, the keys, the region and the bucket name all at
      // once — which four separate field validations cannot.
      const { listBucket } = await import("../integrations/s3.ts");
      const bucket = need(v, "bucket");
      await listBucket(
        {
          endpoint: need(v, "endpoint"),
          accessKeyId: need(v, "access_key_id"),
          secretAccessKey: need(v, "secret_access_key"),
          bucket,
          region: v.region || "auto",
          publicUrl: need(v, "public_url"),
        },
        signal,
      );
      return `Bucket "${bucket}" is reachable`;
    },
  },

  /*
   * Meta's Graph API — Instagram publishing and Facebook Pages. One token
   * covers both when the IG account is a Business account linked to the Page,
   * which is how The Mantra's is set up.
   *
   * The two ids are configuration, not credentials: they appear in every Graph
   * URL this makes, so redacting them would blank out the run page for no
   * gain, and neither one authenticates anything on its own.
   *
   * Threads is NOT this. It is a separate API with a separate token that
   * expires in 60 days, so it lives in `defineOAuth` where something can
   * refresh it — see workflows/the-mantra/threads-token-auto-refresh.ts.
   */
  meta: {
    label: "Meta Graph (Instagram & Facebook)",
    blurb: "A long-lived Page access token, for publishing to a Facebook Page and its Instagram.",
    docs: "https://developers.facebook.com/tools/explorer/",
    fields: {
      access_token: {
        label: "Page access token",
        schema: z.string().min(50),
        placeholder: "EAA…",
        help: "Long-lived. Derive it from a long-lived user token so it does not expire.",
      },
      page_id: {
        label: "Facebook Page ID",
        schema: z.string().regex(/^\d+$/, "A Page ID is digits only"),
        secret: false,
      },
      ig_user_id: {
        label: "Instagram user ID",
        schema: z.string().regex(/^\d+$/, "An Instagram user ID is digits only"),
        secret: false,
        optional: true,
        help: "The IG Business account linked to the Page. Leave blank if not posting to Instagram.",
      },
    },
    async test(v, signal) {
      const token = need(v, "access_token");
      const page = need(v, "page_id");

      // Reads the Page this token is for. Also surfaces the token's own
      // expiry, which is the thing most worth knowing about a Meta credential.
      const me = await probe(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(page)}` +
          `?fields=name&access_token=${encodeURIComponent(token)}`,
        {},
        signal,
        "Meta",
      );

      const debug = await probe(
        `https://graph.facebook.com/v21.0/debug_token` +
          `?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
        {},
        signal,
        "Meta",
      ).catch(() => undefined);

      const expires = debug?.data?.expires_at;
      // Meta uses 0 for "never", which is what a correctly derived Page token
      // reports and is worth saying out loud.
      const when =
        expires === 0
          ? ", token does not expire"
          : typeof expires === "number"
            ? `, token expires ${new Date(expires * 1000).toISOString().slice(0, 10)}`
            : "";

      return `Page "${me?.name ?? page}" is reachable${when}`;
    },
  },

  monday: {
    label: "Monday.com",
    blurb: "A personal or service API token, for reading boards and writing back to items.",
    docs: "https://developer.monday.com/api-reference/docs/authentication",
    fields: {
      api_token: {
        label: "API token",
        schema: z.string().min(40),
        placeholder: "eyJhbGciOi…",
        help: "Monday › avatar › Developers › My access tokens. It is a JWT, and it does not expire.",
      },
    },
    envMap: { api_token: "MONDAY_API_TOKEN" },
    async test(v, signal) {
      const token = need(v, "api_token");

      // The cheapest authenticated query there is, and the only one that works
      // regardless of which boards the token can see.
      const body = await probe(
        "https://api.monday.com/v2",
        {
          method: "POST",
          headers: { authorization: token, "content-type": "application/json" },
          body: JSON.stringify({ query: "{ me { name email } account { name } }" }),
        },
        signal,
        "Monday.com",
      );

      // Monday answers 200 with an `errors` array for a revoked token, so the
      // status probe() checked proves nothing on its own.
      if (body?.errors?.length) {
        throw new Error(
          `Monday.com rejected the token — ${body.errors.map((e: any) => e?.message ?? "unknown").join("; ")}`,
        );
      }

      const me = body?.data?.me;
      if (!me?.name) throw new Error("Monday.com answered without identifying the token's user");
      const account = body?.data?.account?.name;
      return `Authenticated as ${me.name}${account ? ` (${account})` : ""}`;
    },
  },

  /*
   * WhatsApp Business Cloud — a different API and a different token to `meta`
   * above, despite both being Graph. A Page token cannot send a WhatsApp
   * message and a WhatsApp token cannot post to a Page, so they are two
   * credentials rather than two fields of one.
   */
  whatsapp: {
    label: "WhatsApp Business Cloud",
    blurb: "A system-user token and a sending number, for message templates and replies.",
    docs: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
    fields: {
      access_token: {
        label: "Access token",
        schema: z.string().min(50),
        placeholder: "EAA…",
        help:
          "Generate it for a System User in Business Settings and give it a permanent expiry. " +
          "The 24-hour token from the API Setup page will stop working tomorrow.",
      },
      phone_number_id: {
        label: "Phone number ID",
        schema: z.string().regex(/^\d+$/, "A phone number ID is digits only"),
        secret: false,
        placeholder: "361426827060787",
        help: "WhatsApp Manager › API Setup. Not the phone number itself.",
      },
    },
    envMap: {
      access_token: "WHATSAPP_ACCESS_TOKEN",
      phone_number_id: "WHATSAPP_PHONE_NUMBER_ID",
    },
    async test(v, signal) {
      const token = need(v, "access_token");
      const id = need(v, "phone_number_id");

      // Reads the sending number itself: proves the token is live *and* that it
      // is scoped to this number, which a /me call would not.
      const me = await probe(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(id)}` +
          "?fields=display_phone_number,verified_name,quality_rating",
        { headers: { authorization: `Bearer ${token}` } },
        signal,
        "WhatsApp",
      );

      const number = me?.display_phone_number ?? id;
      const name = me?.verified_name ? `"${me.verified_name}" ` : "";
      const quality = me?.quality_rating ? `, quality ${String(me.quality_rating).toLowerCase()}` : "";
      return `Sending as ${name}${number}${quality}`;
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
