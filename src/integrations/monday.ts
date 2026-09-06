import { z } from "zod";
import type { HttpClient } from "./http.ts";
import type { WebhookRegistration } from "../core/types.ts";

/* --------------------------------------------------------------- the wire */

/** One cell. `text` is what the board displays; `value` is its JSON, as a string. */
export interface MondayColumn {
  id: string;
  type?: string;
  text: string | null;
  value: string | null;
}

export interface MondayItem {
  id: string;
  name: string;
  created_at?: string;
  state?: string;
  column_values: MondayColumn[];
}

export interface MondayAsset {
  id: string;
  name: string;
  /** A signed, expiring link. Fetchable by anyone who has it, for about an hour. */
  public_url: string;
}

/**
 * Reads the cells of an item by column id.
 *
 * Every reader answers `undefined` for a cell that is empty, missing, or holds
 * unparseable JSON, rather than guessing — `?? "-"` at the call site is then a
 * visible decision instead of a default buried three layers down. That matters
 * more than it looks: a WhatsApp template rejects an empty parameter outright,
 * so "what does an empty cell send" is a question every caller has to answer.
 */
export interface MondayFields {
  /** Display text, trimmed. */
  text(columnId: string): string | undefined;
  /** The parsed `value` JSON. */
  json<T = any>(columnId: string): T | undefined;
  /**
   * A status/dropdown column's numeric index — the stable identity of a label.
   * Renaming "START PRINTING" on the board changes `text` and not this.
   */
  index(columnId: string): number | undefined;
  /** A phone column's number, digits and any leading `+` only. */
  phone(columnId: string): string | undefined;
  /** An email column's address. */
  email(columnId: string): string | undefined;
  /** A link column's URL — the href, not the "title - href" text Monday renders. */
  url(columnId: string): string | undefined;
  /** Long text with its newlines collapsed to `sep` (default ", "). */
  lines(columnId: string, sep?: string): string | undefined;
}

export interface MondayClient {
  /** Any GraphQL document. Throws on a `errors` array even though Monday sends it with a 200. */
  query<T = any>(document: string, variables?: Record<string, unknown>): Promise<T>;
  /** One item with every column. Throws if the id does not resolve. */
  item(itemId: string | number): Promise<MondayItem>;
  /**
   * Items on a board whose *name* is exactly this. Empty array when none match.
   *
   * Deliberately not the more obvious `items_page_by_column_values`: that query
   * does not accept `name` as a column, only real columns. The n8n node this
   * replaces used the older `items_by_column_values`, which did — and which
   * Monday removed. Silently, from the caller's point of view: the lookup just
   * stops matching.
   */
  itemsByName(opts: {
    boardId: string | number;
    name: string;
    limit?: number;
  }): Promise<MondayItem[]>;
  createItem(opts: {
    boardId: string | number;
    groupId?: string;
    name: string;
    /** Keyed by column id, in Monday's per-type shape. Serialised for you. */
    columnValues?: Record<string, unknown>;
  }): Promise<{ id: string; name: string }>;
  setColumn(opts: {
    boardId: string | number;
    itemId: string | number;
    columnId: string;
    /** A string for a text column, an object for anything structured. */
    value: unknown;
  }): Promise<{ id: string }>;
  /** Files attached to an item, with the signed links that make them fetchable. */
  assets(itemId: string | number): Promise<MondayAsset[]>;
  /** Subscribes a URL to a board's events. Returns Monday's id for it. */
  createWebhook(opts: {
    boardId: string | number;
    url: string;
    event: MondayWebhookEvent;
    /** For the `*_specific_column_value` events: which column. */
    columnId?: string;
  }): Promise<{ id: string }>;
  /** Removes a subscription. A subscription already gone is not an error. */
  deleteWebhook(id: string): Promise<void>;
  /** Column readers over an item — see MondayFields. */
  fields(item: MondayItem): MondayFields;
}

/**
 * The subset of Monday's webhook events these workflows use.
 * `change_specific_column_value` needs a `columnId` and is worth the extra
 * config: `change_column_value` fires on every edit to every column, so a
 * corrected address or an added note wakes a workflow that then does nothing.
 *
 * **`create_item`, not `create_pulse`.** Monday has two vocabularies for the
 * same event and they do not match: you *subscribe* with `create_item`, and
 * the payload that arrives says `"type": "create_pulse"`. The old name is
 * still all over Monday's own sample payloads, which is how it got in here —
 * and it is not a silent mismatch, `create_webhook` refuses it outright with
 * `Value "create_pulse" does not exist in "WebhookEventType" enum`. The
 * receiving side keeps reading `create_pulse`, because that is what is sent.
 */
