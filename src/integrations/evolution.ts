import { z } from "zod";
import type { HttpClient } from "./http.ts";
import type { WebhookRegistration, WebhookVerifier } from "../core/types.ts";
import { timingSafeEqual } from "../core/verify.ts";

/**
 * Evolution API v2 — the open-source, self-hosted WhatsApp gateway
 * (github.com/EvolutionAPI/evolution-api).
 *
 * Not the same thing as `ctx.whatsapp`, and not a drop-in for it. That one is
 * Meta's Cloud API: an official business number, approved templates, and a
 * 24-hour window outside which free text is refused. This one drives an
 * ordinary WhatsApp account linked by QR code, so there are no templates and
 * no window — and no Meta either, which is the trade: an account WhatsApp
 * decides is a bot can be banned, and nothing here can appeal that.
 *
 * One Evolution server hosts many *instances*, each a linked phone. A
 * credential is the server's URL, a key, and which instance to speak as.
 */

/** The three values that make a connection, as a credential carries them. */
export interface EvolutionConnection {
  /** The server's base URL: `https://evo.example.com`. */
  url: string;
  /** The global API key, or the instance's own token. Sent as `apikey`. */
  api_key: string;
  /** The instance name, as created in Evolution's manager. */
  instance: string;
}

export interface EvolutionCallOptions {
  /**
   * Speak through a credential other than the primary one:
   *
   *   const shop = defineCredential("evolution", "shop");
   *   ctx.evolution.text(to, body, { credential: shop });
   */
  credential?: EvolutionConnection;
}

/** What Evolution gives back for one accepted message. */
export interface EvolutionSent {
  /** WhatsApp's message id — what an inbound reply quotes in `contextInfo.stanzaId`. */
  id: string;
  /** Who it went to, as a JID: `60120000000@s.whatsapp.net`, or `…@g.us` for a group. */
  remoteJid: string;
}

export interface EvolutionMedia {
  /** A public URL Evolution can fetch, or the file as base64. */
  media: string;
  type: "image" | "video" | "document" | "audio";
  caption?: string;
  /** Shown as the file's name for a document. */
  fileName?: string;
  /** `application/pdf`, `image/png`. Evolution guesses from the URL when absent. */
  mimetype?: string;
}

/** One chat, as `chats()` lists it. */
export interface EvolutionChat {
  /** The JID — what `messages()` and a reply take. `…@g.us` for a group. */
  chat: string;
  /** The contact's or group's name, when Evolution has one. */
  name: string | undefined;
  isGroup: boolean;
  /**
   * Evolution's own count of unread messages — and in practice it stays
   * 0 however much is waiting. "Their message is the newest" is the signal
   * that holds up: `lastMessage` with `outgoing` false.
   */
  unread: number;
  /** ISO 8601 — when the newest message arrived. */
  updatedAt: string | undefined;
  lastMessage: EvolutionMessage | undefined;
}

