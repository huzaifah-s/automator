import {
  defineView,
  note,
  rows,
  scorecard,
  scorecardSlots,
  stats,
  type Headline,
  type ScorecardWhich,
} from "../../src/core/define.ts";

/**
 * Maria's scorecard — whether the assistant is getting better, in numbers.
 *
 * The same numbers as the card she sends Wednesday and Sunday at 20:00 and
 * her own `scorecard` tool: all three call `scorecard()` in
 * src/core/scorecard.ts, so they cannot disagree. A period is the half-week
 * ending at a card, against the same days a week earlier.
 *
 * Not shareable: it counts how a private assistant handled private chats,
 * and nobody outside the dashboard needs it.
 */

const HISTORY = 6;
/** Column heads for the history table, which has to fit a phone. */
const SHORT: Record<Headline["key"], string> = {
  sent_as_written: "Sent as is",
  questions_per_day: "Asks",
  tasks_kept: "Tasks kept",
  reply_minutes: "Reply",
  unlearned: "Unlearned",
  sorting_kept: "Sorts kept",
};

/** Short enough for a tile on a phone: "↑ 63% · ≥ 70%". */
const sub = (h: Headline) => {
  const target = `${h.better === "up" ? "≥" : "≤"} ${h.unit === "%" ? `${h.target}%` : `${h.target}${h.unit === "min" ? " min" : h.unit}`}`;
  return h.arrow ? `${h.arrow} ${h.beforeDisplay} · ${target}` : `goal ${target}`;
};

export default defineView({
  name: "maria-scorecard",
  title: "Maria's scorecard",
  description: "Whether the assistant is getting better: drafts, questions, tasks, replies, learning, sorting.",
  refresh: 300,

  controls: {
    period: {
      kind: "select",
      label: "Half-week",
      options: [
        { value: "last", label: "Last card" },
        { value: "current", label: "So far" },
      ],
      default: "last",
    },
  },

  load(ctx) {
    const which: ScorecardWhich = ctx.control("period") === "current" ? "current" : "last";
    const card = scorecard(which, ctx.now);

    const tiles = stats(
      card.headlines.map((h) => ({
        label: h.label,
        value: h.display,
        sub: sub(h),
        tone: h.onTarget === null ? "plain" : h.onTarget ? "good" : "bad",
      })),
    );

    const worst = card.worst
      ? `Furthest from target: ${card.worst.label.toLowerCase()}, ${card.worst.display}.` +
        (card.lesson
          ? ` Her lesson for it: “${String(card.lesson.lesson)}”`
          : which === "last"
            ? " She writes one lesson aimed at it on her next run."
            : "")
      : "Every number with data is on target.";

    const counts = rows({
      title: `${card.period.label} against ${card.compare.label}`,
      columns: [
        { key: "what", label: "Count" },
        { key: "now", label: "This half", align: "right", mono: true },
        { key: "before", label: "Last week", align: "right", mono: true },
      ],
      data: card.areas.flatMap((a) =>
        a.counts.map((c) => ({ what: `${a.title} · ${c.label.toLowerCase()}`, now: c.now, before: c.before ?? "—" })),
      ),
    });

    // Earlier finished half-weeks, newest first: is the trend real?
    const slots = scorecardSlots(ctx.now, HISTORY + 1);
    const history = slots.slice(0, HISTORY).map((end) => scorecard("last", end));
    const keys = history[0]?.headlines.filter((h) => h.key !== "unlearned") ?? [];
    const trend = rows({
      title: "Earlier half-weeks",
      note: "Each row is one card. Outcomes not learned is a snapshot of now, so it is left out here.",
      columns: [
        { key: "period", label: "Half-week" },
        ...keys.map((h) => ({ key: h.key, label: SHORT[h.key], align: "right" as const, mono: true })),
      ],
      data: history.map((c) => ({
        period: c.period.label,
        ...Object.fromEntries(c.headlines.map((h) => [h.key, h.display])),
      })),
    });

    return [tiles, note({ title: card.period.label, body: worst }), counts, trend];
  },
});
