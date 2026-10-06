import { z } from "zod";
import {
  cron,
  defineCredential,
  defineWorkflow,
  optionalSecret,
  type ChatLogEntry,
  type Ctx,
  type EvolutionMessage,
  type Row,
  type TelegramUserMessage,
} from "../../src/core/define.ts";
import { fireAssistant } from "./_routine.ts";

/**
 * Personal assistant — copies new WhatsApp and Telegram messages into the
 * chat log, where the assistant reads them (src/core/chat-log.ts), and adds
 * every chat it has not seen before to the `people` table with no priority,
 * so the assistant knows to ask about it.
 *
 * **Polling, not Evolution's webhook — for privacy, not latency.** A webhook
 * delivery is stored as the run's input and in the inbox, so every message
 * would land on the run page as well as in the chat log. Here the reads are
 * `private` (the run page lists the calls, not what came back) and each step
 * returns counts, so the chat log holds the only copy and forgets it on
 * schedule. Evolution already stores every message itself, and a poll also
 * catches up after a deploy, which a webhook does not.
 *
 * What is read, before the `people` table says otherwise:
 *
 *   - Every WhatsApp chat — people and groups — except broadcast lists and
 *     channels (`@newsletter`).
 *   - Telegram people and groups, but not channels, bots, muted chats,
 *     archived chats or your own Saved Messages.
 *   - Never Telegram's service account (777000). It is where login codes
 *     arrive, and a login code in a store the assistant reads is a login
 *     code one prompt away from being repeated somewhere.
 *
 * A row's `ignore` skips a chat everywhere; `always` reads one the defaults
 * would have skipped — a muted group that still matters.
 */

const TZ = "Asia/Kuala_Lumpur";

// Named rather than primary: until both exist on a server, the workflow is
// shown as blocked there instead of failing every two minutes.
const whatsappAccount = defineCredential("evolution", "huzaifah-evolution-api");
const telegramAccount = defineCredential("telegram_user", "huzaifah-telegram-user-account");
/** Optional: without it, an `always` chat waits for the hourly run like any other. */
const routineToken = optionalSecret("ASSISTANT_ROUTINE_TOKEN", z.string().min(20), "");

/** Telegram's own notifications account, which sends login codes. */
const TELEGRAM_SERVICE = 777000;

/** How far back the very first sync reads, before there is a cursor. */
const FIRST_SYNC_DAYS = 3;
/** Re-read this much before the last sync, so a late-stamped message is not missed. */
const OVERLAP_MS = 10 * 60_000;
/** Messages taken from a Telegram chat seen for the first time. */
const FIRST_SIGHT = 20;
/**
 * WhatsApp message types that are bookkeeping, not something anybody said:
 * an edit, a deletion, a disappearing-messages setting.
 */
const NOISE = new Set(["protocolMessage"]);

/** Chats looked at per platform per run, newest first. */
const CHATS = 100;
/**
 * Telegram chats whose history is read in one run. Telegram answers a burst
 * of reads with FLOOD_WAIT — the first sync reading 60 chats in 20 seconds
 * got one — and cursors are per chat, so the rest simply wait for the next
 * run. In steady state a two-minute window rarely touches more than a few.
 */
const TELEGRAM_READS = 15;

type Priority = "always" | "normal" | "ignore" | null;

