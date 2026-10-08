import { z } from "zod";
import {
  assistantTools,
  CATEGORIES,
  chatPass,
  chatsToPass,
  claudeOwnLogin,
  cron,
  defineSecrets,
  defineWorkflow,
  isPractice,
  type Ctx,
  type Decision,
  type PassTarget,
} from "../../src/core/define.ts";

/**
 * Personal assistant — the chat pass: every five minutes, each chat where
 * somebody wrote last gets one Claude call of its own, and what it decides
 * is done.
 *
 * This is the part of the hourly routine that matters most — reading chats,
 * deciding what needs him, drafting his replies, sorting new chats, filing
 * the tasks and loops a chat makes plain — moved out of one long session
 * that did eight jobs at once (src/server/assistant-writer.ts says why). The
 * loop is code; the model sees one chat at a time and answers with one
 * decision; this file applies it through the assistant's own tools
 * (`assistantTools`), so every rule they enforce still holds: a draft only
 * for a chat in `people`, one open draft per chat, the second reader on every
 * draft, his priority beating hers, the hourly question budget.
 *
 * **Which chats** (`chatsToPass`): a draft he commented on that live Maria
 * has not revised; then chats where somebody wrote last, `always` first,
 * once their newest message is a few minutes old, and only when something
 * arrived since the last pass read them; then new chats nobody has sorted.
 * A group message that neither replies to him nor names him is not read by a
 * model at all — recorded as `skipped` — except in an `always` group, read
 * at most every half hour in case something was asked of everyone.
 *
 * **A draft the check sends back** goes back to the writer once with the
 * issues; the rewrite is saved whatever the second check says, as with any
 * draft.
 *
 * **What is kept**: a `chat_passes` row per chat read — decision, her
 * one-line why, the draft it saved — and the run's counts. Log lines carry
 * counts and refusals, never names or words.
 *
 * Every call is Claude Code on his subscription (`CLAUDE_CODE_OAUTH_TOKEN`);
 * without a token it does nothing and the routine drafts as before. A day's
 * calls are capped (`ASSISTANT_PASS_MAX_PER_DAY`). While this workflow is on,
 * `waiting` tells the routine to leave drafting and sorting to it.
 */

const TZ = "Asia/Kuala_Lumpur";
const LABEL = "chat pass";
const claude = defineSecrets({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(20).optional(),
  CLAUDE_CODE_OAUTH_TOKEN_2: z.string().min(20).optional(),
});

/** Chats read per run; the next run, five minutes later, takes the rest. */
const PER_RUN = 6;
/** No new chat is started after this much of a run — it must end before the next. */
const RUN_BUDGET_MS = 4 * 60_000;
const USAGE = "passes";

const dayCap = () => {
  const n = Number(process.env.ASSISTANT_PASS_MAX_PER_DAY);
  return Number.isFinite(n) && n >= 0 && process.env.ASSISTANT_PASS_MAX_PER_DAY !== "" ? n : 200;
};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

type Box = ReturnType<typeof assistantTools>;

