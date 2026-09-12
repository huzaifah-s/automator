import { bars, defineView, rows, series, stats } from "../../src/core/define.ts";

/**
 * How the runner itself is doing — the Executions tab's numbers, arranged as a
 * page you can look at rather than a list you have to read.
 *
 * Deliberately **not** shareable. There is no `shareable: true` here and there
 * should not be: this page names every workflow in the deployment and how
 * often each one fails, which is a description of the inside of the system.
 * The finance view is the one that is worth handing to somebody; this one is
 * for whoever already has the dashboard password.
 *
 * It also exists as the second consumer of the view API, which is the only
 * thing that keeps `ctx.runs` honest — a feature with one caller quietly
 * becomes shaped like that caller.
 */
export default defineView({
  name: "runner-health",
  title: "Runner health",
  description: "Runs by day and by workflow, and where the time is going.",

  refresh: 30,

  controls: {
    period: {
      kind: "period",
      label: "Window",
      default: "7d",
      options: ["7d", "30d", "90d"],
    },
  },

  async load(ctx) {
    const period = ctx.period("period");
    // `since` is null only for "all time", which this view does not offer.
    const since = period.since ?? 0;

    const counts = ctx.runs.counts(since);
    const succeeded = counts.success ?? 0;
    const failed = counts.failed ?? 0;
    const skipped = counts.skipped ?? 0;
    const total = succeeded + failed + skipped + (counts.running ?? 0);

    /*
     * `dailyCounts` returns one row per workflow per day per status, which is
     * three dimensions and a chart can carry two. Folded to day × status here:
     * "which day was bad" is the question this chart answers, and "which
     * workflow" is the panel underneath it.
     */
    const perDay = new Map<number, { ok: number; bad: number }>();
    for (const row of ctx.runs.daily(since)) {
      const day = perDay.get(row.day) ?? { ok: 0, bad: 0 };
      if (row.status === "failed") day.bad += row.count;
      else if (row.status === "success") day.ok += row.count;
      perDay.set(row.day, day);
    }
    const days = [...perDay.entries()].sort((a, b) => a[0] - b[0]);

    // Failures per workflow, from the runs themselves rather than from a
    // second aggregate: this is a handful of rows either way, and one source
    // cannot disagree with itself.
    const failures = new Map<string, number>();
    for (const run of ctx.runs.list({ status: "failed", since, limit: 500 })) {
      failures.set(run.workflow, (failures.get(run.workflow) ?? 0) + 1);
    }
    const worst = [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

    const slow = ctx.runs.stepHotspots(since, 10);

    return [
      stats([
        { label: `Runs · ${period.label.toLowerCase()}`, value: String(total) },
        { label: "Succeeded", value: String(succeeded), tone: succeeded ? "good" : "plain" },
        { label: "Failed", value: String(failed), tone: failed ? "bad" : "plain" },
        { label: "Skipped", value: String(skipped), tone: skipped ? "warn" : "plain" },
      ]),

      series({
        title: "Runs per day",
        legend: ["Succeeded", "Failed"],
        points: days.map(([day, c]) => ({
          label: new Date(day).toISOString().slice(5, 10),
          values: [c.ok, c.bad],
          displays: [`${c.ok} ok`, `${c.bad} failed`],
        })),
        empty: "Nothing ran in this window.",
      }),

      bars({
        title: "Failures by workflow",
        rows: worst.map(([name, n]) => ({
          label: name,
          value: n,
          display: String(n),
          tone: "bad",
        })),
        empty: "Nothing failed in this window.",
      }),

      rows({
        title: "Slowest steps",
        note: "Total time spent in each step across the window, and how often it was retried.",
        columns: [
          { key: "workflow", label: "Workflow", mono: true },
          { key: "step", label: "Step" },
          { key: "runs", label: "Runs", align: "right", mono: true },
          { key: "avg", label: "Average", align: "right", mono: true },
          { key: "retried", label: "Retried", align: "right", mono: true },
        ],
        data: slow.map((s) => ({
          workflow: s.workflow,
          step: s.name,
          runs: s.runs,
          avg: s.avg_ms === null ? "—" : `${Math.round(s.avg_ms)}ms`,
          retried: s.retried,
        })),
        empty: "No steps recorded in this window.",
      }),
    ];
  },
});