export default defineWorkflow({
  name: "personal-assistant-sync-chats",
  description: "Copies new WhatsApp and Telegram messages into the assistant's chat log",
  trigger: cron("*/2 * * * *", { tz: TZ }),
  retries: 1,
  timeoutMs: 110_000,

  async run(ctx) {
    const people = new Map<string, Row>(
      ctx.table("people").query({ limit: 1000 }).map((r) => [String(r.chat_key), r]),
    );
    const book: People = {
      priority: (key) => (people.get(key)?.priority as Priority) ?? null,
      // Added the moment a chat passes the filters, inside the step that read
      // it. A later step would be lost to a run that failed in between —
      // after the cursors had moved, so the chat would not come round again
      // until it next had something new.
      remember(chat) {
        if (people.has(chat.chat_key)) return false;
        const { row, created } = ctx.table("people").insert(chat, { writtenBy: ctx.workflow });
        people.set(chat.chat_key, row);
        return created;
      },
    };

    const whatsapp = await ctx.step("whatsapp", () => syncWhatsApp(ctx, book));
    const telegram = await ctx.step("telegram", () => syncTelegram(ctx, book));

    // Somebody whose chat is `always` wrote: start the assistant now rather
    // than at the top of the hour. The count, never who — see _routine.ts.
    const urgent = whatsapp.urgent + telegram.urgent;
    const fired = urgent
      ? await fireAssistant(ctx, routineToken, `${urgent} new message(s) in chats marked always. Start with \`waiting\`.`)
      : undefined;
    return { whatsapp, telegram, ...(fired ? { fired } : {}) };
  },
});

type NewChat = {
  name: string;
  channel: "whatsapp" | "telegram";
  kind: "person" | "group" | "channel" | "bot";
  priority: null;
  chat_key: string;
};

/** What a sync step reads and writes of the `people` table. */
interface People {
  priority(key: string): Priority;
  /** Adds a chat not in the table yet. True when it was new. */
  remember(chat: NewChat): boolean;
}

/** What a sync step returns — counts only, because it is the run page's copy. */
interface Synced {
  /** Chats that had new messages. */
  chats: number;
  messages: number;
  /** Chats added to `people`. */
  newChats: number;
  /** Chats marked `always` with a new message from somebody else. */
  urgent: number;
  /** Chats with something new that were left for the next run. */
  deferred?: number;
}

/* ---------------------------------------------------------------- whatsapp */

async function syncWhatsApp(ctx: Ctx, people: People): Promise<Synced> {
  const startedAt = Date.now();
  const last = await ctx.state.get<number>("wa:since");
  const since = new Date(
    last !== undefined ? last - OVERLAP_MS : startedAt - FIRST_SYNC_DAYS * 86_400_000,
  );

  const chats = await ctx.evolution.chats({
    since,
    limit: CHATS,
    private: true,
    credential: whatsappAccount,
  });
  let messages = 0;
  let read = 0;
  let newChats = 0;
  let urgent = 0;

  for (const chat of chats) {
    const key = `whatsapp:${chat.chat}`;
    const p = people.priority(key);
    const broadcast = chat.chat.endsWith("@newsletter") || chat.chat.endsWith("@broadcast");
    if (p === "ignore" || (broadcast && p !== "always")) continue;

    const list = (
      await ctx.evolution.messages(chat.chat, {
        since,
        limit: 100,
        private: true,
        credential: whatsappAccount,
      })
    ).filter((m) => !NOISE.has(m.type));
    if (list.length === 0) continue;
    // Before the cursor moves — see syncTelegram.
    if (
      people.remember({
        name: chat.name ?? chat.chat.split("@")[0]!,
        channel: "whatsapp",
        kind: broadcast ? "channel" : chat.isGroup ? "group" : "person",
        priority: null,
        chat_key: key,
      })
    ) newChats++;
    read++;
    const added = ctx.chatLog.record(list.map((m) => fromWhatsApp(m, chat.name)));
    messages += added;
    if (added > 0 && p === "always" && list.some((m) => !m.outgoing)) urgent++;
  }

  // Only once everything is recorded: a failure above leaves the cursor
  // where it was, and the next run reads the same window again.
  await ctx.state.set("wa:since", startedAt);
  return { chats: read, messages, newChats, urgent };
}

function fromWhatsApp(m: EvolutionMessage, chatName: string | undefined): ChatLogEntry {
  return {
    channel: "whatsapp",
    chat: m.chat,
    chatName,
    isGroup: m.isGroup,
    id: m.id,
    sender: m.from,
    senderName: m.name,
    text: m.text,
    type: m.type,
    outgoing: m.outgoing,
    replyTo: m.replyTo,
    sentAt: m.timestamp ? m.timestamp * 1000 : Date.now(),
  };
}

