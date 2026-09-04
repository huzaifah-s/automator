import { defineWorkflow, manual } from "../src/core/define.ts";

/**
 * The polling-cursor pattern: a fixed feed, but each run only reports what it
 * hasn't seen before. Run it twice — the second run finds nothing new, which is
 * the whole point. `bun run trigger -- state-demo`
 */
const FEED = [
  { id: 1, title: "first" },
  { id: 2, title: "second" },
  { id: 3, title: "third" },
];

export default defineWorkflow({
  name: "state-demo",
  description: "Polling cursor — only reports feed items newer than the last run",
  trigger: manual(),

  async run(ctx) {
    // Checkpointing is off here: the point of the demo is what survives
    // *between* runs, not what a retry reuses within one.
    const cursor = (await ctx.state.get<number>("cursor")) ?? 0;

    const fresh = await ctx.step(
      "collect new items",
      async () => FEED.filter((item) => item.id > cursor),
      { input: { cursor }, checkpoint: false },
    );

    if (fresh.length > 0) {
      await ctx.state.set("cursor", Math.max(...fresh.map((i) => i.id)));
    }

    // update() is a read-modify-write in one tick, so concurrent runs can't
    // lose an increment the way get-then-set would.
    const seen = await ctx.state.update<number>("runs-so-far", (n) => (n ?? 0) + 1);

    ctx.log.info(
      fresh.length > 0
        ? `${fresh.length} new item(s): ${fresh.map((i) => i.title).join(", ")}`
        : "nothing new since the last run",
    );

    return { cursorWas: cursor, newItems: fresh.length, runsSoFar: seen };
  },
});
