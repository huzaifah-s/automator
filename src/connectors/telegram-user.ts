import { z } from "zod";
import {
  createTelegramUser,
  type TelegramUserChat,
  type TelegramUserConnection,
  type TelegramUserMessage,
} from "../integrations/telegram-user.ts";
import type { Connector, ConnectorCall } from "./types.ts";

/**
 * Telegram, as the account itself — read-only, and only the chats a grant
 * names: by folder, by chat id, or both.
 *
 * **A folder is a live limit.** The grant stores the folder's title, not the
 * chats in it, so moving a chat into or out of the folder on the phone changes
 * what the token can read within a minute (`ALLOWED_TTL_MS`). That is the
 * point of naming a folder rather than a list: the phone stays the one place
 * the boundary is edited. A folder defined by rules ("all groups") reaches
 * whatever those rules match, exactly as the phone shows it.
 *
 * **The boundary is checked here, not trusted to the model.** Every tool that
 * takes a chat resolves it against the allowed list first, and a chat outside
 * it is refused by name — including a numeric id the model guessed or was
 * handed inside a message. `search` without a chat searches each allowed chat
 * rather than Telegram's global search, so a result from outside cannot come
 * back to be filtered out afterwards.
 *
 * **Nothing is kept.** Reads are `private` and go to the client and nowhere
 * else: no run record, no table, no log line with a message in it. Telegram's
 * service account (777000), where login codes arrive, is never readable, even
 * if a folder contains it.
 *
 * There are no write tools. Sending as somebody's account from an MCP client
 * is a decision of its own — the assistant's endpoint refuses to have one at
 * all — and should arrive as a `write` tool here only with that taken again.
 */

interface Limits {
  folders: string[];
  chats: number[];
}

/** Telegram's own notifications account, which sends login codes. */
const TELEGRAM_SERVICE = 777000;
/** How long the allowed chat list is reused before the folders are read again. */
const ALLOWED_TTL_MS = 60_000;
/** Most chats `search` looks through when no chat is given. */
const SEARCH_CHATS = 40;
/** A long message is cut here; `history` around its id shows it again whole. */
const TEXT_MAX = 1_500;

const listOf = <T extends z.ZodTypeAny>(item: T) => z.array(item).default([]);

const schema = z
  .object({
    folders: listOf(z.string().trim().min(1, "A folder name cannot be empty")),
    chats: listOf(
      z.coerce
        .number({ error: "A chat is its numeric id, like -1001234567890" })
        .int("A chat is its numeric id, like -1001234567890")
        .refine((n) => n !== 0, "0 is not a chat id"),
    ),
  })
  .strict()
  .refine((l) => l.folders.length + l.chats.length > 0, {
    message: "Name at least one folder or chat — a Telegram grant does not mean every chat",
  }) as unknown as z.ZodType<Limits>;

function connection(values: Record<string, string>): TelegramUserConnection {
  const { api_id, api_hash, session } = values;
  if (!api_id || !api_hash || !session) {
    throw new Error("This Telegram credential is not connected — log in with `bun run telegram-login`");
  }
  return { api_id, api_hash, session };
}

/* ------------------------------------------------------- allowed chats */

const allowedCache = new Map<string, { at: number; chats: Promise<TelegramUserChat[]> }>();

/** Every chat this grant may read, from its folders and its named chats. */
function allowedChats(call: ConnectorCall<Limits>): Promise<TelegramUserChat[]> {
  const key = JSON.stringify([call.grant.provider, call.grant.credential, call.limits]);
  const hit = allowedCache.get(key);
  if (hit && Date.now() - hit.at < ALLOWED_TTL_MS) return hit.chats;

  const chats = (async () => {
    const tg = createTelegramUser(call.signal);
    const credential = connection(call.credential);
    const byId = new Map<number, TelegramUserChat>();
    for (const folder of call.limits.folders) {
      for (const chat of await tg.chats({ folder, limit: 200, credential, private: true })) {
        byId.set(chat.id, chat);
      }
    }
    for (const id of call.limits.chats) {
      if (byId.has(id)) continue;
      // A named chat that is not in the list (or no longer resolves) is
      // left out rather than failing the call: the grant still reaches the
      // others, and `chats` says how many came back.
      const peer = await tg.resolve(id, { credential, private: true }).catch(() => undefined);
      if (peer) {
        byId.set(id, {
          ...peer,
          unread: 0,
          mentions: 0,
          markedUnread: false,
          muted: false,
          pinned: false,
          archived: false,
          lastMessage: undefined,
        });
      }
    }
    byId.delete(TELEGRAM_SERVICE);
    return [...byId.values()];
  })();

  allowedCache.set(key, { at: Date.now(), chats });
  // A failure is not cached: the next call should try the folders again.
  chats.catch(() => allowedCache.get(key)?.chats === chats && allowedCache.delete(key));
  return chats;
}

