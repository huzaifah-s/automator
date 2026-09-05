import { z } from "zod";
import {
  defineCredential,
  defineSecrets,
  defineWorkflow,
  redact,
  telegramSecretToken,
  webhook,
} from "../../src/core/define.ts";

/**
 * The Mantra — Notion (Contents) — Telegram commands.
 *
 * A Telegram bot that answers `/content_id <page id>` with everything on a
 * Contents page: its properties, the Hook / Script / Caption written in the
 * body, the unresolved comments, the post dates and the two links.
 *
 * A port of the n8n graph "Notion - Get contents from Telegram commands"
 * (telegram trigger → IF bot_command → Code split → Switch → get page →
 * comments → child blocks → Code → telegram).
 *
 * **The bot's updates move here.** Telegram allows exactly one webhook per
 * bot, and `register` below calls `setWebhook`. The moment this deploys, The
 * Mantra bot stops delivering to n8n and starts delivering here — there is no
 * way to run both, and nothing warns you. That is the migration, not a side
 * effect: delete the n8n workflow when this one answers.
 *
 * What changed from the n8n version, and why:
 *
 * 1. **`/content_today` and `/content_date` are not built.** They were not
 *    built in n8n either — the Switch had both outputs wired to nothing, so
 *    typing either one got silence. Here they answer "not built yet", which is
 *    the same amount of functionality and a different amount of confusion.
 * 2. **A long page arrives in several messages instead of failing.** Telegram
 *    refuses anything over 4096 characters, and a script plus a caption plus a
 *    comment thread passes that regularly. n8n sent one message and got an
 *    error back. See `messages()`.
 * 3. **The "(Posted ✅)" marks work.** n8n read them off `$json`, which at that
 *    node was the Code node's output — an object that has never held either
 *    key — so the marks could not appear no matter what Notion said.
 * 4. **A missing post date is "—".** n8n read `.start` off whatever came back
 *    and threw on a page that had no date, losing the whole reply.
 * 5. **A date with no time is not given one.** n8n formatted every value as
 *    `dd/MM/yyyy hh:mm a`, so a date-only property rendered a time that Notion
 *    does not hold and that shifted with the reader's zone.
 * 6. **Everything from Notion is HTML-escaped.** A caption containing `<` or
 *    `&` — a script with "Q&A" in it will do — took the whole message down.
 * 7. **The route is authenticated.** n8n's Telegram trigger accepted anything
 *    that reached its webhook path; the chat allowlist ran *after*. Here
 *    Telegram's `secret_token` guards the door and the allowlist decides who
 *    gets answered.
 * 8. **`/content_id@TheMantraFragranceBot` works.** Telegram appends the bot's
 *    username to commands sent in a group, and n8n's exact-match Switch did
 *    not strip it.
 */

/* ------------------------------------------------------------ credentials */

/** The same two slots the other Mantra workflows use. */
const notion = defineCredential("notion", "the-mantra-contents");
const telegram = defineCredential("telegram", "the-mantra");

/**
 * The token Telegram echoes back on every delivery, proving the request came
 * from Telegram and not from whoever guessed the path.
 *
 * Required, unlike the Notion webhook token next door — the difference is that
 * this one is *ours*. We choose the value, hand it to `setWebhook`, and check
 * it on the way back in, so it can be in the store before the route exists:
 *
 *   openssl rand -hex 32
 *   bun run secret -- set TELEGRAM_WEBHOOK_SECRET
 *
 * A missing one stops the boot. That is louder than the alternative, which is
 * a bot that registers a webhook it will then reject every delivery from and
 * looks, from Telegram, exactly like a bot nobody is running.
 */
const secrets = defineSecrets({
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
});

/* ---------------------------------------------------------- configuration */

/**
 * Who may talk to the bot — n8n's `chatIds` on the trigger, kept as
 * configuration rather than a secret so the run page stays readable. Anything
 * from anywhere else is dropped without a reply: answering a stranger, even to
 * refuse them, confirms the bot is alive.
 */
const ALLOWED_CHATS = () =>
  (process.env.TELEGRAM_COMMAND_CHAT_IDS ?? "443332004,1737003626")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

const TZ = "Asia/Kuala_Lumpur";

/** Pinned rather than floating: a schema change should not arrive unannounced. */
const NOTION_VERSION = "2022-06-28";

