import { z } from "zod";
import {
  defineCredential,
  defineSecrets,
  defineWorkflow,
  telegramSecretToken,
  webhook,
  type Ctx,
  type Row,
} from "../../src/core/define.ts";
import {
  botApi,
  chatLabel,
  taskLabel,
  draftButtons,
  draftOutcome,
  esc,
  owner,
  questionOutcome,
  webhookSecret,
} from "./_bot.ts";
import { fireAssistant } from "./_routine.ts";

/**
 * Personal assistant — the Telegram bot's side of the conversation: what
 * happens when you press a button on a card or reply to one.
 *
 *   ✅ Send     sends the draft from your own WhatsApp or Telegram, exactly as
 *              written, and the card says when.
 *   Skip       closes it; nothing is sent.
 *   reply to a draft card    is a comment: the draft goes to `revise` with your
 *              words in `feedback`, and the assistant writes a new version.
 *              On a draft already sent or skipped it is the reason, kept for
 *              the assistant to learn from.
 *   option on a question card    is the answer. always / normal / ignore
 *              about a chat is applied to `people` at once, so the chat stops
 *              being "unsorted" before the assistant next runs.
 *   reply to a question card, a digest or an answered card    is a note
 *              about that card. The assistant decides what it is: an answer
 *              (recorded on the question, and the card rewritten) or you
 *              asking back, which it answers under your message. A bare
 *              always / normal / ignore is the one reply taken as the answer
 *              here and now.
 *   any other message    is a note to the assistant, filed as an answered
 *              "question" so its next run reads it.
 *
 * **Every message gets a reply.** A card edited a screen above is not one:
 * what you see after swiping to reply is whether anything heard you.
 *
 * **Only you.** The credential's Default chat id is the one person the bot
 * answers; an update from anyone else is dropped without a reply, because
 * answering a stranger — even to refuse — tells them the bot is alive. The
 * webhook's `secret_token` proves a delivery came from Telegram at all.
 *
 * **One update at a time** (`onOverlap: "queue"`). Two taps on Send arrive as
 * two deliveries; queued, the second finds the draft already `sent` and does
 * nothing. Skipped instead of queued, a tap could be lost; run in parallel, it
 * could send twice.
 *
 * Not retried: a send that failed after reaching WhatsApp would arrive twice.
 * A failure is written on the card with the Send button still there.
 */

const bot = defineCredential("telegram", "maria");
const whatsappAccount = defineCredential("evolution", "huzaifah-evolution-api");
const telegramAccount = defineCredential("telegram_user", "huzaifah-telegram-user-account");
/**
 * Optional: without it, comments wait for the hourly run. See _routine.ts.
 * Read on every run, so setting it on the Secrets tab works without a restart.
 */
const routine = defineSecrets({ ASSISTANT_ROUTINE_TOKEN: z.string().min(20).optional() });
const routineToken = () => routine.ASSISTANT_ROUTINE_TOKEN ?? "";

const update = z.looseObject({
  update_id: z.number().optional(),
  message: z
    .looseObject({
      message_id: z.number(),
      text: z.string().optional(),
      from: z.looseObject({ id: z.number() }).optional(),
      chat: z.looseObject({ id: z.number() }),
      reply_to_message: z.looseObject({ message_id: z.number() }).optional(),
    })
    .optional(),
  callback_query: z
    .looseObject({
      id: z.string(),
      from: z.looseObject({ id: z.number() }),
      data: z.string().optional(),
      message: z.looseObject({ message_id: z.number() }).optional(),
    })
    .optional(),
});
type Update = z.infer<typeof update>;