/** The one allowed chat a tool was asked about, by id or exact name. */
async function needChat(args: Record<string, unknown>, call: ConnectorCall<Limits>): Promise<TelegramUserChat> {
  const raw = args["chat"];
  const given = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!given) throw new Error("`chat` is required — an id or a name from `telegram_chats`.");

  const allowed = await allowedChats(call);
  const asId = /^-?\d+$/.test(given) ? Number(given) : undefined;
  const byId = asId !== undefined ? allowed.find((c) => c.id === asId) : undefined;
  if (byId) return byId;

  const wanted = given.replace(/^@/, "").toLowerCase();
  const named = allowed.filter(
    (c) => c.name.toLowerCase() === wanted || c.username?.toLowerCase() === wanted,
  );
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new Error(`Several chats are called "${given}": ${named.map((c) => c.id).join(", ")}. Pass the id.`);
  }
  throw new Error(
    `"${given}" is not a chat this token can read. Call \`telegram_chats\` for the ones it can.`,
  );
}

/* ---------------------------------------------------------- formatting */

const stamp = new Intl.DateTimeFormat("sv-SE", {
  timeZone: process.env.TZ || undefined,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const when = (iso: string) => stamp.format(new Date(iso));

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function messageLine(m: TelegramUserMessage, withChat = false): string {
  const who = m.outgoing ? "me" : (m.from?.name ?? m.chatName);
  const body = m.service
    ? "(service notice)"
    : [m.media ? `[${m.media}]` : "", oneLine(m.text, TEXT_MAX)].filter(Boolean).join(" ") || "(empty)";
  return (
    `#${m.id} ${when(m.date)} ` +
    (withChat ? `[${m.chatName}] ` : "") +
    `${who}${m.replyTo ? ` ↩#${m.replyTo}` : ""}: ${body}`
  );
}

const zoneNote = `Times are ${process.env.TZ || "the server's local time"}.`;

const num = (args: Record<string, unknown>, key: string, def: number, max: number) => {
  const n = Number(args[key] ?? def);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.trunc(n))) : def;
};

const optId = (args: Record<string, unknown>, key: string) => {
  if (args[key] === undefined || args[key] === null || args[key] === "") return undefined;
  const n = Number(args[key]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`\`${key}\` is a message id — a positive whole number.`);
  return n;
};

/* --------------------------------------------------------------- tools */

