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

/** A button that comes back to the bot, or one that opens a page. */
type Button = { text: string; callback_data: string } | { text: string; url: string };

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
    async send(html: string, buttons?: Button[][], replyTo?: number): Promise<number> {
      const m = await call<{ message_id: number }>(
        "sendMessage",
        {
          chat_id: owner(bot),
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
          // Threaded under what it answers — your note, or the card you
          // replied to — so an answer is next to the question, not a screen
          // away. Sent anyway if that message was deleted.
          ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
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
const channelOf = (chatKey: string) => CHANNEL[chatKey.split(":")[0]!] ?? "chat";

/**
 * Where a chat lives, said the way you would look for it: "ANSARA Lounge ·
 * WhatsApp group". Every card that is about a chat carries one, because the
 * same name can be a WhatsApp group and a Telegram one, and a card that does
 * not say which sends you searching both apps.
 */
export function chatLabel(chatKey: string, person?: Row | null): string {
  const name = person?.name ? String(person.name) : chatKey.slice(chatKey.indexOf(":") + 1);
  return `${name} · ${chatWhere(chatKey, person)}`;
}

/** "Renew road tax · Notion To Do" — a question about a task, not a chat. */
export function taskLabel(title: unknown): string {
  return `${title ? `“${String(title)}”` : "a task"} · Notion To Do`;
}

/** "WhatsApp", "Telegram group" — the app, and the kind of chat when it is not one person. */
export function chatWhere(chatKey: string, person?: Row | null): string {
  const kind = person?.kind && person.kind !== "person" ? ` ${person.kind}` : "";
  return `${channelOf(chatKey)}${kind}`;
}

/**
 * The assistant writes `*like this*` for emphasis, the way WhatsApp does;
 * the cards are Telegram HTML, where that shows the asterisks. Applied after
 * escaping, so it can only ever add <b>.
 */
const bold = (html: string) => html.replace(/\*([^*\n]+)\*/g, "<b>$1</b>");

/** Notion links for task titles, by lower-cased title. */
export type TaskLinks = Map<string, string>;

export function taskLinks(tasks: Row[]): TaskLinks {
  return new Map(tasks.map((t) => [String(t.title).trim().toLowerCase(), String(t.url)]));
}

/**
 * What the assistant writes to you, as Telegram HTML. Its text is plain with
 * a few marks, and every message to you goes through here, so a digest, an
 * answer and a card read the same way:
 *
 *   # Heading          a bold line
 *   - item / • item    a bullet
 *   > their words      a quote; consecutive lines are one quote
 *   *bold*  _italic_
 *   [[Task title]]     the task, linked to its Notion page when it is one
 *
 * Escaped first, so the text can only ever gain the tags added here.
 */
export function rich(text: string, links?: TaskLinks): string {
  const inline = (s: string) =>
    bold(s)
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1<i>$2</i>")
      .replace(/\[\[([^\]\n]+)\]\]/g, (_, title: string) => {
        const url = links?.get(title.trim().toLowerCase().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
        return url && /^https:\/\//.test(url) ? `<a href="${url.replace(/"/g, "&quot;")}">${title}</a>` : `<b>${title}</b>`;
      });
  const out: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };
  for (const raw of esc(text.replace(/\r/g, "")).split("\n")) {
    const l = raw.trimEnd();
    const q = l.match(/^\s*&gt; ?(.*)$/);
    if (q) {
      quote.push(inline(q[1]!));
      continue;
    }
    flush();
    const h = l.match(/^\s*#{1,3}\s+(.+)$/);
    const b = l.match(/^\s*[-•]\s+(.+)$/);
    out.push(h ? `<b>${inline(h[1]!.replace(/\*/g, ""))}</b>` : b ? `• ${inline(b[1]!)}` : inline(l));
  }
  flush();
  // A blank line between groups reads as a gap; three in a row read as a bug.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A draft as shown on a card. Telegram refuses a message over 4096
 * characters, and a draft may be 4000 before the card's own lines; what is
 * sent on approval is the row's full text, never this.
 */
const shown = (text: unknown) => {
  const t = String(text ?? "");
  return t.length > 3300 ? `${t.slice(0, 3300)}… (${t.length - 3300} more characters — full text in the drafts table)` : t;
};

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
export function draftCard(d: Row, previousFeedback?: string | null, person?: Row | null): string {
  return [
    `✉️ <b>Reply to ${esc(String(d.chat_name))}</b> · ${chatWhere(String(d.chat_key), person)}`,
    d.why ? `<i>${esc(String(d.why))}</i>` : null,
    d.quote ? `\n<b>They wrote</b>\n${quoted(d.quote)}` : null,
    previousFeedback ? `\nRevised after: “${esc(previousFeedback)}”` : null,
    "",
    "<b>Your reply</b>",
    `<blockquote>${esc(shown(d.text))}</blockquote>`,
    "",
    "<i>Reply to this message to ask for changes.</i>",
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

/** A draft the assistant took back itself, and why. */
export function draftWithdrawn(d: Row): string {
  return [
    `🗑 <b>Withdrawn</b> — reply to ${esc(String(d.chat_name))}`,
    d.reason ? `<i>${esc(String(d.reason))}</i>` : null,
    "",
    `<blockquote>${esc(shown(d.text))}</blockquote>`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * The messages a card is about — what they wrote, stored on the row by the
 * endpoint as `Name: text` lines — as one quote.
 */
function quoted(quote: unknown): string {
  const lines = String(quote).split("\n").filter((l) => l.trim());
  return `<blockquote>${lines.map((l) => bold(esc(l))).join("\n")}</blockquote>`;
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

/** `about` is a chatLabel (which chat, in which app) or a taskLabel (which To Do task). */
export function questionCard(q: Row, about?: string | null, links?: TaskLinks): string {
  const options = Array.isArray(q.options) ? q.options : [];
  return [
    `❓ ${rich(String(q.question), links)}`,
    about ? `<i>About ${esc(about)}</i>` : null,
    q.quote ? `\n<b>Their latest</b>\n${quoted(q.quote)}` : null,
    options.length ? null : "\n<i>Reply to this message with your answer.</i>",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function questionOutcome(q: Row, about?: string | null, links?: TaskLinks): string {
  return [
    `❓ ${rich(String(q.question), links)}`,
    about ? `<i>About ${esc(about)}</i>` : null,
    "",
    q.answer ? `<b>Answer:</b> ${esc(String(q.answer))}` : "🗑 <i>No longer needed — I dropped this question.</i>",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/* --------------------------------------------------- chats to sort, batched */

const PRIORITY_OPTIONS = ["always", "normal", "ignore"];
/** Chats on one card. Three buttons each, and a card past this is a wall. */
export const BATCH_MAX = 8;

/**
 * "How important is this chat?" — a question about one chat whose choices are
 * exactly always / normal / ignore. The assistant asks a run's worth of these
 * at once, and one card each was a screen of cards; `deliver-cards` puts them
 * on one card instead, every question keeping its own row and `card_id`.
 */
export function isPriorityQuestion(q: Row): boolean {
  const options = Array.isArray(q.options) ? (q.options as unknown[]) : [];
  return (
    Boolean(q.chat_key) &&
    String(q.kind ?? "question") === "question" &&
    options.length === PRIORITY_OPTIONS.length &&
    options.every((o, i) => o === PRIORITY_OPTIONS[i])
  );
}

/**
 * The shared card, drawn from every question on it — so a tap, or an answer
 * the assistant took from your reply, redraws it whole: answered chats show
 * the answer, open ones keep their row of buttons. `qs` oldest first; the
 * numbers on the buttons are the numbers in the list.
 */
export function batchCard(
  qs: Row[],
  aboutOf: (q: Row) => string | null,
): { html: string; buttons: Button[][] } {
  const open = qs.filter((q) => q.status === "open");
  const lines = qs.map((q, i) => {
    const head = `<b>${i + 1}.</b> ${esc(aboutOf(q) ?? String(q.chat_key))}`;
    const status = q.status === "open" ? "" : ` — <b>${esc(String(q.answer ?? "dropped"))}</b>`;
    const asked = String(q.question).replace(/\s+/g, " ");
    // Eight of these and the card's own lines stay inside Telegram's 4096.
    const said = q.quote && q.status === "open" ? `\n${quoted(clipLines(String(q.quote), 160))}` : "";
    return `${head}${status}\n<i>${bold(esc(asked.length > 220 ? `${asked.slice(0, 220)}…` : asked))}</i>${said}`;
  });
  const html = [
    `❓ <b>How important are these chats?</b>`,
    open.length
      ? "<i>One tap per chat — or reply to this card to tell me who someone is.</i>"
      : "<i>All sorted.</i>",
    "",
    lines.join("\n\n"),
  ].join("\n");
  const buttons = qs.flatMap((q, i) =>
    q.status === "open"
      ? [PRIORITY_OPTIONS.map((o, j) => ({ text: `${i + 1} · ${o}`, callback_data: `q:${q.id}:${j}` }))]
      : [],
  );
  return { html, buttons };
}

/**
 * The order of the chats on a shared card — and so their numbers. Ties on
 * the millisecond are broken by id, so the card is numbered the same when it
 * is first posted and every time it is redrawn.
 */
export const byAsked = (a: Row, b: Row) =>
  Number(a.created_at) - Number(b.created_at) || String(a.id).localeCompare(String(b.id));

/** Every question posted on one card, oldest first — more than one for a batch of chats. */
export function cardQuestions(ctx: Pick<Ctx, "table">, cardId: string): Row[] {
  return ctx
    .table("questions")
    .query({ where: [{ column: "card_id", op: "=", value: cardId }], limit: BATCH_MAX * 2 })
    .filter((q) => String(q.kind ?? "question") === "question")
    .sort(byAsked);
}

/** The button under an update that carries a link — a task the assistant added. */
export function linkButtons(url: unknown): Button[][] | undefined {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return undefined;
  return [[{ text: /notion\.(so|com)\//.test(url) ? "Open in Notion" : "Open", url }]];
}

/** Each line of a quote cut to `max` characters, so a batch card stays inside Telegram's limit. */
const clipLines = (text: string, max: number) =>
  text
    .split("\n")
    .map((l) => (l.length > max ? `${l.slice(0, max)}…` : l))
    .join("\n");

/**
 * An update from the assistant — a digest, its answer to something you asked,
 * a task it added. One that opens with its own title (a digest, `# ➕ Added
 * to your To Do`) keeps it; anything else gets the notepad, so a message from
 * Maria is recognisable at a glance.
 */
export const updateCard = (u: Row, links?: TaskLinks) => {
  const body = rich(String(u.question), links);
  return /^\s*(🌅|🌙|#)/.test(String(u.question)) ? body : `🗒 ${body}`;
};
