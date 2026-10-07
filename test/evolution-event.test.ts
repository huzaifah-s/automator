/**
 * Evolution API deliveries, through the shared schema and reader every
 * Evolution workflow uses.
 *
 * The per-workflow samples in webhook-fixtures.test.ts cover a schema a
 * workflow wrote for itself. This one is written once in
 * src/integrations/evolution.ts and reused, so its shapes are pinned here
 * instead — the structures come from Evolution's source (2.3.7), the values
 * are made up. See AGENTS.md "Webhook samples".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "automator-test-")), "test.db");
const { createEvolution, evolutionEvent, evolutionMessage } = await import("../src/integrations/evolution.ts");
type HttpClient = import("../src/integrations/http.ts").HttpClient;

const envelope = (data: unknown, event = "messages.upsert") => ({
  event,
  instance: "contoh",
  data,
  destination: "https://automator.example.com/hooks/contoh/whatsapp",
  date_time: "2026-01-01T09:00:00.000Z",
  sender: "60120000001@s.whatsapp.net",
  server_url: "https://evolution.example.com",
  apikey: null,
});

const dm = {
  key: { remoteJid: "60120000000@s.whatsapp.net", fromMe: false, id: "3EB000000000000000A1" },
  pushName: "Cikgu Contoh",
  status: "DELIVERY_ACK",
  message: { conversation: "Selamat pagi" },
  messageType: "conversation",
  messageTimestamp: 1767250800,
  instanceId: "00000000-0000-0000-0000-000000000000",
  source: "android",
};

describe("evolutionEvent", () => {
  test("drops the apikey Evolution can put in the body", () => {
    const withKey = { ...envelope(dm), apikey: "made-up-instance-token-0000" };
    const parsed = evolutionEvent.parse(withKey) as Record<string, unknown>;
    expect("apikey" in parsed).toBe(false);
    expect(parsed.server_url).toBe("https://evolution.example.com");
  });

  test("accepts a connection update, which arrives down the same URL", () => {
    const update = envelope({ instance: "contoh", state: "close", statusReason: 401 }, "connection.update");
    expect(evolutionEvent.safeParse(update).success).toBe(true);
    expect(evolutionMessage(update)).toBeUndefined();
  });

  test("accepts a message with a null pushName and a string timestamp", () => {
    const loose = envelope({ ...dm, pushName: null, messageTimestamp: "1767250800" });
    expect(evolutionEvent.safeParse(loose).success).toBe(true);
    expect(evolutionMessage(loose)?.timestamp).toBe(1767250800);
  });
});

describe("evolutionMessage", () => {
  test("reads a direct message", () => {
    expect(evolutionMessage(envelope(dm))).toEqual({
      id: "3EB000000000000000A1",
      chat: "60120000000@s.whatsapp.net",
      from: "60120000000",
      name: "Cikgu Contoh",
      isGroup: false,
      text: "Selamat pagi",
      type: "conversation",
      replyTo: undefined,
      timestamp: 1767250800,
      outgoing: false,
    });
  });

  test("ignores a message this account sent, so a bot never answers itself", () => {
    expect(evolutionMessage(envelope({ ...dm, key: { ...dm.key, fromMe: true } }))).toBeUndefined();
  });

  test("ignores a status broadcast", () => {
    expect(
      evolutionMessage(envelope({ ...dm, key: { ...dm.key, remoteJid: "status@broadcast" } })),
    ).toBeUndefined();
  });

  test("a group message is addressed to the group, from the participant's number", () => {
    const group = {
      ...dm,
      key: {
        remoteJid: "120363000000000000@g.us",
        fromMe: false,
        id: "3EB000000000000000B2",
        participant: "100000000000001@lid",
        participantAlt: "60120000002@s.whatsapp.net",
      },
    };
    const m = evolutionMessage(envelope(group));
    expect(m?.isGroup).toBe(true);
    expect(m?.chat).toBe("120363000000000000@g.us");
    expect(m?.from).toBe("60120000002");
  });

  test("a hidden number stays hidden rather than becoming the lid's digits", () => {
    const lid = { ...dm, key: { ...dm.key, remoteJid: "100000000000003@lid" } };
    const m = evolutionMessage(envelope(lid));
    expect(m?.chat).toBe("100000000000003@lid");
    expect(m?.from).toBeUndefined();
  });

  test("an image caption is the text, and a reply names what it replies to", () => {
    const image = {
      ...dm,
      messageType: "imageMessage",
      message: {
        imageMessage: {
          caption: "Gambar kad",
          mimetype: "image/jpeg",
          contextInfo: { stanzaId: "3EB000000000000000C3" },
        },
      },
    };
    const m = evolutionMessage(envelope(image));
    expect(m?.text).toBe("Gambar kad");
    expect(m?.type).toBe("imageMessage");
    expect(m?.replyTo).toBe("3EB000000000000000C3");
  });

  test("an older server's extendedTextMessage still reads as text", () => {
    const extended = {
      ...dm,
      messageType: "extendedTextMessage",
      message: { extendedTextMessage: { text: "Terima kasih", contextInfo: { stanzaId: "3EB0000000000000000D4" } } },
    };
    const m = evolutionMessage(envelope(extended));
    expect(m?.text).toBe("Terima kasih");
    expect(m?.replyTo).toBe("3EB0000000000000000D4");
  });

  test("a sticker has no text, and is still a message", () => {
    const sticker = { ...dm, messageType: "stickerMessage", message: { stickerMessage: { mimetype: "image/webp" } } };
    expect(evolutionMessage(envelope(sticker))?.text).toBe("");
  });

  test("a business template's title and body are its text, without the footer", () => {
    const promo = {
      ...dm,
      messageType: "templateMessage",
      message: {
        templateMessage: {
          hydratedTemplate: {
            hydratedTitleText: "Contoh Motors",
            hydratedContentText: "Pandu uji model baharu hujung minggu ini.",
            hydratedFooterText: "Balas STOP untuk berhenti",
          },
        },
      },
    };
    expect(evolutionMessage(envelope(promo))?.text).toBe("Contoh Motors\nPandu uji model baharu hujung minggu ini.");
  });

  test("an interactive message reads its body", () => {
    const notice = {
      ...dm,
      messageType: "interactiveMessage",
      message: { interactiveMessage: { body: { text: "Pesanan anda sudah dihantar." } } },
    };
    expect(evolutionMessage(envelope(notice))?.text).toBe("Pesanan anda sudah dihantar.");
  });
});

/**
 * Reading back what Evolution stored. The record shapes are what `fetchChats`
 * and `fetchMessages` return in Evolution's source; the client is a stand-in
 * that answers the one POST and remembers what it was asked.
 */