/* ---------------------------------------------------------------- telegram */

async function syncTelegram(ctx: Ctx, people: People): Promise<Synced> {
  // Saved Messages is a chat with yourself. Cached forever: an account's id
  // does not change, and it saves a call on every run.
  let me = await ctx.state.get<number>("tg:me");
  if (me === undefined) {
    me = (await ctx.telegramUser.me({ credential: telegramAccount })).id;
    await ctx.state.set("tg:me", me);
  }

  const chats = await ctx.telegramUser.chats({
    limit: CHATS,
    private: true,
    credential: telegramAccount,
  });
  let messages = 0;
  let read = 0;
  let deferred = 0;
  let calls = 0;
  let stopped = false;
  let newChats = 0;
  let urgent = 0;

  for (const chat of chats) {
    if (chat.id === TELEGRAM_SERVICE || chat.id === me) continue;
    const key = `telegram:${chat.id}`;
    const p = people.priority(key);
    const quiet = chat.muted || chat.type === "channel" || chat.type === "bot";
    if (p === "ignore" || (quiet && p !== "always")) continue;

    const cursor = await ctx.state.get<number>(`tg:${chat.id}`);
    const newest = chat.lastMessage?.id;
    if (newest === undefined || (cursor !== undefined && newest <= cursor)) continue;
    if (stopped || calls >= TELEGRAM_READS) {
      deferred++;
      continue;
    }

    // Oldest first either way, so the last one is the new cursor. A busy
    // group with more than 100 since the last run is finished next run.
    let list: TelegramUserMessage[];
    calls++;
    try {
      list =
        cursor === undefined
          ? await ctx.telegramUser.history(chat.id, {
              limit: FIRST_SIGHT,
              private: true,
              credential: telegramAccount,
            })
          : await ctx.telegramUser.history(chat.id, {
              after: cursor,
              limit: 100,
              private: true,
              credential: telegramAccount,
            });
    } catch (err) {
      // Telegram asking for a pause is not a failure of this run: what was
      // read is recorded and its cursors kept, and the next run carries on.
      if (!/FLOOD_WAIT/.test(String((err as Error)?.message))) throw err;
      ctx.log.warn("Telegram asked for a pause — the rest waits for the next run");
      stopped = true;
      deferred++;
      continue;
    }
    // The cursor moves past notices too, or a chat whose newest message is
    // "joined Telegram" would be read again on every run.
    const last = list.at(-1)?.id;
    const said = list.filter((m) => !m.service);
    if (said.length > 0) {
      // Added before the cursor moves. Adding it in a later step would lose
      // it to a run that failed in between: the cursor would already be past
      // these messages, and the chat would not come round again until it
      // next had something new.
      if (
        people.remember({
          name: chat.name,
          channel: "telegram",
          kind:
            chat.type === "user" ? "person" : chat.type === "bot" ? "bot" : chat.type === "channel" ? "channel" : "group",
          priority: null,
          chat_key: key,
        })
      ) newChats++;
      read++;
      const added = ctx.chatLog.record(said.map((m) => fromTelegram(m, chat.type !== "user")));
      messages += added;
      if (added > 0 && p === "always" && said.some((m) => !m.outgoing)) urgent++;
    }
    if (last !== undefined) await ctx.state.set(`tg:${chat.id}`, last);
  }

  return { chats: read, messages, newChats, deferred, urgent };
}

function fromTelegram(m: TelegramUserMessage, isGroup: boolean): ChatLogEntry {
  return {
    channel: "telegram",
    chat: String(m.chatId),
    chatName: m.chatName,
    isGroup,
    id: String(m.id),
    sender: m.outgoing ? undefined : m.from && String(m.from.id),
    senderName: m.outgoing ? undefined : m.from?.name,
    text: m.text,
    type: m.media ?? "text",
    outgoing: m.outgoing,
    replyTo: m.replyTo !== undefined ? String(m.replyTo) : undefined,
    sentAt: Date.parse(m.date),
  };
}
