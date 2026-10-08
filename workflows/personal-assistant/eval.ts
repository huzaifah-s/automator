import { z } from "zod";
import {
  claudeOwnLogin,
  cron,
  defineSecrets,
  defineWorkflow,
  evalCases,
  evalVariants,
  isPractice,
  runEval,
  scoreSystems,
} from "../../src/core/define.ts";

/**
 * Personal assistant — the replay test: is Maria's writing getting better,
 * as a number you can check before a change goes live.
 *
 * Replays moments that already happened through the chat pass's writer, as
 * things stood then, and has a fresh Claude grade each draft against what he
 * really sent (src/server/assistant-eval.ts). Each run writes one `evals`
 * row per system: `baseline` (what she actually did at the time), `current`
 * (the writer the chat pass runs) and any variant named.
 *
 * **Before a change to how she writes**: add it to `WRITER_VARIANTS`
 * (src/server/assistant-writer.ts), deploy — the chat pass still runs
 * `current` — then run this with `{ "variants": ["current", "<yours>"] }`.
 * Promote it only if it scores higher on the same cases.
 *
 * On its own it runs Wednesday and Sunday at 19:00, an hour before the
 * scorecard, with `current` only — a trend line of the live writer.
 *
 * Every draft and grade is Claude Code on his subscription, about two calls
 * a case; a 30-case run is ~60 calls and a few minutes. Nothing written is
 * kept; the run's result and `evals` are counts.
 */

const claude = defineSecrets({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(20).optional(),
  CLAUDE_CODE_OAUTH_TOKEN_2: z.string().min(20).optional(),
});

const input = z
  .object({
    variants: z.array(z.string()).min(1).max(4).optional(),
    max: z.number().int().min(4).max(80).optional(),
  })
  .default({});

export default defineWorkflow({
  name: "personal-assistant-eval",
  description: "Replays past moments through Maria's writer and grades the drafts against what he really sent",
  trigger: cron("0 19 * * 0,3", { tz: "Asia/Kuala_Lumpur" }),
  retries: 0,
  timeoutMs: 40 * 60_000,

  async run(ctx) {
    const opts = input.parse(ctx.input ?? {});
    const known = evalVariants();
    const variants = opts.variants ?? ["current"];
    const unknown = variants.filter((v) => !known.includes(v));
    if (unknown.length) throw new Error(`Unknown variant(s) ${unknown.join(", ")} — known: ${known.join(", ")}`);

    const tokens = [claude.CLAUDE_CODE_OAUTH_TOKEN ?? "", claude.CLAUDE_CODE_OAUTH_TOKEN_2 ?? ""];
    if (!tokens.some(Boolean) && !claudeOwnLogin()) return { skipped: "no Claude token" };

    const cases = evalCases(opts.max ?? 30);
    const kinds = cases.reduce<Record<string, number>>((n, c) => ({ ...n, [c.kind]: (n[c.kind] ?? 0) + 1 }), {});
    if (cases.length === 0) return { cases: 0, why: "nothing to replay yet" };
    if (isPractice()) return { practice: true, cases: cases.length, kinds };

    const started = Date.now();
    const results = await runEval(ctx, tokens, cases, variants);
    const systems = ["baseline", ...variants];
    const scores = scoreSystems(results, systems).filter((s) => s.cases > 0);
    for (const s of scores) {
      ctx.table("evals").insert({ batch: ctx.runId, ...s }, { writtenBy: ctx.workflow });
    }
    ctx.log.info(`Replay: ${cases.length} case(s), ${scores.map((s) => `${s.system} ${s.score ?? "-"}%`).join(", ")}, ${Date.now() - started}ms`);
    return {
      cases: cases.length,
      kinds,
      scores: Object.fromEntries(scores.map((s) => [s.system, { score: s.score, vsBaseline: s.common_score, cases: s.cases, noAnswer: s.no_answer }])),
      ms: Date.now() - started,
    };
  },
});
