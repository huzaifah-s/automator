import { z } from "zod";
import {
  defineCredential,
  defineSecrets,
  defineWorkflow,
  notionSignature,
  webhook,
} from "../../src/core/define.ts";

/**
 * The Mantra — Notion (Contents) — Update Notification on Telegram.
 *
 * Notion posts every change the integration can see; this route keeps the ones
 * that moved a **Status** in the Contents database, reassigns the page to
 * whoever the new status belongs to, and tells that person on Telegram — with
 * the page's unresolved comments attached when the ball is in Jenny's court.
 *
 * A port of two n8n graphs, merged into one:
 *
 *   "Notion - Webhook Subscriptions"                    (webhook → switch →
 *                                                        get page → code →
 *                                                        execute workflow)
 *   "The Mantra - Notion (Contents) - Update
 *    Notification on Telegram"                          (filter → update page →
 *                                                        switch → comments →
 *                                                        blocks → code →
 *                                                        telegram)
 *
 * **Why one workflow and not two.** n8n's split existed because a Notion
 * subscription delivers to a single URL for the whole integration, and the
 * first graph was the shared front door that fanned out. Today it fans out to
 * exactly one consumer, so the second graph is inlined and the database filter
 * that made the split meaningful lives here as `isContents()`. When a second
 * database wants its own notifier, split it then: this file keeps the webhook
 * and calls the others with `ctx.run()`.
 *
 * Six things the n8n version got wrong or left implicit, fixed here:
 *
 * 1. **The status change is found, not assumed.** n8n read `changes[0]` and
 *    filtered on it, so a save that touched a checkbox *and* the status —
 *    which the pinned example is — notified nobody, depending on the order
 *    Notion happened to list the ids in.
 * 2. **Events from other databases are dropped.** A Notion subscription is
 *    per-integration, so the Threads database's events arrive on this URL too.
 *    n8n fetched every one of those pages before discovering it did not care.
 * 3. **The reassignment is skipped when it would change nothing.** n8n wrote
 *    the same assignee back for "Approved" and "Posted", and each of those
 *    writes generated another `page.properties_updated` webhook. The loop
 *    stopped only because the second event's changed property was Assignee,
 *    not Status — i.e. by luck of the filter, one condition away from a cycle.
 * 4. **The route is authenticated.** n8n's was an unguessable path and nothing
 *    else, on an endpoint that mutates a database.
 * 5. **The dead "get child blocks" hop is gone.** Its only purpose was to give
 *    the Code node items to enumerate page ids from — page ids this workflow
 *    already has.
 * 6. **Names are HTML-escaped.** A page titled "Tan & Sons" broke the whole
 *    Telegram message.
 */

/* ------------------------------------------------------------ credentials */

/**
 * The same two slots the runway alert uses — connect them once on the
 * Credentials tab and both workflows are covered. Unconnected, this one is
 * marked blocked and refuses to run rather than stopping the boot.
 */
const notion = defineCredential("notion", "the-mantra-contents");
const telegram = defineCredential("telegram", "the-mantra");

/**
 * Notion's webhook verification token, which is what signs every delivery.
 *
 * `.optional()` on purpose: it cannot exist until Notion has sent it, and
 * Notion will not send it until this route is live. A required secret here
 * would mean the deploy that creates the endpoint is the deploy that cannot
 * boot. Unset, the verifier fails every *event* closed and only the handshake
 * gets through — see the header comment on `notionSignature`.
 *
 * Read through the live proxy on every request, so storing it takes effect on
 * the next delivery instead of the next restart.
 */
const secrets = defineSecrets({
  NOTION_WEBHOOK_TOKEN: z.string().min(10).optional(),
});

/* ---------------------------------------------------------- configuration */

/** The Contents database, and the data source Notion names it by in events. */
const CONTENTS_DB = "39903cbd-c49e-805d-8a15-e991fc30b12e";
const CONTENTS_DATA_SOURCE = "39903cbd-c49e-8002-9d5c-000b80ab96d5";

/**
 * The Status property's id in that database. Notion lists changed properties
 * by id, and an id survives a rename where the name does not — but it is
 * opaque, so the name is checked too and either one is enough.
 */