export interface EvolutionClient {
  /**
   * Sends plain text. `to` is a phone number in international format (any
   * punctuation is stripped) or a full JID — a group is `1203…@g.us`.
   */
  text(
    to: string,
    body: string,
    opts?: EvolutionCallOptions & {
      /** Milliseconds of "typing…" before it sends. */
      delay?: number;
      /** Render a preview card for the first link. Default false. */
      linkPreview?: boolean;
      /** Numbers to @-mention in a group; they must also appear in the text. */
      mentions?: string[];
    },
  ): Promise<EvolutionSent>;
  /** Sends an image, video, document or voice note. */
  media(to: string, media: EvolutionMedia, opts?: EvolutionCallOptions): Promise<EvolutionSent>;
  /**
   * Which of these numbers have WhatsApp. Read-only; worth calling before a
   * first message to a number that came out of a form, because a send to a
   * number without WhatsApp is accepted by Evolution and then goes nowhere.
   */
  exists(
    numbers: string[],
    opts?: EvolutionCallOptions,
  ): Promise<{ number: string; exists: boolean; jid?: string }[]>;
  /** `open` when the linked phone is connected; `close` or `connecting` otherwise. */
  state(opts?: EvolutionCallOptions): Promise<"open" | "close" | "connecting" | string>;
  /**
   * Chats, most recently active first, each with its newest message. Read-only,
   * and nothing is marked as read. `since` keeps only chats with a message
   * after it.
   *
   * Evolution can only answer from its own database, so this is empty unless
   * the server runs with `DATABASE_SAVE_DATA_NEW_MESSAGE=true` — and holds only
   * what arrived after the phone was linked, plus whatever history sync
   * brought in if `DATABASE_SAVE_DATA_HISTORIC` was on at the time.
   */
  chats(opts?: EvolutionCallOptions & { limit?: number; since?: Date }): Promise<EvolutionChat[]>;
  /**
   * Messages in one chat, **oldest first**, both directions — `outgoing`
   * says which. `chat` is a JID from `chats()` or a phone number. Without
   * `since`, the latest `limit` (default 50, at most 100). Read-only, from
   * the same database as `chats()`.
   */
  messages(
    chat: string,
    opts?: EvolutionCallOptions & { limit?: number; since?: Date },
  ): Promise<EvolutionMessage[]>;
  /**
   * Points the instance's webhook at `url`. An instance has exactly one, so
   * this replaces whatever was there. `headers` are sent on every delivery,
   * which is how a delivery proves where it came from — Evolution signs
   * nothing. See `evolutionRegistration`, which is what a workflow should use.
   */
  setWebhook(
    url: string,
    opts?: EvolutionCallOptions & { events?: EvolutionEventName[]; headers?: Record<string, string> },
  ): Promise<void>;
  /**
   * Switches the instance's webhook off. Evolution refuses a `webhook/set`
   * without a URL even to disable one, so pass the one that was registered.
   */
  clearWebhook(url: string, opts?: EvolutionCallOptions): Promise<void>;
}

