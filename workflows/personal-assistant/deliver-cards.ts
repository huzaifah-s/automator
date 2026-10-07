import { cron, defineCredential, defineWorkflow, type Row } from "../../src/core/define.ts";
import {
  botApi,
  chatLabel,
  draftButtons,
  draftCard,
  draftOutcome,
  questionButtons,
  questionCard,
  questionOutcome,
  updateCard,
} from "./_bot.ts";

/**
 * Personal assistant — posts a Telegram card for every draft and question the
 * assistant has written that you have not seen yet.
 *
 * The assistant's endpoint only writes rows; this is what turns a row into
 * something on your phone. A minute's delay is the price of keeping the
 * endpoint unable to send anything at all, not even to you.
 *
 * A row is carded once: `card_id` is set the moment Telegram returns the
 * message id, and only rows without one are picked up. Sends are not retried
 * within a run, because a retried send whose first attempt arrived is a
 * second card with a second Send button; the next minute picks up anything
 * that genuinely failed.
 *
 * A revision's card says what you asked to change, and the card of the draft
 * it replaces is closed so that only one Send button is live per reply.
 */

const bot = defineCredential("telegram", "maria");

export default defineWorkflow({
  name: "personal-assistant-deliver-cards",
  description: "Posts the assistant's new drafts and questions to you on Telegram",
  trigger: cron("* * * * *", { tz: "Asia/Kuala_Lumpur" }),
  retries: 0,
  timeoutMs: 50_000,

  async run(ctx) {
    const api = botApi(ctx, bot);
    const drafts = ctx.table("drafts");
    const questions = ctx.table("questions");
    const people = new Map(ctx.table("people").query({ limit: 1000 }).map((p) => [String(p.chat_key), p]));

    const newDrafts = drafts
      .query({ where: [{ column: "card_id", op: "is null" }], limit: 20 })
      .filter((d) => d.status === "pending");
    const unsent = questions
      .query({ where: [{ column: "card_id", op: "is null" }], limit: 20 })
      .filter((q) => q.status === "open");
    // `kind` is NULL on rows from before it existed, which were all questions.
    const updates = unsent.filter((q) => q.kind === "update");
    const newQuestions = unsent.filter((q) => q.kind !== "update" && q.kind !== "note");

    let posted = 0;
    // Oldest first, so cards arrive in the order they were written.
    for (const d of [...newDrafts].reverse()) {
      await ctx.step(`draft ${d.id}`, async () => {
        const previous: Row | null = d.revision_of ? drafts.get(String(d.revision_of)) : null;
        const cardId = await api.send(
          draftCard(d, previous?.feedback as string | null, people.get(String(d.chat_key))),
          draftButtons(String(d.id)),
        );
        drafts.update(String(d.id), { card_id: String(cardId) }, { writtenBy: ctx.workflow });
        // The old card's buttons go, so one reply never has two live Sends.
        if (previous?.card_id && previous.status === "replaced") {
          await api.edit(String(previous.card_id), draftOutcome(previous, "replaced"));
        }
      });
      posted++;
    }
    for (const q of [...newQuestions].reverse()) {
      await ctx.step(`question ${q.id}`, async () => {
        const about = q.chat_key ? chatLabel(String(q.chat_key), people.get(String(q.chat_key))) : null;
        const cardId = await api.send(questionCard(q, about), questionButtons(q));
        questions.update(String(q.id), { card_id: String(cardId) }, { writtenBy: ctx.workflow });
      });
      posted++;
    }

    // The assistant's own updates to you — the digests, and its answers to
    // your notes. Plain messages: there is nothing to answer, so they are
    // done once delivered. An answer is threaded under what it answers.
    for (const u of [...updates].reverse()) {
      await ctx.step(`update ${u.id}`, async () => {
        const answers: Row | null = u.reply_to ? questions.get(String(u.reply_to)) : null;
        const under = Number(answers?.card_id);
        const cardId = await api.send(updateCard(u), undefined, Number.isFinite(under) && under > 0 ? under : undefined);
        questions.update(String(u.id), { card_id: String(cardId), status: "done" }, { writtenBy: ctx.workflow });
      });
      posted++;
    }

    // Answers the assistant recognised in a reply you typed: the card it
    // answers is rewritten to show it, and loses its buttons, the same as a
    // tap would have done.
    const outdated = questions.query({ limit: 200 }).filter((q) => q.card_outdated && q.card_id);
    for (const q of outdated) {
      await ctx.step(`answered ${q.id}`, async () => {
        const about = q.chat_key ? chatLabel(String(q.chat_key), people.get(String(q.chat_key))) : null;
        await api.edit(String(q.card_id), questionOutcome(q, about));
        questions.update(String(q.id), { card_outdated: false }, { writtenBy: ctx.workflow });
      });
    }

    return {
      drafts: newDrafts.length,
      questions: newQuestions.length,
      updates: updates.length,
      posted,
      cardsUpdated: outdated.length,
    };
  },
});
