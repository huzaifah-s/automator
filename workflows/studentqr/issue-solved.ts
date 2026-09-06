import {
  defineWorkflow,
  mondayChallenge,
  mondayEvent,
  mondayWebhook,
  pulseId,
  webhook,
  type MondayEvent,
} from "../../src/core/define.ts";
import { ISSUE_COLUMN, firstOf, issueSolved, notify } from "./_studentqr.ts";

/**
 * StudentQR — technical issue resolved.
 *
 * The same board as issue-received.ts, on the other end of the job: when
 * support moves an item's status to "Solved", the teacher is told what was
 * wrong and what was done. A port of the n8n branch on webhook
 * `studentqr/6c49130a-…`.
 *
 * Point the Monday integration at
 *   https://<PUBLIC_URL>/hooks/studentqr/issue-solved?secret=<WEBHOOK_SECRET>
 * with the "when a column changes" recipe on the STATUS column.
 */

/*
 * The column ids for this board live in _studentqr.ts, shared with
 * issue-received.ts — see the note there on why one board is described once.
 */

/** The one status worth messaging about. "Working on it" and "KIV" are not. */
const SOLVED = "Solved";

export default defineWorkflow<MondayEvent>({
  name: "studentqr-issue-solved",
  description: "Tells a school its reported issue has been fixed",
  trigger: webhook("studentqr/issue-solved", {
    method: "POST",
    schema: mondayEvent,
    handshake: mondayChallenge(),
    // Set the board variable and the deploy subscribes the board itself;
    // unset, this URL is pasted into Monday by hand and nothing breaks.
    register: mondayWebhook({
      boardId: process.env.STUDENTQR_BOARD_ISSUES,
      event: "change_specific_column_value",
      columnId: ISSUE_COLUMN.status,
    }),
  }),
  onOverlap: "queue",
  retries: 2,
  timeoutMs: 120_000,

  async run(ctx) {
    const issue = await ctx.step("read the issue", async () => {
      const item = await ctx.monday.item(pulseId(ctx.input));
      const f = ctx.monday.fields(item);

      return {
        itemId: item.id,
        status: f.text(ISSUE_COLUMN.status),
        issue: firstOf(f, ISSUE_COLUMN.issue),
        info: firstOf(f, ISSUE_COLUMN.info),
        nama_sekolah: f.text(ISSUE_COLUMN.school),
        nama_guru: f.text(ISSUE_COLUMN.teacher),
        phone: f.text(ISSUE_COLUMN.phone),
        remarks: f.text(ISSUE_COLUMN.remarks),
      };
    });

    if (issue.status !== SOLVED) {
      ctx.log.info(`Status is "${issue.status ?? "(empty)"}" — nothing to tell the school yet`);
      return { itemId: issue.itemId, status: issue.status ?? null, notified: false };
    }

    const sent = await notify(ctx, {
      message: issueSolved(issue),
      phone: issue.phone,
      name: issue.nama_guru,
    });

    return { itemId: issue.itemId, status: issue.status, ...sent };
  },
});
