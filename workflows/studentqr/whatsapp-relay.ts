import { z } from "zod";
import {
  defineSecrets,
  defineWorkflow,
  hmacSignature,
  metaVerification,
  webhook,
} from "../../src/core/define.ts";
import { SUPPORT_PHONE } from "./_studentqr.ts";

/**
 * StudentQR — two-way WhatsApp relay ("Zahra").
 *
 * The StudentQR bot number is a notification number, not a conversation. This
 * makes it one anyway, without giving support a second phone:
 *
 *   1. A teacher messages the bot. The message is forwarded to the support
 *      number as "From <name> (<number>)", and the id of *that forwarded
 *      message* is written to a Monday board against the teacher's number.
 *   2. Support swipe-replies to it in WhatsApp. Meta puts the id of the
 *      message being replied to in `context.id`, which is the key back to the
 *      teacher, and the reply is relayed to them.
 *
 * A port of the n8n graph "Zahra AI - Retriever". The board is doing the job
 * of a lookup table, which is what it was doing in n8n too — `ctx.state` would
 * hold this more cheaply, but the board is also the thing a human opens to see
 * who is waiting on a reply, so it stays where support can see it.
 *
 * The Meta callback URL is
 *   https://<PUBLIC_URL>/hooks/studentqr/whatsapp
 * with no `?secret=` — Meta will not carry one. The route is authenticated
 * instead by the app-secret signature on every delivery, which is stronger.
 */

const secrets = defineSecrets({
  /**
   * The Meta app secret, which signs every delivery as `x-hub-signature-256`.
   * App Dashboard › Settings › Basic.
   */
  WHATSAPP_APP_SECRET: z.string().min(20),
  /**
   * The string typed into "Verify token" when the callback URL is saved. Meta
   * echoes it back on the one-off GET and never again. Any random string; it
   * has to match on both sides exactly, whitespace included.
   */
  WHATSAPP_VERIFY_TOKEN: z.string().min(8),
});

/** The Monday board that maps a forwarded message back to who sent it. */
const RELAY = {
  boardId: "5029718572",
  group: "topics",
  /** The teacher's number. The item's *name* is the forwarded message's id. */
  phoneColumn: "phone_mm504aq3",
} as const;

/**
 * Meta's envelope, narrowed to the parts this reads. Everything is optional
 * because the same callback URL receives delivery receipts and read receipts
 * (`statuses`) at a far higher rate than actual messages, and those must be
 * accepted and ignored rather than 422'd back at Meta — which retries.
 */
const inbound = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                contacts: z
                  .array(
                    z.object({
                      wa_id: z.string(),
                      profile: z.object({ name: z.string().optional() }).optional(),
                    }),
                  )
                  .optional(),
                messages: z
                  .array(
                    z.object({
                      id: z.string(),
                      from: z.string().optional(),
                      type: z.string().optional(),
                      text: z.object({ body: z.string() }).optional(),
                      /** Present when this message is a reply to another. */
                      context: z.object({ id: z.string().optional() }).optional(),
                    }),
                  )
                  .optional(),
              }),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

const NOT_A_REPLY = "Please swipe to reply directly on the message you're responding to.";
const NO_MATCH = "We can't find the message to reply to.";

