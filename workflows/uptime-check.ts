import { cron, defineWorkflow } from "../src/core/define.ts";

const TARGETS = ["https://example.com", "https://api.github.com"];

/**
 * The smallest useful workflow: hit some URLs every 15 minutes and shout if one
 * is down. Note ctx.signal being passed through — that's what makes the run's
 * timeout actually cancel the in-flight request.
 */
export default defineWorkflow({
  name: "uptime-check",
  description: "Pings a list of URLs and alerts on the first non-2xx",
  trigger: cron("*/15 * * * *"),
  retries: 1,
  timeoutMs: 30_000,

  async run(ctx) {
    const results = await Promise.all(
      TARGETS.map(async (url) => {
        const started = Date.now();
        try {
          const res = await fetch(url, { signal: ctx.signal, redirect: "follow" });
          return { url, ok: res.ok, status: res.status, ms: Date.now() - started };
        } catch (err) {
          return { url, ok: false, status: 0, ms: Date.now() - started, error: String(err) };
        }
      }),
    );

    const down = results.filter((r) => !r.ok);
    for (const r of results) {
      ctx.log[r.ok ? "info" : "error"](`${r.ok ? "up" : "DOWN"} ${r.url} (${r.ms}ms)`, r);
    }

    if (down.length > 0) {
      await ctx.telegram.send(
        `🔴 ${down.length} target(s) down:\n${down.map((d) => `${d.url} → ${d.status}`).join("\n")}`,
      );
      // Throwing marks the run failed, which is what you want on the dashboard.
      throw new Error(`${down.length} target(s) down`);
    }

    return { checked: results.length, allUp: true };
  },
});
