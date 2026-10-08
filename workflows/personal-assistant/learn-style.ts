import { z } from "zod";
import { askClaude, cron, defineCredential, defineSecrets, defineWorkflow, type Ctx, type Row } from "../../src/core/define.ts";
import { NOISE } from "./_whatsapp.ts";

/**
 * Personal assistant — learns how he writes in each chat, from his own
 * messages there, and keeps it as one lesson for that chat (source `style`).
 *
 * Her first draft to Faiz (8 Oct) was formal Malay; he writes to clients in
 * an English–Malay mix ("so kitorang harap we can go to the next step"). The
 * chat log only reaches back 14 days, but WhatsApp and Telegram hold months,
 * so this reads his last messages in a chat straight from them, asks Claude
 * for one line on how he writes there, and saves that line. `thread` shows a
 * chat's lessons above its messages, so she reads it before every draft.
 *
 * **Nothing he wrote is kept.** The reads are `private` (the run page lists
 * the calls, not what came back), the messages go only into the prompt, and
 * what is stored is the one-line description — and the run's counts.
 *
 * **Which chats.** Every chat not set to ignore, `always` first, that has no
 * style lesson or one older than `STALE_DAYS`, and where he has written at
 * least `MIN_MINE` messages; a few per run so a day's runs cover the list
 * without a burst. A style lesson is retired and replaced when relearned, and
 * he can delete one from the Sunday lessons card like any other.
 *
 * The model is Claude Code on his subscription with no tools at all
 * (`askClaude`, src/core/claude-code.ts) — the same token as live Maria. Without one it
 * does nothing.
 */

const TZ = "Asia/Kuala_Lumpur";
const whatsappAccount = defineCredential("evolution", "huzaifah-evolution-api");
const telegramAccount = defineCredential("telegram_user", "huzaifah-telegram-user-account");
const claude = defineSecrets({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(20).optional(),
  CLAUDE_CODE_OAUTH_TOKEN_2: z.string().min(20).optional(),
});

/** Chats learned per run. */
const PER_RUN = 4;
/** A style older than this is learned again — how he writes to someone changes. */
const STALE_DAYS = 30;
/** Fewer of his own messages than this says too little to describe. */
const MIN_MINE = 5;
/** His messages given to the model, newest kept, each cut to `MAX_CHARS`. */
const MAX_MINE = 40;
const MAX_CHARS = 300;
/** A chat that had too little is not looked at again for this long. */
const RETRY_SECONDS = 7 * 86_400;

const SYSTEM = `You describe how one man writes in one chat, so an assistant can draft messages that sound like him there. You get his own messages from that chat, oldest first.

Answer with ONE line, at most 260 characters, that an assistant can follow: the language (English, Malay, or his mix — say how he mixes), how he greets and signs off, how he addresses them (En., bro, kak, by name), formality, typical length, emoji and punctuation habits, lowercase or not. Concrete, from what you see — quote a typical opener or closer in a few words if it helps. Nothing about what the messages are about, no names of third parties, no numbers, links or private details.

If the messages are too few or too mixed to say anything useful, answer exactly NONE.`;

const input = z.object({ chat: z.string().regex(/^(whatsapp|telegram):.+/).optional() }).default({});

interface Mine {
  text: string;
  at: number;
}