export type MondayWebhookEvent =
  | "create_item"
  | "change_column_value"
  | "change_specific_column_value"
  | "change_status_column_value";

const ENDPOINT = "https://api.monday.com/v2";

/**
 * Monday.com's GraphQL API.
 *
 * Reads MONDAY_API_TOKEN, and pins `API-Version`. Pinning is the point: Monday
 * moves the unversioned default forward on a schedule and has already removed
 * one query this depends on (`items_by_column_values` became
 * `items_page_by_column_values`). An unpinned client breaks on their calendar
 * rather than on a deploy of ours.
 */
export function createMonday(http: HttpClient): MondayClient {
  const token = () => {
    const t = process.env.MONDAY_API_TOKEN;
    if (!t) throw new Error("MONDAY_API_TOKEN is not set");
    return t;
  };

  const headers = () => ({
    authorization: token(),
    "content-type": "application/json",
    "api-version": process.env.MONDAY_API_VERSION ?? "2024-10",
  });

  const client: MondayClient = {
    async query(document, variables) {
      const res = await http.post<{ data?: any; errors?: { message?: string }[]; error_message?: string }>(
        ENDPOINT,
        { query: document, variables: variables ?? {} },
        { headers: headers() },
      );

      // Monday answers 200 with an `errors` array for a bad query, an expired
      // token, and a rate limit alike, so the status check ctx.http already did
      // proves nothing on its own.
      if (res.errors?.length) {
        throw new Error(
          `Monday.com: ${res.errors.map((e) => e.message ?? "unknown error").join("; ")}`,
        );
      }
      if (res.error_message) throw new Error(`Monday.com: ${res.error_message}`);
      if (!res.data) throw new Error("Monday.com answered with no data and no error");
      return res.data;
    },

    async item(itemId) {
      const data = await client.query<{ items: MondayItem[] }>(
        `query ($ids: [ID!]) {
           items (ids: $ids) {
             id name created_at state
             column_values { id type text value }
           }
         }`,
        { ids: [String(itemId)] },
      );
      const item = data.items?.[0];
      // An id that does not resolve comes back as an empty list rather than an
      // error — a deleted item and a typo look identical, and both have to be
      // louder than `undefined` propagating into a message body.
      if (!item) throw new Error(`Monday.com has no item ${itemId} (deleted, or not visible to this token)`);
      return item;
    },

    async itemsByName({ boardId, name, limit = 25 }) {
      // `compare_value` is inlined rather than passed as a variable, which is
      // the one place in this client that interpolates into a query. Monday's
      // own example for a name rule is an inline array literal, and its
      // GraphQL type is a custom scalar whose *name* is not something the docs
      // pin down — a variable declaration would have to guess it, and guessing
      // wrong is an error only a live token can reveal. `JSON.stringify`
      // produces a valid GraphQL string literal for any input, escaping the
      // quotes, backslashes and newlines that would otherwise end the string,
      // so this is as injection-safe as a variable would have been.
      const compare = `[${JSON.stringify(name)}]`;

      const data = await client.query<{
        boards: { items_page: { items: MondayItem[] } | null }[] | null;
      }>(
        `query ($boardId: ID!, $limit: Int!) {
           boards (ids: [$boardId]) {
             items_page (
               limit: $limit
               query_params: { rules: [{ column_id: "name", compare_value: ${compare} }] }
             ) {
               items { id name column_values { id type text value } }
             }
           }
         }`,
        { boardId: String(boardId), limit },
      );

      const items = data.boards?.[0]?.items_page?.items ?? [];
      // Monday does not document the name rule's matching as exact, and the
      // operators available on it include substring matches. Filtering here
      // rather than trusting it is not defensive noise: the caller looks these
      // up by WhatsApp message id, and a prefix match would hand one school's
      // conversation to another school.
      return items.filter((i) => i.name === name);
    },

    async createItem({ boardId, groupId, name, columnValues }) {
      const data = await client.query<{ create_item: { id: string; name: string } }>(
        `mutation ($boardId: ID!, $groupId: String, $name: String!, $columnValues: JSON) {
           create_item (
             board_id: $boardId
             group_id: $groupId
             item_name: $name
             column_values: $columnValues
           ) { id name }
         }`,
        {
          boardId: String(boardId),
          groupId,
          name,
          // Monday's JSON scalar is a *string* of JSON, not an object.
          columnValues: columnValues ? JSON.stringify(columnValues) : undefined,
        },
      );
      return data.create_item;
    },

    async setColumn({ boardId, itemId, columnId, value }) {
      const data = await client.query<{ change_column_value: { id: string } }>(
        `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
           change_column_value (
             board_id: $boardId
             item_id: $itemId
             column_id: $columnId
             value: $value
           ) { id }
         }`,
        { boardId: String(boardId), itemId: String(itemId), columnId, value: JSON.stringify(value) },
      );
      return data.change_column_value;
    },

    async assets(itemId) {
      const data = await client.query<{ items: { assets: MondayAsset[] | null }[] }>(
        `query ($ids: [ID!]) { items (ids: $ids) { assets { id name public_url } } }`,
        { ids: [String(itemId)] },
      );
      return data.items?.[0]?.assets ?? [];
    },

    async createWebhook({ boardId, url, event, columnId }) {
      const data = await client.query<{ create_webhook: { id: string } }>(
        `mutation ($boardId: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
           create_webhook (board_id: $boardId, url: $url, event: $event, config: $config) {
             id
           }
         }`,
        {
          boardId: String(boardId),
          url,
          event,
          config: columnId ? JSON.stringify({ columnId }) : undefined,
        },
      );
      return { id: String(data.create_webhook.id) };
    },

    async deleteWebhook(id) {
      try {
        await client.query(`mutation ($id: ID!) { delete_webhook (id: $id) { id } }`, { id });
      } catch (err) {
        // A subscription somebody already removed in Monday's UI is the state
        // we wanted, not a failure. Anything else still throws — reconciliation
        // deletes before it recreates, and swallowing a real error there would
        // leave the board with two subscriptions sending everything twice.
        const message = err instanceof Error ? err.message : String(err);
        if (!/not.?found|does not exist|invalid.*webhook/i.test(message)) throw err;
      }
    },

    fields: (item) => readFields(item),
  };

  return client;
}

