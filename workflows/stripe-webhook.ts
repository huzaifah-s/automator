import { z } from "zod";
import { defineWorkflow, webhook } from "../src/core/define.ts";

// The trigger schema rejects malformed payloads with a 422 before the workflow
// ever starts, so `ctx.input` below is fully typed and already validated.
const payload = z.object({
  type: z.string(),
  data: z.object({
    object: z.object({
      id: z.string(),
      amount_total: z.number().optional(),
      customer_email: z.string().email().nullish(),
    }),
  }),
});

export default defineWorkflow<z.infer<typeof payload>>({
  name: "stripe-webhook",
  description: "Records completed checkouts and welcomes the customer",
  trigger: webhook("stripe", { method: "POST", schema: payload }),
  // Payment events must not be dropped, so queue rather than skip on overlap.
  onOverlap: "queue",
  retries: 3,

  async run(ctx) {
    const { type, data } = ctx.input;

    if (type !== "checkout.session.completed") {
      ctx.log.info(`Ignoring ${type}`);
      return { ignored: type };
    }

    const session = data.object;
    ctx.log.info("Checkout completed", { id: session.id, amount: session.amount_total });

    await ctx.step("record", async () => {
      await ctx.sql`
        insert into orders (stripe_id, amount, email)
        values (${session.id}, ${session.amount_total ?? 0}, ${session.customer_email ?? null})
        on conflict (stripe_id) do nothing
      `;
    });

    if (session.customer_email) {
      await ctx.step("welcome email", () =>
        ctx.email.send({
          to: session.customer_email!,
          subject: "Thanks for your order",
          text: "We've received your payment and we're getting started.",
        }),
      );
    }

    return { recorded: session.id };
  },
});
