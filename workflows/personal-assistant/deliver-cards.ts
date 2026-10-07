import { z } from "zod";
import { cron, defineCredential, defineSecrets, defineWorkflow, type Row } from "../../src/core/define.ts";
import {
  BATCH_MAX,
  batchCard,
  botApi,
  byAsked,
  cardQuestions,
  chatLabel,
  draftButtons,
  draftCard,
  draftOutcome,
  draftWithdrawn,
  isPriorityQuestion,
  linkButtons,
  questionButtons,
  questionCard,
  questionOutcome,
  taskLabel,
  taskLinks,
  updateCard,
} from "./_bot.ts";
import { firePending } from "./_routine.ts";

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
 *
 * It is also the minute clock for the assistant's early starts: a start asked
 * for during the two-minute cooldown is owed, and made here once it is over
 * (see _routine.ts).
 */

const bot = defineCredential("telegram", "maria");
/** Optional, as in bot.ts: without it there are no early starts to make. */
const routine = defineSecrets({ ASSISTANT_ROUTINE_TOKEN: z.string().min(20).optional() });

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
    const taskRows = ctx.table("tasks").query({ limit: 1000 });
    const tasks = new Map(taskRows.map((t) => [String(t.page_id), t.title]));
    /** `[[Task title]]` in anything the assistant wrote opens that task in Notion. */
    const links = taskLinks(taskRows);
    /** Which chat — and in which app — or which To Do task a question is about. */
    const aboutOf = (q: Row): string | null =>
      q.chat_key
        ? chatLabel(String(q.chat_key), people.get(String(q.chat_key)))
        : q.task_id
          ? taskLabel(tasks.get(String(q.task_id)))
          : null;

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
    // "How important is this chat?" comes a run's worth at a time: two or
    // more go on one card, each keeping its own row of buttons.
    const oldestFirst = [...newQuestions].reverse();
    const sorting = oldestFirst.filter(isPriorityQuestion).sort(byAsked);
    const batched = sorting.length > 1 ? sorting.slice(0, BATCH_MAX) : [];
    if (batched.length) {
      await ctx.step(`chats ${batched[0]!.id}`, async () => {
        const { html, buttons } = batchCard(batched, aboutOf);
        const cardId = await api.send(html, buttons);
        for (const q of batched) questions.update(String(q.id), { card_id: String(cardId) }, { writtenBy: ctx.workflow });
      });
      posted++;
    }
    const inBatch = new Set(batched.map((q) => String(q.id)));
    for (const q of oldestFirst.filter((q) => !inBatch.has(String(q.id)))) {
      await ctx.step(`question ${q.id}`, async () => {
        const cardId = await api.send(questionCard(q, aboutOf(q), links), questionButtons(q));
        questions.update(String(q.id), { card_id: String(cardId) }, { writtenBy: ctx.workflow });
      });
      posted++;
    }

    // The assistant's own updates to you — the digests, its answers to your
    // notes, and every task it adds (with a button that opens it in Notion).
    // Nothing to answer, so they are done once delivered. An answer is
    // threaded under what it answers.
    for (const u of [...updates].reverse()) {
      await ctx.step(`update ${u.id}`, async () => {
        const answers: Row | null = u.reply_to ? questions.get(String(u.reply_to)) : null;
        const under = Number(answers?.card_id);
        const cardId = await api.send(
          updateCard(u, links),
          linkButtons(u.link),
          Number.isFinite(under) && under > 0 ? under : undefined,
        );
        questions.update(String(u.id), { card_id: String(cardId), status: "done" }, { writtenBy: ctx.workflow });
      });
      posted++;
    }

    // Answers the assistant recognised in a reply you typed: the card it
    // answers is rewritten to show it, and loses its buttons, the same as a
    // tap would have done.
    // A shared card is redrawn whole, once, however many of its chats changed.
    const outdated = questions.query({ limit: 200 }).filter((q) => q.card_outdated && q.card_id);
    const redrawn = new Set<string>();
    for (const q of outdated) {
      await ctx.step(`answered ${q.id}`, async () => {
        const card = String(q.card_id);
        if (!redrawn.has(card)) {
          redrawn.add(card);
          const onCard = cardQuestions(ctx, card);
          if (onCard.length > 1) {
            const { html, buttons } = batchCard(onCard, aboutOf);
            await api.edit(card, html, buttons);
          } else {
            await api.edit(card, questionOutcome(q, aboutOf(q), links));
          }
        }
        questions.update(String(q.id), { card_outdated: false }, { writtenBy: ctx.workflow });
      });
    }

    // Drafts the assistant took back: the card says so and loses its Send.
    const withdrawn = drafts.query({ limit: 200 }).filter((d) => d.card_outdated && d.card_id);
    for (const d of withdrawn) {
      await ctx.step(`withdrawn ${d.id}`, async () => {
        await api.edit(String(d.card_id), draftWithdrawn(d));
        drafts.update(String(d.id), { card_outdated: false }, { writtenBy: ctx.workflow });
      });
    }

    const fired = await ctx.step("owed start", () => firePending(ctx, routine.ASSISTANT_ROUTINE_TOKEN ?? ""));

    return {
      fired,
      drafts: newDrafts.length,
      questions: newQuestions.length,
      updates: updates.length,
      posted,
      cardsUpdated: outdated.length + withdrawn.length,
    };
  },
});
