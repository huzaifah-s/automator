import { z } from "zod";
import { defineWorkflow, webhook } from "../src/core/define.ts";
import { approvalKey, type Approval } from "./approval-request.ts";

// GET query values are always strings, so the schema is what turns a clicked
// link into typed input — and rejects a malformed id with 422 before a run starts.
const query = z.object({
  id: z.uuid(),
  decision: z.enum(["approve", "decline"]),
});

/** A decided approval is kept only so a second click still gets a real answer. */
const RESOLVED_TTL_SECONDS = 24 * 60 * 60;

/**
 * The answering half of the approval gate opened by `approval-request`.
 * Everything it knows arrives in the URL and in `ctx.state.shared`; the run
 * that asked the question finished days ago.
 */
export default defineWorkflow<z.infer<typeof query>>({
  name: "approval-resolve",
  description: "Closes an approval opened by approval-request and acts on the decision",
  trigger: webhook("approval", {
    method: "GET",
    schema: query,
    // A person is watching a browser tab. "202 accepted" would tell them
    // nothing about whether the refund actually happened.
    respond: "sync",
    // The caller is a human following a link, so the shared WEBHOOK_SECRET
    // cannot travel with them — see approval-request for what replaces it.
    secret: false,
  }),
  // A decision must never be dropped, so clicks queue rather than skip. The
  // default would be "skip", which drops the second of two clicks landing at
  // once — including clicks on two *different* approvals — and answers the
  // manager with a skipped run instead of a decision.
  onOverlap: "queue",
  // Both kept small because the browser is holding the connection open, and
  // Bun.serve gives up on an idle one after 60s.
  retries: 1,
  timeoutMs: 15_000,

  async run(ctx) {
    // Everything derived from ctx.input is read inside a step, because a
    // resumed run has no input — /runs/:id/resume replays the checkpoint key
    // and nothing else, so ctx.input is {} the second time through. Read here,
    // a resume gets the recorded answer back instead of looking up
    // "approval:undefined" and reporting the approval missing.
    const opened = await ctx.step("read approval", async () => {
      const { id, decision } = ctx.input;
      const record = await ctx.state.shared.get<Approval>(approvalKey(id));
      return { id, decision, record: record ?? null };
    });

    if (!opened.record) {
      // Expired, already swept, or invented. All three answer identically on
      // purpose: a wrong id must not learn whether it came close.
      ctx.log.warn("No approval matches that id");
      return { resolved: false, reason: "unknown or expired" };
    }
    const { decision, record: existing } = opened;
    const key = approvalKey(opened.id);

    const claim = await ctx.step(
      "claim decision",
      async () => {
        // onOverlap: "queue" already serialises two managers clicking at once,
        // so this claim is what keeps the result correct rather than what makes
        // it correct today. update() is the one read-modify-write that finishes
        // inside a single synchronous tick: whoever gets here second finds the
        // record already decided, however the runner scheduled them.
        let claimed = false;
        const record = await ctx.state.shared.update<Approval>(
          key,
          (current) => {
            // `current` is missing only if the TTL lapsed between the read
            // above and this tick. Falling back re-opens a row that was valid
            // microseconds ago — the kinder of the two wrong answers on offer.
            const base = current ?? existing;
            if (base.status !== "pending") return base;
            claimed = true;
            return {
              ...base,
              status: decision === "approve" ? "approved" : "declined",
              decidedAt: new Date().toISOString(),
            };
          },
          { ttlSeconds: RESOLVED_TTL_SECONDS },
        );
        // `claimed` has to travel out inside the checkpointed value. Left as a
        // closure variable it would read false on a retry, because a reused
        // step never runs its body — and the retry would then refuse to pay out
        // an approval it had itself just recorded.
        return { claimed, record };
      },
      { input: { decision } },
    );

    if (!claim.claimed) {
      ctx.log.info(`Already ${claim.record.status} — ignoring this click`);
      return { resolved: false, reason: `already ${claim.record.status}` };
    }

    if (decision === "approve") {
      await ctx.step("issue refund", async () => {
        // Stands in for the real payout. A separate step from the claim on
        // purpose: the claim is checkpointed, so resuming this run from its run
        // page pays out without re-deciding, and can never flip the decision on
        // the way through. Clicking the link again would not do it — the second
        // click is refused as already decided, which is the whole point.
        ctx.log.info(`Refunding $${claim.record.amount} to ${claim.record.email}`);
        return { amount: claim.record.amount, email: claim.record.email };
      });
    }

    return {
      resolved: true,
      decision: claim.record.status,
      subject: claim.record.subject,
      // The two halves have separate run pages; this is the only thread between
      // them. Paste it after /runs/ to see the run that asked.
      openedByRun: claim.record.requestedByRun,
    };
  },
});