export function createEvolution(http: HttpClient): EvolutionClient {
  const connection = (override?: EvolutionConnection): EvolutionConnection => {
    if (override) return override;
    const url = process.env.EVOLUTION_URL;
    const api_key = process.env.EVOLUTION_API_KEY;
    const instance = process.env.EVOLUTION_INSTANCE;
    if (!url) throw new Error("EVOLUTION_URL is not set");
    if (!api_key) throw new Error("EVOLUTION_API_KEY is not set");
    if (!instance) throw new Error("EVOLUTION_INSTANCE is not set");
    return { url, api_key, instance };
  };

  const endpoint = (c: EvolutionConnection, path: string) =>
    `${c.url.replace(/\/+$/, "")}/${path}/${encodeURIComponent(c.instance)}`;

  const headers = (c: EvolutionConnection) => ({ apikey: c.api_key });

  /**
   * No retries on a send. ctx.http retries a 5xx or a dropped connection, and
   * for a message both of those can mean "delivered, then the reply was lost"
   * — so a retry here is a customer receiving the same message twice. A
   * failed step is retried by the run, where it is visible.
   */
  const send = async (c: EvolutionConnection, path: string, body: Record<string, unknown>) => {
    const res = await http.post<{ key?: { id?: string; remoteJid?: string } }>(
      endpoint(c, path),
      body,
      { headers: headers(c), retries: 0 },
    );
    const id = res?.key?.id;
    // A caller that stores this to match a later reply must not be handed an
    // empty string and left to find out downstream.
    if (!id) throw new Error("Evolution accepted the request but returned no message id");
    return { id, remoteJid: res.key?.remoteJid ?? "" };
  };

  return {
    text(to, body, opts = {}) {
      const c = connection(opts.credential);
      return send(c, "message/sendText", {
        number: recipient(to),
        text: body,
        ...(opts.delay !== undefined ? { delay: opts.delay } : {}),
        linkPreview: opts.linkPreview ?? false,
        ...(opts.mentions?.length ? { mentioned: opts.mentions.map(recipient) } : {}),
      });
    },

    media(to, media, opts = {}) {
      const c = connection(opts.credential);
      return send(c, "message/sendMedia", {
        number: recipient(to),
        mediatype: media.type,
        media: media.media,
        ...(media.mimetype ? { mimetype: media.mimetype } : {}),
        ...(media.caption ? { caption: media.caption } : {}),
        ...(media.fileName ? { fileName: media.fileName } : {}),
      });
    },

    async exists(numbers, opts = {}) {
      const c = connection(opts.credential);
      const res = await http.post<{ number?: string; exists?: boolean; jid?: string }[]>(
        endpoint(c, "chat/whatsappNumbers"),
        { numbers: numbers.map(recipient) },
        { headers: headers(c) },
      );
      return (Array.isArray(res) ? res : []).map((r) => ({
        number: String(r.number ?? ""),
        exists: r.exists === true,
        ...(r.jid ? { jid: r.jid } : {}),
      }));
    },

    async state(opts = {}) {
      const c = connection(opts.credential);
      const res = await http.get<{ instance?: { state?: string } }>(
        endpoint(c, "instance/connectionState"),
        { headers: headers(c) },
      );
      return res?.instance?.state ?? "unknown";
    },

    // findChats and findMessages are POSTs that change nothing, so they keep
    // ctx.http's retries — and `classify` in practice.ts lets them through.
    async chats(opts = {}) {
      const c = connection(opts.credential);
      const limit = Math.min(Math.max(1, opts.limit ?? 50), MAX_PAGE);
      const res = await http.post<Record<string, unknown>[]>(
        endpoint(c, "chat/findChats"),
        {
          ...(opts.since ? { where: { messageTimestamp: sinceFilter(opts.since) } } : {}),
          take: limit,
        },
        { headers: headers(c) },
      );
      return (Array.isArray(res) ? res : []).flatMap((r): EvolutionChat[] => {
        const chat = typeof r.remoteJid === "string" ? r.remoteJid : undefined;
        if (!chat || chat === "status@broadcast") return [];
        const updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : undefined;
        const lastMessage = r.lastMessage ? toMessage(r.lastMessage, true) : undefined;
        // findChats selects `pushName` twice and the second, the chat's own
        // name, wins — set for a group, empty for a person. Their name on
        // their last message is the next best thing.
        const named = typeof r.pushName === "string" && r.pushName ? r.pushName : undefined;
        return [
          {
            chat,
            name: named ?? (lastMessage?.isGroup ? undefined : lastMessage?.name),
            isGroup: chat.endsWith("@g.us"),
            unread: Number(r.unreadCount) || 0,
            updatedAt,
            lastMessage,
          },
        ];
      });
    },

    async messages(chat, opts = {}) {
      const c = connection(opts.credential);
      const limit = Math.min(Math.max(1, opts.limit ?? 50), MAX_PAGE);
      const res = await http.post<{ messages?: { records?: unknown[] } }>(
        endpoint(c, "chat/findMessages"),
        {
          where: {
            key: { remoteJid: jid(chat) },
            ...(opts.since ? { messageTimestamp: sinceFilter(opts.since) } : {}),
          },
          // Evolution's names: `offset` is the page size, `page` is 1-based.
          offset: limit,
          page: 1,
        },
        { headers: headers(c) },
      );
      const records = res?.messages?.records ?? [];
      // Newest first from Evolution; oldest first here, like Telegram's history.
      return records.flatMap((r) => toMessage(r, true) ?? []).reverse();
    },

    async setWebhook(url, opts = {}) {
      const c = connection(opts.credential);
      await http.post(
        endpoint(c, "webhook/set"),
        {
          webhook: {
            enabled: true,
            url,
            headers: opts.headers ?? {},
            // One URL for every event, not `/messages-upsert` appended per
            // event — the workflow's route is one path.
            byEvents: false,
            // Media as a URL to fetch, not inlined: a voice note as base64 is
            // a megabyte in the inbox table and on the run page.
            base64: false,
            events: opts.events ?? ["MESSAGES_UPSERT"],
          },
        },
        { headers: headers(c) },
      );
    },

    async clearWebhook(url, opts = {}) {
      const c = connection(opts.credential);
      await http.post(
        endpoint(c, "webhook/set"),
        { webhook: { enabled: false, url, headers: {}, events: ["MESSAGES_UPSERT"] } },
        { headers: headers(c) },
      );
    },
  };
}

