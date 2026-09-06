import {
  defineWorkflow,
  mondayChallenge,
  mondayEvent,
  mondayWebhook,
  pulseId,
  webhook,
  type MondayEvent,
} from "../../src/core/define.ts";
import { SUPPORT_PHONE } from "./_studentqr.ts";

/**
 * StudentQR — monthly school report.
 *
 * Monday board "School Monthly Report" holds one item per school per month,
 * with the PDF attached to its Report column. Moving the item's status sends
 * the PDF to the named recipient over WhatsApp and marks the row Sent or
 * Failed. A port of the n8n graph "StudentQR Monday.com - School Monthly
 * Report".
 *
 * Point the Monday integration at
 *   https://<PUBLIC_URL>/hooks/studentqr/monthly-report?secret=<WEBHOOK_SECRET>
 */

const BOARD = "5003113445";

const COLUMN = {
  status: "status",
  year: "color_mkw3svcg",
  /** A status column whose labels are the month numbers, "1" to "12". */
  month: "color_mkw310xy",
  report: "file_mkw39b8e",
  submissions: "numeric_mkw8p9h7",
  recipientPhone: "phone_mkw322mb",
  recipientName: "text_mkw3nv50",
} as const;

/** Index into this board's Status column. */
const STATUS = { sent: 1, failed: 2 } as const;

/**
 * The statuses this workflow itself writes. Seeing one means the delivery
 * arriving is the echo of our own write-back, not a request to send anything.
 *
 * Without this guard the workflow feeds itself: the send sets the status, the
 * status change fires the webhook, the webhook sends again. n8n survived that
 * only because its Monday recipe happened to be narrowed to one label — a
 * property of a dropdown in somebody's browser, not of the automation.
 */
const OURS = new Set(["Sent", "Failed"]);

const MONTHS = [
  "Januari", "Februari", "Mac", "April", "Mei", "Jun",
  "Julai", "Ogos", "September", "Oktober", "November", "Disember",
];

/** The item id, when this run has its payload. Absent on a resume. */
function itemFrom(input: MondayEvent): string | undefined {
  try {
    return pulseId(input);
  } catch {
    return undefined;
  }
}

