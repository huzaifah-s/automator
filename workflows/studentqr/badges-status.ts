import { orderStatusWorkflow } from "./_studentqr.ts";

/**
 * StudentQR — badge order status. Monday board "7. JACKIE - PRINTING
 * (BADGES)". A port of the n8n branch on webhook `studentqr/c0cab420-…`.
 *
 * The steps live in `orderStatusWorkflow` in _studentqr.ts — these three
 * boards run the same workflow, and everything below is what makes this one
 * that board rather than another.
 *
 * Point the Monday integration at
 *   https://<PUBLIC_URL>/hooks/studentqr/badges-status?secret=<WEBHOOK_SECRET>
 * with the "when a column changes" recipe on the STATUS column. The n8n URL
 * was guarded by nothing but being hard to guess; this one takes the same
 * shared secret as every other route here, so the `?secret=` is not optional.
 */
export default orderStatusWorkflow({
  name: "studentqr-badges-status",
  description: "Tells a school when its QR badge order changes status",
  path: "studentqr/badges-status",

  /** Set this variable and the deploy subscribes the board itself. */
  boardId: process.env.STUDENTQR_BOARD_BADGES,

  /**
   * Column ids are the contract with the board. Renaming a column in Monday
   * does not change its id, but deleting and re-adding one does — and this is
   * the list to fix when that happens.
   */
  columns: {
    status: "status",
    teacher: "text",
    phone: "phone",
    students: "numbers",
    address: "long_text",
    tracking: "text3",
    courier: "status0",
    drive: "link9",
  },

  /**
   * Every other status on this board — WAITING DATA, COUNT BADGES, HOLD —
   * moves without anybody being messaged. Deliberate: they are internal
   * production states and a teacher has nothing to do about them.
   */
  stages: {
    DELIVERED: "delivered",
    DELIVERING: "delivering",
    "START PRINTING": "printing",
    "VERIFICATION FROM SCHOOL": "verification",
  },
});