/**
 * A phone number becomes digits; a JID passes through untouched, because a
 * group id (`1203…@g.us`) and a linked-device id (`…@lid`) are not numbers and
 * stripping them would address someone else.
 */
function recipient(to: string): string {
  if (to.includes("@")) return to.trim();
  const digits = to.replace(/[^\d]/g, "");
  if (!digits) throw new Error(`"${to}" is not a usable WhatsApp number`);
  return digits;
}

/**
 * The full JID Evolution stores a chat under. A send takes bare digits, but
 * the message table is keyed by `…@s.whatsapp.net` and matches it exactly.
 */
function jid(chat: string): string {
  const to = recipient(chat);
  return to.includes("@") ? to : `${to}@s.whatsapp.net`;
}

/** Evolution's largest sensible page; it has no ceiling of its own. */
const MAX_PAGE = 100;

/**
 * A time filter as Evolution takes one. It ignores the filter unless both
 * ends are given, so "since" needs an explicit "until now".
 */
function sinceFilter(since: Date) {
  return { gte: since.toISOString(), lte: new Date().toISOString() };
}

/* ---------------------------------------------------------------- webhooks */

/** Evolution's names for what its webhook can report, as `setWebhook` takes them. */
export type EvolutionEventName =
  | "MESSAGES_UPSERT"
  | "MESSAGES_UPDATE"
  | "MESSAGES_DELETE"
  | "SEND_MESSAGE"
  | "CONNECTION_UPDATE"
  | "QRCODE_UPDATED"
  | "CONTACTS_UPSERT"
  | "CHATS_UPSERT"
  | "GROUPS_UPSERT"
  | "GROUP_PARTICIPANTS_UPDATE"
  | "PRESENCE_UPDATE"
  | "CALL";

/**
 * The header a registered webhook carries, and the one `evolutionSecret`
 * checks. Not `x-automator-secret`: that header is the global WEBHOOK_SECRET's,
 * and this one is per workflow, so the copy kept in Evolution's database can
 * open one route and not every route.
 */
const SECRET_HEADER = "x-evolution-secret";

/**
 * Keeps an Evolution instance's webhook pointed at this workflow. Use it as a
 * webhook trigger's `register`, beside `evolutionSecret` as its `verify`:
 *
 *   const evo = defineCredential("evolution", "shop");
 *   const secrets = defineSecrets({ EVOLUTION_WEBHOOK_SECRET: z.string().min(16) });
 *
 *   trigger: webhook("shop/whatsapp", {
 *     schema: evolutionEvent,
 *     verify: evolutionSecret(() => secrets.EVOLUTION_WEBHOOK_SECRET),
 *     register: evolutionRegistration({
 *       credential: evo,
 *       secret: () => secrets.EVOLUTION_WEBHOOK_SECRET,
 *     }),
 *   })
 *
 * An instance has one webhook and no subscription ids, which is Telegram's
 * shape: setting it replaces the last one, so the URL itself is what is kept
 * in state and what the reconciler compares. That is also the warning — two
 * workflows registering the same instance take turns overwriting each other
 * on every boot. One instance, one receiving workflow.
 */
