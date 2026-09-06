import { orderStatusWorkflow } from "./_studentqr.ts";

/**
 * StudentQR — card order status, HQ board. Monday board "9. HQ - PRINTING
 * (CARD)". A port of the n8n branch on webhook `studentqr/5c9eda34-…`.
 *
 * Point the Monday integration at
 *   https://<PUBLIC_URL>/hooks/studentqr/card-status-hq?secret=<WEBHOOK_SECRET>
 */
export default orderStatusWorkflow({
  name: "studentqr-card-status-hq",
  description: "Tells a school when its QR card order changes status (HQ board)",
  path: "studentqr/card-status-hq",

  /** Set this variable and the deploy subscribes the board itself. */
  boardId: process.env.STUDENTQR_BOARD_CARD_HQ,

  columns: {
    status: "status",
    teacher: "text",
    phone: "phone",
    students: "numbers",
    address: "long_text",
    tracking: "tracking_number",
    courier: "status80",
    drive: "link9",
  },

  /**
   * Three stages, not four. This board's status column has no "VERIFICATION
   * FROM SCHOOL" label — artwork is verified on the factory board — so there
   * is nothing to map it to and no message to send.
   */
  stages: {
    DELIVERED: "delivered",
    DELIVERING: "delivering",
    "START PRINTING": "printing",
  },
});