export default defineWorkflow<MondayEvent>({
  name: "studentqr-monthly-report",
  description: "WhatsApps a school its monthly PDF report and marks the row sent",
  trigger: webhook("studentqr/monthly-report", {
    method: "POST",
    schema: mondayEvent,
    handshake: mondayChallenge(),
    // Set the board variable and the deploy subscribes the board itself;
    // unset, this URL is pasted into Monday by hand and nothing breaks.
    register: mondayWebhook({
      boardId: process.env.STUDENTQR_BOARD_REPORTS,
      event: "change_specific_column_value",
      columnId: COLUMN.status,
    }),
  }),
  onOverlap: "queue",
  // One retry, not the usual two: a send that failed for a bad number or a
  // paused template will fail again, and each attempt that gets *past* the
  // teacher's send has already delivered a PDF. The checkpoint stops a retry
  // re-sending a step that succeeded, so this is about how long a genuinely
  // broken send takes to reach onFailure and mark the row.
  retries: 1,
  timeoutMs: 180_000,

  async run(ctx) {
    const report = await ctx.step("read the report row", async () => {
      const itemId = pulseId(ctx.input);
      const item = await ctx.monday.item(itemId);
      const f = ctx.monday.fields(item);

      const status = f.text(COLUMN.status);
      if (status && OURS.has(status)) return { itemId, status, skip: true as const };

      // Which of the item's files is *the report*. n8n took `assets[0]`,
      // which is whichever file Monday happens to list first across every
      // file column on the item — a second attachment anywhere on the row
      // would have sent a school the wrong document.
      const attached = f.json<{ files?: { assetId?: number | string; name?: string }[] }>(
        COLUMN.report,
      );
      const assetId = attached?.files?.[0]?.assetId;
      if (assetId === undefined) {
        throw new Error(`Report row ${itemId} has no file in its Report column`);
      }

      const assets = await ctx.monday.assets(itemId);
      const asset = assets.find((a) => String(a.id) === String(assetId));
      if (!asset?.public_url) {
        throw new Error(`Monday.com gave no downloadable link for asset ${assetId}`);
      }

      // The month column's label is the number, so "8" is Ogos. A label that
      // is not 1-12 leaves the month blank rather than sending "undefined".
      const monthNumber = Number(f.text(COLUMN.month));
      const month = MONTHS[monthNumber - 1];

      return {
        skip: false as const,
        itemId,
        status,
        school: item.name,
        month,
        year: f.text(COLUMN.year),
        submissions: f.text(COLUMN.submissions),
        recipientName: f.text(COLUMN.recipientName),
        recipientPhone: f.phone(COLUMN.recipientPhone),
        // Signed and short-lived — about an hour. Meta fetches it while the
        // send is in flight, so it never has to outlive this run.
        link: asset.public_url,
        filename: asset.name,
      };
    });

    if (report.skip) {
      ctx.log.info(`Row is already "${report.status}" — this is our own write-back`);
      return { itemId: report.itemId, status: report.status, sent: false };
    }

    if (!report.recipientPhone) {
      // n8n left the row untouched here, so a row with no phone number looked
      // identical to one nobody had got round to. Marking it Failed is what
      // makes it findable on the board.
      ctx.log.warn("No recipient phone on the row — marking it failed");
      await ctx.step("mark the row failed", () => setStatus(ctx, report.itemId, STATUS.failed));
      return { itemId: report.itemId, sent: false, reason: "no recipient phone" };
    }

    const message = {
      name: "school_monthly_report",
      language: "ms",
      document: { link: report.link, filename: report.filename },
      params: [report.recipientName, report.school, report.month, report.year, report.submissions],
    };

    // The school first and support second, which is the order n8n used here
    // and the opposite of every other StudentQR flow. Kept: this is the one
    // message where the recipient is the point and the internal copy is the
    // receipt, and support's copy carries the same expiring link — sending it
    // first would burn part of that hour before the school's send is tried.
    const sent = await ctx.step(
      "send the report",
      () => ctx.whatsapp.template({ to: report.recipientPhone!, ...message }),
      { input: { to: report.recipientPhone, school: report.school, month: report.month } },
    );

    // Deliberately cannot fail the run. The school has the report by this
    // point, and `onFailure` marks the row Failed — so letting a failed
    // *receipt* through would label a delivered report as undelivered, and the
    // next person to read the board would send it again. n8n had exactly this
    // shape and exactly this hole. The failure is still visible: it is on the
    // run page, in the log, and in the result below.
    const receipt = await ctx.step("copy to support", async () => {
      try {
        const copy = await ctx.whatsapp.template({ to: SUPPORT_PHONE, ...message });
        return { ok: true as const, wamid: copy.wamid };
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        ctx.log.warn(`The school has its report, but support's copy did not send — ${why}`);
        return { ok: false as const, error: why };
      }
    });

    await ctx.step("mark the row sent", () => setStatus(ctx, report.itemId, STATUS.sent));

    return {
      itemId: report.itemId,
      school: report.school,
      period: `${report.month ?? "?"} ${report.year ?? "?"}`,
      to: report.recipientPhone,
      wamid: sent.wamid,
      supportCopy: receipt.ok ? receipt.wamid : `failed: ${receipt.error}`,
      sent: true,
    };
  },

  /**
   * Marks the row Failed once every attempt is spent, which is what the n8n
   * graph did through its error outputs. Errors in here are logged rather than
   * thrown, so a Monday API that is also down cannot turn a failed send into a
   * second failure on top of it.
   */
  async onFailure(ctx, error) {
    const itemId = itemFrom(ctx.input);
    if (!itemId) {
      // A resumed run carries no input, so there is nothing to mark. The
      // original run's failure already alerted.
      ctx.log.warn("No item id on this run — cannot mark the row failed");
      return;
    }
    ctx.log.warn(`Marking report row ${itemId} failed — ${error.message}`);
    await setStatus(ctx, itemId, STATUS.failed);
  },
});

function setStatus(
  ctx: { monday: { setColumn: (o: any) => Promise<unknown> } },
  itemId: string,
  index: number,
) {
  return ctx.monday.setColumn({
    boardId: BOARD,
    itemId,
    columnId: COLUMN.status,
    value: { index },
  });
}