/** 100 blocks a page. Ten pages of one content page is a misconfiguration. */
const BLOCK_PAGES = 10;
/** How far into nested blocks to follow. Toggles and list children live here. */
const BLOCK_DEPTH = 2;
/** Past this many comments, read the thread in Notion — the link is in the reply. */
const MAX_COMMENTS = 200;

/**
 * Blocks whose children are a different document, not more of this one.
 * Following a `child_page` pulls an entire subpage into the reply.
 */
const OPAQUE = new Set(["child_page", "child_database", "table", "synced_block"]);

/** The `# Heading` names in the page body that mark the sections we read. */
const SECTIONS = { hook: "Hook", script: "Script", caption: "Caption" } as const;
type SectionKey = keyof typeof SECTIONS;

/**
 * Properties as they are named in the Contents database. Matched loosely —
 * see `prop()` — because "Post Date (Tik Tok)" and "Posted (Tiktok)" already
 * disagree about how to spell it and a rename should not blank a field.
 */
const PROPS = {
  status: "Status",
  type: "Type",
  objective: "Objective",
  objectiveType: "Objective Type",
  contentType: "Content Type",
  postDateTikTok: "Post Date (Tik Tok)",
  postDateOthers: "Post Date (Others)",
  postedTikTok: "Posted (Tiktok)",
  postedOthers: "Posted (X, Threads, Instagram, Facebook)",
  fileUrl: "File URL",
} as const;

/* ------------------------------------------------------------------ payload */

/**
 * One Telegram update. Loose all the way down: Telegram adds fields to these
 * constantly, and a schema rejection is a 401-shaped hole in a bot that was
 * working yesterday.
 */
const update = z.looseObject({
  update_id: z.number().optional(),
  message: z
    .looseObject({
      message_id: z.number().optional(),
      text: z.string().optional(),
      from: z.looseObject({ id: z.number(), username: z.string().optional() }).optional(),
      chat: z.looseObject({ id: z.number() }).optional(),
      entities: z
        .array(z.looseObject({ type: z.string(), offset: z.number(), length: z.number() }))
        .optional(),
    })
    .optional(),
});

type Update = z.infer<typeof update>;

/* ------------------------------------------------------------------- notion */

