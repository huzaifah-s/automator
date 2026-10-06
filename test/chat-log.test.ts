/**
 * The chat log's three promises: an overlapping page is recorded once, a
 * credential this process knows never reaches the table, and nothing
 * outlives its retention. Made-up values only.
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

  test("messages past the retention are forgotten, newer ones kept", () => {
    process.env.CHAT_LOG_RETENTION_DAYS = "14";
    chatLog.record([message("OLD", { sentAt: Date.now() - 15 * DAY }), message("NEW", { sentAt: Date.now() - 13 * DAY })]);
    expect(pruneChatLog()).toBe(1);
    expect(db.query("SELECT id FROM chat_messages WHERE id IN ('OLD','NEW')").all()).toEqual([{ id: "NEW" }]);
  });

  test("a retention of 0 does not switch forgetting off", () => {
    process.env.CHAT_LOG_RETENTION_DAYS = "0";
    chatLog.record([message("STALE", { sentAt: Date.now() - 30 * DAY })]);
    expect(pruneChatLog()).toBe(1);
    delete process.env.CHAT_LOG_RETENTION_DAYS;
  });
});
