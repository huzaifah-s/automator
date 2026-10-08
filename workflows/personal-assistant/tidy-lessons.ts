import { z } from "zod";
import { askClaude, claudeOwnLogin, cron, defineCredential, defineSecrets, defineWorkflow, isPractice, type Row } from "../../src/core/define.ts";
import { botApi, chatLabel, conflictsCard, TIDY_PREFIX, tidyCard } from "./_bot.ts";

/**
 * Personal assistant — every night, lessons that say the same thing become
 * one, so the list she reads before everything stays short and clear.
 *
 * Lessons are written one correction at a time, and they pile up: by 8 Oct
 * three said "no kau/aku with work contacts" in different words and three
 * more overlapped on chasing payments. Every lesson competes for her
 * attention with every other, so a long, repetitive list is followed worse
 * than a short one. This is the "sleep-time" pass: while he sleeps, a
 * Claude with no tools reads them all and proposes merges, and code applies
 * only the ones that hold up:
 *
 * - a merge replaces at least two lessons, all active, all with the same
 *   scope (one chat, or everyone) and the same kind (how to write, tasks,
 *   sorting, follow-ups) — never across;
 * - each lesson is in at most one merge, and the merged one is at most 300
 *   characters, like any lesson;
 * - style lessons (one per chat, kept by learn-style) and scorecard lessons
 *   (`now` watches for those) are never touched.
 *
 * The merged lesson is a new row (`evidence` "Tidied from <ids>") with the
 * strongest source among those it replaced — "you" if he said any of them
 * directly — and the old ones are retired, not deleted. He gets a card with
 * an ↩ per merge that puts the old ones back (the bot does it at once); and,
 * separately, any lessons the model found contradicting each other, for him
 * to settle by replying. A night with nothing to merge sends nothing.
 */

const TZ = "Asia/Kuala_Lumpur";
const bot = defineCredential("telegram", "maria");
const claude = defineSecrets({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(20).optional(),
  CLAUDE_CODE_OAUTH_TOKEN_2: z.string().min(20).optional(),
});

/** Fewer lessons than this are not worth a call. */
const MIN_LESSONS = 6;
const MERGES_MAX = 8;
const CONFLICTS_MAX = 3;
/** Never merged: kept by their own mechanisms. */
const UNTOUCHED = new Set(["style", "scorecard"]);
/** Lessons merge only within one kind. */
const KIND: Record<string, string> = {
  comment: "writing",
  skip: "writing",
  sent: "writing",
  answer: "writing",
  you: "writing",
  task: "tasks",
  sorting: "sorting",
  followup: "follow-ups",
};
/** The strongest source wins: what he said directly outranks what was inferred. */
const STRENGTH = ["you", "comment", "answer", "skip", "sent", "task", "sorting", "followup"];

const SYSTEM = `You tidy a personal assistant's lessons — instructions her user taught her, one per line, each followed every time. A long list with repeats is followed worse than a short clear one. Find lessons that say the same thing or overlap, and merge each such set into ONE lesson that keeps every instruction of the ones it replaces.

Rules:
- Merge only lessons in the same group (the same scope and kind, as headed below). Never across groups.
- A merged lesson is imperative, at most 300 characters, and loses nothing: every instruction, condition, exception, and his example words in quotes. If it cannot fit, do not merge.
- Never change what a lesson means and never add anything. Two lessons that disagree are not merged: list them under conflicts.
- A lesson that overlaps nothing is left alone — do not reword it.
- Where it helps, start the merged lesson with who it is for: "Work contacts and clients: …", "Friends: …".

Answer with JSON only:
{"merges": [{"replaces": ["id", "id"], "lesson": "..."}], "conflicts": [["id", "id"]]}
Empty lists when there is nothing to do.`;

const answerSchema = z.object({
  merges: z.array(z.object({ replaces: z.array(z.string()).min(2).max(8), lesson: z.string().min(10).max(300) })).catch([]),
  conflicts: z.array(z.array(z.string()).length(2)).catch([]),
});

