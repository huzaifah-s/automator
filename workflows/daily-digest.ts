import { z } from "zod";
import { cron, defineSecrets, defineWorkflow } from "../src/core/define.ts";

// Validated the moment this file is imported — a missing key stops the boot.
const secrets = defineSecrets({
  GITHUB_TOKEN: z.string().min(10),
});

/**
 * Every weekday at 09:00, summarise yesterday's GitHub activity and post it.
 * Shows off ctx.step, ctx.http, ctx.ai, and ctx.slack in one place.
 */
export default defineWorkflow({
  name: "daily-digest",
  description: "Weekday summary of repo activity, written by Claude, posted to Slack",
  trigger: cron("0 9 * * 1-5", { tz: "Asia/Kuala_Lumpur" }),
  retries: 2,
  timeoutMs: 120_000,

  async run(ctx) {
    const since = new Date(Date.now() - 86_400_000).toISOString();

    const commits = await ctx.step("fetch commits", () =>
      ctx.http.get<{ commit: { message: string; author: { name: string } } }[]>(
        "https://api.github.com/repos/oven-sh/bun/commits",
        {
          query: { since, per_page: 30 },
          headers: { authorization: `Bearer ${secrets.GITHUB_TOKEN}` },
        },
      ),
    );

    if (commits.length === 0) {
      ctx.log.info("Nothing landed yesterday — skipping the post");
      return { posted: false, commits: 0 };
    }

    const summary = await ctx.step("summarise", () =>
      ctx.ai.claude(
        `Summarise these commit messages as 3-5 short bullets for a standup.\n\n` +
          commits.map((c) => `- ${c.commit.message.split("\n")[0]}`).join("\n"),
        { effort: "low", maxTokens: 800 },
      ),
    );

    await ctx.step("post to slack", () =>
      ctx.slack.send("#engineering", `*Daily digest* (${commits.length} commits)\n${summary}`),
    );

    return { posted: true, commits: commits.length };
  },

  // Runs once after every attempt has failed, on top of the global alert.
  async onFailure(ctx, error) {
    await ctx.slack.send("#alerts", `daily-digest failed: ${error.message}`);
  },
});
