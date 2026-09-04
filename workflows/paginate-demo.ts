import { defineWorkflow, manual } from "../src/core/define.ts";

/**
 * Walking a paginated API, against a real one that needs no credentials:
 * GitHub sends an RFC 5988 `Link: <…>; rel="next"` header, which
 * `ctx.http.paginate` follows on its own.
 *
 * Safe to ship enabled because it is `manual()` — nothing schedules it. Run it
 * from the dashboard and the run page shows one recorded HTTP call per page.
 */
interface Contributor {
  login: string;
  contributions: number;
}

export default defineWorkflow({
  name: "paginate-demo",
  description: "Pages through GitHub contributors with ctx.http.paginate",
  trigger: manual(),
  timeoutMs: 60_000,

  async run(ctx) {
    const contributors = await ctx.step(
      "page through contributors",
      () =>
        ctx.http
          .paginate<Contributor>("https://api.github.com/repos/oven-sh/bun/contributors", {
            query: { per_page: 30 },
            // Unauthenticated GitHub allows 60 requests an hour, so this asks
            // for three pages rather than all ninety-odd.
            maxItems: 90,
          })
          .all(),
      { input: { repo: "oven-sh/bun", perPage: 30 } },
    );

    // The iterator form is the one to reach for when the pages are big: it
    // never holds more than one page in memory.
    let commits = 0;
    for await (const c of ctx.http.paginate<Contributor>(
      "https://api.github.com/repos/oven-sh/bun/contributors",
      { query: { per_page: 100 }, maxItems: 100 },
    )) {
      commits += c.contributions;
    }

    return {
      contributors: contributors.length,
      top: contributors.slice(0, 3).map((c) => c.login),
      commitsCounted: commits,
    };
  },
});
