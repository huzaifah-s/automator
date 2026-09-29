import { defineCredential, defineWorkflow, poll, type PollCtx } from "../../src/core/define.ts";
import { dayOf, daysBetween, nextOccurrence, parseRepeat, shiftDays } from "./_repeat.ts";

/**
 * Personal — To Do — repeating tasks.
 *
 * A task in the "To Do" database with something in its **Repeat** column
 * ("Monthly", "Every 2 weeks", "Every 3 months", …) gets its next copy the
 * moment it is marked **Done**: same title, same properties, same page body,
 * Status back to the first not-started option, and **Due Date** moved to the
 * next occurrence. So there is only ever one future copy of a series, rather
 * than a year of them created up front.
 *
 * **Two dates, because "I am late" and "move the series" are different
 * edits.** **Due Date** is when this task is due, and is pushed around freely.
 * **Next Due** is when the next copy will be, and is what the copy gets as its
 * Due Date — so a task for the 24th pushed to the 29th is still followed by
 * the 24th. Changing the schedule is typing the date you want into Next Due:
 * 24 Feb → 27 Feb, and every copy after follows the 27th. A copy is created
 * with its own Next Due already worked out, and a task a person made gets
 * one filled in (Due Date plus one step) within a poll of Repeat being set, so
 * the column always says what will happen and can be corrected before it
 * does. A database without the column works from Due Date alone.
 *
 * The date lives in Notion rather than in the runner so that it can be seen
 * and changed where the task is. `ctx.state` keeps only what a date cannot
 * hold: the series' day of the month (`anchor:<page id>`), so 31 January →
 * 28 February → 31 March rather than → 28 March. It is used only while Next
 * Due still says what the runner wrote; the moment somebody edits it, the day
 * comes from the edit.
 *
 * **A late finish still produces the missed occurrence.** A monthly task for
 * 24 September done on 2 November is followed by 24 October, which is already
 * past — because each month's invoice request is its own piece of work, and
 * skipping to November would drop October's without telling anybody.
 *
 * **Polling, not Notion's webhook.** A subscription delivers one URL per
 * integration, needs the handshake dance, and was switched off by Notion for
 * four days in September without anything here noticing (see the Contents
 * notifier). A five-minute poll of one filtered query costs nothing and
 * cannot go quiet without a failed run to say so.
 *
 * One copy per finished task, whatever happens: the new page's id is written
 * to `spawned:<page id>` in the same step that creates it, and a task with
 * that key is skipped. Un-ticking and re-ticking Done does nothing further.
 */

const notion = defineCredential("notion", "huzaifah-notion");

/** Pinned rather than floating, like every other Notion caller here. */
const NOTION_VERSION = "2022-06-28";

/** Found by title unless TODO_NOTION_DATABASE_ID pins it. */
const DATABASE_TITLE = "To Do";
const STATUS = "Status";
const DONE = "Done";
const DUE = "Due Date";
const REPEAT = "Repeat";
/** Optional. When the next copy will be due — see the top of the file. */
const NEXT_DUE = "Next Due";

/**
 * How far back a finished task is looked for. The filter is on last edit, and
 * marking a task Done is an edit — so this is "the runner may be down this
 * long and still catch up", not a limit on anything a person does.
 */
const LOOKBACK_DAYS = 30;

/* ------------------------------------------------------------------ notion */

interface RichText {
  type: string;
  plain_text?: string;
  href?: string | null;
  text?: { content: string; link: { url: string } | null };
  annotations?: Record<string, unknown>;
}

