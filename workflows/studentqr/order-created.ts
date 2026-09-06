import {
  defineWorkflow,
  mondayChallenge,
  mondayEvent,
  mondayWebhook,
  pulseId,
  webhook,
  type MondayEvent,
} from "../../src/core/define.ts";
import { notify, requestCreatedBadges, requestCreatedSimple } from "./_studentqr.ts";

/**
 * StudentQR — order received.
 *
 * Monday board "5. PRODUCTION TRACKING". A school submits the order form, an
 * item lands in the incoming group, and the teacher gets the "we have your
 * order" message with the spec read back to them. A port of the n8n branch on
 * webhook `studentqr/f70439a1-…`.
 *
 * Point the Monday integration at
 *   https://<PUBLIC_URL>/hooks/studentqr/order-created?secret=<WEBHOOK_SECRET>
 * with the "when an item is created" recipe.
 */

const COLUMN = {
  teacher: "text",
  phone: "phone",
  students: "numbers",
  product: "single_select5",
  badgeType: "single_select0",
  designBadges: "single_select_1",
  designCard: "single_select55",
  designSticker: "single_select4",
  spec: "long_text2",
} as const;

type Family = "card" | "badges" | "sticker";

/**
 * Which product family each option of the PRODUCT column belongs to, by its
 * status index. The index is the stable identity — renaming "Lencana QR (3
 * Keping) / QR Badges (3 Pcs)" on the board does not move it.
 *
 * **Indices 2 ("Lencana QR (5 Keping)") and 7 ("Lencana QR Magnetik (1
 * Keping)") are absent on purpose.** n8n routed `[0,1]` to cards, `[3,4,5]` to
 * badges and `6` to stickers; index 5 does not exist on this board and 2 and 7
 * were never routed, so a school ordering five-piece or magnetic badges got no
 * confirmation. That silence was the intended behaviour and it is kept.
 *
 * The port does change one thing about it: an unrouted product now warns on
 * the run page instead of passing as a successful no-op, so the next person
 * asking "why did this school hear nothing" gets an answer. Add an entry here
 * to start confirming either product.
 */
const FAMILY: Record<number, Family> = {
  0: "card", // Kad QR Sahaja
  1: "card", // Kad QR (Tali + Pemegang kad)
  // 2: Lencana QR (5 Keping)   — not confirmed, as in n8n
  3: "badges", // Lencana QR (3 Keping)
  4: "badges", // Lencana QR (2 Keping)
  6: "sticker", // Pelekat QR (Saiz A4)
  // 7: Lencana QR Magnetik     — not confirmed, as in n8n
};

export default defineWorkflow<MondayEvent>({
  name: "studentqr-order-created",
  description: "Confirms a new QR order to the school that submitted it",
  trigger: webhook("studentqr/order-created", {
    method: "POST",
    schema: mondayEvent,
    handshake: mondayChallenge(),
    // Set the board variable and the deploy subscribes the board itself;
    // unset, this URL is pasted into Monday by hand and nothing breaks.
    register: mondayWebhook({
      boardId: process.env.STUDENTQR_BOARD_ORDERS,
      // Monday subscribes with create_item and then sends "create_pulse".
      event: "create_item",
    }),
  }),
  // Two schools submitting at once must both be confirmed, so the second
  // delivery waits rather than being dropped.
  onOverlap: "queue",
  retries: 2,
  timeoutMs: 120_000,

  async run(ctx) {
    const order = await ctx.step("read the order", async () => {
      const item = await ctx.monday.item(pulseId(ctx.input));
      const f = ctx.monday.fields(item);

      return {
        itemId: item.id,
        nama_sekolah: item.name,
        nama_guru: f.text(COLUMN.teacher),
        phone: f.phone(COLUMN.phone),
        jumlah_pelajar: f.text(COLUMN.students),
        jenis_produk: f.text(COLUMN.product),
        jenis_produk_index: f.index(COLUMN.product),
        jenis_lencana: f.text(COLUMN.badgeType),
        design_qr_badges: f.text(COLUMN.designBadges),
        design_qr_card: f.text(COLUMN.designCard),
        design_qr_sticker: f.text(COLUMN.designSticker),
        details_specification: f.lines(COLUMN.spec, " "),
      };
    });

    const family = order.jenis_produk_index === undefined ? undefined : FAMILY[order.jenis_produk_index];
    if (!family) {
      // Loud rather than silent. Reached both by the two products left
      // unrouted on purpose and by an option added to the board that nobody
      // mapped — the second is a bug, and the two are indistinguishable from
      // here, so both say so on the run page rather than passing as a no-op.
      ctx.log.warn(
        `No message for product "${order.jenis_produk ?? "(empty)"}" ` +
          `(index ${order.jenis_produk_index ?? "none"}) — add it to FAMILY in this file`,
      );
      return { itemId: order.itemId, product: order.jenis_produk ?? null, notified: false };
    }

    const message =
      family === "badges"
        ? requestCreatedBadges({ ...order, design: order.design_qr_badges })
        : requestCreatedSimple({
            ...order,
            design: family === "card" ? order.design_qr_card : order.design_qr_sticker,
          });

    // n8n filtered on the phone number *before* the support copy, so an order
    // submitted without one produced no message at all and nobody at HQ knew
    // it had arrived. Every other StudentQR flow already copied support first;
    // this one now does too, and only the teacher's copy is conditional.
    const sent = await notify(ctx, {
      message,
      phone: order.phone,
      name: order.nama_guru,
    });

    return { itemId: order.itemId, product: order.jenis_produk, family, ...sent };
  },
});