export default defineWorkflow({
  name: "personal-assistant-bot",
  description: "Handles your taps and replies on the assistant's Telegram cards",
  trigger: webhook("personal-assistant/bot", {
    method: "POST",
    schema: update,
    // Structure only. Who sent it is checked in run(), where the credential
    // is certain to be readable — a filter is a shortcut, not the guard.
    filter: (u) => (u.message || u.callback_query ? true : "not a message or a button"),
    verify: telegramSecretToken(() => webhookSecret(bot.token)),
    register: {
      // One bot, one webhook, identified only by its URL — so the URL is what
      // is returned and kept, and a changed PUBLIC_URL re-registers.
      async create(ctx) {
        await botApi(ctx, bot).setWebhook(ctx.url);
        return ctx.url;
      },
      async remove(ctx) {
        await botApi(ctx, bot).deleteWebhook();
      },
    },
  }),
  onOverlap: "queue",
  retries: 0,
  timeoutMs: 60_000,

  async run(ctx) {
    const u = ctx.input as Update;
    const me = owner(bot);
    const from = u.callback_query?.from.id ?? u.message?.from?.id ?? u.message?.chat.id;
    if (String(from) !== me) return { ignored: "not the owner" };

    if (u.callback_query) return onButton(ctx, u.callback_query);
    if (u.message) return onMessage(ctx, u.message);
    return { ignored: "nothing to do" };
  },
});

/* ---------------------------------------------------------------- buttons */

async function onButton(ctx: Ctx, cb: NonNullable<Update["callback_query"]>) {
  const api = botApi(ctx, bot);
  const [kind, id, action] = (cb.data ?? "").split(":");

  if (kind === "d" && id && (action === "send" || action === "skip")) {
    const drafts = ctx.table("drafts");
    const d = drafts.get(id);
    if (!d) {
      await api.answer(cb.id, "That draft no longer exists.");
      return { draft: id, outcome: "missing" };
    }
    // Only a draft still waiting can be acted on. A second tap, or a tap on
    // a card a revision replaced, lands here and changes nothing.
    if (d.status !== "pending" && d.status !== "failed") {
      await api.answer(cb.id, `Already ${d.status}.`);
      return { draft: id, outcome: `already ${d.status}` };
    }

    if (action === "skip") {
      const row = drafts.update(id, { status: "skipped" }, { writtenBy: ctx.workflow });
      if (d.card_id) await api.edit(String(d.card_id), draftOutcome(row, "skipped"));
      await api.answer(cb.id, "Skipped.");
      return { draft: id, outcome: "skipped" };
    }

    try {
      await ctx.step("send", () => sendDraft(ctx, d));
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 300);
      const row = drafts.update(id, { status: "failed", error: message }, { writtenBy: ctx.workflow });
      if (d.card_id) {
        await api.edit(String(d.card_id), draftOutcome(row, "failed"), draftButtons(id));
      }
      await api.answer(cb.id, "Could not send — see the card.");
      ctx.log.warn(`Draft ${id} could not be sent: ${message}`);
      return { draft: id, outcome: "failed" };
    }
    const row = drafts.update(
      id,
      { status: "sent", sent_at: Date.now(), error: null },
      { writtenBy: ctx.workflow },
    );
    if (d.card_id) await api.edit(String(d.card_id), draftOutcome(row, "sent"));
    await api.answer(cb.id, `Sent to ${d.chat_name}.`);
    return { draft: id, outcome: "sent" };
  }

  if (kind === "q" && id && action !== undefined) {
    const questions = ctx.table("questions");
    const q = questions.get(id);
    const options = Array.isArray(q?.options) ? (q!.options as string[]) : [];
    const choice = options[Number(action)];
    if (!q || choice === undefined) {
      await api.answer(cb.id, "That question no longer exists.");
      return { question: id, outcome: "missing" };
    }
    if (q.status !== "open") {
      await api.answer(cb.id, `Already answered: ${q.answer}`);
      return { question: id, outcome: "already answered" };
    }
    const row = answer(ctx, q, choice);
    const priority = applyPriority(ctx, row);
    if (q.card_id) await api.edit(String(q.card_id), questionOutcome(row, about(ctx, row)));
    if (priority) {
      await api.answer(cb.id, `Noted — set to ${priority}.`);
      return { question: id, outcome: "answered", priority };
    }
    const fired = await fireAssistant(ctx, routineToken(), "The user answered a question. Read `questions` and act on it.");
    await api.answer(cb.id, fired === "fired" ? "Noted — on it now." : "Noted.");
    return { question: id, outcome: "answered", fired };
  }

  await api.answer(cb.id);
  return { ignored: "unknown button" };
}

