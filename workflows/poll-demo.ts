import { defineWorkflow, poll } from "../src/core/define.ts";

/**
 * The polling pattern, with no network and no credentials: a synthetic feed
 * that grows by one item a minute. Set `enabled: true` to watch it — the first
 * tick baselines what's already there and runs nothing, and every tick after
 * that runs only if a new item has appeared.
 *
 * Disabled by default because a poll is scheduled: an example that ships
 * enabled would run on every deploy of this repo.
 */
interface Item {
  id: number;
  title: string;
}

/** Stands in for "everything the API currently has", newest last. */
function currentFeed(): Item[] {
  const minute = Math.floor(Date.now() / 60_000);
  return Array.from({ length: 5 }, (_, i) => {
    const id = minute - 4 + i;
    return { id, title: `item ${id}` };
  });
}

export default defineWorkflow<Item[]>({
  name: "poll-demo",
  description: "Synthetic feed — runs only when a new item shows up",
  enabled: false,

  trigger: poll("* * * * *", {
    fetch: async () => currentFeed(),
    // Without this the whole item is hashed, so an edited title would look new.
    id: (item) => item.id,
    remember: 100,
  }),

  async run(ctx) {
    // ctx.input is only the items this workflow has never seen.
    for (const item of ctx.input) {
      await ctx.step(`handle ${item.id}`, async () => {
        ctx.log.info(`new: ${item.title}`);
        return { id: item.id };
      });
    }
    return { handled: ctx.input.length };
  },
});
