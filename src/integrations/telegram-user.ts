import type { TelegramClient } from "@mtcute/bun";
import { withheld, type CallRecorder } from "./http.ts";
import { createLogger } from "../core/logger.ts";
import { registerSecret } from "../core/redact.ts";

/**
 * Telegram as a *user account*, over MTProto — not `ctx.telegram`, which is
 * the Bot API. A bot cannot message somebody who has not messaged it first,
 * cannot read a channel it was not added to, and cannot post as you. This can
 * do all three, because it *is* you: the session string is a logged-in device
 * on the account, as powerful as the phone it was approved from.
 *
 * Three things follow from that, and each is why something below is shaped
 * the way it is.
 *
 * **A session must only ever be live in one place.** Telegram treats the same
 * authorization on two parallel connections as stolen and revokes it
 * (`AUTH_KEY_DUPLICATED`) — the account then needs logging in again by hand.
 * Inside this process the pool guarantees one connection per session, which
 * is why the credential test borrows the pool rather than opening its own.
 * Across processes nothing can guarantee it, so the login command never
 * prints a session: log in separately on each machine (`bun run
 * telegram-login`), and never copy one.
 *
 * **Nothing connects by itself.** The connection opens on the first call and
 * closes after `IDLE_MS` without one. There is no listener and no update
 * stream (`updates: false`), so a laptop beside the deploy holds nothing open
 * and "only production fires by itself" stays true without a check here.
 * Inbound messages are a `poll()` over `history()`.
 *
 * **It is not HTTP.** MTProto is its own TCP protocol, so the practice gate on
 * `fetch` cannot see it and the run page would not either. Sends are held in
 * a practice run by the getter in `index.ts`, and every call is recorded on
 * the run page here, as `MTPROTO mtproto://telegram/<call>`.
 */

/** The three values that make a session, as a credential carries them. */
export interface TelegramUserConnection {
  /** From my.telegram.org › API development tools. Digits. */
  api_id: string;
  api_hash: string;
  /** What `bun run telegram-login` stored. Never printed, never copied. */
  session: string;
}

export interface TelegramUserCallOptions {
  /**
   * Act as an account other than the primary one:
   *
   *   const me = defineCredential("telegram_user", "personal");
   *   ctx.telegramUser.send("@someone", "hi", { credential: me });
   */
  credential?: TelegramUserConnection;
  /**
   * List the call on the run page without what came back — its size instead.
   * For reading chats into a store of their own, so the run log does not
   * keep a second copy of somebody's messages. Same as `private` on ctx.http.
   */
  private?: boolean;
}

/**
 * Who to talk to. `"@username"` or `"username"`, a `t.me/` link, `"me"` for
 * Saved Messages, a phone number with its `+` (`"+60120000000"`), or a numeric
 * chat id (`-1001234567890`).
 *
 * The `+` is required for a phone number, because without it a number and a
 * chat id are the same string. A phone only resolves if the person is in the
 * account's contacts or lets anyone find them by number. A numeric id — what
 * `chats()` and `history()` hand back — resolves for any chat the account is
 * in, on a fresh connection too: mtcute asks Telegram when its cache misses.
 */
export type TelegramPeer = string | number;

export interface TelegramUserPeer {
  id: number;
  type: "user" | "bot" | "group" | "supergroup" | "channel" | "other";
  /** A person's display name, or a group's or channel's title. */
  name: string;
  username: string | undefined;
}

export interface TelegramUserMessage {
  id: number;
  /** The chat it is in — a person for a DM, the group or channel otherwise. */
  chatId: number;
  chatName: string;
  /** ISO 8601. */
  date: string;
  /** The text, or a media message's caption. */
  text: string;
  /** Absent for a post in a channel, which is authored by the channel. */
  from: { id: number; name: string; username: string | undefined } | undefined;
  /** The id of the message this one replies to. */
  replyTo: number | undefined;
  /** Sent by this account. */
  outgoing: boolean;
  /**
   * A notice rather than something somebody wrote — "joined Telegram", a
   * pinned message, a member added. Its `text` is empty.
   */
  service: boolean;
  /** `photo`, `video`, `voice`, `document`, `sticker`, … when it carries one. */
  media: string | undefined;
}

