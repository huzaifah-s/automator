import { createHash } from "node:crypto";
import type { Ctx, Row } from "../../src/core/define.ts";

/**
 * The assistant's Telegram bot, as the two workflows that use it see it:
 * `deliver-cards` posts a card for every new draft and question, and `bot`
 * handles the taps and replies that come back.
 *
 * Each of those files declares the `telegram` / `maria` credential
 * itself and hands it in here. Declaring it in this file would attribute it to
 * whichever workflow happened to import it first, and the other would not be
 * marked blocked without it.
 */

export interface BotCredential {
  token: string;
  chat_id?: string;
}

/** Times on cards are the reader's, not the server's. */
const TZ = "Asia/Kuala_Lumpur";

/**
 * The `secret_token` Telegram echoes on every delivery, derived from the bot
 * token rather than stored as a secret of its own. A new `defineSecrets` key
 * stops the boot until it is set, and a deploy that is down until somebody
 * reads the changelog is a worse failure than the one the secret prevents.
 * Whoever has the bot token can already impersonate the bot; this adds no
 * second thing to leak. Hex, which is inside Telegram's allowed alphabet.
 */
export function webhookSecret(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return createHash("sha256").update(`personal-assistant-bot\0${token}`).digest("hex");
}

/** The one chat the bot talks to — yours. Required, and said so plainly. */
export function owner(bot: Partial<BotCredential>): string {
  if (!bot.chat_id) {
    throw new Error(
      "The telegram / maria credential has no Default chat id — set it to your own " +
        "Telegram user id on the Credentials tab",
    );
  }
  return bot.chat_id;
}

/** Telegram HTML needs three characters escaped, and a message full of "&" needs it badly. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const clock = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));

type Button = { text: string; callback_data: string };

/** Only `http` is needed, so a webhook's `register` can use it as well as a run. */
export function botApi(ctx: Pick<Ctx, "http"> & Partial<Pick<Ctx, "log">>, bot: Partial<BotCredential>) {
  const call = async <T>(method: string, body: Record<string, unknown>, retries = 2): Promise<T> => {
    if (!bot.token) throw new Error("The telegram / maria credential is not connected");
    try {
      const res = await ctx.http.post<{ ok: boolean; result: T; description?: string }>(
        `https://api.telegram.org/bot${bot.token}/${method}`,
        body,
        { retries },
      );
      return res.result;
    } catch (err) {
      // A bot cannot write first. Until you have pressed Start in it, every
      // send is "chat not found", which names neither the bot nor the fix.
      if (/chat not found|bot can't initiate/i.test(String((err as Error)?.message))) {
        throw new Error(
          "Telegram cannot reach your chat — open the bot in Telegram and press Start " +
            "(and check the maria credential's Default chat id is your user id)",
        );
      }
      throw err;
    }
  };

  return {
    /**
     * Posts a message to you and returns its id. Not retried: a send that
     * timed out may have arrived, and a second card for one draft is a second
     * Send button for one message.
     */
    async send(html: string, buttons?: Button[][]): Promise<number> {
      const m = await call<{ message_id: number }>(
        "sendMessage",
        {
          chat_id: owner(bot),
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
        },
        0,
      );
      return m.message_id;
    },

    /** Rewrites a card in place — its outcome, and no buttons unless given. */
    async edit(messageId: number | string, html: string, buttons?: Button[][]): Promise<void> {
      try {
        await call("editMessageText", {
          chat_id: owner(bot),
          message_id: Number(messageId),
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: buttons ?? [] },
        });
      } catch (err) {
        // Pressing a button twice asks for the same text twice, and Telegram
        // calls that an error. The card already says the right thing.
        if (!/message is not modified/i.test(String((err as Error)?.message))) throw err;
      }
    },

    /**
     * Stops the button's spinner; `text` is the toast shown on your phone.
     * Best effort: Telegram refuses an answer more than a few seconds after
     * the tap ("query is too old"), which a slow WhatsApp send can cause —
     * and by then the draft was sent and the card says so. Letting that fail
     * the run would report a send that worked as a failure.
     */
    async answer(callbackId: string, text?: string): Promise<void> {
      try {
        await call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
      } catch (err) {
        ctx.log?.warn(`Could not answer the button tap: ${String((err as Error)?.message).slice(0, 120)}`);
      }
    },

    /** A plain reply in the chat, quoting the message it answers. */
    async reply(toMessageId: number, html: string): Promise<void> {
      await call(
        "sendMessage",
        {
          chat_id: owner(bot),
          text: html,
          parse_mode: "HTML",
          reply_parameters: { message_id: toMessageId, allow_sending_without_reply: true },
        },
        0,
      );
    },

    async setWebhook(url: string): Promise<void> {
      await call("setWebhook", {
        url,
        secret_token: webhookSecret(bot.token),
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      });
    },

    async deleteWebhook(): Promise<void> {
      await call("deleteWebhook", {});
    },
  };
}