const STATUS_PROP_ID = "%5B%5Bh%5B";
const STATUS_PROP_NAME = "Status";
/** The property this workflow writes. */
const ASSIGNEE_PROP_NAME = "Assignee";

/** Pinned rather than floating: a schema change should not arrive unannounced. */
const NOTION_VERSION = "2022-06-28";
/** Unresolved comments on one content page. Past this, read them in Notion. */
const COMMENT_PAGES = 3;

/**
 * Who each status belongs to. Both halves of what n8n split across a Switch
 * node and an inline object literal in the page-update expression:
 *
 *   `assign`  — the person the page is handed to. Absent means "leave the
 *               assignee alone", which is what n8n's `|| [existing]` fallback
 *               did for Approved and Posted.
 *   `tell`    — who gets the Telegram. A status listed with neither is known
 *               and deliberately silent; one that is not listed at all is
 *               logged as unrouted, so a new status option in Notion shows up
 *               as a gap rather than as silence.
 */
const ROUTES: Record<string, { assign?: PersonId; tell?: PersonId }> = {
  "In Review": { assign: "huzaifah", tell: "huzaifah" },
  "To Fix": { assign: "jenny", tell: "jenny" },
  Approved: { tell: "jenny" },
  Posted: { tell: "jenny" },
};

type PersonId = "huzaifah" | "jenny";

/**
 * Notion user ids and Telegram chat ids are both configuration, not secrets:
 * declaring them with `defineSecrets` would blank them out of every run page,
 * and neither one authenticates anything. The literals are the defaults so the
 * workflow works on a fresh deploy; the env vars are there for when a person
 * changes, which is a `.env` edit rather than a code change.
 */
const PEOPLE: Record<PersonId, { label: string; notionUser: string; chat: () => string }> = {
  huzaifah: {
    label: "Huzaifah",
    notionUser: "ae20b114-abf9-48f3-b05f-e4abdcadb569",
    chat: () => process.env.TELEGRAM_CHAT_ID_HUZAIFAH ?? "443332004",
  },
  jenny: {
    label: "Jenny",
    notionUser: "2bed872b-594c-81af-8775-000246b0eb5b",
    // No fallback to the credential's own chat id, unlike Huzaifah's: that
    // would quietly send Jenny's queue to whoever the bot's default chat is.
    chat: () => process.env.TELEGRAM_CHAT_ID_JENNY ?? "1737003626",
  },
};

/** Where the handshake token is parked for the operator to collect. */
const TOKEN_STATE_KEY = "notion:the-mantra-contents:verification-token";

/* ------------------------------------------------------------------ payload */

/**
 * Notion's one-time verification POST, and the reason this schema has a
 * transform in it.
 *
 * The parsed body is what reaches the inbox table, the run's captured input,
 * and the run page — and this one is a live credential the redactor has never
 * heard of, because it is being delivered *for the first time*. The schema is
 * the last boundary before any of that, so it strips the token out and parks
 * it in memory for `run()` to file away. Nothing containing it is written
 * anywhere except `ctx.state`, which is the one store that is never rendered.
 *
 * The cost: a crash between the 202 and the run loses the token, and inbox
 * recovery replays a payload the token is no longer in. That is a click on
 * "Resend token" in Notion's verification modal, which is why it is affordable.
 */
let pendingToken: string | null = null;

const handshake = z
  .object({ verification_token: z.string().min(10) })
  .transform(({ verification_token }) => {
    pendingToken = verification_token;
    return { handshake: true as const };
  });

/**
 * A change event. Loose all the way down — Notion adds fields to these, and a
 * new one must not turn a delivery into a 422 that Notion then retries five
 * times before giving up on the subscription.
 */
