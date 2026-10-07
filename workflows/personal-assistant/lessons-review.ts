import { cron, defineCredential, defineWorkflow } from "../../src/core/define.ts";
import { botApi, chatLabel, LESSONS_MAX, lessonsCard } from "./_bot.ts";

/**
 * Personal assistant — once a week, the lessons it learned that week, on one
 * card, so you can see what it now believes and strike out what it got wrong.
 *
 * Lessons are written by the assistant from your comments, skips and answers,
 * and it follows every one of them from then on. One drawn the wrong way
 * ("say nothing about hidden numbers", from "show me their texts") is worse
 * than none, and until now the only place to notice it was the table. Each
 * lesson gets a 🗑 button that retires it (and ↩ to bring it back) — handled
 * by `personal-assistant-bot`, which redraws this card from its own buttons.
 * Replying to the card is a note to the assistant, quoting it, for rewording.
 *
 * Nothing new that week, no card.
 */

const bot = defineCredential("telegram", "maria");
const WEEK_MS = 7 * 24 * 3_600_000;

export default defineWorkflow({
  name: "personal-assistant-lessons-review",
  description: "Sundays at 8pm: the assistant's lessons from the week, each one a tap to forget",
  trigger: cron("0 20 * * 0", { tz: "Asia/Kuala_Lumpur" }),
  retries: 0,
  timeoutMs: 30_000,

  async run(ctx) {
    const since = Date.now() - WEEK_MS;
    const lessons = ctx
      .table("lessons")
      .query({ limit: 500 })
      .filter((l) => Number(l.created_at) >= since && !l.retired)
      .sort((a, b) => Number(a.created_at) - Number(b.created_at))
      .slice(-LESSONS_MAX);
    if (lessons.length === 0) return { lessons: 0, posted: false };

    const people = new Map(ctx.table("people").query({ limit: 1000 }).map((p) => [String(p.chat_key), p]));
    const { html, buttons } = lessonsCard(lessons, (key) => chatLabel(key, people.get(key)));
    const cardId = await ctx.step("card", () => botApi(ctx, bot).send(html, buttons));
    return { lessons: lessons.length, posted: true, card: cardId };
  },
});
