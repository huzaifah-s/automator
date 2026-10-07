import type { Ctx } from "../../src/core/define.ts";

/**
 * The To Do database, as the assistant's three Notion workflows see it:
 * `create-task` adds a page, `sync-tasks` mirrors the open ones into the
 * `tasks` table, `task-note` appends Maria's work to one.
 *
 * Also the two conversions between Notion blocks and the plain text the
 * assistant reads and writes. They are one pair on purpose: `sync-tasks`
 * decides whether you edited one of Maria's notes by rendering it with
 * `blocksText` and comparing that with what `task-note` rendered from the
 * blocks it built — the same function on both sides, so a note nobody
 * touched always compares equal.
 */

/** Search only, the same lookup as todo-repeat. */
const SEARCH_VERSION = "2022-06-28";
/** Data sources and templates — everything after the lookup. */
export const NOTION_VERSION = "2026-03-11";
export const DATABASE_TITLE = "To Do";
export const STATUS = "Status";
export const DUE = "Due Date";
export const CATEGORY = "Category";

/**
 * The first words of every callout Maria writes. `todo-repeat` leaves callouts
 * that start with this out of a repeating task's next copy, so last month's
 * notes do not follow the series — keep the two in step.
 */
export const MARIA_MARK = "Maria ·";
export const MARIA_ICON = "🤖";

export const headers = (token: string, version = NOTION_VERSION) => ({
  authorization: `Bearer ${token}`,
  "notion-version": version,
});