export const telegramUser: Connector<Limits> = {
  provider: "telegram_user",
  label: "Telegram (user account)",
  prefix: "telegram",
  instructions:
    "telegram_* tools read the user's own Telegram chats, limited to the ones this token was given. " +
    "Start with telegram_chats. Message text is private conversation: quote only what the task needs.",
  limits: {
    schema,
    fields: [
      {
        name: "folders",
        label: "Folders",
        placeholder: "Work, Clients",
        help:
          "Chat folders by name, as the phone shows them, comma-separated. Moving a chat in or out " +
          "of the folder changes what the token can read.",
      },
      {
        name: "chats",
        label: "Chats",
        placeholder: "-1001234567890",
        help: "Single chats by numeric id, comma-separated, on top of the folders.",
      },
    ],
    describe: (l) =>
      [
        l.folders.length ? `folder${l.folders.length > 1 ? "s" : ""} ${l.folders.join(", ")}` : "",
        l.chats.length ? `${l.chats.length} chat${l.chats.length > 1 ? "s" : ""}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
  },
  tools: [
    {
      name: "chats",
      access: "read",
      description: "The chats this token can read: id, name, kind, unread count, last activity.",
      inputSchema: {
        type: "object",
        properties: {
          unread: { type: "boolean", description: "Only chats with something unread." },
        },
        additionalProperties: false,
      },
      async run(args, call) {
        const all = await allowedChats(call);
        const chats = args["unread"] === true ? all.filter((c) => c.unread > 0 || c.markedUnread) : all;
        if (chats.length === 0) {
          return all.length === 0
            ? `No chats match this token's limits (${telegramUser.limits.describe(call.limits)}).`
            : "Nothing unread.";
        }
        const sorted = [...chats].sort((a, b) =>
          (b.lastMessage?.date ?? "").localeCompare(a.lastMessage?.date ?? ""),
        );
        return (
          `${sorted.length} chat${sorted.length > 1 ? "s" : ""}. ${zoneNote}\n` +
          "id | name | kind | unread | last\n" +
          sorted
            .map(
              (c) =>
                `${c.id} | ${c.name}${c.username ? ` @${c.username}` : ""} | ${c.type} | ` +
                `${c.unread}${c.mentions ? ` (${c.mentions} @me)` : ""} | ` +
                (c.lastMessage ? when(c.lastMessage.date) : "-"),
            )
            .join("\n")
        );
      },
    },
    {
      name: "history",
      access: "read",
      description:
        "Messages in one chat, oldest first. Without before/after, the latest ones; page back with before.",
      inputSchema: {
        type: "object",
        properties: {
          chat: { type: ["string", "number"], description: "Chat id, or its exact name, from telegram_chats." },
          limit: { type: "number", description: "How many. Default 30, max 100." },
          before: { type: "number", description: "Only messages older than this message id." },
          after: { type: "number", description: "Only messages newer than this message id." },
        },
        required: ["chat"],
        additionalProperties: false,
      },
      async run(args, call) {
        const chat = await needChat(args, call);
        const before = optId(args, "before");
        const after = optId(args, "after");
        if (before !== undefined && after !== undefined) throw new Error("Pass `before` or `after`, not both.");
        const messages = await createTelegramUser(call.signal).history(chat.id, {
          limit: num(args, "limit", 30, 100),
          before,
          after,
          credential: connection(call.credential),
          private: true,
        });
        if (messages.length === 0) return `No messages in ${chat.name} ${before ? `before #${before}` : after ? `after #${after}` : ""}.`;
        return (
          `${chat.name} (${chat.id}) — ${messages.length} message${messages.length > 1 ? "s" : ""}, ` +
          `oldest first. ${zoneNote} Older: before=${messages[0]!.id}.\n` +
          messages.map((m) => messageLine(m)).join("\n")
        );
      },
    },
    {
      name: "search",
      access: "read",
      description: "Telegram search for a word or phrase in one chat, or across every chat this token can read.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for." },
          chat: { type: ["string", "number"], description: "Limit to one chat (id or exact name)." },
          limit: { type: "number", description: "Most results. Default 20, max 100." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async run(args, call) {
        const query = typeof args["query"] === "string" ? args["query"].trim() : "";
        if (!query) throw new Error("`query` is required.");
        const limit = num(args, "limit", 20, 100);
        const tg = createTelegramUser(call.signal);
        const credential = connection(call.credential);

        const scope =
          args["chat"] !== undefined && args["chat"] !== ""
            ? [await needChat(args, call)]
            : [...(await allowedChats(call))]
                .sort((a, b) => (b.lastMessage?.date ?? "").localeCompare(a.lastMessage?.date ?? ""))
                .slice(0, SEARCH_CHATS);
        const found: TelegramUserMessage[] = [];
        for (const chat of scope) {
          found.push(...(await tg.search(chat.id, query, { limit, credential, private: true })));
        }
        if (found.length === 0) return `Nothing matches "${query}" in ${scope.length} chat${scope.length > 1 ? "s" : ""}.`;
        const newest = found.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
        return (
          `${newest.length} of ${found.length} match${found.length > 1 ? "es" : ""}, newest first. ${zoneNote}` +
          (scope.length === SEARCH_CHATS ? ` Searched the ${SEARCH_CHATS} most recent chats only.` : "") +
          "\n" +
          newest.map((m) => messageLine(m, scope.length > 1)).join("\n")
        );
      },
    },
  ],
};