/** The approved text, from your own account, to the chat it was drafted for. */
async function sendDraft(ctx: Ctx, d: Row) {
  const [channel, ...rest] = String(d.chat_key).split(":");
  const chat = rest.join(":");
  const text = String(d.text);
  if (channel === "whatsapp") {
    const sent = await ctx.evolution.text(chat, text, { credential: whatsappAccount });
    return { channel, id: sent.id };
  }
  if (channel === "telegram") {
    const replyTo = d.reply_to ? Number(d.reply_to) : undefined;
    const sent = await ctx.telegramUser.send(Number(chat), text, {
      credential: telegramAccount,
      ...(Number.isFinite(replyTo) ? { replyTo } : {}),
    });
    return { channel, id: sent.id };
  }
  throw new Error(`Unknown channel in ${d.chat_key}`);
}

/* --------------------------------------------------------------- messages */

async function onMessage(ctx: Ctx, m: NonNullable<Update["message"]>) {
  const api = botApi(ctx, bot);
  const text = (m.text ?? "").trim();
  if (!text) return { ignored: "no text" };

  if (text === "/start" || text === "/help") {
    await api.reply(
      m.message_id,
      "I'm your assistant. Drafts and questions arrive here as cards.\n\n" +
        "• <b>Send</b> or <b>Skip</b> a draft with its buttons.\n" +
        "• <b>Reply to a draft</b> to say what to change — a new version follows.\n" +
        "• <b>Reply to a question</b>, or tap an option, to answer it.\n" +
        "• Anything else you send me is a note I read on my next run.",
    );
    return { outcome: "help" };
  }

  const replied = m.reply_to_message?.message_id;
  if (replied !== undefined) {
    const card = String(replied);
    const d = ctx.table("drafts").query({ where: [{ column: "card_id", op: "=", value: card }], limit: 1 })[0];
    if (d) return comment(ctx, d, text, m.message_id);
    const q = ctx.table("questions").query({ where: [{ column: "card_id", op: "=", value: card }], limit: 1 })[0];
    // Typed in words, a reply may answer the card or ask something back —
    // "telegram or whatsapp", with or without the "?". Telling those apart
    // is the assistant's job, so it arrives as a note and the question stays
    // open. Only a bare priority is unambiguous enough to apply here.
    const bare = text.toLowerCase();
    if (q && kindOf(q) === "question" && q.status === "open" && q.chat_key && PRIORITIES.has(bare)) {
      const row = answer(ctx, q, bare);
      const priority = applyPriority(ctx, row);
      if (q.card_id) await api.edit(String(q.card_id), questionOutcome(row, about(ctx, row)));
      if (priority) {
        await api.reply(m.message_id, `Noted — ${esc(about(ctx, row) ?? "that chat")} is now <b>${priority}</b>.`);
        return { question: q.id, outcome: "answered", priority };
      }
    }
    if (q) return note(ctx, text, m.message_id, q);
  }

  return note(ctx, text, m.message_id, null);
}

/**
 * Something for the assistant's next run that is not an answer. Filed as an
 * answered "question" so the one place it already looks is where it is; when
 * it was a reply to a card, it quotes that card and carries its chat, so
 * "telegram or whatsapp?" arrives with what it was asking about. `card_id`
 * is your message, which the assistant's answer is threaded under.
 */
async function note(ctx: Ctx, text: string, messageId: number, about: Row | null) {
  const quoted = about
    ? `(your reply to: “${String(about.question).replace(/\s+/g, " ").slice(0, 300)}”)`
    : "(a message from you)";
  const { row } = ctx.table("questions").insert(
    {
      kind: "note",
      question: quoted,
      answer: text,
      chat_key: about?.chat_key ?? null,
      task_id: about?.task_id ?? null,
      reply_to: about ? String(about.id) : null,
      status: "answered",
      answered_at: Date.now(),
      card_id: String(messageId),
    },
    { writtenBy: ctx.workflow },
  );
  const fired = await fireAssistant(
    ctx,
    routineToken(),
    "The user sent you a note. Read `questions`, act on it, and answer him with `brief` (reply_to the note).",
  );
  await botApi(ctx, bot).reply(messageId, heard(fired));
  return { note: row.id, about: about?.id ?? null, fired };
}