/* ------------------------------------------------------------- the reading */

function readFields(item: MondayItem): MondayFields {
  const by = new Map(item.column_values.map((c) => [c.id, c]));
  const cell = (id: string) => by.get(id);

  const blank = (s: string | null | undefined): s is null | undefined =>
    s === null || s === undefined || s.trim() === "";

  const json = <T,>(id: string): T | undefined => {
    const raw = cell(id)?.value;
    if (blank(raw) || raw === "null") return undefined;
    try {
      const parsed = JSON.parse(raw);
      return parsed === null ? undefined : (parsed as T);
    } catch {
      return undefined;
    }
  };

  const text = (id: string) => {
    const t = cell(id)?.text;
    return blank(t) ? undefined : t.trim();
  };

  return {
    text,
    json,
    index: (id) => {
      const v = json<{ index?: unknown }>(id);
      return typeof v?.index === "number" ? v.index : undefined;
    },
    phone: (id) => {
      // The `value` JSON is authoritative: `text` on a phone column can carry
      // the country name Monday appends for display.
      const v = json<{ phone?: unknown }>(id);
      const raw = typeof v?.phone === "string" ? v.phone : text(id);
      const digits = raw?.replace(/[^\d+]/g, "");
      return blank(digits) ? undefined : digits;
    },
    email: (id) => {
      const v = json<{ email?: unknown; text?: unknown }>(id);
      const raw = typeof v?.email === "string" ? v.email : text(id);
      return blank(raw) ? undefined : raw.trim();
    },
    url: (id) => {
      // A link column renders as "Some title - https://…", which is not a URL.
      // The href only exists in the JSON.
      const v = json<{ url?: unknown }>(id);
      return typeof v?.url === "string" && v.url.trim() !== "" ? v.url.trim() : undefined;
    },
    lines: (id, sep = ", ") => {
      const v = json<{ text?: unknown }>(id);
      const raw = typeof v?.text === "string" ? v.text : text(id);
      if (blank(raw)) return undefined;
      const flat = raw.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean).join(sep);
      return flat === "" ? undefined : flat;
    },
  };
}