export default defineWorkflow({
  name: "personal-assistant-chat-pass",
  description: "Every 5 minutes: reads each chat where somebody wrote last, one Claude call per chat — drafts, sorts, files tasks",
  trigger: cron("*/5 8-23 * * *", { tz: TZ }),
  retries: 0,
  timeoutMs: 9 * 60_000,
  onOverlap: "skip",

  async run(ctx) {
    const tokens = [claude.CLAUDE_CODE_OAUTH_TOKEN ?? "", claude.CLAUDE_CODE_OAUTH_TOKEN_2 ?? ""];
    if (!tokens.some(Boolean) && !claudeOwnLogin()) return { skipped: "no Claude token" };

    const { targets, notForHim } = chatsToPass();
    if (isPractice()) {
      // What it would read; the first call shows as held, nothing is written.
      if (targets[0]) await chatPass(ctx, tokens, targets[0].key, { revise: targets[0].draft });
      return { practice: true, wouldRead: targets.length, notForHim: notForHim.length };
    }

    const passes = ctx.table("chat_passes");
    for (const t of notForHim) {
      passes.insert(
        { chat_key: t.key, chat_name: t.name, upto_at: t.upto, decision: "skipped", why: "Group messages, none replying to him or naming him" },
        { writtenBy: ctx.workflow },
      );
    }

    const stored = await ctx.state.get<{ day: string; calls: number }>(USAGE);
    const usage = stored?.day === today() ? stored : { day: today(), calls: 0 };
    const box = assistantTools({ label: LABEL });
    const started = Date.now();
    const counts = { read: 0, drafts: 0, revised: 0, withdrawn: 0, none: 0, failed: 0, sorted: 0, tasks: 0, loops: 0, sentBack: 0 };
    let capped = false;

    for (const t of targets.slice(0, PER_RUN)) {
      if (Date.now() - started > RUN_BUDGET_MS) break;
      if (usage.calls >= dayCap()) {
        capped = true;
        break;
      }
      usage.calls++;
      counts.read++;
      const began = Date.now();
      const pass = await chatPass(ctx, tokens, t.key, { revise: t.draft });
      if (!pass.decision) {
        counts.failed++;
        passes.insert(
          { chat_key: t.key, chat_name: t.name, upto_at: t.upto, decision: "failed", why: pass.failed ?? null, ms: pass.ms },
          { writtenBy: ctx.workflow },
        );
        continue;
      }
      const done = await apply(ctx, box, t, pass.decision, async (sentBack) => {
        usage.calls++;
        return (await chatPass(ctx, tokens, t.key, { revise: t.draft, sentBack })).decision;
      });
      if (t.mode === "revise" && done.decision === "none") {
        // He asked for a change and got neither a new version nor a
        // withdrawal: the routine no longer revises, so this must be tried
        // again rather than left in revise for good.
        counts.failed++;
        passes.insert(
          { chat_key: t.key, chat_name: t.name, upto_at: t.upto, decision: "failed", why: "No new version of the draft he commented on", ms: Date.now() - began },
          { writtenBy: ctx.workflow },
        );
        continue;
      }
      counts[done.decision === "draft" ? "drafts" : done.decision === "revise" ? "revised" : done.decision === "withdraw" ? "withdrawn" : "none"]++;
      if (done.sentBack) counts.sentBack++;
      counts.sorted += done.did.filter((d) => d.startsWith("sorted")).length;
      counts.tasks += done.did.filter((d) => d.startsWith("task")).length;
      counts.loops += done.did.filter((d) => d.startsWith("loop")).length;
      passes.insert(
        {
          chat_key: t.key,
          chat_name: t.name,
          upto_at: t.upto,
          decision: done.decision,
          why: done.why,
          draft_id: done.draftId,
          did: done.did.join(", ") || null,
          ms: Date.now() - began,
        },
        { writtenBy: ctx.workflow },
      );
    }
    await ctx.state.set(USAGE, usage, { ttlSeconds: 3 * 86_400 });
    return { waiting: targets.length, notForHim: notForHim.length, ...counts, ...(capped ? { capped: true } : {}) };
  },
});

/**
 * Does what one decision says, through the assistant's tools, in the order
 * that keeps them consistent: who the chat is, then the draft, then the task
 * and the loop. A tool's refusal is logged (its name and the refusal's first
 * words — never the arguments) and the rest carries on.
 */