interface Property {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface Page {
  id: string;
  url?: string;
  icon?: unknown;
  last_edited_time?: string;
  properties: Record<string, Property>;
}

interface Database {
  id: string;
  properties: Record<string, Property>;
}

interface Block {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface Item {
  id: string;
  title: string;
  repeat: string;
  due: string | null;
  nextDue: string | null;
  /** Done → create the next copy. Open → fill in its empty Next Due. */
  done: boolean;
  lastEdited: string;
}

type Http = PollCtx["http"];

const headers = () => ({
  authorization: `Bearer ${notion.token}`,
  "Notion-Version": NOTION_VERSION,
});

function plain(prop: Property | undefined): string {
  if (!prop) return "";
  const v = prop[prop.type];
  if (prop.type === "select" || prop.type === "status") return (v as { name?: string } | null)?.name ?? "";
  if (prop.type === "title" || prop.type === "rich_text") {
    return ((v as RichText[] | null) ?? []).map((t) => t.plain_text ?? "").join("").trim();
  }
  if (prop.type === "multi_select") return ((v as { name: string }[]) ?? []).map((o) => o.name).join(", ");
  return "";
}

function dueOf(page: Page): { start: string; end: string | null; time_zone: string | null } | null {
  const prop = page.properties[DUE];
  if (prop?.type !== "date") return null;
  const v = prop.date as { start?: string; end?: string | null; time_zone?: string | null } | null;
  return v?.start ? { start: v.start, end: v.end ?? null, time_zone: v.time_zone ?? null } : null;
}

function nextDueOf(page: Page): string | null {
  const prop = page.properties[NEXT_DUE];
  if (prop?.type !== "date") return null;
  return (prop.date as { start?: string } | null)?.start ?? null;
}

function titleOf(page: Page): string {
  const prop = Object.values(page.properties).find((p) => p.type === "title");
  return plain(prop) || "(untitled)";
}

async function databaseId(http: Http, state: PollCtx["state"]): Promise<string> {
  const pinned = process.env.TODO_NOTION_DATABASE_ID;
  if (pinned) return pinned;
  const cached = await state.get<string>("database");
  if (cached) return cached;

  const found = await http.post<{ results: Array<{ id: string; title?: RichText[] }> }>(
    "https://api.notion.com/v1/search",
    { query: DATABASE_TITLE, filter: { property: "object", value: "database" }, page_size: 50 },
    { headers: headers() },
  );
  const exact = found.results.filter(
    (db) =>
      (db.title ?? []).map((t) => t.plain_text ?? "").join("").trim().toLowerCase() ===
      DATABASE_TITLE.toLowerCase(),
  );
  if (exact.length === 0) {
    throw new Error(
      `No database called "${DATABASE_TITLE}" is shared with the Notion / huzaifah-notion integration — ` +
        `open it in Notion, ••• → Connections, and add the integration`,
    );
  }
  if (exact.length > 1) {
    throw new Error(
      `${exact.length} databases are called "${DATABASE_TITLE}" — set TODO_NOTION_DATABASE_ID ` +
        `(bun run variable -- set TODO_NOTION_DATABASE_ID <id>) to say which`,
    );
  }
  await state.set("database", exact[0]!.id);
  return exact[0]!.id;
}

/** The three columns this reads, checked by type, with the fix in the message. */
function checkSchema(db: Database): { statusType: "status" | "select"; repeatType: string } {
  const status = db.properties[STATUS];
  const due = db.properties[DUE];
  const repeat = db.properties[REPEAT];
  const problems: string[] = [];
  if (status?.type !== "status" && status?.type !== "select") {
    problems.push(`a "${STATUS}" column of type Status or Select`);
  }
  if (due?.type !== "date") problems.push(`a "${DUE}" column of type Date`);
  if (repeat?.type !== "select" && repeat?.type !== "rich_text") {
    problems.push(`a "${REPEAT}" column of type Select or Text (Monthly, Every 2 weeks, …)`);
  }
  if (problems.length) {
    throw new Error(`The ${DATABASE_TITLE} database needs ${problems.join(", ")}`);
  }
  return { statusType: status!.type as "status" | "select", repeatType: repeat!.type };
}

/**
 * The option a new copy starts on: the first one in Notion's "To-do" group
 * for a Status column, or the first option that is not Done for a Select.
 */
function startingStatus(db: Database): string | null {
  const prop = db.properties[STATUS]!;
  if (prop.type === "status") {
    const s = prop.status as {
      options: Array<{ id: string; name: string }>;
      groups: Array<{ name: string; option_ids: string[] }>;
    };
    const group = s.groups.find((g) => g.name.toLowerCase() === "to-do") ?? s.groups[0];
    const first = group?.option_ids[0];
    return s.options.find((o) => o.id === first)?.name ?? null;
  }
  const options = (prop.select as { options: Array<{ name: string }> }).options;
  return options.find((o) => o.name !== DONE)?.name ?? null;
}

/**
 * The page's properties in the shape the create endpoint takes. Computed and
 * read-only types — formula, rollup, created_time, unique_id, button — are
 * left out because Notion fills them; a file uploaded to Notion is left out
 * because its URL expires within the hour.
 */
function copyProperties(page: Page): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(page.properties)) {
    const v = prop[prop.type] as any;
    switch (prop.type) {
      case "title":
      case "rich_text":
        out[name] = { [prop.type]: cleanText(v ?? []) };
        break;
      case "number":
      case "checkbox":
      case "url":
      case "email":
      case "phone_number":
        out[name] = { [prop.type]: v };
        break;
      case "select":
      case "status":
        out[name] = { [prop.type]: v ? { name: v.name } : null };
        break;
      case "multi_select":
        out[name] = { multi_select: (v ?? []).map((o: { name: string }) => ({ name: o.name })) };
        break;
      case "date":
        out[name] = { date: v };
        break;
      case "people":
        out[name] = { people: (v ?? []).map((p: { id: string }) => ({ id: p.id })) };
        break;
      case "relation":
        out[name] = { relation: (v ?? []).map((r: { id: string }) => ({ id: r.id })) };
        break;
      case "files":
        out[name] = {
          files: (v ?? []).filter((f: { type: string }) => f.type === "external"),
        };
        break;
    }
  }
  return out;
}

