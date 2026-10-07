import { z } from "zod";
import { defineCredential, defineWorkflow, manual } from "../../src/core/define.ts";
import { CATEGORY, DUE, headers, matchCategory, readDataSource, taskFields, taskProps, type Page } from "./_notion.ts";

/**
 * Personal assistant — sets the category or due date of a task it created.
 *
 * Started by the assistant's `update_task` tool, which only accepts a task
 * with a `created` row in `task_work`: this is how a category it was unsure
 * of gets filled in once you answer, never a way to change your own tasks.
 * Only those two properties — no status, nothing on the page.
 *
 * The `created` row's `seen_text` moves with the change, in the same step, so
 * the sync does not read the assistant's own update as yours.
 */

const notion = defineCredential("notion", "huzaifah-notion");

const input = z
  .object({
    page_id: z.string().trim().min(32),
    category: z.string().trim().min(1).optional(),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due is YYYY-MM-DD").optional(),
  })
  .refine((v) => v.category || v.due, "pass category, due, or both");

export default defineWorkflow({
  name: "personal-assistant-update-task",
  description: "Sets the category or due date on a task the assistant created",
  trigger: manual(),
  retries: 0,
  timeoutMs: 60_000,

  async run(ctx) {
    const parsed = input.safeParse(ctx.input);
    if (!parsed.success) {
      return { refused: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    }
    const change = parsed.data;
    const properties: Record<string, unknown> = {};
    if (change.category) {
      const db = await ctx.step("read database", () => readDataSource(ctx, notion.token));
      const match = matchCategory(db, change.category);
      if ("refused" in match) return match;
      properties[CATEGORY] = { select: { name: match.name } };
    }
    if (change.due) properties[DUE] = { date: { start: change.due } };

    return ctx.step("update task", async () => {
      const page = await ctx.http.patch<Page | undefined>(
        `https://api.notion.com/v1/pages/${change.page_id}`,
        { properties },
        { headers: headers(notion.token), retries: 0 },
      );
      // A practice run's held PATCH returns no page: nothing changed, so
      // nothing is recorded.
      if (typeof page?.id !== "string" || !page.properties) return { updated: false };

      // The mirror takes what Notion now says. The `created` row's record of
      // what has been seen moves only for the field changed here: if you
      // changed the other one in the meantime, the sync must still see it.
      const now = taskFields(page);
      const mirror = ctx.table("tasks").query({ where: [{ column: "page_id", op: "=", value: change.page_id }], limit: 1 })[0];
      if (mirror) ctx.table("tasks").update(String(mirror.id), { category: now.category, due: now.due }, { writtenBy: ctx.workflow });
      const created = ctx
        .table("task_work")
        .query({ where: [{ column: "page_id", op: "=", value: change.page_id }], limit: 100 })
        .find((w) => w.kind === "created");
      if (created) {
        const seen = parseProps(String(created.seen_text ?? created.text));
        const next = taskProps(change.category ? now.category : seen.category, change.due ? now.due : seen.due);
        ctx.table("task_work").update(String(created.id), { seen_text: next }, { writtenBy: ctx.workflow });
      }
      return { updated: true, category: now.category, due: now.due };
    });
  },
});

/** `taskProps` read back. */
function parseProps(text: string): { category: string | null; due: string | null } {
  const m = text.match(/^Category: (.*) · Due: (.*)$/);
  const value = (v: string | undefined) => (!v || v === "-" ? null : v);
  return { category: value(m?.[1]), due: value(m?.[2]) };
}
