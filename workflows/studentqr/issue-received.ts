import {
  defineWorkflow,
  mondayChallenge,
  mondayEvent,
  mondayWebhook,
  pulseId,
  webhook,
  type MondayEvent,
} from "../../src/core/define.ts";
import { ISSUE_COLUMN, firstOf, issueReceived, notify } from "./_studentqr.ts";

/**
 * StudentQR — technical issue acknowledged.
 *
 * Monday board "3. BORANG MASALAH TEKNIKAL". A teacher reports a problem
 * through the form, an item is created, and they are told it has been picked
 * up. A port of the n8n branch on webhook `studentqr/f37bf5e0-…`.
 *
 * Point the Monday integration at
 *   https://<PUBLIC_URL>/hooks/studentqr/issue-received?secret=<WEBHOOK_SECRET>
 * with the "when an item is created" recipe.
 */

/*
 * The column ids for this board live in _studentqr.ts, shared with
 * issue-solved.ts — it is one board, and describing it twice is how the two
 * files quietly drift apart.
 */

export default defineWorkflow<MondayEvent>({
  name: "studentqr-issue-received",
  description: "Acknowledges a technical issue a school reported",
  trigger: webhook("studentqr/issue-received", {
    method: "POST",
    schema: mondayEvent,
    handshake: mondayChallenge(),
    // Set the board variable and the deploy subscribes the board itself;
    // unset, this URL is pasted into Monday by hand and nothing breaks.
    register: mondayWebhook({
      boardId: process.env.STUDENTQR_BOARD_ISSUES,
      // Monday subscribes with create_item and then sends "create_pulse".
      event: "create_item",
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
        issue: firstOf(f, ISSUE_COLUMN.issue),
        nama_sekolah: f.text(ISSUE_COLUMN.school),
        nama_guru: f.text(ISSUE_COLUMN.teacher),
        // Not normalised beyond stripping punctuation, and deliberately: the
        // form accepts whatever a teacher types, so this is often a local
        // "0189…" with no country code. Meta rejects those, and a failed run
        // that says so is better than this file guessing a country prefix and
        // messaging a stranger who happens to hold 60189….
        phone: f.text(ISSUE_COLUMN.phone),
      };
    });

    const sent = await notify(ctx, {
      message: issueReceived(issue),
      phone: issue.phone,
      name: issue.nama_guru,
    });

    return { itemId: issue.itemId, issue: issue.issue ?? null, ...sent };
  },
});
