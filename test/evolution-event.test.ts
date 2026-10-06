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
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "automator-test-")), "test.db");
const { evolutionEvent, evolutionMessage } = await import("../src/integrations/evolution.ts");

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
});
