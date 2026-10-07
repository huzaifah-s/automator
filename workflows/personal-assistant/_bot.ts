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
  const call = async <T>(method: string, body: Record<string, unknown>, retries = 2, privateRequest = false): Promise<T> => {
    if (!bot.token) throw new Error("The telegram / maria credential is not connected");
    try {
      const res = await ctx.http.post<{ ok: boolean; result: T; description?: string }>(
        `https://api.telegram.org/bot${bot.token}/${method}`,
        body,
        { retries, privateRequest },
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

    /**
     * Live Maria's answer, threaded under your message. Like `send`, but the
     * text is kept off the run page (`privateRequest`): it can quote a chat,
     * and the chat log is the only place messages live.
     */
    async liveReply(replyTo: number, html: string): Promise<number> {
      const m = await call<{ message_id: number }>(
        "sendMessage",
        {
          chat_id: owner(bot),
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
        },
        0,
        true,
      );
      return m.message_id;
    },

    /** "typing…" under the bot's name for about five seconds. Best effort. */
    async typing(): Promise<void> {
      try {
        await call("sendChatAction", { chat_id: owner(bot), action: "typing" }, 0);
      } catch {
        /* a missing typing indicator is not worth a failed answer */
      }
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
          link_preview_options: { is_disabled: true },
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

    /** The menu Telegram shows beside the message box. */
    async setCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
      await call("setMyCommands", { commands });
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

/**
 * The buttons under an open draft. `d:<id>:<action>` stays well inside
 * Telegram's 64 bytes. `chatUrl` opens the conversation itself, when the chat
 * has a link at all (see `chatUrl` in the endpoint) — to read more than the
 * card quotes, or to answer by hand.
 */
export const draftButtons = (id: string, chatUrl?: unknown): Button[][] => [
  [
    { text: "✅ Send", callback_data: `d:${id}:send` },
    { text: "Skip", callback_data: `d:${id}:skip` },
  ],
  ...(typeof chatUrl === "string" && /^https:\/\//.test(chatUrl) ? [[{ text: "💬 Open chat", url: chatUrl }]] : []),
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
    q.answer
      ? `<b>Answer:</b> ${esc(String(q.answer))}`
      : q.expired_at
        ? `⌛ <i>Expired — no answer in ${EXPIRE_DAYS} days. Reply to this message if it still matters.</i>`
        : "🗑 <i>No longer needed — I dropped this question.</i>",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * How long a question card waits for an answer. After that it is closed as
 * expired — its card says so, and the next digest mentions it once — rather
 * than sitting open, unanswerable in practice, above a day of newer cards.
 */
export const EXPIRE_DAYS = 2;

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
    const status =
      q.status === "open" ? "" : ` — <b>${esc(String(q.answer ?? (q.expired_at ? "expired" : "dropped")))}</b>`;
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

/* ------------------------------------------------- chats she sorted herself */

/** Chats with buttons on one "I sorted these" card; the rest of a run's are named in a line. */
export const SORTED_MAX = 10;
/**
 * A sorted card waits for the run that wrote it to finish — its `log_run`
 * — so a run's worth arrives as one card; this long after its newest call,
 * it goes anyway (a run that died before logging).
 */
export const SORTED_SETTLE_MS = 10 * 60_000;

const SORT_RANK: Record<string, number> = { always: 0, normal: 1, ignore: 2 };

/**
 * The order of the chats on a sorted card, and so their numbers: the ones
 * she let through first, the ignored last — the end he can skim.
 */
export const bySorted = (a: Row, b: Row) =>
  (SORT_RANK[String(a.choice)] ?? 3) - (SORT_RANK[String(b.choice)] ?? 3) || byAsked(a, b);

/**
 * "I sorted these": every chat she gave a priority on her own this run, her
 * choice and her reason, and a row of buttons each to change it — her
 * choice marked ✓. Untouched, her choice stands, so the card asks nothing of
 * him unless one is wrong. Redrawn whole from the rows after each tap.
 * `more` are the run's calls past SORTED_MAX, named without buttons.
 */
export function sortedCard(
  rows: Row[],
  aboutOf: (r: Row) => string,
  more: Row[] = [],
  quotes = true,
): { html: string; buttons: Button[][] } {
  const lines = rows.map((r, i) => {
    const mine = String(r.choice);
    const verdict = !r.answer
      ? `→ <b>${mine}</b>`
      : r.answer === mine
        ? `→ <b>${mine}</b> ✓ <i>you agreed</i>`
        : `→ <s>${mine}</s> <b>${esc(String(r.answer))}</b> <i>(you)</i>`;
    const said =
      quotes && r.quote && !r.answer ? `\n${quoted(clipLines(String(r.quote).split("\n").slice(-1).join("\n"), 120))}` : "";
    return `<b>${i + 1}.</b> ${esc(aboutOf(r))} ${verdict}\n<i>${esc(String(r.reason))}</i>${said}`;
  });
  const named = more.slice(0, 12).map((r) => `${clipLines(aboutOf(r).split(" · ")[0]!, 40)} (${r.choice})`);
  const extra = more.length
    ? `\n\n<i>Also set: ${esc(named.join(", "))}${more.length > named.length ? ` and ${more.length - named.length} more` : ""}.</i>`
    : "";
  const open = rows.some((r) => !r.answer);
  const html = [
    `🗂 <b>I sorted ${rows.length + more.length} new chat${rows.length + more.length === 1 ? "" : "s"}</b>`,
    open
      ? "<i>Nothing to do if these look right. Tap to change one and I'll learn from it — or reply to tell me who someone is.</i>"
      : "<i>All checked.</i>",
    "",
    lines.join("\n\n") + extra,
  ].join("\n");
  // Telegram refuses past 4096: the quotes are what can go.
  if (html.length > 4000 && quotes) return sortedCard(rows, aboutOf, more, false);
  const buttons = rows.flatMap((r, i) =>

    r.answer
      ? []
      : [PRIORITY_OPTIONS.map((o, j) => ({ text: `${i + 1} · ${o}${o === r.choice ? " ✓" : ""}`, callback_data: `s:${r.id}:${j}` }))],
  );
  return { html, buttons };
}

/** Her calls shown on one card — with buttons, in their numbered order. */
export function sortedOnCard(ctx: Pick<Ctx, "table">, cardId: string): Row[] {
  return ctx
    .table("sorting")
    .query({ where: [{ column: "card_id", op: "=", value: cardId }], limit: 100 })
    .sort(bySorted);
}

/**
 * A priority he gave — by a tap or in a reply. It is his from now on, so
 * the assistant can no longer change it, and every call of hers on that
 * chat he has not answered gets his choice: where it differs, that is the
 * feedback `outcomes` hands her to learn from.
 */
export function setByHim(ctx: Pick<Ctx, "table" | "workflow">, person: Row, priority: string): void {
  ctx.table("people").update(String(person.id), { priority, priority_by: "him", reason: null }, { writtenBy: ctx.workflow });
  const sorting = ctx.table("sorting");
  for (const r of sorting.query({ where: [{ column: "chat_key", op: "=", value: person.chat_key }], limit: 20 })) {
    if (!r.answer) sorting.update(String(r.id), { answer: priority, answered_at: Date.now() }, { writtenBy: ctx.workflow });
  }
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

/* ------------------------------------------------- lessons, twice a week */

/** Lesson buttons per row: "🗑 1"… fits four across a phone. */
const LESSON_ROW = 4;
/** A card past this is a wall; the newest are the ones worth checking. */
export const LESSONS_MAX = 15;

/**
 * "What I learned lately": every lesson since the last card, numbered, with
 * a button each that retires it — or, once retired (struck through), brings it
 * back. `l:<id>:t` toggles, so a mistaken tap is one more tap to undo, and
 * the card is drawn from the same list every time.
 */
export function lessonsCard(
  lessons: Row[],
  whereOf: (chatKey: string) => string,
): { html: string; buttons: Button[][] } {
  const lines = lessons.map((l, i) => {
    const where = l.chat_key ? ` <i>(${esc(whereOf(String(l.chat_key)))})</i>` : "";
    // Lessons are at most 300 characters; fifteen of those would pass
    // Telegram's 4096, so each is cut on the card (the table has it whole).
    const said = String(l.lesson);
    const text = `${esc(said.length > 200 ? `${said.slice(0, 200)}…` : said)}${where}`;
    return `<b>${i + 1}.</b> ${l.retired ? `<s>${text}</s>` : text}`;
  });
  const html = [
    "🧠 <b>What I learned lately</b>",
    "<i>Tap 🗑 to make me forget one — or reply to this card to reword it.</i>",
    "",
    lines.join("\n\n"),
  ].join("\n");
  const buttons: Button[][] = [];
  lessons.forEach((l, i) => {
    if (i % LESSON_ROW === 0) buttons.push([]);
    buttons.at(-1)!.push({ text: `${l.retired ? "↩" : "🗑"} ${i + 1}`, callback_data: `l:${l.id}:t` });
  });
  return { html, buttons };
}

/** The lesson ids a lessons card carries, in order — read back from its own buttons. */
export function lessonIds(markup: unknown): string[] {
  const rows = (markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)?.inline_keyboard;
  return (rows ?? [])
    .flat()
    .map((b) => b.callback_data?.match(/^l:([^:]+):t$/)?.[1])
    .filter((id): id is string => Boolean(id));
}

/* -------------------------------------------------------------------- /now */

const NOW_CAP = 5;

/**
 * What needs you right now, from the tables alone: drafts waiting for Send,
 * the assistant's open questions, To Do tasks overdue or due today, and the
 * loops you owe somebody that are due. The
 * same layout as a digest, without a run of the assistant — so it answers at
 * once, and says nothing the tables do not.
 */
export function nowCard(ctx: Pick<Ctx, "table">): { html: string; items: number } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const people = new Map(ctx.table("people").query({ limit: 1000 }).map((p) => [String(p.chat_key), p]));
  const tasks = ctx.table("tasks").query({ limit: 1000 });
  const titles = new Map(tasks.map((t) => [String(t.page_id), String(t.title)]));
  const where = (key: unknown) => chatLabel(String(key), people.get(String(key))).replace(" · ", " (") + ")";
  const one = (s: unknown, max: number) => {
    const t = String(s ?? "").replace(/\s+/g, " ").replace(/\*/g, "").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };

  const drafts = ctx
    .table("drafts")
    .query({ limit: 200 })
    .filter((d) => d.status === "pending" || d.status === "failed")
    .map((d) => `- ${where(d.chat_key)}: ${one(d.why ?? d.text, 90)}${d.status === "failed" ? " — failed to send" : ""}`);
  const asked = ctx
    .table("questions")
    .query({ where: [{ column: "status", op: "=", value: "open" }], limit: 200 })
    .filter((q) => (q.kind ?? "question") === "question")
    .map((q) => {
      const about = q.chat_key ? `${where(q.chat_key)}: ` : q.task_id ? `[[${titles.get(String(q.task_id)) ?? "a task"}]]: ` : "";
      return `- ${about}${one(q.question, 90)}`;
    });
  const due = (t: Row) => String(t.due ?? "").slice(0, 10);
  const open = tasks.filter((t) => t.status !== "KIV" && due(t));
  const overdue = open.filter((t) => due(t) < today).sort((a, b) => due(a).localeCompare(due(b)));
  const dueToday = open.filter((t) => due(t) === today);

  // What he owes somebody and is due — the loops on him. Theirs wait for a nudge draft, not for him.
  const owed = ctx
    .table("loops")
    .query({ limit: 1000 })
    .filter((l) => l.status === "open" && l.waiting_on === "him" && l.due && String(l.due) <= today)
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))
    .map((l) => `- ${one(l.what, 90)}${String(l.due) < today ? ` — due ${String(l.due).slice(5)}` : " — due today"}`);

  const section = (title: string, lines: string[]) =>
    lines.length
      ? `# ${title}\n${lines.slice(0, NOW_CAP).join("\n")}${lines.length > NOW_CAP ? `\n_+${lines.length - NOW_CAP} more_` : ""}`
      : null;
  const blocks = [
    section("✉️ Drafts waiting for Send", drafts),
    section("❓ I asked you", asked),
    section("⏰ Overdue", overdue.map((t) => `- [[${t.title}]]`)),
    section("📅 Due today", dueToday.map((t) => `- [[${t.title}]]`)),
    section("🔄 You owe", owed),
  ].filter((b): b is string => b !== null);
  const items = drafts.length + asked.length + overdue.length + dueToday.length + owed.length;
  const head = items ? `*Right now* — ${items} thing${items === 1 ? "" : "s"}` : "*Right now* — nothing needs you. 🎉";
  return { html: rich([head, ...blocks].join("\n\n"), taskLinks(tasks)), items };
}

/* ------------------------------------------------------------------ /brain */

/** The brain's topics, in the order `/brain` shows them — the endpoint's `brain` tool uses the same words. */
const BRAIN_TOPICS: Array<[string, string]> = [
  ["me", "👤 You"],
  ["work", "💼 Work"],
  ["project", "📁 Projects"],
  ["person", "👥 People"],
  ["preference", "⚙️ How you like things"],
];
/** The title line — also how a reply to one of these is recognised as being about the brain. */
export const BRAIN_TITLE = "🧠 What I know about you";
/** Under Telegram's 4096, with room for the tags `rich` adds. */
const BRAIN_MESSAGE_MAX = 3_400;

/**
 * Everything the assistant believes about you, as you would read it on a
 * phone: a heading per topic, a bullet per fact, the subject in bold. A
 * brain past one message is split between topics (or, for one long topic,
 * between facts), and every part says it is part of the brain, so a reply
 * to any of them arrives as a note quoting it — which is how "that's wrong"
 * reaches the assistant.
 */
export function brainCards(ctx: Pick<Ctx, "table">): { messages: string[]; facts: number } {
  const facts = ctx.table("brain").query({ limit: 1000 }).filter((f) => !f.retired);
  if (facts.length === 0) {
    return {
      messages: [rich(`*${BRAIN_TITLE}*\n\nNothing yet. Tell me about your work, your projects and the people in your chats, and I'll remember it.`)],
      facts: 0,
    };
  }
  const one = (s: unknown, max: number) => {
    const t = String(s ?? "").replace(/\s+/g, " ").replace(/\*/g, "").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const lines: string[] = [];
  for (const [topic, title] of BRAIN_TOPICS) {
    const rows = facts
      .filter((f) => f.topic === topic)
      .sort((a, b) => String(a.subject ?? "").localeCompare(String(b.subject ?? "")));
    if (!rows.length) continue;
    lines.push("", `# ${title}`);
    for (const f of rows) lines.push(`- ${f.subject ? `*${one(f.subject, 40)}*: ` : ""}${one(f.fact, 220)}`);
  }
  const foot = "_Reply to this message to correct anything — I'll fix it._";
  const parts: string[][] = [[]];
  let size = 0;
  let heading = "";
  for (const l of lines) {
    if (l.startsWith("# ")) heading = l;
    if (size + l.length > BRAIN_MESSAGE_MAX && parts.at(-1)!.length) {
      // Cut inside a topic, the next part says which topic it is still on.
      parts.push(l.startsWith("# ") || !l ? [] : ["", `${heading} (cont.)`]);
      size = 0;
    }
    parts.at(-1)!.push(l);
    size += l.length + 1;
  }
  const messages = parts.map((p, i) => {
    const head = `*${BRAIN_TITLE}*${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ""}`;
    const tail = i === parts.length - 1 ? `\n\n${foot}` : "";
    return rich(`${head}\n${p.join("\n")}${tail}`);
  });
  return { messages, facts: facts.length };
}