export default defineWorkflow({
  name: "personal-assistant-learn-style",
  description: "Learns how he writes in each chat, from his own messages, as one lesson per chat",
  trigger: cron("25 9-22 * * *", { tz: TZ }),
  retries: 0,
  timeoutMs: 10 * 60_000,

  async run(ctx) {
    const tokens = [claude.CLAUDE_CODE_OAUTH_TOKEN ?? "", claude.CLAUDE_CODE_OAUTH_TOKEN_2 ?? ""];
    if (!tokens.some(Boolean) && process.env.ASSISTANT_LIVE_LOGIN !== "1") return { skipped: "no Claude token" };
    const only = input.parse(ctx.input ?? {}).chat;

    const people = ctx.table("people").query({ limit: 1000 });
    const lessons = ctx.table("lessons").query({ limit: 1000 }).filter((l) => l.source === "style" && !l.retired);
    const styled = new Map(lessons.map((l) => [String(l.chat_key), l]));
    const stale = Date.now() - STALE_DAYS * 86_400_000;
    const rank: Record<string, number> = { always: 0, normal: 1 };

    const due: Row[] = [];
    for (const p of people) {
      const key = String(p.chat_key);
      if (p.same_as || p.priority === "ignore" || (p.channel !== "whatsapp" && p.channel !== "telegram")) continue;
      if (p.kind === "channel" || p.kind === "bot") continue;
      if (only ? key !== only : (styled.get(key) && Number(styled.get(key)!.created_at) > stale)) continue;
      if (!only && (await ctx.state.get(`tried:${key}`))) continue;
      due.push(p);
    }
    due.sort((a, b) => (rank[String(a.priority)] ?? 2) - (rank[String(b.priority)] ?? 2));

    let learned = 0;
    let tooFew = 0;
    let none = 0;
    let failed = 0;
    for (const p of due.slice(0, only ? 1 : PER_RUN)) {
      const key = String(p.chat_key);
      // Not a step: a step's result is stored, and this is his messages. The
      // reads are private, so the run page shows the calls and their sizes.
      const mine = await hisMessages(ctx, p, people);
      if (mine.length < MIN_MINE) {
        tooFew++;
        await ctx.state.set(`tried:${key}`, true, { ttlSeconds: RETRY_SECONDS });
        continue;
      }
      const shown = mine.slice(-MAX_MINE);
      const answer = await askClaude(ctx, tokens, {
        who: "Learn style",
        system: SYSTEM,
        prompt:
          `Chat: ${p.channel === "whatsapp" ? "WhatsApp" : "Telegram"} ${p.kind === "group" ? "group" : "1:1"}` +
          (p.notes ? ` — who they are: ${String(p.notes).slice(0, 200)}` : "") +
          `\nHis messages there (${shown.length}, oldest first):\n` +
          shown.map((m) => `- ${m.text.replace(/\s+/g, " ").slice(0, MAX_CHARS)}`).join("\n"),
      });
      if (!answer) {
        failed++;
        continue;
      }
      const line = answer.text.replace(/\s+/g, " ").trim();
      if (!line || /^NONE\.?$/i.test(line)) {
        none++;
        await ctx.state.set(`tried:${key}`, true, { ttlSeconds: RETRY_SECONDS });
        continue;
      }
      const old = styled.get(key);
      if (old) ctx.table("lessons").update(String(old.id), { retired: true }, { writtenBy: ctx.workflow });
      const first = new Date(shown[0]!.at).toISOString().slice(0, 10);
      const last = new Date(shown.at(-1)!.at).toISOString().slice(0, 10);
      ctx.table("lessons").insert(
        {
          lesson: `How he writes here: ${line.slice(0, 300)}`,
          chat_key: key,
          source: "style",
          evidence: `His last ${shown.length} messages in this chat, ${first} to ${last}`,
        },
        { writtenBy: ctx.workflow },
      );
      learned++;
    }
    return { due: due.length, learned, tooFew, none, failed };
  },
});

/** His own messages in a chat with words in them, oldest first — WhatsApp under the number and any hidden id linked to it. */
async function hisMessages(ctx: Ctx, p: Row, people: Row[]): Promise<Mine[]> {
  const key = String(p.chat_key);
  if (p.channel === "telegram") {
    const list = await ctx.telegramUser.history(Number(key.slice("telegram:".length)), {
      limit: 100,
      private: true,
      credential: telegramAccount,
    });
    return list.filter((m) => m.outgoing && m.text.trim()).map((m) => ({ text: m.text, at: Date.parse(m.date) }));
  }
  const jids = [key, ...people.filter((r) => r.same_as === key).map((r) => String(r.chat_key))].map((k) =>
    k.slice("whatsapp:".length),
  );
  const out: Mine[] = [];
  for (const jid of jids) {
    const list = await ctx.evolution.messages(jid, { limit: 100, private: true, credential: whatsappAccount });
    for (const m of list) {
      if (m.outgoing && !NOISE.has(m.type) && m.text.trim()) out.push({ text: m.text, at: (m.timestamp ?? 0) * 1000 });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
