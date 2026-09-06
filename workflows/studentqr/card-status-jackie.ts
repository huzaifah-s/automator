import { orderStatusWorkflow } from "./_studentqr.ts";

/**
 * StudentQR — card order status, factory board. Monday board "8. JACKIE -
 * PRINTING (CARD)". A port of the n8n branch on webhook `studentqr/15357e79-…`.
 *
 * Point the Monday integration at
 *   https://<PUBLIC_URL>/hooks/studentqr/card-status-jackie?secret=<WEBHOOK_SECRET>
 */
export default orderStatusWorkflow({
  name: "studentqr-card-status-jackie",
  description: "Tells a school when its QR card order changes status (factory board)",
  path: "studentqr/card-status-jackie",

  /** Set this variable and the deploy subscribes the board itself. */
  boardId: process.env.STUDENTQR_BOARD_CARD_JACKIE,

  /** Tracking and courier sit under different ids here than on the HQ board. */
  columns: {
    status: "status",
    teacher: "text",
    phone: "phone",
    students: "numbers",
    address: "long_text",
    tracking: "text70",
    courier: "status12",
    drive: "link9",
  },

  /** "(JACKIE)" is part of the label on this board and on no other. */
  stages: {
    DELIVERED: "delivered",
    DELIVERING: "delivering",
    "START PRINTING (JACKIE)": "printing",
    "VERIFICATION FROM SCHOOL": "verification",
  },
});
