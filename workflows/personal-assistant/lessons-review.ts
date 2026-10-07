import { cron, defineCredential, defineWorkflow, SCORECARD_CRON, scorecard, scorecardMarks } from "../../src/core/define.ts";
import { botApi, chatLabel, LESSONS_MAX, lessonsCard, rich } from "./_bot.ts";

/**
 * Personal assistant — twice a week, Wednesday and Sunday at 20:00: the
 * scorecard, then the lessons it learned since the last card.
 *
 * **The scorecard** (src/core/scorecard.ts) says in numbers whether Maria got
 * better over the half-week — drafts sent as written, questions per day,
 * tasks kept as made, how fast she answered your notes, outcomes she has not
 * learned from, her sorting kept — against the same days a week earlier.
 * She reads the same numbers with her `scorecard` tool and writes one lesson
 * aimed at the worst. Twice a week rather than weekly because a change made
 * on Monday should show by Wednesday, not the Sunday after.
 *
 * **The lessons** are written by the assistant from your comments, skips and
 * answers, and it follows every one of them from then on. One drawn the
 * wrong way ("say nothing about hidden numbers", from "show me their texts")
 * is worse than none, and until now the only place to notice it was the
 * table. Each lesson gets a 🗑 button that retires it (and ↩ to bring it
 * back) — handled by `personal-assistant-bot`, which redraws that card from
 * its own buttons, so it is a message of its own and the scorecard is not on
 * it. Replying to either card is a note to the assistant, quoting it.
 *
 * No new lessons, no lessons card; the scorecard always goes.
 */

const bot = defineCredential("telegram", "maria");

export default defineWorkflow({
  name: "personal-assistant-lessons-review",
  description: "Wednesdays and Sundays at 8pm: Maria's scorecard, and her lessons since the last card, each a tap to forget",
  trigger: cron(SCORECARD_CRON, { tz: "Asia/Kuala_Lumpur" }),
  retries: 0,
  timeoutMs: 30_000,

  async run(ctx) {
    const card = scorecard("last");
    const api = botApi(ctx, bot);
    const scoreId = await ctx.step("scorecard", () => api.send(rich(scorecardMarks(card))));

    const lessons = ctx
      .table("lessons")
      .query({ limit: 500 })
      .filter((l) => Number(l.created_at) >= card.period.from && !l.retired)
      .sort((a, b) => Number(a.created_at) - Number(b.created_at))
      .slice(-LESSONS_MAX);
    const result = {
      scorecard: scoreId,
      worst: card.worst?.key ?? null,
      onTarget: card.headlines.filter((h) => h.onTarget).length,
      lessons: lessons.length,
    };
    if (lessons.length === 0) return { ...result, posted: false };

    const people = new Map(ctx.table("people").query({ limit: 1000 }).map((p) => [String(p.chat_key), p]));
    const { html, buttons } = lessonsCard(lessons, (key) => chatLabel(key, people.get(key)));
    const cardId = await ctx.step("card", () => api.send(html, buttons));
    return { ...result, posted: true, card: cardId };
  },
});
