import type { HttpClient } from "./http.ts";

/* ------------------------------------------------------------------ Slack */

export interface SlackClient {
  /** Posts to a channel with a bot token (SLACK_BOT_TOKEN). */
  send(channel: string, text: string, extra?: Record<string, unknown>): Promise<{ ts: string }>;
  /** Replies in a thread. */
  reply(channel: string, threadTs: string, text: string): Promise<{ ts: string }>;
  /** Posts to an incoming webhook URL — no bot token needed. */
  webhook(url: string, payload: string | Record<string, unknown>): Promise<void>;
}

export function createSlack(http: HttpClient): SlackClient {
  const token = () => {
    const t = process.env.SLACK_BOT_TOKEN;
    if (!t) throw new Error("SLACK_BOT_TOKEN is not set");
    return t;
  };

  const post = async (body: Record<string, unknown>) => {
    // Slack answers 200 with {ok:false} on failure, so the status check isn't enough.
    const res = await http.post<{ ok: boolean; error?: string; ts?: string }>(
      "https://slack.com/api/chat.postMessage",
      body,
      { headers: { authorization: `Bearer ${token()}` } },
    );
    if (!res.ok) throw new Error(`Slack API error: ${res.error ?? "unknown"}`);
    return { ts: res.ts ?? "" };
  };

  return {
    send: (channel, text, extra = {}) => post({ channel, text, ...extra }),
    reply: (channel, thread_ts, text) => post({ channel, thread_ts, text }),
    async webhook(url, payload) {
      await http.post(url, typeof payload === "string" ? { text: payload } : payload, {
        as: "text",
      });
    },
  };
}

/* --------------------------------------------------------------- Telegram */

export interface TelegramClient {
  /**
   * `token` defaults to TELEGRAM_BOT_TOKEN and `chatId` to TELEGRAM_CHAT_ID —
   * both of which a *primary* Telegram credential supplies. Pass `token` to
   * send as a different bot, which is how one server pings from several brands:
   *
   *   const telegram = defineCredential("telegram", "the-mantra");
   *   ctx.telegram.send(text, { token: telegram.token, chatId: … });
   */
  send(
    text: string,
    opts?: {
      token?: string;
      chatId?: string;
      parseMode?: "Markdown" | "MarkdownV2" | "HTML";
      silent?: boolean;
    },
  ): Promise<void>;
  sendPhoto(
    photoUrl: string,
    opts?: { token?: string; chatId?: string; caption?: string },
  ): Promise<void>;
}

export function createTelegram(http: HttpClient): TelegramClient {
  // The token goes in the path, not a header, so this URL is a credential.
  // It reaches the run page through capture(), which redacts it — every bot
  // token is registered with the redactor, whether it arrived from the
  // environment or was decrypted out of a credential.
  const api = (method: string, override?: string) => {
    const token = override ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("No token given and TELEGRAM_BOT_TOKEN is not set");
    return `https://api.telegram.org/bot${token}/${method}`;
  };

  const chat = (override?: string) => {
    const id = override ?? process.env.TELEGRAM_CHAT_ID;
    if (!id) throw new Error("No chatId given and TELEGRAM_CHAT_ID is not set");
    return id;
  };

  return {
    async send(text, opts = {}) {
      await http.post(api("sendMessage", opts.token), {
        chat_id: chat(opts.chatId),
        text,
        parse_mode: opts.parseMode,
        disable_notification: opts.silent,
      });
    },
    async sendPhoto(photo, opts = {}) {
      await http.post(api("sendPhoto", opts.token), {
        chat_id: chat(opts.chatId),
        photo,
        caption: opts.caption,
      });
    },
  };
}

/* ---------------------------------------------------------------- Discord */

export interface DiscordClient {
  /** Posts to an incoming webhook; defaults to DISCORD_WEBHOOK_URL. */
  send(
    content: string,
    opts?: { webhookUrl?: string; username?: string; embeds?: unknown[] },
  ): Promise<void>;
}

export function createDiscord(http: HttpClient): DiscordClient {
  return {
    async send(content, opts = {}) {
      const url = opts.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
      if (!url) throw new Error("No webhookUrl given and DISCORD_WEBHOOK_URL is not set");
      await http.post(
        url,
        { content, username: opts.username, embeds: opts.embeds },
        { as: "none" },
      );
    },
  };
}
