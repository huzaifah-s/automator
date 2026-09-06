import { z } from "zod";
import { defineWorkflow, webhook } from "../../src/core/define.ts";

/**
 * StudentQR — welcome a new WhatsApp contact.
 *
 * Sends the approved `welcome_message` template to a number and records it as
 * a contact. A port of the n8n graph on webhook `studentqr/3521cd0d-…`, which
 * was called by whatever front end registers a new teacher.
 *
 * `respond: "sync"` because the caller genuinely waits on the answer — it is
 * not a provider that will retry, it is a person's screen. Note that the reply
 * body is this runner's shape, not n8n's: where n8n answered
 * `{"message":"Message sent!"}`, this answers
 * `{"runId":…,"status":"success","result":{"message":"Message sent!",…}}`.
 * A caller reading `message` at the top level has to read `result.message`.
 *
 * The other shape change: n8n answered 400 for an empty phone number. Here an
 * unusable one fails the trigger's schema and the route answers 422 before any
 * run exists, which is where every other malformed request to this server is
 * already handled — and unlike n8n's 400, it shows up in the rejected
 * deliveries box instead of looking like a successful no-op.
 */

const payload = z
  .object({
    /** The new contact's WhatsApp number. Meta calls this a wa_id. */
    phone_number_id: z.union([z.string(), z.number()]),
    name: z.string().optional(),
  })
  .refine((v) => /\d/.test(String(v.phone_number_id)), {
    message: "must contain a phone number",
    path: ["phone_number_id"],
  });

export default defineWorkflow<z.infer<typeof payload>>({
  name: "studentqr-welcome-message",
  description: "Sends the WhatsApp welcome template to a new contact",
  trigger: webhook("studentqr/welcome-message", {
    method: "POST",
    schema: payload,
    respond: "sync",
  }),
  onOverlap: "queue",
  retries: 2,
  timeoutMs: 60_000,

  async run(ctx) {
    const contact = await ctx.step("read the request", () =>
      Promise.resolve({
        phone: String(ctx.input.phone_number_id).replace(/[^\d]/g, ""),
        name: ctx.input.name?.trim() || "-",
      }),
    );

    const sent = await ctx.step(
      "send the welcome",
      // No body parameters: the approved template is fixed text.
      () => ctx.whatsapp.template({ to: contact.phone, name: "welcome_message", language: "ms" }),
      { input: { to: contact.phone } },
    );

    // Non-fatal for the same reason as in _studentqr.ts notify(): the welcome
    // has been delivered, and this caller is a person's screen waiting on a
    // yes. Failing the whole call over a bookkeeping row would report "not
    // sent" for a message that was.
    const recorded = await ctx.step("record contact", async () => {
      try {
        await ctx.run("studentqr-add-contact", {
          phone_number_id: contact.phone,
          name: contact.name,
        });
        return true;
      } catch (err) {
        ctx.log.warn(
          `Welcome sent, but the contact was not recorded — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    });

    return {
      message: "Message sent!",
      phone: contact.phone,
      wamid: sent.wamid,
      contactRecorded: recorded,
    };
  },
});
