import {
  cron,
  defineCredential,
  defineWorkflow,
  HttpError,
  type Ctx,
  type Row,
} from "../../src/core/define.ts";
import {
  STATUS,
  blocksText,
  dataSourceId,
  findBlock,
  headers,
  readBlocks,
  sameText,
  taskFields,
  type Block,
  type Page,
} from "./_notion.ts";

/**
 * Personal assistant — mirrors your open Notion To Do tasks into the `tasks`
 * table, and notices what you did to the notes Maria wrote on them.
 *
 * Every ten minutes: one query for every task that is not Done, then the text
 * of each page that changed since it was last read. A task that has left the
 * list — Done, deleted, moved — is looked at once more and dropped.
 *
 * **What you did is worked out here, not by the model.** For each of Maria's
 * notes on a page that changed (`task_work`), the callout is read back and
 * compared with what she wrote: edited, removed, or the task marked Done or
 * KIV after it. That sets the row's `outcome` and clears `learned`, which puts
 * it on the assistant's `outcomes` list until it draws a lesson — the same
 * path a skipped or commented draft takes. A feedback signal that only lived
 * in a page the model might not reopen would be read once and forgotten.
 *
 * **Re-read on any edit since the last read, not on a changed timestamp.**
 * Notion's `last_edited_time` is rounded to the minute, so a page read at
 * 14:00:10 and typed in until 14:00:50 still says 14:00. A page whose edit
 * time is within a minute of the last read is read again.
 *
 * **Who edited.** `last_edited_by` is compared with this integration's own
 * bot user: anything else is you. Maria's notes, created tasks and
 * todo-repeat's copies all edit as the integration, so they read as
 * "automation" and never as your feedback.
 *
 * Page text is copied to the `tasks` table and nowhere else: the reads are
 * `private`, and every step returns counts or page ids.
 */

const notion = defineCredential("notion", "huzaifah-notion");

/** Page texts read per run; the rest wait for the next one, most urgent first. */
const READS = 25;
const BODY_MAX = 8_000;
const DETAIL_MAX = 2_000;
/** Notion rounds edit times to the minute. */
const ROUNDING_MS = 60_000;
/** Notes older than this are no longer compared — the task has moved on. */
const WATCH_DAYS = 60;

export default defineWorkflow({
  name: "personal-assistant-sync-tasks",
  description: "Mirrors your open Notion To Do tasks for the assistant, and what you did to its notes",
  trigger: cron("*/10 * * * *", { tz: "Asia/Kuala_Lumpur" }),
  retries: 1,
  timeoutMs: 240_000,

  async run(ctx) {
    const token = notion.token;
    const tasks = ctx.table("tasks");
    const bot = await ctx.step("integration user", () => botUser(ctx, token));
    const source = await ctx.step("find database", () => dataSourceId(ctx, token));

    // Properties are written as they are listed; the text is read after.
    const listed = await ctx.step("list open tasks", async () => {
      const pages = await openPages(ctx, token, source);
      const known = new Map(tasks.query({ limit: 1000 }).map((r) => [String(r.page_id), r]));
      const stale: Array<{ id: string; due: string | null }> = [];
      for (const page of pages) {
        const fields = taskFields(page);
        const edited = Date.parse(page.last_edited_time);
        const values = {
          ...fields,
          url: page.url,
          edited_at: edited,
          edited_by: page.last_edited_by?.id === bot ? "automation" : "you",
        };
        const row = known.get(page.id);
        if (row) tasks.update(String(row.id), values, { writtenBy: ctx.workflow });
        else tasks.insert({ page_id: page.id, ...values, checked_at: 0 }, { writtenBy: ctx.workflow });
        if (!row || edited >= Number(row.checked_at) - ROUNDING_MS) stale.push({ id: page.id, due: fields.due });
      }
      const open = new Set(pages.map((p) => p.id));
      const gone = [...known.keys()].filter((id) => !open.has(id));
      // Due soonest first, undated last: when there are more than READS, the
      // tasks the assistant is most likely to work on get read this run.
      stale.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
      return { open: pages.length, stale: stale.slice(0, READS).map((s) => s.id), waiting: Math.max(0, stale.length - READS), gone };
    });

    let notesChanged = 0;
    for (const pageId of listed.stale) {
      notesChanged += await ctx.step(`read ${pageId}`, async () => {
        const row = tasks.query({ where: [{ column: "page_id", op: "=", value: pageId }], limit: 1 })[0];
        if (!row) return 0;
        const startedAt = Date.now();
        const { blocks, complete } = await readBlocks(ctx, token, pageId);
        const work = watched(ctx, pageId);
        const body = clip(blocksText(blocks, labels(work)), BODY_MAX);
        // A first read is not a change: there was nothing to compare with.
        const bodyChanged = Number(row.checked_at) > 0 && !sameText(String(row.body ?? ""), body);
        tasks.update(String(row.id), { body, checked_at: startedAt }, { writtenBy: ctx.workflow });
        return judge(ctx, work, {
          blocks,
          complete,
          status: (row.status as string | null) ?? null,
          youEditedPage: bodyChanged && row.edited_by === "you",
        });
      });
    }

    let closed = 0;
    for (const pageId of listed.gone) {
      notesChanged += await ctx.step(`closed ${pageId}`, async () => {
        const work = watched(ctx, pageId);
        let changed = 0;
        if (work.length) {
          const page = await pageOrNull(ctx, token, pageId);
          if (page && (page.in_trash || page.archived)) {
            changed = judge(ctx, work, { deleted: true });
          } else if (page) {
            const { blocks, complete } = await readBlocks(ctx, token, pageId);
            changed = judge(ctx, work, { blocks, complete, status: taskFields(page).status, youEditedPage: false });
          }
          // No page at all: it was moved somewhere the integration cannot
          // see. That says nothing about the note, so nothing is recorded.
        }
        const row = ctx.table("tasks").query({ where: [{ column: "page_id", op: "=", value: pageId }], limit: 1 })[0];
        if (row) ctx.table("tasks").remove(String(row.id));
        return changed;
      });
      closed++;
    }

    return {
      open: listed.open,
      read: listed.stale.length,
      stillToRead: listed.waiting,
      closed,
      notesChanged,
    };
  },
});

