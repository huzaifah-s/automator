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
   * were new.
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
const prune = db.prepare(`DELETE FROM chat_messages WHERE sent_at < ?`);

/** One for the whole process: it is a store, not a per-run client. */
export const chatLog: ChatLog = {
  record(entries) {
    const now = Date.now();
    const write = db.transaction((list: ChatLogEntry[]) => {
      let added = 0;
      for (const e of list) {
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

/** Days of chat log kept when `CHAT_LOG_RETENTION_DAYS` says nothing usable. */
const DEFAULT_RETENTION_DAYS = 14;

function retentionDays(): number {
  const raw = process.env.CHAT_LOG_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  // Unlike runs, there is no "keep forever": 0 or nonsense falls back rather
  // than switching the prune off, because the promise this store makes is
  // that it forgets.
  if (!Number.isFinite(n) || n <= 0) {
    log.warn(
      `CHAT_LOG_RETENTION_DAYS is "${raw}", which is not a positive number of days — ` +
        `keeping ${DEFAULT_RETENTION_DAYS}`,
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return n;
}

/** Deletes messages older than the retention. Called by the nightly prune. */
export function pruneChatLog(): number {
  return prune.run(Date.now() - retentionDays() * 86_400_000).changes;
}