/** What you are told after a message: whether the assistant is already on it. */
function heard(fired: Awaited<ReturnType<typeof fireAssistant>>): string {
  return fired === "fired"
    ? "Got it — on it now."
    : "Got it — I'll pick this up on my next run (hourly, 08:00–23:00).";
}

/** Your reply to a draft card: what to change. */
async function comment(ctx: Ctx, d: Row, text: string, messageId: number) {
  const api = botApi(ctx, bot);
  const drafts = ctx.table("drafts");
  // After it ended, a reply is not a request to change it but a reason —
  // "skipped: he already called me" — and the reason is what the assistant
  // learns from. Kept on the draft, which is not reopened.
  if (d.status === "sent" || d.status === "skipped") {
    const feedback = d.feedback ? `${d.feedback}\n${text}` : text;
    drafts.update(String(d.id), { feedback, learned: false }, { writtenBy: ctx.workflow });
    await api.reply(messageId, "Noted — I'll learn from that.");
    return { draft: d.id, outcome: "reason noted" };
  }
  if (d.status !== "pending" && d.status !== "revise" && d.status !== "failed") {
    await api.reply(messageId, `That draft is already ${d.status}.`);
    return { draft: d.id, outcome: `already ${d.status}` };
  }
  // A second comment before the revision arrives adds to the first rather
  // than replacing it — both are still things you want changed.
  const feedback = d.status === "revise" && d.feedback ? `${d.feedback}\n${text}` : text;
  const row = drafts.update(String(d.id), { status: "revise", feedback }, { writtenBy: ctx.workflow });
  if (d.card_id) await api.edit(String(d.card_id), draftOutcome(row, "revise"));
  const fired = await fireAssistant(
    ctx,
    routineToken(),
    "The user commented on a draft. Revise the drafts in `revise` (see `drafts`) and learn from the comment.",
  );
  await api.reply(
    messageId,
    fired === "fired"
      ? "Got it — a new version is coming."
      : "Got it — I'll send a new version on my next run (hourly, 08:00–23:00).",
  );
  return { draft: d.id, outcome: "revise", fired };
}

function answer(ctx: Ctx, q: Row, value: string): Row {
  return ctx
    .table("questions")
    .update(String(q.id), { answer: value, status: "answered", answered_at: Date.now() }, { writtenBy: ctx.workflow });
}

/** `kind` is NULL on rows from before it existed, which were all questions. */
const kindOf = (q: Row) => String(q.kind ?? "question");

const PRIORITIES = new Set(["always", "normal", "ignore"]);

const personFor = (ctx: Ctx, chatKey: unknown): Row | undefined =>
  chatKey
    ? ctx.table("people").query({ where: [{ column: "chat_key", op: "=", value: chatKey }], limit: 1 })[0]
    : undefined;

/**
 * An answer that is exactly a priority, about one chat, goes straight into
 * `people`. Waiting for the assistant's next run left the chat "unsorted" in
 * between, and an unsorted chat is one it asks about — which is how the same
 * group got asked twice. The question stays `answered`, so the assistant still
 * reads it and can learn from the pattern.
 */
function applyPriority(ctx: Ctx, q: Row): string | null {
  const value = String(q.answer ?? "").trim().toLowerCase();
  if (!PRIORITIES.has(value)) return null;
  const person = personFor(ctx, q.chat_key);
  if (!person) return null;
  ctx.table("people").update(String(person.id), { priority: value }, { writtenBy: ctx.workflow });
  return value;
}

/** Which chat a question is about, and in which app — or which To Do task. */
function about(ctx: Ctx, q: Row): string | null {
  if (q.chat_key) return chatLabel(String(q.chat_key), personFor(ctx, q.chat_key));
  if (!q.task_id) return null;
  const task = ctx.table("tasks").query({ where: [{ column: "page_id", op: "=", value: q.task_id }], limit: 1 })[0];
  return taskLabel(task?.title);
}