/** One chat in the account's chat list, as `chats()` returns it. */
export interface TelegramUserChat extends TelegramUserPeer {
  /** Unread messages, as the phone counts them. */
  unread: number;
  /** How many of those @-mention this account or reply to it. */
  mentions: number;
  /** Marked unread by hand — counts as unread even with nothing new in it. */
  markedUnread: boolean;
  muted: boolean;
  pinned: boolean;
  archived: boolean;
  lastMessage: TelegramUserMessage | undefined;
}

export interface TelegramUserSent {
  id: number;
  chatId: number;
}

export interface TelegramUserSendOptions extends TelegramUserCallOptions {
  /**
   * How to read `text`. Default plain — sent exactly as written. `"html"` is
   * the Bot API's subset (`<b>`, `<i>`, `<a href>`, `<code>`), so a message
   * written for `ctx.telegram` with `parseMode: "HTML"` reads the same here.
   */
  format?: "plain" | "html" | "markdown";
  /** A message id in the same chat to reply to. */
  replyTo?: number;
  /** Deliver without a notification sound. */
  silent?: boolean;
  /** Show a preview card for the first link. Default false. */
  linkPreview?: boolean;
}

export interface TelegramUserClient {
  /** The account this session is logged in as. */
  me(opts?: TelegramUserCallOptions): Promise<TelegramUserPeer>;
  /** Looks up a username, link, phone or id. Read-only. */
  resolve(peer: TelegramPeer, opts?: TelegramUserCallOptions): Promise<TelegramUserPeer>;
  /**
   * Sends text as this account — to a person, a group, or a channel it can
   * post in. In a channel it posts as the channel.
   */
  send(peer: TelegramPeer, text: string, opts?: TelegramUserSendOptions): Promise<TelegramUserSent>;
  /**
   * Sends a photo, video or file from a public URL. Telegram fetches the URL
   * itself, so it has to be reachable from Telegram, not just from here.
   */
  sendMedia(
    peer: TelegramPeer,
    media: { url: string; type?: "photo" | "video" | "document"; caption?: string },
    opts?: Omit<TelegramUserSendOptions, "linkPreview">,
  ): Promise<TelegramUserSent>;
  /**
   * Recent messages in a chat, **oldest first**. `after` returns only
   * messages newer than that id — the cursor for reading a channel
   * incrementally. Without it, the latest `limit`.
   *
   *   trigger: poll("*\/5 * * * *", {
   *     fetch: (ctx) => ctx.telegramUser.history("somechannel", { limit: 50 }),
   *     id: (m) => `${m.chatId}:${m.id}`,
   *   })
   */
  history(
    peer: TelegramPeer,
    opts?: TelegramUserCallOptions & { limit?: number; after?: number },
  ): Promise<TelegramUserMessage[]>;
  /**
   * The chat list, as the phone orders it — pinned first, then newest
   * activity — each with its unread count and newest message. Reading it
   * marks nothing as read. `id` is what `history()` and `send()` take.
   *
   *   const waiting = await ctx.telegramUser.chats({ unread: true });
   *
   * `limit` (default 30, at most 200) is how many come back. With `unread`
   * only chats with something unread count towards it, and the search stops
   * after the newest 500 chats. Archived chats are left out unless `archived`
   * is set, the same as the main list.
   */
  chats(
    opts?: TelegramUserCallOptions & { limit?: number; unread?: boolean; archived?: boolean },
  ): Promise<TelegramUserChat[]>;
}

/** How long a connection is kept after its last call. */
const IDLE_MS = Number(process.env.TELEGRAM_USER_IDLE_MS ?? 5 * 60_000);
/** Ceiling on opening a connection, separate from the call's own. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Telegram's own ceiling on one page of history. */
const MAX_HISTORY = 100;
/** Most chats `chats()` returns. */
const MAX_CHATS = 200;
/** How far down the chat list an unread search goes. Five pages of Telegram's 100. */
const SCAN_CHATS = 500;

const mtLog = createLogger("telegram-user");

