import {
  defineWorkflow,
  mondayChallenge,
  mondayEvent,
  mondayWebhook,
  pulseId,
  webhook,
  type Ctx,
  type MondayEvent,
  type WorkflowDef,
} from "../../src/core/define.ts";

/**
 * Shared by the StudentQR workflows in this folder. Not a workflow — the
 * loader skips files whose name starts with an underscore.
 *
 * What earns its place here is the **message catalogue** below. In the n8n
 * graph this replaces, every approved template's parameter order was retyped
 * into each node that sent it — `notification_delivered` appeared six times,
 * `notification_delivering` six more. They did not all agree: the teacher's
 * copy of the badges "delivering" message passed courier and tracking number
 * in the opposite order to the other five, so every teacher whose badges
 * shipped was told their courier was "MY43206650254" and their tracking
 * number was "J&T". That is not a bug you can see on a canvas, and it is not
 * one that can recur here: there is exactly one line that says what order
 * `notification_delivering` takes its parameters in.
 */

/**
 * The internal number that gets a copy of everything, so support sees what a
 * teacher saw without asking them to screenshot it.
 *
 * Configuration, not a secret — deliberately. Declaring it through
 * defineSecrets would blank it out of every run page and alert, and "which
 * number did this go to" is the first question when a notification goes
 * astray. The literal is the number the n8n workflows used; the environment
 * overrides it without a deploy.
 *
 * Reduced to digits, and that is load-bearing rather than tidy: the relay
 * decides which direction a message is going by comparing this to the `wa_id`
 * Meta sends, and Meta's is always bare digits. Set with a `+` or a space and
 * every support reply would be treated as a new inbound message from a school
 * and forwarded straight back to support.
 */
export const SUPPORT_PHONE = (process.env.STUDENTQR_SUPPORT_PHONE ?? "601114356132").replace(
  /[^\d]/g,
  "",
);

/** Malay, for every StudentQR template. */
const LANGUAGE = "ms";

/** One send, resolved: which template, and what goes in its placeholders. */
export interface OutgoingTemplate {
  name: string;
  params?: (string | number | null | undefined)[];
  /** A file header, for a template whose header is a document. */
  document?: { link: string; filename: string };
}

/* ------------------------------------------------------- the order fields */

/**
 * The fields the order templates read, after a board's own column ids have
 * been mapped onto them. Every value is optional because every cell on a
 * Monday board can be empty; `ctx.whatsapp` substitutes "-" at the wire rather
 * than each caller doing it, since an empty template parameter is rejected
 * outright by Meta.
 */
export interface OrderFields {
  nama_guru?: string;
  nama_sekolah?: string;
  status?: string;
  courier?: string;
  tracking_number?: string;
  jumlah_pelajar?: string;
  alamat_sekolah?: string;
  google_drive_link?: string;
  /** The teacher's WhatsApp number. Absent means nobody outside HQ is told. */
  phone?: string;
}

/**
 * The four stages an order can reach that are worth a message. A board names
 * them differently — "START PRINTING" on one, "START PRINTING (JACKIE)" on
 * another — so each workflow maps its own labels onto these, and the template
 * each one sends is decided once, here.
 */
export type OrderStage = "delivered" | "delivering" | "printing" | "verification";

export function orderTemplate(stage: OrderStage, o: OrderFields): OutgoingTemplate {
  switch (stage) {
    case "delivered":
      return {
        name: "notification_delivered",
        params: [
          o.nama_guru,
          o.nama_sekolah,
          o.status,
          o.courier,
          o.tracking_number,
          o.jumlah_pelajar,
          o.alamat_sekolah,
        ],
      };
    // Courier and tracking number are the other way round to `delivered`, and
    // that is correct — the two approved templates word the lines in different
    // orders. This is the pair the n8n graph got wrong in one node out of six.
    case "delivering":
      return {
        name: "notification_delivering",
        params: [
          o.nama_guru,
          o.nama_sekolah,
          o.status,
          o.tracking_number,
          o.courier,
          o.jumlah_pelajar,
          o.alamat_sekolah,
        ],
      };
    case "printing":
      return { name: "notification_printing", params: [o.nama_sekolah, o.jumlah_pelajar] };
    case "verification":
      return {
        name: "notification_pending_verification",
        params: [o.nama_guru, o.nama_sekolah, o.google_drive_link],
      };
  }
}

/* ----------------------------------------------------- the other templates */

/** A new order for badges — the only product whose template names its type. */
export function requestCreatedBadges(o: {
  nama_guru?: string;
  nama_sekolah?: string;
  jenis_produk?: string;
  jenis_lencana?: string;
  design?: string;
  details_specification?: string;
  jumlah_pelajar?: string;
}): OutgoingTemplate {
  return {
    name: "notification_request_created",
    params: [
      o.nama_guru,
      o.nama_sekolah,
      o.jenis_produk,
      o.jenis_lencana,
      o.design,
      o.details_specification,
      o.jumlah_pelajar,
    ],
  };
}

/**
 * A new order for cards or stickers. One template serves both, and the design
 * placeholder takes whichever design column the product actually uses — which
 * is why the caller passes `design` rather than this reaching for a column id.
 */
