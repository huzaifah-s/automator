import { z } from "zod";
import { defineCredential, defineWorkflow, manual, type Ctx } from "../../src/core/define.ts";

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
 */

const notion = defineCredential("notion", "huzaifah-notion");
const NOTION_VERSION = "2022-06-28";
const DATABASE_TITLE = "To Do";
const STATUS = "Status";
const DUE = "Due Date";
const CATEGORY = "Category";
const SAME_TASK_SECONDS = 7 * 86_400;

const input = z.object({
  title: z.string().trim().min(1).max(200),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due is YYYY-MM-DD").optional(),
  category: z.string().trim().min(1).optional(),
  notes: z.string().trim().max(1800).optional(),
  /** Where it came from, e.g. "WhatsApp — Ali". Written into the page. */
  source: z.string().trim().max(200).optional(),
});

type Prop = { type: string; [k: string]: unknown };
type Database = { id: string; properties: Record<string, Prop> };

const headers = () => ({
  authorization: `Bearer ${notion.token}`,
  "notion-version": NOTION_VERSION,
});

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

    const db = await ctx.step("read database", async () => {
      const id = await databaseId(ctx);
      return ctx.http.get<Database>(`https://api.notion.com/v1/databases/${id}`, {
        headers: headers(),
      });
    });

    const titleProp = Object.entries(db.properties).find(([, p]) => p.type === "title")?.[0];
    if (!titleProp) throw new Error(`The ${DATABASE_TITLE} database has no title column`);

    const properties: Record<string, unknown> = {
      [titleProp]: { title: [{ text: { content: task.title } }] },
    };
    const status = startingStatus(db);
    if (status) properties[STATUS] = { [db.properties[STATUS]!.type]: { name: status } };
    if (task.due && db.properties[DUE]?.type === "date") {
      properties[DUE] = { date: { start: task.due } };
    }
    if (task.category) {
      const options = selectOptions(db.properties[CATEGORY]);
      const match = options.find((o) => o.toLowerCase() === task.category!.toLowerCase());
      // Refused rather than created: a select silently grows a new option on
      // every typo, and the assistant can read this and pick a real one.
      if (!match) {
        return { refused: `"${task.category}" is not a ${CATEGORY} — it is one of ${options.join(", ")}` };
      }
      properties[CATEGORY] = { select: { name: match } };
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
        { parent: { database_id: db.id }, properties, children },
        { headers: headers(), retries: 0 },
      ),
    );

    // Only a real page is remembered. A practice run's held POST answers with
    // no url, and remembering that would turn the next real attempt into
    // "already on the list" for a task that does not exist.
    if (typeof page?.url === "string") {
      await ctx.state.set(dedupeKey, { url: page.url }, { ttlSeconds: SAME_TASK_SECONDS });
    }
    return { url: page?.url, created: true };
  },
});

/** Same lookup as todo-repeat: pinned by variable, else found by title once. */
async function databaseId(ctx: Ctx): Promise<string> {
  const pinned = process.env.TODO_NOTION_DATABASE_ID;
  if (pinned) return pinned;
  const cached = await ctx.state.get<string>("database");
  if (cached) return cached;

  const found = await ctx.http.post<{
    results: Array<{ id: string; title?: Array<{ plain_text?: string }> }>;
  }>(
    "https://api.notion.com/v1/search",
    { query: DATABASE_TITLE, filter: { property: "object", value: "database" }, page_size: 50 },
    { headers: headers() },
  );
  const exact = found.results.filter(
    (db) =>
      (db.title ?? []).map((t) => t.plain_text ?? "").join("").trim().toLowerCase() ===
      DATABASE_TITLE.toLowerCase(),
  );
  if (exact.length !== 1) {
    throw new Error(
      exact.length === 0
        ? `No database called "${DATABASE_TITLE}" is shared with the Notion / huzaifah-notion integration`
        : `${exact.length} databases are called "${DATABASE_TITLE}" — set TODO_NOTION_DATABASE_ID to say which`,
    );
  }
  await ctx.state.set("database", exact[0]!.id);
  return exact[0]!.id;
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

function selectOptions(prop: Prop | undefined): string[] {
  if (prop?.type !== "select") return [];
  return ((prop.select as { options?: Array<{ name: string }> }).options ?? []).map((o) => o.name);
}
