import { defineWorkflow, manual } from "../src/core/define.ts";

/**
 * The asking half of an approval gate — the two-workflow stand-in for n8n's
 * Wait node. This half opens an approval and hands out the decision links;
 * `approval-resolve` closes it when someone clicks one. They only ever meet in
 * `ctx.state.shared`, which is the one thing that outlives both runs.
 *
 * This is deliberately not a Wait node. No run sits there pending, and the two
 * halves get separate run pages — see README "Approval gates" for what that
 * costs and why the runner doesn't try to do better.
 *
 *   bun run trigger -- approval-request
 */

/** The record the two halves agree on. `approval-resolve` imports this. */
export interface Approval {
  status: "pending" | "approved" | "declined";
  /** Shown to whoever decides. */
  subject: string;
  amount: number;
  email: string;
  requestedAt: string;
  /** The run that opened it — the only thread tying the two run pages together. */
  requestedByRun: string;
  decidedAt?: string;
}

/** Where an approval lives in the shared namespace. Both halves use this. */
export const approvalKey = (id: string): string => `approval:${id}`;

/**
 * How long a link stays clickable. The TTL is the entire expiry mechanism —
 * nothing sweeps abandoned approvals; the row stops being readable and the
 * link starts answering "unknown or expired" on its own.
 */
const PENDING_TTL_SECONDS = 7 * 24 * 60 * 60;

export default defineWorkflow({
  name: "approval-request",
  description: "Opens a refund approval and posts its approve/decline links",
  trigger: manual(),
  retries: 0,
  timeoutMs: 30_000,

  async run(ctx) {
    // Stands in for whatever actually needs a human — a refund over the limit.
    const refund = { amount: 520, email: "jane@example.com" };

    // The id *is* the credential. approval-resolve's route opts out of
    // WEBHOOK_SECRET, because a manager clicking a link in Slack cannot carry
    // it, so an unguessable id is the only thing standing between a stranger
    // and an approved refund. randomUUID is a CSPRNG; a counter, a timestamp,
    // or the customer's email here would each be a hole.
    const id = crypto.randomUUID();

    const approval: Approval = {
      status: "pending",
      subject: `Refund $${refund.amount} to ${refund.email}`,
      amount: refund.amount,
      email: refund.email,
      requestedAt: new Date().toISOString(),
      requestedByRun: ctx.runId,
    };

    await ctx.step(
      "open approval",
      () => ctx.state.shared.set(approvalKey(id), approval, { ttlSeconds: PENDING_TTL_SECONDS }),
      { input: { subject: approval.subject, expiresInDays: PENDING_TTL_SECONDS / 86_400 } },
    );

    const base = (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(
      /\/+$/,
      "",
    );
    const link = (decision: "approve" | "decline") =>
      `${base}/hooks/approval?id=${id}&decision=${decision}`;

    // Not a declared secret: the channel name is configuration, and running it
    // through the redactor would blank it out of every run page that mentions it.
    const channel = process.env.APPROVAL_SLACK_CHANNEL;

    if (channel) {
      await ctx.step("ask slack", () =>
        ctx.slack.send(
          channel,
          `*Approval needed* — ${approval.subject}\n` +
            `<${link("approve")}|Approve>  ·  <${link("decline")}|Decline>`,
        ),
      );
    } else {
      // The links work whether or not anything posted them, and this is the
      // path `bun run trigger` takes — which is what makes the example
      // exercisable with nothing configured.
      ctx.log.info("APPROVAL_SLACK_CHANNEL is not set — decide with one of these:");
      ctx.log.info(link("approve"));
      ctx.log.info(link("decline"));
    }

    // The id reaches the run page in this result. That is a capability leak to
    // anyone holding the dashboard password, and it is not an escalation:
    // that password can already trigger any workflow here.
    return { approvalId: id, subject: approval.subject, notified: Boolean(channel) };
  },
});