export function createTelegramUser(signal: AbortSignal, record?: CallRecorder): TelegramUserClient {
  /**
   * One call, on the pool, recorded on the run page. The request and response
   * go through `capture()` in the recorder, which redacts; the session never
   * appears in either, but a phone number passed as a peer does, which is the
   * same as a WhatsApp number in a captured URL.
   */
  const call = async <T>(
    name: string,
    conn: TelegramUserConnection,
    request: unknown,
    fn: (client: TelegramClient) => Promise<T>,
    opts: TelegramUserCallOptions = {},
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      const result = await abortable(withClient(conn, fn), signal);
      record?.({
        method: "MTPROTO",
        url: `mtproto://telegram/${name}`,
        status: 200,
        durationMs: Date.now() - startedAt,
        request,
        response: opts.private ? withheld(result) : result,
      });
      return result;
    } catch (err) {
      record?.({
        method: "MTPROTO",
        url: `mtproto://telegram/${name}`,
        status: null,
        durationMs: Date.now() - startedAt,
        request,
        response: { error: err instanceof Error ? err.message : String(err) },
      });
      throw explain(err);
    }
  };

  return {
    me(opts = {}) {
      return call("getMe", connection(opts.credential), {}, async (c) => toPeer(await c.getMe()));
    },

    resolve(peer, opts = {}) {
      return call("resolve", connection(opts.credential), { peer }, async (c) =>
        toPeer(await c.getPeer(await target(c, peer))),
      );
    },

    send(peer, text, opts = {}) {
      return call(
        "sendText",
        connection(opts.credential),
        { peer, text, format: opts.format ?? "plain" },
        async (c) => {
          const m = await c.sendText(await target(c, peer), await formatted(text, opts.format), {
            replyTo: opts.replyTo,
            silent: opts.silent,
            disableWebPreview: !(opts.linkPreview ?? false),
          });
          return { id: m.id, chatId: m.chat.id };
        },
      );
    },

    sendMedia(peer, media, opts = {}) {
      return call(
        "sendMedia",
        connection(opts.credential),
        { peer, ...media },
        async (c) => {
          const { InputMedia } = await import("@mtcute/bun");
          // A string, not a URL object: mtcute hands a string URL to Telegram
          // to fetch, and *downloads* a URL object itself first.
          const caption = media.caption ? await formatted(media.caption, opts.format) : undefined;
          const input =
            media.type === "video"
              ? InputMedia.video(media.url, { caption })
              : media.type === "document"
                ? InputMedia.document(media.url, { caption })
                : InputMedia.photo(media.url, { caption });
          const m = await c.sendMedia(await target(c, peer), input, {
            replyTo: opts.replyTo,
            silent: opts.silent,
          });
          return { id: m.id, chatId: m.chat.id };
        },
      );
    },

    history(peer, opts = {}) {
      const limit = Math.min(Math.max(1, opts.limit ?? 50), MAX_HISTORY);
      return call(
        "getHistory",
        connection(opts.credential),
        { peer, limit, after: opts.after },
        async (c) => {
          const chat = await target(c, peer);
          // `reverse` pages forward from the offset, oldest first, which is
          // the only way to ask for "after X" without fetching everything
          // newer than now and throwing most of it away.
          const page =
            opts.after !== undefined
              ? await c.getHistory(chat, {
                  limit,
                  reverse: true,
                  offset: { id: opts.after + 1, date: 0 },
                })
              : [...(await c.getHistory(chat, { limit }))].reverse();
          return [...page].filter((m) => opts.after === undefined || m.id > opts.after).map(toMessage);
        },
        opts,
      );
    },

    chats(opts = {}) {
      const limit = Math.min(Math.max(1, opts.limit ?? 30), MAX_CHATS);
      return call(
        "getDialogs",
        connection(opts.credential),
        { limit, unread: opts.unread ?? false, archived: opts.archived ?? false },
        async (c) => {
          const found: TelegramUserChat[] = [];
          let scanned = 0;
          for await (const d of c.iterDialogs({
            archived: opts.archived ? "keep" : "exclude",
            limit: opts.unread ? SCAN_CHATS : limit,
          })) {
            scanned++;
            if (!opts.unread || d.isUnread) found.push(toChat(d));
            if (found.length >= limit || scanned >= SCAN_CHATS) break;
          }
          return found;
        },
        opts,
      );
    },
  };
}

/* ------------------------------------------------------------------ pool */

interface Pooled {
  client: Promise<TelegramClient>;
  busy: number;
  idle?: ReturnType<typeof setTimeout>;
}