/** Pinned by TODO_NOTION_DATABASE_ID, else found by title once and remembered. */
export async function databaseId(ctx: Ctx, token: string): Promise<string> {
  const pinned = process.env.TODO_NOTION_DATABASE_ID;
  if (pinned) return pinned;
  const cached = await ctx.state.get<string>("database");
  if (cached) return cached;

  const found = await ctx.http.post<{
    results: Array<{ id: string; title?: Array<{ plain_text?: string }> }>;
  }>(
    "https://api.notion.com/v1/search",
    { query: DATABASE_TITLE, filter: { property: "object", value: "database" }, page_size: 50 },
    { headers: headers(token, SEARCH_VERSION) },
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

/**
 * The database's data source id. Since 2025-09-03 the columns and the rows
 * belong to the data source, not the database.
 */
export async function dataSourceId(ctx: Ctx, token: string): Promise<string> {
  const id = await databaseId(ctx, token);
  const database = await ctx.http.get<{ data_sources: Array<{ id: string }> }>(
    `https://api.notion.com/v1/databases/${id}`,
    { headers: headers(token) },
  );
  const source = database.data_sources[0];
  if (!source) throw new Error(`The ${DATABASE_TITLE} database has no data source`);
  return source.id;
}

/* ------------------------------------------------------------ properties */

export interface RichText {
  plain_text?: string;
  text?: { content: string };
  annotations?: { bold?: boolean };
}

export interface Page {
  id: string;
  url: string;
  in_trash?: boolean;
  archived?: boolean;
  last_edited_time: string;
  last_edited_by?: { id: string };
  properties: Record<string, { type: string; [k: string]: any }>;
}

export const richText = (list: RichText[] | undefined) =>
  (list ?? []).map((t) => t.plain_text ?? t.text?.content ?? "").join("");

/** The fields of a To Do page the assistant cares about. */
export function taskFields(page: Page) {
  const props = page.properties;
  const title = Object.values(props).find((p) => p.type === "title");
  const status = props[STATUS];
  const due = props[DUE];
  const category = props[CATEGORY];
  return {
    title: richText(title?.title).trim() || "(untitled)",
    status: (status?.[status.type] as { name?: string } | null)?.name ?? null,
    due: due?.type === "date" ? ((due.date as { start?: string } | null)?.start ?? null) : null,
    category: category?.type === "select" ? ((category.select as { name?: string } | null)?.name ?? null) : null,
  };
}

/* ---------------------------------------------------------------- blocks */

export interface Block {
  id: string;
  type: string;
  has_children?: boolean;
  in_trash?: boolean;
  archived?: boolean;
  [k: string]: any;
  /** Filled in by `readBlocks`, not by Notion. */
  children?: Block[];
}

/** A page's blocks read this deep, at most this many in all. */
const MAX_DEPTH = 3;
const MAX_BLOCKS = 300;

/**
 * Every block under `id`, children nested, up to `MAX_DEPTH` levels and
 * `MAX_BLOCKS` blocks — a task is a page, not a wiki, and anything past that
 * is cut rather than read for minutes. `complete` is false when it was cut,
 * so a block that is missing may only be further down. `private`: the body is
 * copied to the `tasks` table, and the run page has no business holding a
 * second copy.
 */
export async function readBlocks(
  ctx: Ctx,
  token: string,
  id: string,
): Promise<{ blocks: Block[]; complete: boolean }> {
  let budget = MAX_BLOCKS;
  let complete = true;
  const read = async (parent: string, depth: number): Promise<Block[]> => {
    const out: Block[] = [];
    let cursor: string | undefined;
    do {
      const page = await ctx.http.get<{ results: Block[]; has_more: boolean; next_cursor: string | null }>(
        `https://api.notion.com/v1/blocks/${parent}/children`,
        { headers: headers(token), query: { page_size: 100, start_cursor: cursor }, private: true },
      );
      for (const b of page.results) {
        if (budget-- <= 0) {
          complete = false;
          return out;
        }
        out.push(b);
      }
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
    for (const b of out) {
      if (!b.has_children || b.type === "child_page" || b.type === "child_database") continue;
      if (depth >= MAX_DEPTH || budget <= 0) complete = false;
      else b.children = await read(b.id, depth + 1);
    }
    return out;
  };
  const blocks = await read(id, 1);
  return { blocks, complete };
}

/** A block anywhere in the tree — a note you moved into a toggle is still there. */
export function findBlock(blocks: Block[], id: string): Block | null {
  for (const b of blocks) {
    if (b.id === id) return b;
    const inner = b.children ? findBlock(b.children, id) : null;
    if (inner) return inner;
  }
  return null;
}

/** Blocks as plain text, one line each, children indented. `maria` labels her notes. */
export function blocksText(blocks: Block[], maria: Map<string, string> = new Map(), indent = ""): string {
  const lines: string[] = [];
  for (const b of blocks) {
    const body = (b[b.type] ?? {}) as Record<string, any>;
    const text = richText(body.rich_text);
    const note = maria.get(b.id);
    let own: string;
    switch (b.type) {
      case "paragraph": own = text; break;
      case "heading_1": own = `# ${text}`; break;
      case "heading_2": own = `## ${text}`; break;
      case "heading_3": own = `### ${text}`; break;
      case "bulleted_list_item": own = `- ${text}`; break;
      case "numbered_list_item": own = `1. ${text}`; break;
      case "to_do": own = `[${body.checked ? "x" : " "}] ${text}`; break;
      case "quote": own = `> ${text}`; break;
      case "toggle": own = `▸ ${text}`; break;
      case "callout": own = note ? `[Maria's note ${note}] ${text}` : `[callout] ${text}`; break;
      case "code": own = `\`\`\`\n${text}\n\`\`\``; break;
      case "divider": own = "---"; break;
      case "child_page": own = `[page: ${body.title ?? ""}]`; break;
      case "child_database": own = `[database: ${body.title ?? ""}]`; break;
      case "bookmark":
      case "embed":
      case "link_preview": own = String(body.url ?? `[${b.type}]`); break;
      case "table_row": own = ((body.cells ?? []) as RichText[][]).map(richText).join(" | "); break;
      case "image":
      case "file":
      case "pdf":
      case "video":
      case "audio": own = `[${b.type}${body.caption?.length ? `: ${richText(body.caption)}` : ""}]`; break;
      default: own = `[${b.type}]`;
    }
    lines.push(indent + own);
    if (b.children?.length) lines.push(blocksText(b.children, maria, `${indent}  `));
  }
  return lines.filter((l) => l !== "").join("\n");
}

/** Same text, whatever Notion did to the spacing. */
export const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();

/** Notion takes at most 2000 characters in one text object. */
function spans(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  // **bold** is the one inline mark worth keeping: it is how a draft says "fill this in".
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  for (const part of parts) {
    const bold = /^\*\*[^*]+\*\*$/.test(part);
    const content = bold ? part.slice(2, -2) : part;
    for (let i = 0; i < content.length; i += 2000) {
      out.push({
        type: "text",
        text: { content: content.slice(i, i + 2000) },
        ...(bold ? { annotations: { bold: true } } : {}),
      });
    }
  }
  return out;
}

const block = (type: string, text: string, extra: Record<string, unknown> = {}): Block =>
  ({ object: "block", type, [type]: { rich_text: spans(text), ...extra } }) as unknown as Block;

/**
 * The assistant's text as blocks, one per line: `#` headings, `-` bullets,
 * `1.` numbered, `[ ]` checkboxes, `>` quotes, `---` dividers, anything else a
 * paragraph. Blank lines separate and are dropped — Notion spaces blocks itself.
 */
export function textBlocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m: RegExpMatchArray | null;
    if (/^\s*---+\s*$/.test(line)) out.push({ object: "block", type: "divider", divider: {} } as unknown as Block);
    else if ((m = line.match(/^\s*#{1,3}\s+(.*)$/))) out.push(block("heading_3", m[1]!));
    else if ((m = line.match(/^\s*(?:[-*]\s+)?\[( |x|X)\]\s+(.*)$/))) out.push(block("to_do", m[2]!, { checked: m[1] !== " " }));
    else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) out.push(block("bulleted_list_item", m[1]!));
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) out.push(block("numbered_list_item", m[1]!));
    else if ((m = line.match(/^\s*>\s?(.*)$/))) out.push(block("quote", m[1]!));
    else out.push(block("paragraph", line.trim()));
  }
  return out;
}