export function requestCreatedSimple(o: {
  nama_guru?: string;
  nama_sekolah?: string;
  jenis_produk?: string;
  design?: string;
  details_specification?: string;
  jumlah_pelajar?: string;
}): OutgoingTemplate {
  return {
    name: "notification_request_created_with_card_only",
    params: [
      o.nama_guru,
      o.nama_sekolah,
      o.jenis_produk,
      o.design,
      o.details_specification,
      o.jumlah_pelajar,
    ],
  };
}

export function issueReceived(o: {
  nama_guru?: string;
  issue?: string;
  nama_sekolah?: string;
}): OutgoingTemplate {
  return {
    name: "notification_issue_received",
    params: [o.nama_guru, o.issue, o.nama_sekolah],
  };
}

export function issueSolved(o: {
  nama_guru?: string;
  issue?: string;
  info?: string;
  remarks?: string;
}): OutgoingTemplate {
  return {
    name: "notification_issue_solved",
    // The fourth placeholder is the literal the n8n node sent. The board has a
    // status column, but this template is only ever reached when it reads
    // "Solved", so the word is a constant rather than a field.
    params: [o.nama_guru, o.issue, o.info, "FIXED", o.remarks],
  };
}

/* ------------------------------------------------------------ the sending */

export interface NotifyResult {
  template: string;
  support: string;
  teacher: string | null;
  /** Why nobody outside HQ was told, when nobody was. */
  skipped?: string;
  /** Set only when both messages went but the contacts sheet did not take it. */
  contactNotRecorded?: string;
}

/**
 * Sends one notification the way every StudentQR flow sends one: a copy to
 * support first, then the teacher's own copy, then the teacher is recorded as
 * a contact.
 *
 * Support is told first on purpose. If the teacher's send fails — a number
 * that is not on WhatsApp, a template Meta has paused — the run fails with
 * support already holding the message, so a person can follow it up. The other
 * order would lose both.
 *
 * The contact upsert runs as a child workflow rather than the HTTP call back
 * into its own webhook that n8n used: it gets its own run page, it inherits
 * this run's concurrency slot, and it does not need the webhook secret.
 */
export async function notify(
  ctx: Ctx<any>,
  opts: { message: OutgoingTemplate; phone?: string; name?: string },
): Promise<NotifyResult> {
  const { message, phone, name } = opts;

  const support = await ctx.step(
    "copy to support",
    () => ctx.whatsapp.template({ to: SUPPORT_PHONE, language: LANGUAGE, ...message }),
    { input: { to: SUPPORT_PHONE, template: message.name } },
  );

  // n8n tested `phone?.trim() && phone.trim() !== '-'`, because its column
  // reader substituted "-" for an empty cell before anything could tell the
  // two apart. Ours returns undefined for an empty cell, so the dash check is
  // only here for a board where somebody has typed one in by hand.
  const to = phone?.trim();
  if (!to || to === "-") {
    const skipped = "the board has no phone number for this teacher";
    ctx.log.warn(`Sent ${message.name} to support only — ${skipped}`);
    return { template: message.name, support: support.wamid, teacher: null, skipped };
  }

  const teacher = await ctx.step(
    "notify teacher",
    () => ctx.whatsapp.template({ to, language: LANGUAGE, ...message }),
    { input: { to, template: message.name } },
  );

  // Bookkeeping, and deliberately unable to fail the run. By this line both
  // WhatsApp messages have been delivered; the contact row only puts a name
  // against a number in the human inbox. Letting it fail the run would mark a
  // delivered notification as failed and alert about it — and because the two
  // sends are checkpointed and would not repeat, the retry it triggers is of
  // the one part that did not matter.
  //
  // It is also the likeliest thing here to be misconfigured: the contacts
  // sheet is the only piece needing a Google service account, and a deployment
  // that skipped that would otherwise see every notification run fail while
  // every message arrived.
  const contact = await ctx.step("record contact", async () => {
    try {
      await ctx.run("studentqr-add-contact", { phone_number_id: to, name: name ?? "-" });
      return { ok: true as const };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`Both messages were sent, but the contact was not recorded — ${why}`);
      return { ok: false as const, error: why };
    }
  });

  return {
    template: message.name,
    support: support.wamid,
    teacher: teacher.wamid,
    ...(contact.ok ? {} : { contactNotRecorded: contact.error }),
  };
}

/* ---------------------------------------------------- the issue board's map */

/**
 * Column ids on "3. BORANG MASALAH TEKNIKAL", shared by issue-received.ts and
 * issue-solved.ts because it is **one board**, and a board's column ids are
 * one fact. Two copies of it is the shape of bug that does not raise an error:
 * the form gets rebuilt, somebody updates the file they were looking at, and
 * from then on half the messages carry a blank school name.
 *
 * Not hypothetical here — that form has already been rebuilt once. `issue` and
 * `info` each list the new column id and then the old one, and both are read
 * newest-first, because items raised before the rebuild only populate the old
 * pair. Dropping the fallbacks would silently blank every historic issue.
 */