/* ------------------------------------------------------------------ cards */

const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", telegram: "Telegram" };

/**
 * A draft as shown on a card. Telegram refuses a message over 4096
 * characters, and a draft may be 4000 before the card's own lines; what is
 * sent on approval is the row's full text, never this.
 */
const shown = (text: unknown) => {
  const t = String(text ?? "");
  return t.length > 3300 ? `${t.slice(0, 3300)}… (${t.length - 3300} more characters — full text in the drafts table)` : t;
};
const channelOf = (chatKey: string) => CHANNEL[chatKey.split(":")[0]!] ?? "chat";

/** The buttons under an open draft. `d:<id>:<action>` stays well inside Telegram's 64 bytes. */
export const draftButtons = (id: string): Button[][] => [
  [
    { text: "✅ Send", callback_data: `d:${id}:send` },
    { text: "Skip", callback_data: `d:${id}:skip` },
  ],
];

/**
 * A draft's card. `previousFeedback` is what you said about the version this
 * one replaces, so a revision arrives with the reason for it.
 */
export function draftCard(d: Row, previousFeedback?: string | null): string {
  return [
    `✉️ <b>Reply to ${esc(String(d.chat_name))}</b> · ${channelOf(String(d.chat_key))}`,
    d.why ? `<i>${esc(String(d.why))}</i>` : null,
    previousFeedback ? `Revised after: “${esc(previousFeedback)}”` : null,
    "",
    `<blockquote>${esc(shown(d.text))}</blockquote>`,
    "",
    "Reply to this message to ask for changes.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function draftOutcome(d: Row, outcome: "sent" | "skipped" | "revise" | "replaced" | "failed"): string {
  const to = esc(String(d.chat_name));
  const head = {
    sent: `✅ <b>Sent to ${to}</b> · ${clock(Date.now())}`,
    skipped: `⏭ <b>Skipped</b> — reply to ${to}\n<i>Reply to this message to say why, and I'll learn from it.</i>`,
    revise: `✏️ <b>Revising</b> — reply to ${to}\nYou said: “${esc(String(d.feedback ?? ""))}”`,
    replaced: `↪️ <b>Replaced</b> by a newer draft to ${to}`,
    failed: `⚠️ <b>Could not send to ${to}</b>: ${esc(String(d.error ?? "unknown error"))}`,
  }[outcome];
  return `${head}\n\n<blockquote>${esc(shown(d.text))}</blockquote>`;
}

/** Options in rows of two, `q:<id>:<index>` — the index, because an option can be long. */
export function questionButtons(q: Row): Button[][] | undefined {
  const options = Array.isArray(q.options) ? (q.options as string[]) : [];
  if (options.length === 0) return undefined;
  const rows: Button[][] = [];
  options.forEach((text, i) => {
    if (i % 2 === 0) rows.push([]);
    rows.at(-1)!.push({ text, callback_data: `q:${q.id}:${i}` });
  });
  return rows;
}

export function questionCard(q: Row, about?: string | null): string {
  const options = Array.isArray(q.options) ? q.options : [];
  return [
    `❓ ${esc(String(q.question))}`,
    about ? `<i>About ${esc(about)}</i>` : null,
    options.length ? null : "\nReply to this message with your answer.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function questionOutcome(q: Row, about?: string | null): string {
  return [
    `❓ ${esc(String(q.question))}`,
    about ? `<i>About ${esc(about)}</i>` : null,
    "",
    `<b>Answer:</b> ${esc(String(q.answer ?? ""))}`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}
