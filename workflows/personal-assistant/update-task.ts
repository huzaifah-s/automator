import { z } from "zod";
import { defineCredential, defineWorkflow, manual } from "../../src/core/define.ts";
import {
  CATEGORY,
  DUE,
  headers,
  matchCategory,
  readDataSource,
  taskFields,
  taskProps,
  type Page,
} from "./_notion.ts";

/**
 * Personal assistant — changes a task it created: its title, category or due
 * date, or moves it to Notion's trash.
 *
 * Started by the assistant's `update_task` and `trash_task` tools, which only
 * accept a task with a `created` row in `task_work`: this is how a category
 * it was unsure of gets filled in once you answer, and how a task it should
 * not have made goes away when you say so — never a way to change your own
 * tasks. No status, nothing on the page.
 *
 * The `created` row's `seen_text` moves with a category or due change, in the
 * same step, so the sync does not read the assistant's own update as yours.
 *
 * **Trash, not delete.** Notion keeps a trashed page for 30 days and you can
 * restore it from there; the API has no permanent delete and this does not
 * want one. The page leaves the `tasks` mirror at once, and every `task_work`
 * row for it is marked `deleted` with the reason you gave and left unlearned,
 * so it reaches `outcomes` and the assistant draws its lesson from why the
 * task was wrong — the same path as a task you deleted yourself.
 */

const notion = defineCredential("notion", "huzaifah-notion");

const input = z.union([
  z.object({
    page_id: z.string().trim().min(32),
    trash: z.literal(true),
    reason: z.string().trim().min(3).max(500),
  }),
  z
    .object({
      page_id: z.string().trim().min(32),
      title: z.string().trim().min(1).max(200).optional(),
      category: z.string().trim().min(1).optional(),
      due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due is YYYY-MM-DD").optional(),
    })
    .refine((v) => v.title || v.category || v.due, "pass title, category, due, or trash"),
]);

export default defineWorkflow({
  name: "personal-assistant-update-task",
  description: "Renames, re-dates, files or trashes a task the assistant created",
  trigger: manual(),
  retries: 0,
  timeoutMs: 60_000,

  async run(ctx) {
    const parsed = input.safeParse(ctx.input);
    if (!parsed.success) {
      return { refused: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    }
    if ("trash" in parsed.data) {
      const { page_id, reason } = parsed.data;
      return ctx.step("trash task", async () => {
        const page = await ctx.http.patch<Page | undefined>(
          `https://api.notion.com/v1/pages/${page_id}`,
          { in_trash: true },
          { headers: headers(notion.token), retries: 0 },
        );
        // A practice run's held PATCH returns nothing: nothing was trashed.
        if (typeof page?.id !== "string" || !(page.in_trash || page.archived)) return { trashed: false };
        const mirror = ctx.table("tasks").query({ where: [{ column: "page_id", op: "=", value: page_id }], limit: 1 })[0];
        if (mirror) ctx.table("tasks").remove(String(mirror.id));
        const work = ctx.table("task_work").query({ where: [{ column: "page_id", op: "=", value: page_id }], limit: 100 });
        for (const w of work) {
          ctx.table("task_work").update(
            String(w.id),
            {
              outcome: "deleted",
              detail: `You moved it to the trash because he said: ${reason}`,
              outcome_at: Date.now(),
              learned: false,
            },
            { writtenBy: ctx.workflow },
          );
        }
        return { trashed: true, title: taskFields(page).title };
      });
    }

    const change = parsed.data;
    const properties: Record<string, unknown> = {};
    const db = change.category || change.title
      ? await ctx.step("read database", () => readDataSource(ctx, notion.token))
      : null;
    if (db && change.category) {
      const match = matchCategory(db, change.category);
      if ("refused" in match) return match;
      properties[CATEGORY] = { select: { name: match.name } };
    }
    if (change.due) properties[DUE] = { date: { start: change.due } };
    if (db && change.title) {
      const titleProp = Object.entries(db.properties).find(([, p]) => p.type === "title")?.[0];
      if (!titleProp) throw new Error("The To Do database has no title column");
      properties[titleProp] = { title: [{ text: { content: change.title } }] };
    }

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
      if (mirror) {
        ctx.table("tasks").update(
          String(mirror.id),
          { title: now.title, category: now.category, due: now.due },
          { writtenBy: ctx.workflow },
        );
      }
      const work = ctx.table("task_work").query({ where: [{ column: "page_id", op: "=", value: change.page_id }], limit: 100 });
      // The title is not something the sync compares, so it simply follows.
      if (change.title) {
        for (const w of work) ctx.table("task_work").update(String(w.id), { task_title: now.title }, { writtenBy: ctx.workflow });
      }
      const created = work.find((w) => w.kind === "created");
      if (created && (change.category || change.due)) {
        const seen = parseProps(String(created.seen_text ?? created.text));
        const next = taskProps(change.category ? now.category : seen.category, change.due ? now.due : seen.due);
        ctx.table("task_work").update(String(created.id), { seen_text: next }, { writtenBy: ctx.workflow });
      }
      return { updated: true, title: now.title, category: now.category, due: now.due };
    });
  },
});

/** `taskProps` read back. */
function parseProps(text: string): { category: string | null; due: string | null } {
  const m = text.match(/^Category: (.*) · Due: (.*)$/);
  const value = (v: string | undefined) => (!v || v === "-" ? null : v);
  return { category: value(m?.[1]), due: value(m?.[2]) };
}