/**
 * One connection per session in this process, keyed by a digest so the map
 * itself never holds a session string. Two connections on one session is the
 * thing Telegram revokes sessions for, so every path that talks to Telegram
 * with a stored session — runs, polls, the dashboard's test — goes through
 * here. The login command is the exception, because it is creating a session
 * rather than using one.
 */
const pool = new Map<string, Pooled>();

function poolKey(conn: TelegramUserConnection): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${conn.api_id}\0${conn.api_hash}\0${conn.session}`)
    .digest("hex");
}

/** Runs `fn` on this session's connection, opening it if need be. */
export async function withClient<T>(
  conn: TelegramUserConnection,
  fn: (client: TelegramClient) => Promise<T>,
): Promise<T> {
  const key = poolKey(conn);
  let entry = pool.get(key);
  if (!entry) {
    entry = { client: open(conn), busy: 0 };
    pool.set(key, entry);
    // A connection that failed to open is forgotten, so the next call tries
    // again rather than inheriting the rejection forever.
    entry.client.catch(() => pool.get(key) === entry && pool.delete(key));
  }

  const held = entry;
  if (held.idle) clearTimeout(held.idle);
  held.busy++;
  try {
    return await fn(await held.client);
  } catch (err) {
    // A session Telegram has revoked or logged out will fail every call from
    // now on. Dropping the connection means a re-login on the dashboard (a
    // new session, so a new key) is picked up without a restart.
    if (/AUTH_KEY_|SESSION_REVOKED|USER_DEACTIVATED/.test(String((err as Error)?.message))) {
      pool.delete(key);
      void held.client.then((c) => c.destroy()).catch(() => {});
    }
    throw err;
  } finally {
    held.busy--;
    if (held.busy === 0 && pool.get(key) === held) {
      held.idle = setTimeout(() => {
        if (held.busy > 0 || pool.get(key) !== held) return;
        pool.delete(key);
        void held.client.then((c) => c.destroy()).catch(() => {});
      }, IDLE_MS);
      // An idle connection must not be what keeps `bun run trigger` alive.
      held.idle.unref?.();
    }
  }
}

async function open(conn: TelegramUserConnection): Promise<TelegramClient> {
  const { TelegramClient, MemoryStorage } = await import("@mtcute/bun");
  const client = new TelegramClient({
    apiId: Number(conn.api_id),
    apiHash: conn.api_hash,
    // Not the default, which is a `client.session` SQLite file in the working
    // directory: the encrypted store is where the session lives, and a second
    // plaintext copy on disk is exactly what that store exists to prevent.
    storage: new MemoryStorage(),
    // No update stream. Nothing here listens, and an update loop on a
    // connection that exists for one send is churn with nowhere to go.
    updates: false,
    logLevel: 1, // errors only
  });
  // mtcute logs to the console directly; through ours it is redacted.
  client.log.mgr.handler = (_color, _level, tag, fmt, args) =>
    mtLog.warn(`${tag}: ${fmt}`, args.length ? { args: args.map(String) } : undefined);

  // The session is a credential however it arrived — a primary credential's
  // mirrored env var is registered at boot, but one passed as `credential`
  // from a workflow is only registered when its proxy is read, and this is
  // the moment that is guaranteed to have happened.
  registerSecret(conn.session);
  registerSecret(conn.api_hash);

  try {
    // `force`: MemoryStorage is fresh, but importSession is a silent no-op
    // over an existing key, and silently using a different account is not a
    // failure worth leaving possible.
    await client.importSession(conn.session, true);
    await abortable(client.connect(), AbortSignal.timeout(CONNECT_TIMEOUT_MS));
    return client;
  } catch (err) {
    await client.destroy().catch(() => {});
    throw err;
  }
}

/** Closes every connection. Called on shutdown, beside closeSql(). */
export async function closeTelegramUsers(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.allSettled(
    entries.map(async (e) => {
      if (e.idle) clearTimeout(e.idle);
      await (await e.client).destroy();
    }),
  );
}

/* --------------------------------------------------------------- helpers */

function connection(override?: TelegramUserConnection): TelegramUserConnection {
  if (override) return override;
  const api_id = process.env.TELEGRAM_API_ID;
  const api_hash = process.env.TELEGRAM_API_HASH;
  const session = process.env.TELEGRAM_SESSION;
  if (!api_id) throw new Error("TELEGRAM_API_ID is not set");
  if (!api_hash) throw new Error("TELEGRAM_API_HASH is not set");
  if (!session) {
    throw new Error("TELEGRAM_SESSION is not set — log in with `bun run telegram-login -- <name> --primary`");
  }
  return { api_id, api_hash, session };
}

/** A peer as mtcute takes one. See TelegramPeer for the rules. */
async function target(client: TelegramClient, peer: TelegramPeer) {
  if (typeof peer === "number") return peer;
  const s = peer.trim();
  if (s.startsWith("+")) return client.resolvePhoneNumber(s.replace(/[^\d+]/g, ""));
  if (/^-?\d+$/.test(s)) return Number(s);
  const link = s.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]+)/);
  if (link) return link[1]!;
  if (s === "") throw new Error("An empty string is not a Telegram chat");
  return s.replace(/^@/, "");
}

async function formatted(text: string, format: TelegramUserSendOptions["format"]) {
  if (!format || format === "plain") return text;
  const { html, md } = await import("@mtcute/bun");
  return format === "html" ? html(text) : md(text);
}

type MtPeer = Awaited<ReturnType<TelegramClient["getPeer"]>>;

function toPeer(p: MtPeer): TelegramUserPeer {
  if (p.type === "user") {
    return { id: p.id, type: p.isBot ? "bot" : "user", name: p.displayName, username: p.username ?? undefined };
  }
  const kind = p.chatType;
  return {
    id: p.id,
    type: kind === "group" || kind === "supergroup" || kind === "channel" ? kind : kind === "gigagroup" ? "supergroup" : "other",
    name: p.displayName,
    username: p.username ?? undefined,
  };
}

type MtMessage = Awaited<ReturnType<TelegramClient["getHistory"]>>[number];

/** Plain data, so it checkpoints, hashes for a poll, and shows on the run page. */
function toMessage(m: MtMessage): TelegramUserMessage {
  const sender = m.sender;
  const isChannelPost = sender.type === "chat" && sender.id === m.chat.id;
  return {
    id: m.id,
    chatId: m.chat.id,
    chatName: m.chat.displayName,
    date: m.date.toISOString(),
    text: m.text,
    from: isChannelPost
      ? undefined
      : { id: sender.id, name: sender.displayName, username: sender.username ?? undefined },
    replyTo: m.replyToMessage?.id ?? undefined,
    outgoing: m.isOutgoing,
    service: m.isService,
    media: m.media?.type ?? undefined,
  };
}

type MtDialog = import("@mtcute/bun").Dialog;

function toChat(d: MtDialog): TelegramUserChat {
  return {
    ...toPeer(d.peer),
    unread: d.unreadCount,
    mentions: d.unreadMentionsCount,
    markedUnread: d.isManuallyUnread,
    // null is "whatever the account's default is", which is not muted.
    muted: d.isMuted === true,
    pinned: d.isPinned,
    archived: d.isArchived,
    lastMessage: d.lastMessage ? toMessage(d.lastMessage) : undefined,
  };
}

/**
 * The runner can stop *waiting* on a call when the run is cancelled, but not
 * cancel it: a send already on the wire may still arrive.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Telegram's error codes, with the one thing worth knowing about the common ones. */
function explain(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/AUTH_KEY_DUPLICATED/.test(message)) {
    return new Error(
      `${message} — this session was used from two places at once and Telegram revoked it. ` +
        "Log in again with `bun run telegram-login`, and use a separate login on each machine.",
    );
  }
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED/.test(message)) {
    return new Error(`${message} — the session was logged out. Log in again with \`bun run telegram-login\`.`);
  }
  if (/PEER_FLOOD/.test(message)) {
    return new Error(
      `${message} — Telegram has limited this account for messaging people who are not contacts. ` +
        "Sending more makes it worse; @SpamBot says when it lifts.",
    );
  }
  const flood = message.match(/FLOOD_WAIT_(\d+)/);
  if (flood) return new Error(`${message} — Telegram asked for a ${flood[1]}s pause before the next call`);
  return err instanceof Error ? err : new Error(message);
}