export function evolutionRegistration(opts: {
  /** Omit to use the primary Evolution credential. */
  credential?: EvolutionConnection;
  /** A getter, so a rotated secret reaches the next registration. */
  secret: () => string | undefined;
  /** Default `MESSAGES_UPSERT` — new messages, sent and received. */
  events?: EvolutionEventName[];
}): WebhookRegistration {
  return {
    async create(ctx) {
      const secret = opts.secret()?.trim();
      // Registering without one would point Evolution at a route that refuses
      // every delivery — a subscription that looks healthy and delivers nothing.
      if (!secret) throw new Error("Evolution webhook secret is not set — not registering");
      await ctx.evolution.setWebhook(ctx.url, {
        credential: opts.credential,
        events: opts.events,
        headers: { [SECRET_HEADER]: secret },
      });
      return ctx.url;
    },
    async remove(ctx, url) {
      await ctx.evolution.clearWebhook(url, { credential: opts.credential });
    },
  };
}

/**
 * Checks the header `evolutionRegistration` asked Evolution to send. A bearer
 * token in a header, not a signature — Evolution signs nothing — so this is a
 * constant-time equality and no more, the same as Telegram's secret token.
 */
export function evolutionSecret(secret: string | (() => string | undefined)): WebhookVerifier {
  const resolve = typeof secret === "function" ? secret : () => secret;
  return async ({ headers }) => {
    const key = resolve()?.trim();
    // Thrown rather than false: "not set" and "wrong" are the same 401 to
    // Evolution and different problems to whoever reads the rejections.
    if (!key) throw new Error("Evolution webhook secret is not set — cannot check a delivery");
    const provided = headers.get(SECRET_HEADER);
    if (!provided) return false;
    return timingSafeEqual(provided, key);
  };
}

/**
 * One message as Evolution stores it — the `data` of a `messages.upsert`
 * delivery, and a record from `findMessages` or a chat's `lastMessage`, which
 * are the same row read back.
 */