const event = z.looseObject({
  type: z.string(),
  entity: z.looseObject({ id: z.string() }).optional(),
  data: z
    .looseObject({
      parent: z
        .looseObject({
          id: z.string().optional(),
          data_source_id: z.string().optional(),
        })
        .optional(),
      updated_properties: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * Order matters and both branches are mutually exclusive: an event has no
 * `verification_token`, and a handshake has no `type`.
 */
const payload = z.union([handshake, event]);

type Payload = z.infer<typeof payload>;

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

interface NotionComment {
  id: string;
  rich_text?: Array<{ plain_text?: string }>;
}

interface CommentList {
  results: NotionComment[];
  next_cursor: string | null;
  has_more: boolean;
}

/** One resolved property change, the shape n8n's first Code node produced. */
interface Change {
  id: string;
  column: string;
  type: string | null;
  value: unknown;
}

/**
 * The value behind a property, whatever its type — n8n's `readValue`, with
 * `status` and `people` added. `status` because the Contents database could
 * be migrated to Notion's status type at any point and the notification would
 * silently start reading `null`; `people` because the raw array is a page of
 * JSON per assignee on the run page when all this needs is the ids.
 */
function readValue(prop: NotionProperty | undefined): unknown {
  if (!prop?.type) return null;
  const v = prop[prop.type];
  if (v === null || v === undefined) return null;
  switch (prop.type) {
    case "select":
    case "status":
      return (v as { name?: string }).name ?? null;
    case "multi_select":
      return (v as Array<{ name: string }>).map((o) => o.name);
    case "people":
      return (v as Array<{ id: string }>).map((p) => p.id);
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

/** The page's title, found by type rather than by the name "Name". */
function titleOf(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop.type === "title") {
      const text = readValue(prop);
      if (typeof text === "string" && text.trim()) return text;
    }
  }
  return "(untitled)";
}

function stringProp(page: NotionPage, name: string): string | null {
  const value = readValue(page.properties?.[name]);
  return typeof value === "string" && value ? value : null;
}

/** Notion ids arrive dashed or bare depending on which endpoint spoke. */
const bare = (id: string | undefined | null) => (id ?? "").replace(/-/g, "").toLowerCase();

/** Telegram's HTML mode needs these three; a page titled "Tan & Sons" needs them badly. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------------------------------------------------------------- decisions */

type Decision =
  | { kind: "handshake" }
  | { kind: "ignored"; reason: string }
  | { kind: "page-updated"; pageId: string; updated: string[] };

/* ----------------------------------------------------------------- workflow */

export default defineWorkflow<Payload>({
  name: "the-mantra-notion-contents-update-notification",
  description: "Reassigns a Contents page on a Status change and pings the owner",
  trigger: webhook("the-mantra/notion-contents", {
    method: "POST",
    schema: payload,
    // Notion signs the body and has nowhere to put a shared secret, so the
    // route authenticates by signature. `secret` and `verify` are mutually
    // exclusive — this replaces WEBHOOK_SECRET on this path, it does not
    // stack with it.
    verify: notionSignature(() => secrets.NOTION_WEBHOOK_TOKEN),
  }),
  // A status change must not be dropped because another one is in flight, and
  // a busy editing session produces several within a second.
  onOverlap: "queue",
  retries: 3,
  timeoutMs: 120_000,

  async run(ctx) {
    // Read inside a step, never at the top of run(): a resumed run has no
    // ctx.input, so this would look at `{}` and report an unusable event.
    const decision = await ctx.step<Decision>("read event", async () => {
      const input = ctx.input as Partial<Payload>;

      if ("handshake" in input && input.handshake) {
        const token = pendingToken;
        pendingToken = null;
        if (!token) {
          return {
            kind: "ignored",
            reason: "verification handshake replayed — click Resend token in Notion",
          };
        }
        // State is the only store nothing renders, which is the whole reason
        // the token goes here and not into this step's result.
        await ctx.state.shared.set(TOKEN_STATE_KEY, token);
        return { kind: "handshake" };
      }

      if (!("type" in input) || !input.type) {
        return { kind: "ignored", reason: "payload had no event type" };
      }
      if (input.type !== "page.properties_updated") {
        return { kind: "ignored", reason: input.type };
      }

      const parent = input.data?.parent;
      const fromContents =
        bare(parent?.id) === bare(CONTENTS_DB) ||
        bare(parent?.data_source_id) === bare(CONTENTS_DATA_SOURCE);
      if (!fromContents) {
        // Every database the integration can see delivers here, so this is the
        // common case, not an error.
        return { kind: "ignored", reason: `page is not in the Contents database` };
      }

      const pageId = input.entity?.id;
      if (!pageId) return { kind: "ignored", reason: "event named no page" };

      const updated = input.data?.updated_properties ?? [];
      if (!updated.includes(STATUS_PROP_ID)) {
        // Cheap pre-filter on the id alone. The authoritative check is by name
        // as well, below, once the page has told us what the ids mean — but
        // most deliveries are somebody ticking a checkbox, and those should
        // not cost a page fetch.
        return { kind: "ignored", reason: "Status was not among the changed properties" };
      }

      return { kind: "page-updated", pageId, updated };
    });

    if (decision.kind === "handshake") {
      // The token itself is not in this message. It is in state, and state is
      // the one thing this project never renders — so the nudge says where to
      // read it rather than carrying it through Telegram's request body onto
      // the run page.
      await ctx.step("ask for the token to be filed", () =>
        ctx.telegram.send(
          "🔗 <b>Notion webhook verification</b>\n\n" +
            "Notion sent the verification token for <code>the-mantra/notion-contents</code>. " +
            "Read it on the server:\n\n" +
            "<pre>sqlite3 data/automator.db \"select value from state " +
            `where namespace='@shared' and key='${TOKEN_STATE_KEY}'"</pre>\n` +
            "Paste it into Notion's verification modal, then store the same value as " +
            "<code>NOTION_WEBHOOK_TOKEN</code> on the dashboard. Until you do, every real " +
            "event on this route is rejected.",
          { token: telegram.token, chatId: PEOPLE.huzaifah.chat(), parseMode: "HTML" },
        ),
      );
      return { handshake: true };
    }

    if (decision.kind === "ignored") {
      ctx.log.info(`Ignoring delivery: ${decision.reason}`);
      return { ignored: decision.reason };
    }

    const { pageId, updated } = decision;

    const page = await ctx.step<NotionPage>(
      "fetch page",
      () =>
        ctx.http.get<NotionPage>(`https://api.notion.com/v1/pages/${pageId}`, {
          headers: {
            authorization: `Bearer ${notion.token}`,
            "Notion-Version": NOTION_VERSION,
          },
        }),
      { input: { pageId } },
    );

    /** n8n's first Code node: changed property ids → what actually changed. */
    const changes = await ctx.step<Change[]>("resolve changed properties", async () => {
      const byId = new Map<string, { column: string; prop: NotionProperty }>();
      for (const [column, prop] of Object.entries(page.properties ?? {})) {
        byId.set(prop.id, { column, prop });
      }
      return updated.map((id) => {
        const hit = byId.get(id);
        return {
          id,
          column: hit?.column ?? "(unknown)",
          type: hit?.prop.type ?? null,
          value: readValue(hit?.prop),
        };
      });
    });

    // Found, not assumed to be first — the n8n version read changes[0] and so
    // missed every save that touched two properties in an unlucky order.
    const statusChange =
      changes.find((c) => c.id === STATUS_PROP_ID) ??
      changes.find((c) => c.column === STATUS_PROP_NAME);

    if (!statusChange) {
      ctx.log.info("Status id was listed but no Status property resolved", {
        columns: changes.map((c) => c.column),
      });
      return { ignored: "no Status property on the page", pageId };
    }

    const status = typeof statusChange.value === "string" ? statusChange.value : null;
    if (!status) {
      // Someone cleared the status. Nothing to route on, and nobody to tell.
      ctx.log.info("Status was cleared", { pageId });
      return { pageId, status: null, reassigned: false, told: null };
    }

    const route = ROUTES[status];
    if (!route) {
      // A status option exists in Notion that this file has never heard of.
      // Logged rather than silent: that is a gap to close, not a non-event.
      ctx.log.warn(`No route for status "${status}" — nobody was told`, { pageId });
      return { pageId, status, reassigned: false, told: null };
    }

    /* -------------------------------------------------------- reassignment */

    const currentAssignees = (readValue(page.properties?.[ASSIGNEE_PROP_NAME]) ?? []) as
      | string[]
      | unknown;
    const current = Array.isArray(currentAssignees) ? (currentAssignees as string[]) : [];
    const wanted = route.assign ? PEOPLE[route.assign].notionUser : null;

    // Skipped when it would change nothing. Not a micro-optimisation: every
    // write here comes back as another page.properties_updated delivery.
    const needsReassign =
      wanted !== null && !(current.length === 1 && bare(current[0]) === bare(wanted));

    if (needsReassign) {
      await ctx.step(
        "reassign page",
        () =>
          ctx.http.patch(
            `https://api.notion.com/v1/pages/${pageId}`,
            { properties: { [ASSIGNEE_PROP_NAME]: { people: [{ id: wanted }] } } },
            {
              headers: {
                authorization: `Bearer ${notion.token}`,
                "Notion-Version": NOTION_VERSION,
              },
            },
          ),
        { input: { pageId, assignTo: route.assign, from: current } },
      );
    }

    /* --------------------------------------------------------- notification */

    if (!route.tell) {
      ctx.log.info(`"${status}" is routed but silent`, { pageId, reassigned: needsReassign });
      return { pageId, status, reassigned: needsReassign, told: null };
    }

    const person = PEOPLE[route.tell];

    /**
     * Unresolved comments, for the person being asked to act on the page.
     * Notion's comments endpoint returns open comments only, so there is
     * nothing to filter — which is what made n8n's whole child-blocks detour
     * unnecessary. Only fetched for the person who has to do something about
     * them; "In Review" is a nudge, not a work order.
     */
    const comments =
      route.tell === "jenny"
        ? await ctx.step<string[]>(
            "read unresolved comments",
            async () => {
              const found: string[] = [];
              let cursor: string | undefined;

              for (let i = 0; i < COMMENT_PAGES; i++) {
                const url = new URL("https://api.notion.com/v1/comments");
                url.searchParams.set("block_id", pageId);
                url.searchParams.set("page_size", "100");
                if (cursor) url.searchParams.set("start_cursor", cursor);

                const res = await ctx.http.get<CommentList>(url.toString(), {
                  headers: {
                    authorization: `Bearer ${notion.token}`,
                    "Notion-Version": NOTION_VERSION,
                  },
                });

                for (const c of res.results) {
                  const text = (c.rich_text ?? [])
                    .map((t) => t.plain_text ?? "")
                    .join("")
                    .trim();
                  if (text) found.push(text);
                }

                if (!res.has_more || !res.next_cursor) break;
                cursor = res.next_cursor;
              }
              // Deliberately quiet on overflow, unlike the runway alert: a
              // truncated comment list is a shorter reminder, not a wrong
              // number, and the message links to the page that has them all.
              return found;
            },
            { input: { pageId } },
          )
        : [];

    const title = titleOf(page);
    const fileUrl = stringProp(page, "File URL");
    const link = page.url ?? `https://app.notion.com/p/${bare(pageId)}`;

    const lines = [
      `📋 <b>${esc(title)}</b>`,
      `Status: <b>${esc(status)}</b>`,
      `ID: <code>${esc(pageId)}</code>`,
    ];
    if (needsReassign) lines.push(`Assigned to ${esc(person.label)}`);
    if (comments.length) {
      lines.push("", `<b>Unresolved comment(s):</b>`);
      for (const c of comments) lines.push(`• ${esc(c)}`);
    }
    lines.push("", `<a href="${esc(link)}">Open Notion</a>`);
    // n8n rendered this link unconditionally, so a page with no file got an
    // <a href="undefined">.
    if (fileUrl) lines.push(`<a href="${esc(fileUrl)}">Open File</a>`);

    await ctx.step(`tell ${route.tell}`, () =>
      ctx.telegram.send(lines.join("\n"), {
        token: telegram.token,
        chatId: person.chat(),
        parseMode: "HTML",
      }),
    );

    return {
      pageId,
      title,
      status,
      reassigned: needsReassign,
      told: person.label,
      comments: comments.length,
    };
  },
});
