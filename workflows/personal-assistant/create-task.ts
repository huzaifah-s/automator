import { z } from "zod";
import { defineCredential, defineWorkflow, manual, type Ctx } from "../../src/core/define.ts";
import {
  CATEGORY,
  DATABASE_TITLE,
  DUE,
  DUE_FORMAT,
  DUE_HINT,
  DUE_TIMEZONE,
  STATUS,
  dueDate,
  headers as notionHeaders,
  matchCategory,
  readDataSource,
  selectOptions,
  taskProps,
  type Database,
} from "./_notion.ts";

/**
 * Personal assistant — adds a task to the Notion "To Do" database.
 *
 * Started by the assistant's `create_task` tool (src/server/mcp-assistant.ts)
 * rather than called from there directly, so that every task it creates is a
 * run: on the run page, alerted on failure, and in the same place as the
 * todo-repeat workflow that works the same database.
 *
 * **Not retried, and deduplicated by title.** A page create that timed out may
 * still have happened, so retrying it is how one task becomes two. Instead
 * the same title within a week returns the task already made — the assistant
 * runs hourly and may well notice the same thing twice.
 *
 * **Made from the database's default template** ("New Task" today), so a task
 * the assistant adds looks like one added by hand, and changing the template
 * in Notion changes the next task without touching this file. No default
 * template, and the page is made plain. Notion refuses `children` alongside a
 * template and applies the template after it answers, so the notes are
 * appended once the template's blocks have arrived.
 */

const notion = defineCredential("notion", "huzaifah-notion");
const SAME_TASK_SECONDS = 7 * 86_400;

const input = z.object({
  title: z.string().trim().min(1).max(200),
  due: z.string().regex(DUE_FORMAT, DUE_HINT).optional(),
  /** The due date is the assistant's guess, not a date anybody said. Shown on the card. */
  due_guess: z.boolean().optional(),
  category: z.string().trim().min(1).optional(),
  notes: z.string().trim().max(1800).optional(),
  /** Where it came from, e.g. "WhatsApp — Ali". Written into the page. */
  source: z.string().trim().max(200).optional(),
  /**
   * False when the caller tells him itself — a follow-up he chose on its card,
   * which that card now says. Every other task is announced.
   */
  announce: z.boolean().default(true),
});

type Template = { id: string; name: string; blocks: number };

const headers = () => notionHeaders(notion.token);

export default defineWorkflow({
  name: "personal-assistant-create-task",
  description: "Adds a task to the Notion To Do database, for the assistant",
  trigger: manual(),
  retries: 0,
  timeoutMs: 60_000,

  async run(ctx) {
    // A bad input is the caller's mistake, not this workflow failing: it is
    // answered as `refused`, which the assistant reads and corrects, rather
    // than thrown — a throw is a failed run, and a failed run is an alert.
    const parsed = input.safeParse(ctx.input);
    if (!parsed.success) {
      return { refused: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    }
    const task = parsed.data;
    const dedupeKey = `task:${task.title.toLowerCase().replace(/\s+/g, " ")}`;
    const existing = await ctx.state.get<{ url: string }>(dedupeKey);
    if (existing?.url) return { url: existing.url, created: false };

    // Since 2025-09-03 the columns belong to the database's data source, not
    // the database, and a page is made in the data source.
    const db = await ctx.step("read database", () => readDataSource(ctx, notion.token));

    const template = await ctx.step("read template", () => defaultTemplate(ctx, db.id));

    const titleProp = Object.entries(db.properties).find(([, p]) => p.type === "title")?.[0];
    if (!titleProp) throw new Error(`The ${DATABASE_TITLE} database has no title column`);

    const properties: Record<string, unknown> = {
      [titleProp]: { title: [{ text: { content: task.title } }] },
    };
    const status = startingStatus(db);
    if (status) properties[STATUS] = { [db.properties[STATUS]!.type]: { name: status } };
    if (task.due && db.properties[DUE]?.type === "date") {
      properties[DUE] = { date: dueDate(task.due) };
    }
    let category: string | null = null;
    if (task.category) {
      const match = matchCategory(db, task.category);
      if ("refused" in match) return match;
      category = match.name;
      properties[CATEGORY] = { select: { name: category } };
    }

    const children = [task.notes, task.source && `From ${task.source}`]
      .filter((t): t is string => Boolean(t))
      .map((content) => ({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content } }] },
      }));

    const page = await ctx.step("create task", () =>
      ctx.http.post<{ id: string; url: string }>(
        "https://api.notion.com/v1/pages",
        template
          ? {
              parent: { data_source_id: db.id },
              properties,
              template: { type: "template_id", template_id: template.id, timezone: DUE_TIMEZONE },
            }
          : { parent: { data_source_id: db.id }, properties, children },
        { headers: headers(), retries: 0 },
      ),
    );

    if (template && children.length && typeof page?.id === "string") {
      await ctx.step("add notes", async () => {
        await templateApplied(ctx, page.id, template.blocks);
        await ctx.http.patch(
          `https://api.notion.com/v1/blocks/${page.id}/children`,
          { children },
          { headers: headers(), retries: 0 },
        );
      });
    }

    // Only a real page is remembered. A practice run's held POST answers with
    // no url, and remembering that would turn the next real attempt into
    // "already on the list" for a task that does not exist.
    if (typeof page?.url !== "string" || typeof page.id !== "string") return { url: page?.url, created: true };
    await ctx.state.set(dedupeKey, { url: page.url }, { ttlSeconds: SAME_TASK_SECONDS });

    await ctx.step("record and tell", async () => {
      const due = task.due ?? null;
      // In the mirror at once, so the assistant can ask about it in the same
      // run rather than waiting for the next sync to find it.
      ctx.table("tasks").insert(
        {
          page_id: page.id,
          title: task.title,
          status,
          due,
          category,
          url: page.url,
          edited_at: Date.now(),
          edited_by: "automation",
          checked_at: 0,
        },
        { writtenBy: ctx.workflow },
      );
      // What it set, so the sync can tell when you change it — see task_work.
      const set = taskProps(category, due);
      const { row } = ctx.table("task_work").insert(
        { page_id: page.id, task_title: task.title, kind: "created", text: set, seen_text: set, seen_status: status },
        { writtenBy: ctx.workflow },
      );
      // Every task the assistant adds is announced, with a button that opens
      // it in Notion — the quickest way to correct what it guessed.
      if (task.announce) {
        ctx.table("questions").insert(
          { kind: "update", question: announcement(task, category), link: page.url },
          { writtenBy: ctx.workflow },
        );
      }
      return { work: row.id };
    });
    return { url: page.url, created: true, id: page.id };
  },
});