async function apply(
  ctx: Ctx,
  box: Box,
  t: PassTarget,
  d: Decision,
  rewrite: (sentBack: { text: string; issues: string[] }) => Promise<Decision | null>,
): Promise<{ decision: "draft" | "none" | "revise" | "withdraw"; why: string | null; draftId: string | null; did: string[]; sentBack: boolean }> {
  const did: string[] = [];
  const person = ctx.table("people").query({ where: [{ column: "chat_key", op: "=", value: t.key }], limit: 1 })[0];
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = await box.call(tool, args);
    if (r.isError) ctx.log.warn(`Chat pass: ${tool} refused — ${r.text.split("\n")[0]!.slice(0, 120)}`);
    return r;
  };

  if (d.priority && !person?.priority) {
    const r = await call("update_person", { chat: t.key, priority: d.priority.value, reason: d.priority.reason.slice(0, 120) });
    if (!r.isError) did.push(`sorted ${d.priority.value}`);
  }
  if (d.notes && !person?.notes) {
    const r = await call("update_person", { chat: t.key, notes: d.notes.slice(0, 400) });
    if (!r.isError) did.push("noted");
  }

  let decision: "draft" | "none" | "revise" | "withdraw" = "none";
  let draftId: string | null = null;
  let sentBack = false;
  const why = d.why?.trim() || null;

  if (t.mode === "revise" && d.withdraw && t.draft) {
    const r = await call("withdraw_draft", { id: String(t.draft.id), reason: d.withdraw.slice(0, 200) });
    if (!r.isError) decision = "withdraw";
  } else if (d.reply && d.text) {
    const args = {
      chat: t.key,
      text: d.text,
      why: (why ?? "Needs your reply").slice(0, 200),
      ...(d.reply_to ? { reply_to: d.reply_to } : {}),
      ...(t.mode === "revise" && t.draft ? { replaces: String(t.draft.id) } : {}),
    };
    let r = await call("draft_reply", args);
    if (r.isError && r.text.startsWith("Not saved")) {
      // The second reader sent it back: once more with what to fix. Its
      // rewrite is saved whatever the next check says; with no rewrite, the
      // first try goes again and is saved as the second attempt.
      sentBack = true;
      const issues = r.text
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2));
      const again = await rewrite({ text: d.text, issues });
      r = await call("draft_reply", { ...args, text: again?.reply && again.text ? again.text : d.text });
    }
    const saved = r.isError ? null : r.text.match(/^Draft (\S+) for/)?.[1];
    if (saved) {
      draftId = saved;
      decision = t.mode === "revise" ? "revise" : "draft";
    }
  }

  if (d.task) {
    const category = d.task.category && CATEGORIES.includes(d.task.category) ? d.task.category : undefined;
    const r = await call("create_task", {
      title: d.task.title,
      due: d.task.due,
      due_is_guess: d.task.due_is_guess ?? false,
      ...(category ? { category } : {}),
      ...(d.task.notes ? { notes: d.task.notes } : {}),
      chat: t.key,
    });
    const id = r.isError ? null : r.text.match(/^Task ([0-9a-f]{32}) created/)?.[1];
    if (id) {
      did.push(`task ${id.slice(0, 8)}`);
      const options = (d.task.category_options ?? []).filter((o) => CATEGORIES.includes(o));
      if (!category && options.length >= 2) {
        const app = t.key.startsWith("telegram:") ? "Telegram" : "WhatsApp";
        await call("ask", {
          question: `Which category for *${d.task.title}* (from ${t.name}, ${app})?`,
          options: options.slice(0, 4),
          task: id,
        });
      }
    }
  }

  if (d.loop && "open" in d.loop) {
    const r = await call("open_loop", {
      what: d.loop.open.what,
      waiting_on: d.loop.open.waiting_on,
      chat: t.key,
      ...(d.loop.open.due ? { due: d.loop.open.due } : {}),
    });
    if (!r.isError) did.push("loop opened");
  } else if (d.loop && "close" in d.loop) {
    const r = await call("close_loop", { id: d.loop.close, ...(d.loop.how ? { note: d.loop.how.slice(0, 300) } : {}) });
    if (!r.isError) did.push("loop closed");
  }

  return { decision, why, draftId, did, sentBack };
}
