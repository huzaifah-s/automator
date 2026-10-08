import { db } from "./db.ts";
import { log } from "./logger.ts";
import { redact } from "./redact.ts";

/**
 * The chat log — messages read from WhatsApp and Telegram, kept for a couple
 * of weeks so an assistant can ask "who is waiting on me?" without reading
 * every chat again each time.
 *
 * **Not a data table, on purpose.** A table renders on the Tables tab and is
 * served over `/mcp/tables`; this is somebody's private conversations, and
 * the only thing that should read it is the assistant that was given it. So
 * it is invisible the way `ctx.state` is — no tab, no route — and it ages
 * out: `CHAT_LOG_RETENTION_DAYS` (default 14) after a message was sent, the
 * nightly prune deletes it, whatever happens to the run that recorded it.
 * His own messages are kept longer — `CHAT_LOG_OWN_RETENTION_DAYS`, default
 * 90 — because they are what a draft has to sound like, and a chat he last
 * wrote in three weeks ago had none left (2026-10-08: "we dont call each
 * other ko aku" — she had only the other side to copy). The other side
 * still goes at 14.
 *
 * **Redacted on the way in.** A message is text a stranger typed, so it is
 * not credential-shaped by construction — but "nothing that reaches SQLite
 * holds a raw credential" has no exceptions, and a token pasted into a chat
 * that this process also knows is exactly the case it is for.
 *
 * The recording workflow should read with `private: true`, so the run page
 * lists its calls without a second copy of the messages, and return counts.
 */

export type ChatChannel = "whatsapp" | "telegram";

export interface ChatLogEntry {
  channel: ChatChannel;
  /** The chat: a WhatsApp JID, or a Telegram chat id as text. */
  chat: string;
  chatName?: string;
  isGroup?: boolean;
  /** The message's own id within the chat. */
  id: string;
  /** Who wrote it: a phone number, or a Telegram user id. Absent for your own. */
  sender?: string;
  senderName?: string;
  text: string;
  /** `conversation`, `imageMessage`, … — WhatsApp only. */
  type?: string;
  outgoing: boolean;
  replyTo?: string;
  /** Milliseconds since the epoch, as the platform stamped it. */
  sentAt: number;
}