/** This integration's own user id, which is what its edits are signed with. */
async function botUser(ctx: Ctx, token: string): Promise<string> {
  const cached = await ctx.state.get<string>("bot");
  if (cached) return cached;
  const me = await ctx.http.get<{ id: string }>("https://api.notion.com/v1/users/me", { headers: headers(token) });
  await ctx.state.set("bot", me.id);
  return me.id;
}

async function openPages(ctx: Ctx, token: string, source: string): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const res = await ctx.http.post<{ results: Page[]; has_more: boolean; next_cursor: string | null }>(
      `https://api.notion.com/v1/data_sources/${source}/query`,
      {
        filter: { property: STATUS, status: { does_not_equal: "Done" } },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
      { headers: headers(token), private: true },
    );
    pages.push(...res.results.filter((p) => !p.in_trash && !p.archived));
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return pages;
}

async function pageOrNull(ctx: Ctx, token: string, id: string): Promise<Page | null> {
  try {
    return await ctx.http.get<Page>(`https://api.notion.com/v1/pages/${id}`, { headers: headers(token), private: true });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

/** Maria's recent notes on a page, newest first. */
function watched(ctx: Ctx, pageId: string): Row[] {
  const since = Date.now() - WATCH_DAYS * 86_400_000;
  return ctx
    .table("task_work")
    .query({ where: [{ column: "page_id", op: "=", value: pageId }], limit: 100 })
    .filter((w) => w.block_id && Number(w.created_at) > since);
}

/** Block id → the label the assistant sees on its own note in the page text. */
const labels = (work: Row[]) => new Map(work.map((w) => [String(w.block_id), String(w.id)]));

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text;

type Seen =
  | { deleted: true }
  | { deleted?: false; blocks: Block[]; complete: boolean; status: string | null; youEditedPage: boolean };

/**
 * Compares each of Maria's notes on a page with what the page says now, and
 * records an outcome on the ones you changed. Returns how many it set.
 *
 * One outcome per note per look, in order of how much it says: your edit to
 * the note itself, then its removal, then the task's status, then an edit
 * elsewhere on the page — which goes on the newest note only, since that is
 * the one you were most likely answering. The last two never replace an
 * outcome still waiting to be learned from.
 */
function judge(ctx: Ctx, work: Row[], seen: Seen): number {
  const table = ctx.table("task_work");
  let set = 0;
  work.forEach((w, i) => {
    let outcome: string | null = null;
    let detail: string | null = null;
    const patch: Record<string, unknown> = {};

    if (seen.deleted) {
      if (w.outcome !== "deleted") outcome = "deleted";
    } else {
      const block = findBlock(seen.blocks, String(w.block_id));
      if (!block || block.in_trash || block.archived) {
        // Only from a page read whole: on a cut one it may just be further down.
        if (seen.complete && w.outcome !== "removed") outcome = "removed";
      } else {
        const now = blocksText(block.children ?? []);
        if (!sameText(now, String(w.seen_text ?? w.text))) {
          outcome = "edited";
          detail = clip(now, DETAIL_MAX);
          patch.seen_text = now;
        }
      }
      // A note you changed and the assistant has not learned from yet keeps
      // that outcome: "Done" or "page changed" arriving before its next run
      // must not overwrite the edit, which says far more.
      const pending = Boolean(w.outcome) && !w.learned;
      if (seen.status !== (w.seen_status ?? null)) {
        patch.seen_status = seen.status;
        if (!outcome && !pending && seen.status === "Done") outcome = "done";
        if (!outcome && !pending && seen.status === "KIV") outcome = "kiv";
      }
      if (!outcome && i === 0 && seen.youEditedPage && !pending) outcome = "page_edited";
    }

    if (outcome) {
      Object.assign(patch, { outcome, detail, outcome_at: Date.now(), learned: false });
      set++;
    }
    if (Object.keys(patch).length) table.update(String(w.id), patch, { writtenBy: ctx.workflow });
  });
  return set;
}