describe("reading history", () => {
  // Test files share one process, so the connection is set for these and put back.
  const env = {
    EVOLUTION_URL: "https://evolution.example.com/",
    EVOLUTION_API_KEY: "made-up-key-0000",
    EVOLUTION_INSTANCE: "contoh",
  };
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  beforeAll(() => Object.assign(process.env, env));
  afterAll(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const fake = (answer: unknown) => {
    const calls: { url: string; body: any }[] = [];
    const http = {
      async post(url: string, body: unknown) {
        calls.push({ url, body });
        return answer;
      },
    } as unknown as HttpClient;
    return { evo: createEvolution(http), calls };
  };

  const ours = { ...dm, key: { ...dm.key, fromMe: true, id: "3EB000000000000000E5" }, pushName: "Saya", message: { conversation: "Baik" } };

  test("messages() asks for one chat by its full JID and returns oldest first, both sides", async () => {
    const { evo, calls } = fake({
      messages: { total: 2, pages: 1, currentPage: 1, records: [ours, dm] },
    });
    const list = await evo.messages("+60 12-000 0000", { limit: 20 });
    expect(calls[0]!.url).toBe("https://evolution.example.com/chat/findMessages/contoh");
    expect(calls[0]!.body).toEqual({
      where: { key: { remoteJid: "60120000000@s.whatsapp.net" } },
      offset: 20,
      page: 1,
    });
    expect(list.map((m) => [m.text, m.outgoing])).toEqual([
      ["Selamat pagi", false],
      ["Baik", true],
    ]);
    // Our own message is not attributed to the person we sent it to.
    expect(list[1]!.from).toBeUndefined();
    expect(list[1]!.name).toBeUndefined();
  });

  test("messages() sends both ends of the time filter, which Evolution needs", async () => {
    const { evo, calls } = fake({ messages: { records: [] } });
    await evo.messages("120363000000000000@g.us", { since: new Date("2026-01-01T00:00:00Z") });
    const filter = calls[0]!.body.where.messageTimestamp;
    expect(filter.gte).toBe("2026-01-01T00:00:00.000Z");
    expect(typeof filter.lte).toBe("string");
    expect(calls[0]!.body.where.key.remoteJid).toBe("120363000000000000@g.us");
  });

  test("a stored reply keeps its context beside the message", async () => {
    const reply = { ...dm, contextInfo: { stanzaId: "3EB000000000000000F6" } };
    const { evo } = fake({ messages: { records: [reply] } });
    expect((await evo.messages("60120000000"))[0]!.replyTo).toBe("3EB000000000000000F6");
  });

  test("chats() lists each chat with its unread count and newest message", async () => {
    const { evo, calls } = fake([
      {
        id: "00000000-0000-0000-0000-000000000001",
        remoteJid: "60120000000@s.whatsapp.net",
        pushName: "Cikgu Contoh",
        profilePicUrl: null,
        updatedAt: "2026-01-01T09:00:00.000Z",
        windowActive: false,
        lastMessage: { ...dm, pushName: "Cikgu Contoh" },
        unreadCount: 3,
        isSaved: true,
      },
      {
        id: null,
        remoteJid: "120363000000000000@g.us",
        pushName: "Kumpulan Contoh",
        updatedAt: "2026-01-01T08:00:00.000Z",
        lastMessage: { ...ours, key: { ...ours.key, remoteJid: "120363000000000000@g.us" }, pushName: "Você" },
        unreadCount: null,
        isSaved: false,
      },
      { remoteJid: "status@broadcast", unreadCount: 9 },
    ]);
    const chats = await evo.chats({ limit: 10 });
    expect(calls[0]!.url).toBe("https://evolution.example.com/chat/findChats/contoh");
    expect(calls[0]!.body).toEqual({ take: 10 });
    expect(chats.map((c) => [c.chat, c.name, c.isGroup, c.unread])).toEqual([
      ["60120000000@s.whatsapp.net", "Cikgu Contoh", false, 3],
      ["120363000000000000@g.us", "Kumpulan Contoh", true, 0],
    ]);
    expect(chats[0]!.lastMessage?.text).toBe("Selamat pagi");
    expect(chats[1]!.lastMessage?.outgoing).toBe(true);
    expect(chats[1]!.lastMessage?.name).toBeUndefined();
  });
});