/** Rich text the create endpoint accepts. Mentions and equations become their text. */
function cleanText(list: RichText[]): unknown[] {
  return list.map((t) =>
    t.type === "text" && t.text
      ? { type: "text", text: t.text, annotations: t.annotations }
      : {
          type: "text",
          text: { content: t.plain_text ?? "", link: t.href ? { url: t.href } : null },
          annotations: t.annotations,
        },
  );
}

/** Block types copied into the new page. Anything else is left behind and counted. */
const COPYABLE = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "quote",
  "callout",
  "toggle",
  "code",
  "divider",
]);

function copyBlocks(blocks: Block[]): { children: unknown[]; dropped: number } {
  const children: unknown[] = [];
  let dropped = 0;
  for (const b of blocks) {
    if (!COPYABLE.has(b.type)) {
      dropped++;
      continue;
    }
    if (b.has_children) dropped++; // the block comes, what is nested inside it does not
    const src = (b[b.type] ?? {}) as Record<string, any>;
    const body: Record<string, unknown> = {};
    if (src.rich_text) body.rich_text = cleanText(src.rich_text);
    if (src.color) body.color = src.color;
    if (b.type === "to_do") body.checked = false; // a fresh checklist, not last month's ticks
    if (b.type === "code") body.language = src.language ?? "plain text";
    if (b.type === "callout" && src.icon) body.icon = src.icon;
    if (b.type.startsWith("heading_") && src.is_toggleable) body.is_toggleable = true;
    children.push({ object: "block", type: b.type, [b.type]: body });
  }
  return { children, dropped };
}

/* ---------------------------------------------------------------- workflow */

