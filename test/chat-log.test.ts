/**
 * The chat log's three promises: an overlapping page is recorded once, a
 * credential this process knows never reaches the table, and nothing
 * outlives its retention — his own messages' longer one included. Made-up values only.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "automator-test-")), "test.db");
const { chatLog, pruneChatLog } = await import("../src/core/chat-log.ts");
const { db } = await import("../src/core/db.ts");
const { registerSecret } = await import("../src/core/redact.ts");

const DAY = 86_400_000;
const message = (id: string, over: Record<string, unknown> = {}) => ({
  channel: "whatsapp" as const,
  chat: "60120000000@s.whatsapp.net",
  id,
  text: "Selamat pagi",
  outgoing: false,
  sentAt: Date.now(),
  ...over,
});
const count = () => (db.query("SELECT count(*) n FROM chat_messages").get() as { n: number }).n;

describe("chatLog", () => {
  test("an overlapping page is recorded once", () => {
    expect(chatLog.record([message("A1"), message("A2")])).toBe(2);
    expect(chatLog.record([message("A2"), message("A3")])).toBe(1);
    expect(count()).toBe(3);
  });

  test("the same id in another chat or channel is another message", () => {
    expect(chatLog.record([message("A1", { chat: "120363000000000000@g.us" })])).toBe(1);
    expect(chatLog.record([message("A1", { channel: "telegram", chat: "-1000000000001" })])).toBe(1);
  });

  test("a credential the process knows is scrubbed before it is stored", () => {
    registerSecret("made-up-token-0123456789abcdef");
    chatLog.record([message("B1", { text: "the key is made-up-token-0123456789abcdef" })]);
    const row = db.query("SELECT text FROM chat_messages WHERE id = 'B1'").get() as { text: string };
    expect(row.text).not.toContain("made-up-token-0123456789abcdef");
  });

  // Recorded under a long retention, then pruned under a short one: a
  // message that ages past the window while it sits in the log.
  const recordThenShrink = (entries: ReturnType<typeof message>[], theirs: string, own?: string) => {
    process.env.CHAT_LOG_RETENTION_DAYS = "365";
    process.env.CHAT_LOG_OWN_RETENTION_DAYS = "365";
    chatLog.record(entries);
    process.env.CHAT_LOG_RETENTION_DAYS = theirs;
    if (own === undefined) delete process.env.CHAT_LOG_OWN_RETENTION_DAYS;
    else process.env.CHAT_LOG_OWN_RETENTION_DAYS = own;
  };

  test("messages past the retention are forgotten, newer ones kept", () => {
    recordThenShrink([message("OLD", { sentAt: Date.now() - 15 * DAY }), message("NEW", { sentAt: Date.now() - 13 * DAY })], "14");
    expect(pruneChatLog()).toBe(1);
    expect(db.query("SELECT id FROM chat_messages WHERE id IN ('OLD','NEW')").all()).toEqual([{ id: "NEW" }]);
  });

  test("his own messages are kept longer than theirs, and not forever", () => {
    recordThenShrink(
      [
        message("THEIRS20", { sentAt: Date.now() - 20 * DAY }),
        message("MINE20", { sentAt: Date.now() - 20 * DAY, outgoing: true }),
        message("MINE100", { sentAt: Date.now() - 100 * DAY, outgoing: true }),
      ],
      "14",
    );
    expect(pruneChatLog()).toBe(2);
    expect(db.query("SELECT id FROM chat_messages WHERE id IN ('THEIRS20','MINE20','MINE100')").all()).toEqual([{ id: "MINE20" }]);
  });

  test("his own are never kept for less than theirs", () => {
    recordThenShrink([message("MINE10", { sentAt: Date.now() - 10 * DAY, outgoing: true })], "14", "3");
    pruneChatLog();
    expect(db.query("SELECT id FROM chat_messages WHERE id = 'MINE10'").all()).toEqual([{ id: "MINE10" }]);
  });

  test("what is already past its window is not recorded at all", () => {
    delete process.env.CHAT_LOG_RETENTION_DAYS;
    delete process.env.CHAT_LOG_OWN_RETENTION_DAYS;
    expect(
      chatLog.record([
        message("LATE", { sentAt: Date.now() - 15 * DAY }),
        message("LATEMINE", { sentAt: Date.now() - 15 * DAY, outgoing: true }),
        message("ANCIENT", { sentAt: Date.now() - 91 * DAY, outgoing: true }),
      ]),
    ).toBe(1);
    expect(db.query("SELECT id FROM chat_messages WHERE id IN ('LATE','LATEMINE','ANCIENT')").all()).toEqual([{ id: "LATEMINE" }]);
  });

  test("a retention of 0 does not switch forgetting off", () => {
    recordThenShrink([message("STALE", { sentAt: Date.now() - 30 * DAY })], "0");
    expect(pruneChatLog()).toBe(1);
    delete process.env.CHAT_LOG_RETENTION_DAYS;
  });
});