const messageData = z
  .object({
    key: z
      .object({
        remoteJid: z.string().optional(),
        fromMe: z.boolean().optional(),
        id: z.string().optional(),
        /** The member who wrote it, in a group. */
        participant: z.string().optional(),
        /**
         * The other half of a privacy `@lid` pair. Evolution swaps the two
         * when it can, so `remoteJid` is the phone-number JID and this is
         * the `@lid`; when it cannot, `remoteJid` is the `@lid`.
         */
        remoteJidAlt: z.string().optional(),
        /** In a group, the author's phone-number JID when `participant` is a `@lid`. */
        participantAlt: z.string().optional(),
      })
      .passthrough()
      .optional(),
    pushName: z.string().nullish(),
    messageType: z.string().optional(),
    messageTimestamp: z.union([z.number(), z.string()]).optional(),
    message: z.record(z.string(), z.unknown()).nullish(),
    /** A stored record keeps a reply's context here, beside the message. */
    contextInfo: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

/**
 * One delivery, narrowed to what a workflow reads. Loose everywhere and
 * `passthrough` at the top, because a schema that rejects answers 422 and the
 * same instance sends connection updates, receipts and our own outgoing
 * messages down the same URL — all of which must be accepted and ignored,
 * not refused. (A 422 is at least one Evolution does not retry; a 5xx it
 * retries ten times.)
 *
 * **It drops `apikey` from every delivery.** Evolution puts the instance's
 * token in the body when its `AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES` is on,
 * and that token is not necessarily one the redactor knows — a credential
 * holding the *global* key never registers the instance's. The inbox, the run
 * page and a replay all store what the schema returns, not the raw body, so
 * removing it here is what keeps it off disk.
 */
export const evolutionEvent = z
  .object({
    /** `messages.upsert`, lower-case and dotted — not the name `setWebhook` takes. */
    event: z.string(),
    instance: z.string().optional(),
    data: messageData.optional(),
  })
  .passthrough()
  .transform(({ apikey: _dropped, ...rest }) => rest);

export type EvolutionEvent = z.output<typeof evolutionEvent>;

/** A message, as a workflow wants to read one. */
export interface EvolutionMessage {
  id: string;
  /** Where to send a reply: the person, or the group it was said in. */
  chat: string;
  /**
   * The person's number, digits only, when WhatsApp disclosed it. Undefined
   * for a message this account sent.
   */
  from: string | undefined;
  /** Their WhatsApp display name. Chosen by them, so not an identity. */
  name: string | undefined;
  isGroup: boolean;
  /** The text, or a media message's caption. Empty for a sticker or a voice note. */
  text: string;
  /** `conversation`, `imageMessage`, `audioMessage`, … */
  type: string;
  /** The id of the message this one replies to, when it is a reply. */
  replyTo: string | undefined;
  /** Seconds since the epoch, as WhatsApp stamped it. */
  timestamp: number | undefined;
  /** Sent by this account. Always false from `evolutionMessage`, which skips those. */
  outgoing: boolean;
}

/**
 * The message in a `messages.upsert` delivery, or `undefined` for anything
 * else — a receipt, a connection change, or a message *this* account sent,
 * which arrives down the same webhook and would otherwise have a bot answering
 * itself forever.
 *
 *   filter: (e) => (evolutionMessage(e) ? true : "not an inbound message"),
 */
export function evolutionMessage(event: unknown): EvolutionMessage | undefined {
  const parsed = evolutionEvent.safeParse(event);
  if (!parsed.success) return undefined;
  const e = parsed.data;
  if (e.event.toLowerCase().replace(/_/g, ".") !== "messages.upsert") return undefined;
  return toMessage(e.data, false);
}

/**
 * One stored or delivered message, or `undefined` for one that is not a chat
 * message at all. `own` decides whether this account's messages count: a
 * webhook must skip them, a history wants both sides of the conversation.
 */
function toMessage(data: unknown, own: boolean): EvolutionMessage | undefined {
  const parsed = messageData.safeParse(data);
  if (!parsed.success) return undefined;
  const d = parsed.data;

  const key = d.key;
  if (!key?.id || !key.remoteJid) return undefined;
  if (key.remoteJid === "status@broadcast") return undefined;
  const outgoing = key.fromMe === true;
  if (outgoing && !own) return undefined;

  const isGroup = key.remoteJid.endsWith("@g.us");
  // A group's remoteJid is the group and the person is `participant`, which
  // can itself be a `@lid` with the number in `participantAlt` — Evolution does
  // not swap those. Outside a group it already has: remoteJid is the number
  // whenever WhatsApp disclosed one, and a `@lid` only when it did not.
  const pick = (...jids: (string | undefined)[]) =>
    jids.find((j) => j?.endsWith("@s.whatsapp.net"));
  // Our own message in a DM is keyed by the *other* person's JID, so picking
  // from it would name them as the author.
  const person = outgoing
    ? undefined
    : isGroup
      ? pick(key.participant, key.participantAlt)
      : pick(key.remoteJid, key.remoteJidAlt);

  const message = (d.message ?? {}) as Record<string, any>;
  const type = d.messageType ?? Object.keys(message)[0] ?? "unknown";
  const inner = message[type] as Record<string, any> | undefined;
  // Evolution folds an `extendedTextMessage` into `conversation` before it
  // sends, so the second line is for an older server, not a second shape.
  const text =
    (typeof message.conversation === "string" ? message.conversation : undefined) ??
    message.extendedTextMessage?.text ??
    inner?.caption ??
    inner?.text ??
    "";
  const replyTo =
    inner?.contextInfo?.stanzaId ??
    message.extendedTextMessage?.contextInfo?.stanzaId ??
    d.contextInfo?.stanzaId;
  const ts = Number(d.messageTimestamp);

  return {
    id: key.id,
    chat: key.remoteJid,
    from: person?.split("@")[0],
    // A stored message of ours carries our own name, or Evolution's "Você".
    name: outgoing ? undefined : (d.pushName ?? undefined),
    isGroup,
    text: String(text),
    type,
    replyTo: typeof replyTo === "string" ? replyTo : undefined,
    timestamp: Number.isFinite(ts) && ts > 0 ? ts : undefined,
    outgoing,
  };
}