export default defineWorkflow<Item[]>({
  name: "todo-repeat",
  description: "Creates the next copy of a repeating To Do task when it is marked Done",
  trigger: poll("*/5 * * * *", {
    async fetch(ctx) {
      const id = await databaseId(ctx.http, ctx.state);
      const db = await ctx.http.get<Database>(`https://api.notion.com/v1/databases/${id}`, {
        headers: headers(),
      });
      const { statusType, repeatType } = checkSchema(db);

      const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
      const repeating = { property: REPEAT, [repeatType]: { is_not_empty: true } };
      const finished = {
        and: [
          { property: STATUS, [statusType]: { equals: DONE } },
          repeating,
          { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } },
        ],
      };
      // Open, repeating, dated, and nobody has said when the next one is.
      const unfilled = {
        and: [
          { property: STATUS, [statusType]: { does_not_equal: DONE } },
          repeating,
          { property: DUE, date: { is_not_empty: true } },
          { property: NEXT_DUE, date: { is_empty: true } },
        ],
      };
      const filter = { or: db.properties[NEXT_DUE]?.type === "date" ? [finished, unfilled] : [finished] };

      // The query is a POST, so ctx.http.paginate (GET only) does not fit.
      const items: Item[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await ctx.http.post<{ results: Page[]; has_more: boolean; next_cursor: string | null }>(
          `https://api.notion.com/v1/databases/${id}/query`,
          { filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
          { headers: headers() },
        );
        for (const p of res.results) {
          items.push({
            id: p.id,
            title: titleOf(p),
            repeat: plain(p.properties[REPEAT]),
            due: dueOf(p)?.start ?? null,
            nextDue: nextDueOf(p),
            done: plain(p.properties[STATUS]) === DONE,
            lastEdited: p.last_edited_time ?? "",
          });
        }
        if (!res.has_more || !res.next_cursor) break;
        cursor = res.next_cursor;
      }
      return items;
    },
    // A finished task: Repeat and both dates are in the identity, so fixing a
    // typo'd Repeat ("Montly") or a missing date re-delivers it rather than it
    // staying "seen" in the state it was skipped in. An open one: its last
    // edit, so clearing a Next Due the runner filled gets it filled again —
    // the query only returns it while that column is empty anyway.
    id: (item) =>
      item.done
        ? `${item.id}:done:${item.repeat}:${item.due ?? ""}:${item.nextDue ?? ""}`
        : `${item.id}:open:${item.lastEdited}`,
    // The filter is already "Done, repeating, edited this month" — anything it
    // returns on the first poll is a task somebody meant to repeat, and
    // baselining it would silently skip the next copy.
    firstRun: "emit",
  }),
  retries: 2,
  timeoutMs: 120_000,

  async run(ctx) {
    const items = ctx.input ?? [];
    const created: Array<{ task: string; due: string; nextDue: string | null; page: string }> = [];
    const filled: Array<{ task: string; nextDue: string }> = [];
    const skipped: Array<{ task: string; why: string }> = [];

    const db = await ctx.step("read database", async () => {
      const id = await databaseId(ctx.http, ctx.state);
      const d = await ctx.http.get<Database>(`https://api.notion.com/v1/databases/${id}`, {
        headers: headers(),
      });
      checkSchema(d);
      return { id, start: startingStatus(d), hasNextDue: d.properties[NEXT_DUE]?.type === "date" };
    });

    for (const item of items) {
      if (item.done && (await ctx.state.get<string>(`spawned:${item.id}`))) {
        skipped.push({ task: item.title, why: "next copy already created" });
        continue;
      }

      const page = await ctx.step(`read ${item.id}`, () =>
        ctx.http.get<Page>(`https://api.notion.com/v1/pages/${item.id}`, { headers: headers() }),
      );

      // Read again rather than trusting the poll: five minutes is long enough
      // to un-tick a task that was marked Done by mistake, or to finish one
      // the poll saw open.
      const repeat = plain(page.properties[REPEAT]);
      const done = plain(page.properties[STATUS]) === DONE;
      if (done !== item.done || !repeat) {
        skipped.push({ task: titleOf(page), why: "changed since the poll saw it — next poll picks it up" });
        continue;
      }
      const rule = parseRepeat(repeat);
      if (!rule) {
        ctx.log.warn(`"${titleOf(page)}": cannot read Repeat "${repeat}" — try Monthly or Every 2 weeks`);
        skipped.push({ task: titleOf(page), why: `unreadable Repeat "${repeat}"` });
        continue;
      }
      const due = dueOf(page);
      if (!due) {
        ctx.log.warn(`"${titleOf(page)}": no ${DUE}, so there is no date to repeat from`);
        skipped.push({ task: titleOf(page), why: `no ${DUE}` });
        continue;
      }

      const stored = await ctx.state.get<{ next: string; day: number }>(`anchor:${item.id}`);
      const written = nextDueOf(page);

      /* An open task with no Next Due: say when the next one will be. */
      if (!done) {
        if (written || !db.hasNextDue) continue;
        const day = dayOf(due.start);
        const next = nextOccurrence(due.start, rule, day);
        await ctx.step(
          `fill next due ${item.id}`,
          async () => {
            await ctx.http.patch(
              `https://api.notion.com/v1/pages/${item.id}`,
              { properties: { [NEXT_DUE]: { date: { start: next } } } },
              { headers: headers() },
            );
            await ctx.state.set(`anchor:${item.id}`, { next, day });
          },
          { input: { task: item.id, due: due.start, next } },
        );
        filled.push({ task: titleOf(page), nextDue: next });
        continue;
      }

      /* A finished one: its Next Due becomes the copy's Due Date. */
      const day = written
        ? // The stored day only while Next Due is still what the runner wrote;
          // an edited one is a new schedule and brings its own day.
          stored && stored.next === written
          ? stored.day
          : dayOf(written)
        : (stored?.day ?? dayOf(due.start));
      const dueNext = written ?? stored?.next ?? nextOccurrence(due.start, rule, day);
      const after = nextOccurrence(dueNext, rule, day);
      // A range keeps its length: the end moves by as much as the start did.
      const end = due.end ? shiftDays(due.end, daysBetween(due.start, dueNext)) : null;

      const body = await ctx.step(`read body ${item.id}`, () =>
        ctx.http.get<{ results: Block[] }>(
          `https://api.notion.com/v1/blocks/${item.id}/children?page_size=100`,
          { headers: headers() },
        ),
      );
      const { children, dropped } = copyBlocks(body.results);
      if (dropped) ctx.log.info(`"${titleOf(page)}": ${dropped} block(s) or nested block(s) not copied`);

      const properties = {
        ...copyProperties(page),
        [DUE]: { date: { start: dueNext, end, time_zone: due.time_zone } },
        ...(db.hasNextDue ? { [NEXT_DUE]: { date: { start: after } } } : {}),
        ...(db.start ? { [STATUS]: { [page.properties[STATUS]!.type]: { name: db.start } } } : {}),
      };

      const made = await ctx.step(
        `create next ${item.id}`,
        async () => {
          const res = await ctx.http.post<{ id: string; url?: string }>(
            "https://api.notion.com/v1/pages",
            { parent: { database_id: db.id }, icon: page.icon ?? undefined, properties, children },
            { headers: headers() },
          );
          // In the same step as the create, so the window in which a crash
          // could leave a copy with no record of it is one line wide.
          if (res.id) {
            await ctx.state.set(`spawned:${item.id}`, res.id);
            await ctx.state.set(`anchor:${res.id}`, { next: after, day });
          }
          return { id: res.id, url: res.url };
        },
        { input: { from: item.id, due: dueNext, nextDue: after, repeat } },
      );

      created.push({
        task: titleOf(page),
        due: dueNext,
        nextDue: db.hasNextDue ? after : null,
        page: made.url ?? made.id,
      });
    }

    return { created, filled, skipped };
  },
});