export const ISSUE_COLUMN = {
  status: "status_1",
  issue: ["status5", "color_mkp4sy73"],
  info: ["text_mkp4610v", "short_text3"],
  school: "short_text0",
  teacher: "short_text9",
  /** A plain text column on this board, not a Monday phone column. */
  phone: "short_text8",
  remarks: "text",
} as const;

/** First non-empty of several candidate columns — for the rebuilt pairs above. */
export function firstOf(
  fields: { text(id: string): string | undefined },
  ids: readonly string[],
): string | undefined {
  return ids.map((id) => fields.text(id)).find(Boolean);
}

/* ------------------------------------------------ the order-status workflows */

/**
 * Where each piece of an order lives on one board. The three printing boards
 * hold the same information under different column ids, which is the entire
 * difference between them.
 */
export interface OrderColumns {
  status: string;
  teacher: string;
  phone: string;
  students: string;
  address: string;
  tracking: string;
  courier: string;
  drive: string;
}

/**
 * Builds one of the three "an order changed status" workflows.
 *
 * These are the same workflow over three boards: fetch the item, read the
 * status, and send the message that status calls for. What differs is a column
 * map and which labels that board uses — "START PRINTING" on one, "START
 * PRINTING (JACKIE)" on another, and no verification stage at all on the HQ
 * board. Written out three times, those differences were buried in sixty lines
 * of identical code; here they are the whole file.
 *
 * That is not tidiness for its own sake. The bug this port inherited was one
 * of six copies of a template call disagreeing with the other five, and the
 * reason nobody spotted it is that you had to read all six to know.
 *
 * The cost, stated plainly: `badges-status.ts` no longer shows you what it
 * does. It shows you what is true about that board, and the steps live here.
 */
export function orderStatusWorkflow(opts: {
  name: string;
  description: string;
  /** Mounted at /hooks/<path>. */
  path: string;
  /**
   * The Monday board, from a variable. Set, the deploy creates the board's
   * subscription itself and nobody opens Monday's integration centre; unset,
   * this workflow simply does not self-register and its URL is pasted by hand.
   */
  boardId?: string;
  columns: OrderColumns;
  /** Board label → template. A status absent from this map sends nothing. */
  stages: Record<string, OrderStage>;
}): WorkflowDef<MondayEvent> {
  const { columns, stages } = opts;

  return defineWorkflow<MondayEvent>({
    name: opts.name,
    description: opts.description,
    trigger: webhook(opts.path, {
      method: "POST",
      schema: mondayEvent,
      // Monday POSTs `{"challenge":"…"}` once when the subscription is created
      // and wants it straight back. Neither response mode can do that, so the
      // route answers it before any run exists — see types.ts.
      handshake: mondayChallenge(),
      // Subscribed to the status column specifically, not to every column.
      // `change_column_value` fires on a corrected address or an added note
      // too, and each of those woke a run that fetched the item and did
      // nothing — which is what the n8n recipes were doing all day.
      register: mondayWebhook({
        boardId: opts.boardId,
        event: "change_specific_column_value",
        columnId: columns.status,
      }),
    }),
    // A board where two columns are edited in quick succession must not drop
    // the second delivery; each one is somebody's notification.
    onOverlap: "queue",
    retries: 2,
    timeoutMs: 120_000,

    async run(ctx) {
      // Everything derived from the payload is read inside a step. A resumed
      // run has no ctx.input, so reading the pulse id at the top of run()
      // would look it up in an empty object and fetch item "undefined".
      const order = await ctx.step("read the order", async () => {
        const item = await ctx.monday.item(pulseId(ctx.input));
        const f = ctx.monday.fields(item);

        return {
          itemId: item.id,
          // The board's *current* status, not the label the webhook carried.
          // If two changes land close together, both deliveries then act on
          // the state the board is actually in rather than replaying a stale
          // one.
          status: f.text(columns.status),
          nama_sekolah: item.name,
          nama_guru: f.text(columns.teacher),
          phone: f.phone(columns.phone),
          jumlah_pelajar: f.text(columns.students),
          // Newlines collapsed here as well as at the wire: this is the value
          // that shows up on the run page, and a three-line address rendered
          // as one is what the teacher actually receives.
          alamat_sekolah: f.lines(columns.address),
          tracking_number: f.text(columns.tracking),
          courier: f.text(columns.courier),
          // The href, not Monday's "3RD BATCH NOV 2024 - Google Drive -
          // https://…" display text, which is what the n8n badges node sent
          // and what its card nodes already sent correctly.
          google_drive_link: f.url(columns.drive),
        } satisfies OrderFields & { itemId: string };
      });

      const stage = order.status ? stages[order.status] : undefined;
      if (!stage) {
        ctx.log.info(`No message for status "${order.status ?? "(empty)"}"`);
        return { itemId: order.itemId, status: order.status ?? null, notified: false };
      }

      const sent = await notify(ctx, {
        message: orderTemplate(stage, order),
        phone: order.phone,
        name: order.nama_guru,
      });

      return { itemId: order.itemId, status: order.status, stage, ...sent };
    },
  });
}