export default defineWorkflow<z.infer<typeof inbound>>({
  name: "studentqr-whatsapp-relay",
  description: "Relays WhatsApp messages between schools and the support number",
  trigger: webhook("studentqr/whatsapp", {
    method: "POST",
    schema: inbound,
    // Meta verifies the callback URL with a GET carrying `hub.challenge`, and
    // wants the bare challenge back. A handshake answers on any method on its
    // path, which is what lets one URL do both jobs — see types.ts.
    handshake: metaVerification(() => secrets.WHATSAPP_VERIFY_TOKEN),
    // Getters, not values: the trigger is built once at import, so a bare
    // `secrets.X` would freeze whatever existed at boot and a rotated app
    // secret would never reach the route.
    verify: hmacSignature({
      header: "x-hub-signature-256",
      secret: () => secrets.WHATSAPP_APP_SECRET,
      encoding: "hex",
      prefix: "sha256=",
    }),
  }),
  // A teacher and support can be typing at the same time, and a dropped
  // delivery is a message nobody ever sees.
  onOverlap: "queue",
  retries: 2,
  timeoutMs: 60_000,

  async run(ctx) {
    const message = await ctx.step("read the message", async () => {
      const value = ctx.input.entry?.[0]?.changes?.[0]?.value;
      const msg = value?.messages?.[0];
      const body = msg?.text?.body?.trim();

      // No `messages` at all is a status callback; a message with no text is a
      // sticker, an image, or a reaction. Neither is relayable, and both are
      // normal traffic rather than an error.
      if (!msg || !body) return { relayable: false as const };

      return {
        relayable: true as const,
        wamid: msg.id,
        body,
        from: value?.contacts?.[0]?.wa_id ?? msg.from ?? "",
        name: value?.contacts?.[0]?.profile?.name ?? "",
        /** The id of the message being replied to, when this is a reply. */
        replyTo: msg.context?.id,
      };
    });

    if (!message.relayable) {
      ctx.log.info("Not a text message — nothing to relay");
      return { relayed: false, reason: "not a text message" };
    }

    /* ------------------------------------------- support replying outward */

    if (message.from === SUPPORT_PHONE) {
      if (!message.replyTo) {
        await ctx.step("ask support to swipe-reply", () =>
          ctx.whatsapp.text(SUPPORT_PHONE, NOT_A_REPLY),
        );
        return { relayed: false, reason: "support did not reply to a specific message" };
      }

      const teacher = await ctx.step(
        "look up who was asking",
        async () => {
          const items = await ctx.monday.itemsByName({
            boardId: RELAY.boardId,
            // The item's name is the forwarded message's id, which is what
            // WhatsApp quotes back in `context.id`.
            name: message.replyTo!,
            limit: 5,
          });
          const item = items[0];
          if (!item) return null;
          // By column id, not by position. The n8n node read
          // `column_values[0]`, so adding any column to the left of the phone
          // number on that board would have relayed replies to nobody.
          return ctx.monday.fields(item).phone(RELAY.phoneColumn) ?? null;
        },
        { input: { replyTo: message.replyTo } },
      );

      if (!teacher) {
        await ctx.step("tell support it is unmatched", () =>
          ctx.whatsapp.text(SUPPORT_PHONE, NO_MATCH),
        );
        return { relayed: false, reason: "no board item for that message" };
      }

      const sent = await ctx.step(
        "relay to the teacher",
        // Free-form text, which Meta allows only inside the 24-hour window an
        // inbound message opens. That window is open by construction here: the
        // teacher messaged in to create the item support is replying to. Past
        // 24 hours Meta rejects the send and the run fails, which is the
        // correct outcome — a template would be a different conversation.
        () => ctx.whatsapp.text(teacher, message.body),
        { input: { to: teacher } },
      );

      return { relayed: true, direction: "to-teacher", to: teacher, wamid: sent.wamid };
    }

    /* ------------------------------------------- teacher messaging inward */

    const forwarded = await ctx.step(
      "forward to support",
      () =>
        ctx.whatsapp.text(
          SUPPORT_PHONE,
          `From ${message.name || "unknown"} (${message.from}): -\n\n"${message.body}"`,
        ),
      { input: { from: message.from, name: message.name } },
    );

    await ctx.step(
      "record who it came from",
      () =>
        ctx.monday.createItem({
          boardId: RELAY.boardId,
          groupId: RELAY.group,
          // The id of the message *we just sent to support* — not the
          // teacher's — because that is the one support will swipe-reply to.
          name: forwarded.wamid,
          columnValues: {
            [RELAY.phoneColumn]: { phone: message.from, countryShortName: "MY" },
          },
        }),
      { input: { wamid: forwarded.wamid, phone: message.from } },
    );

    return {
      relayed: true,
      direction: "to-support",
      from: message.from,
      wamid: forwarded.wamid,
    };
  },
});