export interface ChatLog {
  /**
   * Stores the messages not stored already — a message is its channel, chat
   * and id, so recording an overlapping page twice is free. Returns how many
   * were new. Anything older than the log keeps (`chatLogKeeps`) is
   * dropped here, so a reader that hands over months of history (find-chat)
   * cannot keep it past the prune.
   */
  record(entries: ChatLogEntry[]): number;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    channel      TEXT    NOT NULL,
    chat         TEXT    NOT NULL,
    id           TEXT    NOT NULL,
    chat_name    TEXT,
    is_group     INTEGER NOT NULL DEFAULT 0,
    sender       TEXT,
    sender_name  TEXT,
    text         TEXT    NOT NULL,
    type         TEXT,
    outgoing     INTEGER NOT NULL,
    reply_to     TEXT,
    sent_at      INTEGER NOT NULL,
    recorded_at  INTEGER NOT NULL,
    PRIMARY KEY (channel, chat, id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_chat_messages_sent ON chat_messages(sent_at);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(channel, chat, sent_at);
`);

const insert = db.prepare(
  `INSERT INTO chat_messages
     (channel, chat, id, chat_name, is_group, sender, sender_name, text, type,
      outgoing, reply_to, sent_at, recorded_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(channel, chat, id) DO NOTHING`,
);
// Theirs past the short window; his own past the long one.
const prune = db.prepare(`DELETE FROM chat_messages WHERE sent_at < ? AND (outgoing = 0 OR sent_at < ?)`);

/** One for the whole process: it is a store, not a per-run client. */
export const chatLog: ChatLog = {
  record(entries) {
    const now = Date.now();
    const keeps = { theirs: chatLogKeepsFrom(now), own: chatLogKeepsFrom(now, true) };
    const write = db.transaction((list: ChatLogEntry[]) => {
      let added = 0;
      for (const e of list) {
        if (e.sentAt < (e.outgoing ? keeps.own : keeps.theirs)) continue;
        const clean = (v: string | undefined) => (v === undefined ? null : redact(v));
        added += insert.run(
          e.channel,
          e.chat,
          e.id,
          clean(e.chatName),
          e.isGroup ? 1 : 0,
          e.sender ?? null,
          clean(e.senderName),
          clean(e.text) ?? "",
          e.type ?? null,
          e.outgoing ? 1 : 0,
          e.replyTo ?? null,
          e.sentAt,
          now,
        ).changes;
      }
      return added;
    });
    return write(entries);
  },
};

/* ------------------------------------------------------------- reading */

/**
 * Reads for the assistant's endpoint (src/server/mcp-assistant.ts) — the only
 * reader. Deliberately not on `ctx`: a workflow that wants to act on a
 * conversation is the assistant's job, and one more reader is one more place
 * a message can be copied out of the log.
 */

export interface StoredMessage {
  channel: ChatChannel;
  chat: string;
  id: string;
  chatName: string | null;
  isGroup: boolean;
  sender: string | null;
  senderName: string | null;
  text: string;
  type: string | null;
  outgoing: boolean;
  replyTo: string | null;
  sentAt: number;
}

/** A chat whose newest message is theirs, not yours. */
export interface WaitingChat {
  /** The newest message — theirs. */
  last: StoredMessage;
  /** Their messages since your last reply, or in the log if you never replied. */
  unanswered: number;
  /** When you last wrote in it, or null if not in the log. */
  myLastAt: number | null;
}

type Raw = Record<string, unknown>;

function toStored(r: Raw): StoredMessage {
  return {
    channel: r.channel as ChatChannel,
    chat: String(r.chat),
    id: String(r.id),
    chatName: (r.chat_name as string | null) ?? null,
    isGroup: r.is_group === 1,
    sender: (r.sender as string | null) ?? null,
    senderName: (r.sender_name as string | null) ?? null,
    text: String(r.text ?? ""),
    type: (r.type as string | null) ?? null,
    outgoing: r.outgoing === 1,
    replyTo: (r.reply_to as string | null) ?? null,
    sentAt: Number(r.sent_at),
  };
}

const waitingQuery = db.prepare(`
  WITH newest AS (
    SELECT channel, chat, MAX(sent_at) AS at
    FROM chat_messages WHERE sent_at >= ? GROUP BY channel, chat
  ),
  mine AS (
    SELECT channel, chat, MAX(sent_at) AS at
    FROM chat_messages WHERE outgoing = 1 GROUP BY channel, chat
  )
  SELECT m.*, mine.at AS my_last_at,
    (SELECT count(*) FROM chat_messages x
      WHERE x.channel = m.channel AND x.chat = m.chat AND x.outgoing = 0
        AND x.sent_at > COALESCE(mine.at, 0)) AS unanswered
  FROM newest
  JOIN chat_messages m ON m.channel = newest.channel AND m.chat = newest.chat AND m.sent_at = newest.at
  LEFT JOIN mine ON mine.channel = m.channel AND mine.chat = m.chat
  ORDER BY m.sent_at ASC
`);

/**
 * Chats active since `since` whose newest message is not yours — the "they
 * spoke last" signal, which holds up where unread counts do not (Evolution's
 * stays 0). Oldest wait first.
 */
export function waitingChats(since: number): WaitingChat[] {
  const out = new Map<string, WaitingChat>();
  // Two messages stamped the same second are both "newest". If either of
  // them is yours, you have answered.
  const answered = new Set<string>();
  for (const r of waitingQuery.all(since) as Raw[]) {
    const key = `${r.channel}:${r.chat}`;
    const last = toStored(r);
    if (last.outgoing) answered.add(key);
    else if (!out.has(key)) {
      out.set(key, {
        last,
        unanswered: Number(r.unanswered),
        myLastAt: r.my_last_at === null ? null : Number(r.my_last_at),
      });
    }
  }
  return [...out].filter(([key]) => !answered.has(key)).map(([, w]) => w);
}

const threadQuery = db.prepare(`
  SELECT * FROM (
    SELECT * FROM chat_messages WHERE channel = ? AND chat = ? AND sent_at < ?
    ORDER BY sent_at DESC LIMIT ?
  ) ORDER BY sent_at ASC
`);

/** No upper bound: "as of now, and anything stamped a little ahead of the clock". */
const NO_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * The latest `limit` messages in one chat, oldest first. `before` reads the
 * chat as it stood at a past moment — the replay test
 * (src/server/assistant-eval.ts) must not see the reply it is grading.
 */
export function chatThread(channel: ChatChannel, chat: string, limit: number, before = NO_BOUND): StoredMessage[] {
  return (threadQuery.all(channel, chat, before, limit) as Raw[]).map(toStored);
}

const hisQuery = db.prepare(`
  SELECT * FROM chat_messages
  WHERE channel = ? AND chat = ? AND outgoing = 1 AND trim(text) <> '' AND sent_at < ?
  ORDER BY sent_at DESC LIMIT ?
`);

/**
 * His own messages with words in one chat, newest first — what a draft to
 * it has to sound like. They reach back `CHAT_LOG_OWN_RETENTION_DAYS`, past
 * the window `chatThread` usually shows.
 */
export function hisMessages(channel: ChatChannel, chat: string, limit: number, before = NO_BOUND): StoredMessage[] {
  return (hisQuery.all(channel, chat, before, limit) as Raw[]).map(toStored);
}

const sinceQuery = db.prepare(`
  SELECT * FROM chat_messages WHERE sent_at >= ? ORDER BY channel, chat, sent_at ASC
`);

/**
 * Every message since `since`, chat by chat, oldest first — what the replay
 * test builds its cases from: each time he answered somebody, and each
 * group message he let pass.
 */
export function messagesSince(since: number): StoredMessage[] {
  return (sinceQuery.all(since) as Raw[]).map(toStored);
}

const newestQuery = db.prepare(`
  WITH newest AS (
    SELECT channel, chat, MAX(sent_at) AS at
    FROM chat_messages WHERE sent_at >= ? GROUP BY channel, chat
  )
  SELECT m.* FROM newest
  JOIN chat_messages m ON m.channel = newest.channel AND m.chat = newest.chat AND m.sent_at = newest.at
`);

/**
 * Chats active since `since` whose newest message is his — the other side of
 * `waitingChats`: he wrote last and nobody has answered. Newest first. Two
 * messages stamped the same second with one of theirs among them count as
 * answered.
 */
export function lastWordMine(since: number): StoredMessage[] {
  const out = new Map<string, StoredMessage>();
  const answered = new Set<string>();
  for (const r of newestQuery.all(since) as Raw[]) {
    const m = toStored(r);
    const key = `${m.channel}:${m.chat}`;
    if (!m.outgoing) answered.add(key);
    else out.set(key, m);
  }
  return [...out.entries()].filter(([k]) => !answered.has(k)).map(([, m]) => m).sort((a, b) => b.sentAt - a.sentAt);
}

const messageQuery = db.prepare(`SELECT * FROM chat_messages WHERE channel = ? AND chat = ? AND id = ?`);

/** One message by its id — what a reply answers. Null once pruned, or never recorded. */
export function chatMessage(channel: ChatChannel, chat: string, id: string): StoredMessage | null {
  const r = messageQuery.get(channel, chat, id) as Raw | null;
  return r ? toStored(r) : null;
}

/** Days of chat log kept when `CHAT_LOG_RETENTION_DAYS` says nothing usable. */
const DEFAULT_RETENTION_DAYS = 14;
/** Days of his own messages kept when `CHAT_LOG_OWN_RETENTION_DAYS` says nothing usable. */
const DEFAULT_OWN_RETENTION_DAYS = 90;

function days(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  // Unlike runs, there is no "keep forever": 0 or nonsense falls back rather
  // than switching the prune off, because the promise this store makes is
  // that it forgets.
  if (!Number.isFinite(n) || n <= 0) {
    log.warn(`${name} is "${raw}", which is not a positive number of days — keeping ${fallback}`);
    return fallback;
  }
  return n;
}

function retentionDays(own: boolean): number {
  const theirs = days("CHAT_LOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
  // His own are never kept for less than theirs.
  return own ? Math.max(theirs, days("CHAT_LOG_OWN_RETENTION_DAYS", DEFAULT_OWN_RETENTION_DAYS)) : theirs;
}

/**
 * The oldest moment the log keeps: anything sent before it goes in the
 * nightly prune. `own` for his own messages, which are kept longer.
 */
export function chatLogKeepsFrom(now = Date.now(), own = false): number {
  return now - retentionDays(own) * 86_400_000;
}

/** Whether a message sent at `sentAt` is one the log keeps. */
export function chatLogKeeps(m: { sentAt: number; outgoing: boolean }, now = Date.now()): boolean {
  return m.sentAt >= chatLogKeepsFrom(now, m.outgoing);
}

/** Deletes messages older than the retention. Called by the nightly prune. */
export function pruneChatLog(): number {
  const now = Date.now();
  return prune.run(chatLogKeepsFrom(now), chatLogKeepsFrom(now, true)).changes;
}
