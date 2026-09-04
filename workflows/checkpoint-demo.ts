import { defineWorkflow, manual } from "../src/core/define.ts";

/**
 * Demonstrates checkpoint resume. Run it from the dashboard: it fails on the
 * third step, and the failed run gets a "Resume from last good step" button.
 * Resuming reuses steps 1 and 2 — watch their timings drop to nothing and the
 * "reused" tag appear — and only re-runs the step that broke.
 *
 * The flag below stands in for you finding the bug and fixing the code.
 */
let bugFixed = false;

export default defineWorkflow({
  name: "checkpoint-demo",
  description: "Fails on step 3 so you can try Resume — steps 1 and 2 are reused",
  trigger: manual(),
  // No retries, so the failure is immediate and the checkpoint is easy to see.
  retries: 0,

  async run(ctx) {
    const users = await ctx.step(
      "fetch users",
      async () => {
        await new Promise((r) => setTimeout(r, 600)); // stand-in for a slow API
        return [
          { id: 1, email: "ada@example.com" },
          { id: 2, email: "alan@example.com" },
        ];
      },
      { input: { source: "users-api", limit: 2 } },
    );

    const enriched = await ctx.step(
      "enrich",
      async () => {
        await new Promise((r) => setTimeout(r, 600));
        return users.map((u) => ({ ...u, domain: u.email.split("@")[1] }));
      },
      { input: { count: users.length } },
    );

    return ctx.step(
      "deliver",
      async () => {
        if (!bugFixed) {
          bugFixed = true; // "you fixed it and redeployed"
          throw new Error("Downstream API rejected the payload (schema changed)");
        }
        return { delivered: enriched.length };
      },
      { input: enriched },
    );
  },
});