export default defineWorkflow({
  name: "personal-assistant-tidy-lessons",
  description: "Every night: merges Maria's lessons that say the same thing, with a card to undo each merge",
  trigger: cron("45 23 * * *", { tz: TZ }),
  retries: 0,
  timeoutMs: 5 * 60_000,

  async run(ctx) {
    const tokens = [claude.CLAUDE_CODE_OAUTH_TOKEN ?? "", claude.CLAUDE_CODE_OAUTH_TOKEN_2 ?? ""];
    if (!tokens.some(Boolean) && !claudeOwnLogin()) return { skipped: "no Claude token" };

    const lessons = ctx
      .table("lessons")
      .query({ limit: 1000 })
      .filter((l) => !l.retired && !UNTOUCHED.has(String(l.source)) && KIND[String(l.source)]);
    if (lessons.length < MIN_LESSONS) return { lessons: lessons.length, merged: 0, why: "too few to tidy" };

    const people = new Map(ctx.table("people").query({ limit: 1000 }).map((p) => [String(p.chat_key), p]));
    const whereOf = (key: string) => chatLabel(key, people.get(key));
    const group = (l: Row) => `${l.chat_key ?? "everyone"}|${KIND[String(l.source)]}`;
    const groups = new Map<string, Row[]>();
    for (const l of lessons) (groups.get(group(l)) ?? groups.set(group(l), []).get(group(l))!).push(l);
    const prompt = [...groups]
      .filter(([, ls]) => ls.length >= 2)
      .map(([g, ls]) => {
        const [scope, kind] = g.split("|");
        const head = scope === "everyone" ? `Everyone — ${kind}` : `One chat (${whereOf(scope!)}) — ${kind}`;
        return `## ${head}\n${ls.map((l) => `- ${l.id}: ${String(l.lesson).replace(/\s+/g, " ")}`).join("\n")}`;
      })
      .join("\n\n");
    if (!prompt) return { lessons: lessons.length, merged: 0, why: "no group has two lessons" };

    const answer = await askClaude(ctx, tokens, { who: "Tidy lessons", system: SYSTEM, prompt, effort: "medium", deadlineMs: 120_000 });
    if (!answer) return { lessons: lessons.length, merged: 0, why: isPractice() ? "practice" : "no answer" };
    let parsed: z.infer<typeof answerSchema>;
    try {
      parsed = answerSchema.parse(JSON.parse(answer.text.match(/\{[\s\S]*\}/)?.[0] ?? ""));
    } catch {
      return { lessons: lessons.length, merged: 0, why: "unreadable answer" };
    }

    // Only merges that hold up are applied; see the header.
    const byId = new Map(lessons.map((l) => [String(l.id), l]));
    const used = new Set<string>();
    const merged: Row[] = [];
    let refused = 0;
    for (const m of parsed.merges) {
      const olds = [...new Set(m.replaces)].map((id) => byId.get(id));
      const ok =
        merged.length < MERGES_MAX &&
        olds.length >= 2 &&
        olds.every((l): l is Row => Boolean(l) && !used.has(String(l!.id))) &&
        new Set(olds.map((l) => group(l!))).size === 1;
      if (!ok) {
        refused++;
        continue;
      }
      const rows = olds as Row[];
      const source = STRENGTH.find((s) => rows.some((l) => l.source === s)) ?? String(rows[0]!.source);
      const { row } = ctx.table("lessons").insert(
        {
          lesson: m.lesson.replace(/\s+/g, " ").trim(),
          chat_key: rows[0]!.chat_key ?? null,
          source,
          evidence: `${TIDY_PREFIX}${rows.map((l) => l.id).join(" ")}`,
        },
        { writtenBy: ctx.workflow },
      );
      for (const l of rows) {
        used.add(String(l.id));
        ctx.table("lessons").update(String(l.id), { retired: true }, { writtenBy: ctx.workflow });
      }
      merged.push(row);
    }
    const conflicts = parsed.conflicts
      .map(([a, b]) => [byId.get(a!), byId.get(b!)] as const)
      .filter((p): p is readonly [Row, Row] => Boolean(p[0] && p[1]) && !used.has(String(p[0]!.id)) && !used.has(String(p[1]!.id)))
      .slice(0, CONFLICTS_MAX)
      .map(([a, b]) => [a, b] as [Row, Row]);

    const api = botApi(ctx, bot);
    let card: number | null = null;
    if (merged.length) {
      const { html, buttons } = tidyCard(merged, whereOf);
      card = await ctx.step("card", () => api.send(html, buttons));
    }
    if (conflicts.length) await ctx.step("conflicts", () => api.send(conflictsCard(conflicts, whereOf)));
    return {
      lessons: lessons.length,
      merged: merged.length,
      replaced: used.size,
      refused,
      conflicts: conflicts.length,
      ...(card ? { card } : {}),
    };
  },
});