/* ------------------------------------------------------------- the webhook */

/**
 * What Monday.com POSTs to a webhook, narrowed to the parts that identify
 * *what changed*. Everything else it sends — `triggerUuid`, `subscriptionId`,
 * the whole `previousValue` tree — is left unvalidated on purpose: a field
 * Monday adds or renames should not turn a delivered notification into a 422.
 *
 * The one-time `{"challenge":"…"}` handshake is deliberately **not** part of
 * this. It never reaches a schema, because `mondayChallenge()` answers it at
 * the route before a run exists. A payload that fails this schema is a real
 * event in a shape we did not expect, and should say so.
 */
export const mondayEvent = z.object({
  event: z.object({
    /** "create_pulse", "update_column_value", … */
    type: z.string().optional(),
    boardId: z.union([z.number(), z.string()]).optional(),
    /** The item. Monday sends it as a number; every API call wants a string. */
    pulseId: z.union([z.number(), z.string()]),
    pulseName: z.string().optional(),
    /** Present on a column change, absent on a create. */
    columnId: z.string().optional(),
    columnTitle: z.string().optional(),
    /** For a status column: `{ label: { index, text } }`. */
    value: z
      .object({ label: z.object({ index: z.number().optional(), text: z.string().optional() }).nullish() })
      .nullish(),
    previousValue: z
      .object({ label: z.object({ index: z.number().optional(), text: z.string().optional() }).nullish() })
      .nullish(),
  }),
});

export type MondayEvent = z.infer<typeof mondayEvent>;

/** The item id as every Monday query wants it — a string. */
export function pulseId(payload: MondayEvent): string {
  return String(payload.event.pulseId);
}

/* -------------------------------------------------- webhook registration */

/**
 * A `register` block for `webhook()`, so a Monday board's subscription is
 * created by the deploy rather than pasted into Monday's integration centre by
 * a person. Reconciled at boot: an unchanged URL makes no API call at all, a
 * changed PUBLIC_URL migrates, and disabling the workflow deletes it.
 *
 * Returns `undefined` when `boardId` is unset, which is the whole point of it
 * being optional — a workflow whose board id has not been filled in yet simply
 * does not self-register, and you paste that one URL by hand until it is. The
 * alternative, throwing, would turn "not configured yet" into a boot alert
 * every restart.
 *
 * **One operational caveat worth knowing.** The subscription URL carries
 * WEBHOOK_SECRET as a query parameter, because Monday has nowhere to put a
 * header. Reconciliation compares the *bare* URL, so rotating WEBHOOK_SECRET
 * does not by itself re-register anything and Monday keeps sending the old
 * one — every delivery then 401s and lands in the rejected-deliveries box.
 * That is true of a hand-pasted URL too; the difference is that the fix here
 * is to delete the `@webhook:subscription` key from the workflow's state and
 * restart, rather than to re-paste.
 */
export function mondayWebhook(opts: {
  /** From configuration. Undefined means "do not register this one". */
  boardId: string | undefined;
  event: MondayWebhookEvent;
  /** Required by the `*_specific_column_value` events. */
  columnId?: string;
}): WebhookRegistration | undefined {
  const boardId = opts.boardId?.trim();
  if (!boardId) return undefined;

  return {
    async create(ctx) {
      // The route is guarded by the shared secret like every other one here,
      // and Monday can only carry it in the query string.
      const secret = process.env.WEBHOOK_SECRET;
      const url = secret ? `${ctx.url}?secret=${encodeURIComponent(secret)}` : ctx.url;

      const { id } = await ctx.monday.createWebhook({
        boardId,
        url,
        event: opts.event,
        columnId: opts.columnId,
      });
      // The board and event, not the URL — that has the secret in it.
      ctx.log.info(
        `Monday board ${boardId} will send ${opts.event}` +
          `${opts.columnId ? ` on ${opts.columnId}` : ""} (subscription ${id})`,
      );
      return id;
    },

    async remove(ctx, subscriptionId) {
      await ctx.monday.deleteWebhook(subscriptionId);
      ctx.log.info(`Monday subscription ${subscriptionId} on board ${boardId} removed`);
    },
  };
}