interface NotionProperty {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface NotionPage {
  id: string;
  url?: string;
  properties?: Record<string, NotionProperty>;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface NotionComment {
  id: string;
  rich_text?: Array<{ plain_text?: string }>;
  display_name?: { resolved_name?: string };
}

/** The value behind a property, whatever its type. */
function readValue(prop: NotionProperty | undefined): unknown {
  if (!prop?.type) return null;
  const v = prop[prop.type];
  if (v === null || v === undefined) return null;
  switch (prop.type) {
    case "select":
    case "status":
      return (v as { name?: string }).name ?? null;
    case "multi_select":
      return (v as Array<{ name: string }>).map((o) => o.name).join(", ");
    case "date":
      return (v as { start?: string }).start ?? null;
    case "title":
    case "rich_text":
      return (v as Array<{ plain_text?: string }>).map((t) => t.plain_text ?? "").join("");
    case "formula": {
      const f = v as { type: string; [key: string]: unknown };
      return f[f.type] ?? null;
    }
    default:
      return v;
  }
}

/** Names compared with the punctuation and case taken out. */
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * One property by name, exactly if it is there and loosely if it is not.
 * "Post Date (Tik Tok)" survives being retyped as "Post Date (TikTok)".
 */
function prop(page: NotionPage, name: string): NotionProperty | undefined {
  const props = page.properties ?? {};
  if (props[name]) return props[name];
  const wanted = key(name);
  for (const [column, p] of Object.entries(props)) {
    if (key(column) === wanted) return p;
  }
  return undefined;
}

/** A property as display text, or "—" when the page does not have it. */
function text(page: NotionPage, name: string): string {
  const value = readValue(prop(page, name));
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function checkbox(page: NotionPage, name: string): boolean {
  return readValue(prop(page, name)) === true;
}

/** The page's title, found by type rather than by the name "Name". */
function titleOf(page: NotionPage): string {
  for (const p of Object.values(page.properties ?? {})) {
    if (p.type === "title") {
      const value = readValue(p);
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return "(untitled)";
}

/** Whatever plain text a block carries. Everything here has `rich_text`. */
function blockText(block: NotionBlock): string {
  const body = block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  if (!Array.isArray(body?.rich_text)) return "";
  return body.rich_text.map((t) => t.plain_text ?? "").join("");
}

/** Notion ids arrive dashed or bare depending on which endpoint spoke. */
const bare = (id: string) => id.replace(/-/g, "").toLowerCase();

/**
 * Is this a page id at all? A 32-character hex string, dashed or not.
 * Checked before the fetch so a typo comes back as "that is not a page id"
 * rather than as Notion's 400 on the run page and nothing in the chat.
 */
const isPageId = (value: string) => /^[0-9a-f]{32}$/.test(bare(value));

/* -------------------------------------------------------------------- clock */

/**
 * `dd/MM/yyyy hh:mm AM` in KL, matching what n8n rendered — except for a
 * date-only value, which gets no time. Notion stores "2026-09-05" when nobody
 * set one, and printing "12:00 AM" invents a fact.
 */
function klDate(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "—";
  if (iso.length === 10) {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return (
    `${get("day")}/${get("month")}/${get("year")} ` +
    `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`
  );
}

/* ---------------------------------------------------------------- telegram */

/** Telegram's HTML mode needs these three; a script with "Q&A" needs them badly. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Same, plus the quote — this one goes inside an href. */
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

/**
 * Telegram's ceiling is 4096 characters. The margin is for the `(2/3)` tag
 * `messages()` adds once it knows there is more than one.
 */
const LIMIT = 4000;

/**
 * A piece of the reply.
 *
 * `line` is short, already escaped, and never split — a heading, a property,
 * a link. `block` is page content: unescaped, because a split has to happen
 * on the raw text. Slicing escaped text cuts `&amp;` in half and Telegram
 * rejects the entire message for it.
 */
type Part =
  | { kind: "line"; html: string }
  | { kind: "block"; raw: string; code?: boolean };

/** What `raw` will measure once escaped, without building the escaped string. */
function escLen(raw: string): number {
  let n = 0;
  for (const c of raw) n += c === "&" ? 5 : c === "<" || c === ">" ? 4 : 1;
  return n;
}

/** How many characters of `raw` fit in `budget` once escaped. */
function fits(raw: string, budget: number): number {
  let cost = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    cost += c === "&" ? 5 : c === "<" || c === ">" ? 4 : 1;
    if (cost > budget) return i;
  }
  return raw.length;
}

/** Breaks raw text into pieces that fit, preferring line boundaries. */
function chunk(raw: string, budget: number): string[] {
  const out: string[] = [];
  let cur = "";
  const add = (piece: string) => {
    if (!cur) cur = piece;
    else if (escLen(cur) + 1 + escLen(piece) <= budget) cur += `\n${piece}`;
    else {
      out.push(cur);
      cur = piece;
    }
  };

  for (const line of raw.split("\n")) {
    let rest = line;
    // Only reached by a single line longer than a whole message, which is a
    // wall of text pasted into one Notion block.
    while (escLen(rest) > budget) {
      const n = Math.max(1, fits(rest, budget));
      add(rest.slice(0, n));
      rest = rest.slice(n);
    }
    add(rest);
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Packs the parts into as few messages as Telegram will take, breaking only
 * where an HTML tag is not open. Numbered once there is more than one, so a
 * reply that arrives out of order is still readable.
 */
function messages(parts: Part[]): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (piece: string) => {
    if (!piece && !cur) return;
    if (cur && cur.length + 1 + piece.length > LIMIT) {
      out.push(cur);
      cur = piece;
    } else cur = cur ? `${cur}\n${piece}` : piece;
  };

  for (const part of parts) {
    if (part.kind === "line") {
      push(part.html);
      continue;
    }
    // `<code>` costs 13 characters and must open and close inside one message.
    const budget = LIMIT - (part.code ? 13 : 0);
    for (const piece of chunk(part.raw, budget)) {
      push(part.code ? `<code>${esc(piece)}</code>` : esc(piece));
    }
  }
  if (cur) out.push(cur);

  if (out.length <= 1) return out;
  return out.map((m, i) => `${m}\n<i>(${i + 1}/${out.length})</i>`);
}

const RULE = "──────────";

/* --------------------------------------------------------------- decisions */

type Command =
  | { kind: "ignored"; reason: string }
  | { kind: "command"; chatId: string; command: string; param: string };

/**
 * n8n's IF node and its first Code node, in one place: is this a command, from
 * someone we answer, and what did they type?
 */
function readCommand(input: Partial<Update>): Command {
  const message = input.message;
  if (!message) return { kind: "ignored", reason: "update carried no message" };

  // The chat, not the sender: a command typed in a group is answered in that
  // group. n8n replied to `message.from.id`, which sends a private message to
  // someone who asked in public and fails outright if they never started the
  // bot.
  const chatId = String(message.chat?.id ?? message.from?.id ?? "");
  if (!chatId) return { kind: "ignored", reason: "update named no chat" };
  if (!ALLOWED_CHATS().includes(chatId)) {
    return { kind: "ignored", reason: `chat ${chatId} is not on the allowlist` };
  }

  const raw = message.text ?? "";
  // The entity check n8n's IF node did, tightened to offset 0: a message that
  // merely *mentions* /content_id halfway through is not a command.
  const isCommand = (message.entities ?? []).some(
    (e) => e.type === "bot_command" && e.offset === 0,
  );
  if (!isCommand) return { kind: "ignored", reason: "message was not a command" };

  const [head = "", ...rest] = raw.trim().split(/\s+/);
  // "/content_id@TheMantraFragranceBot" in a group.
  const command = head.split("@")[0]!.toLowerCase();
  return { kind: "command", chatId, command, param: rest.join(" ") };
}

const HELP =
  "<b>The Mantra — Contents</b>\n\n" +
  "<code>/content_id &lt;page id&gt;</code> — everything on one content page.\n\n" +
  "The id is the 32-character string at the end of a Notion page's URL.";

/* ----------------------------------------------------------------- workflow */

export default defineWorkflow<Update>({
  name: "the-mantra-notion-contents-telegram-commands",
  description: "Answers /content_id on Telegram with a Contents page",
  trigger: webhook("the-mantra/telegram-commands", {
    method: "POST",
    schema: update,
    // Telegram cannot be told to send X-Automator-Secret, so the shared-secret
    // path cannot guard this route. `verify` replaces it — the two are mutually
    // exclusive, and this is the one that matches what the provider sends.
    verify: telegramSecretToken(() => secrets.TELEGRAM_WEBHOOK_SECRET),
    register: {
      /**
       * Telegram has no subscription list and no id: one bot has one webhook,
       * `setWebhook` overwrites whatever was there, and the only thing that
       * identifies it is the URL. So that is what is returned and kept in
       * state — which is what makes the reconciler notice a changed PUBLIC_URL
       * and re-register instead of leaving deliveries going nowhere.
       */
      async create(ctx) {
        await ctx.http.post(
          `https://api.telegram.org/bot${telegram.token}/setWebhook`,
          {
            url: ctx.url,
            secret_token: secrets.TELEGRAM_WEBHOOK_SECRET,
            // n8n's `updates: ["message"]`. Everything else — edits, callback
            // queries, channel posts — is delivery this workflow would drop.
            allowed_updates: ["message"],
            // Whatever queued up while the bot had no webhook is stale by
            // definition: a command answered an hour late reads as a bug.
            drop_pending_updates: true,
          },
        );
        return ctx.url;
      },
      async remove(ctx) {
        await ctx.http.post(
          `https://api.telegram.org/bot${telegram.token}/deleteWebhook`,
          {},
        );
      },
    },
  }),
  // Two people asking at once must both get an answer; "skip" would drop the
  // second command on the floor and look like the bot ignoring them.
  onOverlap: "queue",
  retries: 2,
  timeoutMs: 120_000,
  // The reply is a snapshot of a page. An hour-old checkpoint is worth reusing
  // across a retry; a day-old one, resumed by hand, would answer with content
  // that has since been rewritten.
  checkpointTtlHours: 1,

  async run(ctx) {
    // Read inside a step, never at the top of run(): a resumed run has no
    // ctx.input, so this would look at `{}` and report an unusable update.
    const decision = await ctx.step<Command>("read command", async () =>
      readCommand(ctx.input as Partial<Update>),
    );

    if (decision.kind === "ignored") {
      ctx.log.info(`Ignoring update: ${decision.reason}`);
      return { ignored: decision.reason };
    }

    const { chatId, command, param } = decision;
    const reply = (text: string) =>
      ctx.telegram.send(text, {
        token: telegram.token,
        chatId,
        parseMode: "HTML",
      });

    if (command !== "/content_id") {
      const known = command === "/content_today" || command === "/content_date";
      await ctx.step("answer", () =>
        reply(
          known
            ? `<b>${esc(command)}</b> is not built yet.\n\n${HELP}`
            : `I don't know <b>${esc(command)}</b>.\n\n${HELP}`,
        ),
      );
      return { command, answered: known ? "not built" : "unknown command" };
    }

    if (!isPageId(param)) {
      await ctx.step("answer", () =>
        reply(
          param
            ? `<code>${esc(param)}</code> is not a Notion page id.\n\n${HELP}`
            : HELP,
        ),
      );
      return { command, answered: "bad page id" };
    }

    const pageId = param;
    const headers = {
      authorization: `Bearer ${notion.token}`,
      "Notion-Version": NOTION_VERSION,
    };

    /* ------------------------------------------------------------- the page */

    const page = await ctx.step<NotionPage | null>(
      "fetch page",
      async () => {
        try {
          return await ctx.http.get<NotionPage>(
            `https://api.notion.com/v1/pages/${pageId}`,
            { headers },
          );
        } catch (err) {
          // Duck-typed rather than `instanceof HttpError`: the class is not on
          // the workflow API surface, and the only thing needed off it is the
          // status. A 404 here is somebody mistyping an id, which is an answer
          // to give, not a run to fail.
          const status = (err as { status?: unknown }).status;
          if (status === 404 || status === 400) return null;
          throw err;
        }
      },
      { input: { pageId } },
    );

    if (!page) {
      await ctx.step("answer", () =>
        reply(
          `No page with the id <code>${esc(pageId)}</code>, or the integration ` +
            `cannot see it.`,
        ),
      );
      return { command, pageId, answered: "no such page" };
    }

    /* ---------------------------------------------------------- the comments */

    const comments = await ctx.step<string[]>(
      "read unresolved comments",
      async () => {
        // Notion's comments endpoint returns open comments only, so there is
        // nothing to filter — which is what made n8n's `include_resolved=true`
        // a no-op and its whole resolved-comment branch unnecessary.
        const list = await ctx.http
          .paginate<NotionComment>(
            `https://api.notion.com/v1/comments?block_id=${pageId}&page_size=100`,
            {
              headers,
              next: { cursor: "next_cursor", param: "start_cursor" },
              // maxItems stops quietly where maxPages would throw. A truncated
              // comment list is a shorter reminder, not a wrong answer, and the
              // reply links to the page that has all of them.
              maxItems: MAX_COMMENTS,
              maxPages: BLOCK_PAGES,
            },
          )
          .all();

        const found: string[] = [];
        for (const c of list) {
          const body = (c.rich_text ?? [])
            .map((t) => t.plain_text ?? "")
            .join("")
            .trim();
          if (!body) continue;
          const author = c.display_name?.resolved_name;
          found.push(author ? `${author}: ${body}` : body);
        }
        return found;
      },
      { input: { pageId } },
    );

    /* ------------------------------------------------------------ the body */

    const sections = await ctx.step<Record<SectionKey, string>>(
      "read page content",
      async () => {
        /** Blocks in document order, nested ones included — n8n's fetchNestedBlocks. */
        const collect = async (blockId: string, depth: number): Promise<NotionBlock[]> => {
          const children = await ctx.http
            .paginate<NotionBlock>(
              `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`,
              {
                headers,
                next: { cursor: "next_cursor", param: "start_cursor" },
                maxPages: BLOCK_PAGES,
              },
            )
            .all();

          const flat: NotionBlock[] = [];
          for (const block of children) {
            flat.push(block);
            if (block.has_children && depth < BLOCK_DEPTH && !OPAQUE.has(block.type)) {
              flat.push(...(await collect(block.id, depth + 1)));
            }
          }
          return flat;
        };

        const found: Record<SectionKey, string[]> = { hook: [], script: [], caption: [] };
        const headings = new Map<string, SectionKey>(
          Object.entries(SECTIONS).map(([k, name]) => [key(name), k as SectionKey]),
        );

        let current: SectionKey | null = null;
        for (const block of await collect(pageId, 0)) {
          if (block.type === "heading_1") {
            // An unrecognised heading closes the section rather than being
            // swallowed into it — same as n8n's `sectionMap[content] || null`.
            current = headings.get(key(blockText(block))) ?? null;
            continue;
          }
          if (!current || block.type === "divider") continue;
          const body = blockText(block).trim();
          if (body) found[current].push(body);
        }

        return {
          hook: found.hook.join("\n"),
          script: found.script.join("\n"),
          // A caption's paragraphs are separated, as they will be when it is
          // pasted — the one place n8n's joins differed, and it was right.
          caption: found.caption.join("\n\n"),
        };
      },
      { input: { pageId } },
    );

    /* ----------------------------------------------------------- the reply */

    const parts: Part[] = [];
    const line = (html: string) => parts.push({ kind: "line", html });
    const section = (label: string, body: string, code = false) => {
      line(RULE);
      line(`<b>${label}:</b>`);
      if (body) parts.push({ kind: "block", raw: body, code });
      else line("—");
    };

    const title = titleOf(page);
    const link = page.url ?? `https://app.notion.com/p/${bare(pageId)}`;
    const fileUrl = readValue(prop(page, PROPS.fileUrl));

    line(`<b>ID:</b> <code>${esc(page.id)}</code> 📋`);
    line(`<b>Item:</b> ${esc(title)}`);
    line(`<b>Status:</b> ${esc(text(page, PROPS.status))}`);
    line(RULE);
    line(`<b>Type:</b> ${esc(text(page, PROPS.type))}`);
    line(`<b>Objective:</b> ${esc(text(page, PROPS.objective))}`);
    line(`<b>Objective Type:</b> ${esc(text(page, PROPS.objectiveType))}`);
    line(`<b>Content Type:</b> ${esc(text(page, PROPS.contentType))}`);

    section("Hook", sections.hook);
    section("Script", sections.script);
    // Code-wrapped so it is one tap to copy, which is the whole point of it.
    section("Caption", sections.caption, true);
    section("Comments", comments.map((c) => `• ${c}`).join("\n"));

    line(RULE);
    const posted = (yes: boolean) => (yes ? " (Posted ✅)" : "");
    line(
      `Post date (TikTok): ${esc(klDate(readValue(prop(page, PROPS.postDateTikTok))))}` +
        posted(checkbox(page, PROPS.postedTikTok)),
    );
    line(
      `Post date (Others): ${esc(klDate(readValue(prop(page, PROPS.postDateOthers))))}` +
        posted(checkbox(page, PROPS.postedOthers)),
    );
    line(RULE);
    line(`<a href="${attr(link)}">Open Notion</a>`);
    // n8n rendered this unconditionally, so a page with no file got an
    // <a href="undefined">.
    if (typeof fileUrl === "string" && fileUrl) {
      line(`<a href="${attr(fileUrl)}">Open File</a>`);
    }

    const out = messages(parts);
    for (const [i, message] of out.entries()) {
      // Indexed, because a step name is the checkpoint key and two sends under
      // one name would collide on a retry.
      await ctx.step(`send reply ${i + 1}/${out.length}`, () => reply(message));
    }

    return {
      command,
      pageId,
      title,
      comments: comments.length,
      messages: out.length,
      chars: out.reduce((n, m) => n + m.length, 0),
    };
  },

  /**
   * A person is waiting on this one, so a failed run says so in the chat
   * rather than only on the dashboard. Errors thrown in here are logged and
   * swallowed by the runner, so a Telegram outage cannot turn one failure into
   * two.
   */
  async onFailure(ctx, error) {
    const decision = readCommand(ctx.input as Partial<Update>);
    if (decision.kind !== "command") return;
    await ctx.telegram.send(
      `Couldn't answer <b>${esc(decision.command)}</b>.\n\n` +
        // redact(): a provider's error message is the one thing a workflow
        // composes and sends *out*, so nothing else has scrubbed it.
        `<code>${esc(redact(error.message).slice(0, 500))}</code>`,
      { token: telegram.token, chatId: decision.chatId, parseMode: "HTML" },
    );
  },
});