/**
 * The data source's default template and how many top-level blocks it has, or
 * null when none is marked default. Looked up every run rather than pinned, so
 * a template renamed, edited or replaced in Notion is used from the next task.
 */
async function defaultTemplate(ctx: Ctx, dataSourceId: string): Promise<Template | null> {
  const list = await ctx.http.get<{ templates: Array<{ id: string; name: string; is_default: boolean }> }>(
    `https://api.notion.com/v1/data_sources/${dataSourceId}/templates?page_size=100`,
    { headers: headers() },
  );
  const chosen = list.templates.find((t) => t.is_default);
  if (!chosen) return null;
  const body = await ctx.http.get<{ results: unknown[] }>(
    `https://api.notion.com/v1/blocks/${chosen.id}/children?page_size=100`,
    { headers: headers() },
  );
  return { id: chosen.id, name: chosen.name, blocks: body.results.length };
}

/**
 * Waits for Notion to finish copying the template's blocks into the new page,
 * so the notes land after them rather than in the middle. A template with no
 * blocks has nothing to wait for. Gives up after ~20s and appends anyway: notes
 * in the wrong place are better than a task with none.
 */
async function templateApplied(ctx: Ctx, pageId: string, blocks: number): Promise<void> {
  if (blocks === 0) return;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const body = await ctx.http.get<{ results: unknown[] }>(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
      { headers: headers() },
    );
    if (body.results.length >= blocks) return;
  }
  ctx.log.warn("Template still applying after 20s — adding the notes anyway");
}

/** The first option in Notion's "To-do" group, or the first select option that is not Done. */
function startingStatus(db: Database): string | null {
  const prop = db.properties[STATUS];
  if (prop?.type === "status") {
    const s = prop.status as {
      options: Array<{ id: string; name: string }>;
      groups: Array<{ name: string; option_ids: string[] }>;
    };
    const group = s.groups.find((g) => g.name.toLowerCase() === "to-do") ?? s.groups[0];
    return s.options.find((o) => o.id === group?.option_ids[0])?.name ?? null;
  }
  if (prop?.type === "select") return selectOptions(prop).find((o) => o !== "Done") ?? null;
  return null;
}

const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

/** " 3pm" or " 3:30pm" for a due date with a time, else nothing. */
function timeText(due: string): string {
  if (!due.includes("T")) return "";
  const [h, m] = due.slice(11, 16).split(":").map(Number) as [number, number];
  return ` ${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

/** The card text: what was added, with which due date and category, and from where. */
function announcement(task: z.infer<typeof input>, category: string | null): string {
  const due = task.due
    ? `${dayFmt.format(new Date(`${task.due.slice(0, 10)}T00:00:00Z`)).replace(",", "")}${timeText(task.due)}${task.due_guess ? " (my guess)" : ""}`
    : "none";
  // Written in the assistant's marks (see `rich` in _bot.ts): the card shows
  // a heading, the task, then one fact per line.
  return [
    "# ➕ Added to your To Do",
    `*${task.title}*`,
    "",
    `📅 ${due}`,
    `🏷 ${category ?? "No category yet — I'll ask you"}`,
    task.source ? `💬 From ${task.source}` : null,
    task.notes ? `\n${task.notes.length > 300 ? `${task.notes.slice(0, 299)}…` : task.notes}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}
