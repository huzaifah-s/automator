import { z } from "zod";
import {
  defineSecrets,
  defineWorkflow,
  hmacSignature,
  metaVerification,
  webhook,
  type Ctx,
} from "../../src/core/define.ts";
import { LANGUAGE, SUPPORT_PHONE } from "./_studentqr.ts";

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
 * It has a third job the n8n graph did not: this same callback URL is where
 * Meta reports what happened to every message the StudentQR number sends, so a
 * send that **failed** — a number that is not on WhatsApp, a paused template, an
 * unpaid bill — is turned into a run failure here, and from there into an alert.
 * Nothing reported those before; a school simply never heard back.
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
                /**
                 * The fate of a message *we* sent: "sent", "delivered",
                 * "read", or "failed". Every field is loose on purpose — a
                 * schema that rejects gives Meta a 422, and Meta answers a
                 * 422 by redelivering the same payload for a day. `code` is
                 * a number today and is read as either, for the same reason.
                 */
                statuses: z
                  .array(
                    z.object({
                      id: z.string().optional(),
                      status: z.string().optional(),
                      recipient_id: z.string().optional(),
                      errors: z
                        .array(
                          z.object({
                            code: z.union([z.number(), z.string()]).optional(),
                            title: z.string().optional(),
                            message: z.string().optional(),
                            error_data: z
                              .object({ details: z.string().optional() })
                              .optional(),
                          }),
                        )
                        .optional(),
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

/**
 * The approved template sent when a relay lands outside the recipient's
 * 24-hour service window — the only message Meta will still carry to them.
 *
 * It takes three parameters, in this order: who was writing, what they said,
 * and the bare digits of their number (the template renders `wa.me/{{3}}`).
 * Written to be direction-agnostic on purpose: the same template tells support
 * a teacher is waiting and tells a teacher support could not reach them.
 */
const UNDELIVERED_TEMPLATE = "notification_message_undelivered";

/**
 * Meta's code for "more than 24 hours since the recipient last replied".
 *
 * The only failure code this workflow can *act* on rather than just report,
 * which is why it is matched exactly. A number that is not on WhatsApp
 * (131026) or a paused template would refuse the handoff too, so those keep
 * failing the run and reaching the alert channel as they always did.
 *
 * Compared as a string: Meta sends the code as a number today and the schema
 * accepts either, for the reason given on `statuses` above.
 */
const WINDOW_CLOSED = "131047";

/**
 * How long a relayed message stays traceable by its own id.
 *
 * Meta reports a failed send within seconds — the run this was written for saw
 * the status callback in the same second as the send — so this is slack rather
 * than a working window, and it is bounded so the relay does not accumulate a
 * row per message forever.
 */
const RELAY_MEMORY_SECONDS = 7 * 24 * 60 * 60;

/**
 * How much of the original message the template quotes back. Meta caps a
 * template body at 1024 characters *after* substitution, and a body that
 * overflows is rejected outright — so a teacher writing an essay must not be
 * what stops them being told nobody received it.
 */
const MAX_QUOTED = 600;

/**
 * What we sent, kept under the id of the message itself so a later status
 * callback can say who was waiting on it and what they wrote.
 *
 * `ctx.state` rather than the Monday board: the board already maps a forwarded
 * message to a teacher's number, but not to the text, and the text is the
 * whole point of the handoff — a "someone messaged you" with no message is a
 * notification the recipient cannot act on. The board also only covers one of
 * the two directions.
 */
interface RelayedMessage {
  /** Who it was for — matches `recipient_id` on the status callback. */
  to: string;
  /** Who wrote it, in bare digits, for the template's wa.me link. */
  from: string;
  /** A display name for whoever wrote it. May be empty. */
  fromName: string;
  body: string;
}

const memoryKey = (wamid: string) => `relayed:${wamid}`;

/** Remembers one relayed message, so a failed delivery can be explained. */
function remember(
  ctx: Ctx<z.infer<typeof inbound>>,
  wamid: string,
  record: RelayedMessage,
): Promise<unknown> {
  return ctx.step(
    "remember what we sent",
    async () => {
      await ctx.state.set(memoryKey(wamid), record, { ttlSeconds: RELAY_MEMORY_SECONDS });
      return { wamid, to: record.to };
    },
    { input: { wamid, to: record.to } },
  );
}

/** The quoted message, trimmed to something a template body can carry. */
function quote(body: string): string {
  const flat = body.trim();
  return flat.length <= MAX_QUOTED ? flat : `${flat.slice(0, MAX_QUOTED - 1).trimEnd()}\u2026`;
}

/**
 * Tells the recipient of a message we could not deliver that it is waiting,
 * and who to answer. Returns whether they were actually reached.
 *
 * Everything here is a reason to give up rather than to throw: a failure this
 * cannot explain is still a failure worth alerting on, and the caller does
 * that. Notably the template send itself is caught — while the template is in
 * review at Meta, every attempt fails, and the workflow falls straight back to
 * the behaviour it had before this existed.
 */
async function handOff(
  ctx: Ctx<z.infer<typeof inbound>>,
  failure: { to: string; wamid: string; code: string | number },
  index?: number,
): Promise<boolean> {
  if (String(failure.code) !== WINDOW_CLOSED) return false;
  // A send this workflow did not make — a notification from one of the order
  // or issue workflows — has nothing in state, and there is no sender to name.
  if (!failure.wamid) return false;

  const record = await ctx.state.get<RelayedMessage>(memoryKey(failure.wamid));
  if (!record) return false;

  // Step names key the checkpoint table, so two failures in one delivery must
  // not share one — the second would silently reuse the first's result and
  // nobody would be told. Suffixed only when there is more than one, so the
  // ordinary run page stays readable.
  const label = `tell ${record.to} to reply directly${index ? ` (${index})` : ""}`;

  try {
    await ctx.step(
      label,
      () =>
        ctx.whatsapp.template({
          to: record.to,
          language: LANGUAGE,
          name: UNDELIVERED_TEMPLATE,
          params: [
            // Meta rejects an empty parameter; ctx.whatsapp substitutes "-",
            // but "unknown (60…)" reads better than "- (60…)".
            `${record.fromName || "unknown"} (${record.from})`,
            quote(record.body),
            record.from,
          ],
        }),
      { input: { to: record.to, template: UNDELIVERED_TEMPLATE } },
    );
    return true;
  } catch (err) {
    ctx.log.warn(
      `Could not send ${UNDELIVERED_TEMPLATE} to ${record.to} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Whether a delivery has anything behind it — the trigger's `filter`.
 *
 * This URL receives one delivery per teacher message and three or so per
 * message the StudentQR number *sends*: "sent", then "delivered", then "read".
 * Every notification in _studentqr.ts goes out through that number — orders,
 * issues, card status, badges, welcome — so the receipts outnumber the real
 * traffic several to one, and each of them used to be a full run. Worse than
 * untidy: this workflow is `onOverlap: "queue"`, so a burst of read receipts
 * took its turn in the queue *ahead of* a teacher waiting on support.
 *
 * Deliberately more permissive than run(), which is the safe direction: this
 * decides what is *definitely* nothing, and run() decides what to do with the
 * rest. Anything it lets through that turns out to be unrelayable falls into
 * the branches below and returns `relayed: false` as it always did — those
 * stay, both because a manual run or a replay does not come through here, and
 * because a filter is a shortcut and never the thing enforcing correctness.
 *
 * The two ignorable cases are counted separately on purpose. A receipt is
 * plumbing nobody needs to see; a teacher sending a photo is a person being
 * silently not-answered, and collapsing the two would hide the second inside
 * the volume of the first. Neither keeps its payload — that is the cost of not
 * running: `ignored` holds a count and a reason, and nothing else.
 */
function worthRunning(body: z.infer<typeof inbound>): boolean {
  const values = (body.entry ?? []).flatMap((entry) => entry.changes ?? []).map((c) => c.value);

  // A text message from anyone — a teacher writing in, or support swipe-replying.
  const relayable = values.some((v) =>
    (v.messages ?? []).some((m) => (m.text?.body ?? "").trim() !== ""),
  );
  if (relayable) return true;

  // A send that failed is the workflow's third job, and it arrives as a status
  // callback like all the others. Missing this is the expensive mistake here —
  // it is the only report anyone gets that a school never heard back — so it is
  // checked before anything is turned away.
  return values.some((v) => (v.statuses ?? []).some((s) => s.status === "failed"));
}

/** Names what a delivery was, once worthRunning() has said it was nothing. */
function whyIgnored(body: z.infer<typeof inbound>): string {
  const values = (body.entry ?? []).flatMap((entry) => entry.changes ?? []).map((c) => c.value);
  return values.some((v) => (v.messages ?? []).length > 0)
    ? "a message with no text — a sticker, image or reaction"
    : "a delivery receipt for a message we sent";
}

export default defineWorkflow<z.infer<typeof inbound>>({
  name: "studentqr-whatsapp-relay",
  description:
    "Relays WhatsApp messages between schools and support, and alerts on failed deliveries",
  trigger: webhook("studentqr/whatsapp", {
    method: "POST",
    schema: inbound,
    // Most of what Meta posts here is a receipt for a message we sent, and a
    // receipt is not an execution. See worthRunning() — and note the run body
    // still guards every case this lets through.
    filter: (body) => worthRunning(body) || whyIgnored(body),
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

    // A delivery with nothing to relay is nearly always a status callback, and
    // this number's status callbacks are the only report anyone gets on whether
    // a StudentQR notification actually arrived — every order, issue and welcome
    // message goes out through it, and they all come back here when they don't
    // land. Checked inside this branch because Meta sends `messages` and
    // `statuses` in separate deliveries; a payload that somehow carried both
    // would relay the teacher's message and skip the report, which is the right
    // way round to lose one of the two.
    if (!message.relayable) {
      const delivery = await ctx.step("check what happened to what we sent", async () => {
        const statuses = (ctx.input.entry ?? [])
          .flatMap((entry) => entry.changes ?? [])
          .flatMap((change) => change.value.statuses ?? []);

        return {
          statuses: statuses.length,
          failed: statuses
            .filter((s) => s.status === "failed")
            .flatMap((s) =>
              (s.errors ?? []).map((err) => ({
                to: s.recipient_id ?? "an unknown number",
                // The id of the message *we* sent, which is the key to what it
                // said and who wrote it — see RelayedMessage. Discarding this
                // is what left the failure with nothing to say beyond a code.
                wamid: s.id ?? "",
                code: err.code ?? "",
                reason: err.title ?? err.message ?? "no reason given",
                details: err.error_data?.details ?? "",
              })),
            ),
        };
      });

      if (delivery.failed.length > 0) {
        // A closed 24-hour window is the one failure with a way out: the
        // recipient can still be reached with a template, and the template
        // carries both the message they missed and the number to answer on, so
        // the conversation continues by hand instead of stopping dead. Their
        // reply to it also reopens the window, and the relay resumes working on
        // its own — which is the actual repair, not just the notification.
        //
        // Attempted before anything is logged, because whether it worked is
        // what decides between a warning and a failed run.
        const stranded: typeof delivery.failed = [];

        for (const [i, f] of delivery.failed.entries()) {
          const reached = await handOff(ctx, f, delivery.failed.length > 1 ? i + 1 : undefined);

          if (reached) {
            ctx.log.warn(
              `WhatsApp could not deliver to ${f.to} — ${f.reason}. ` +
                `Sent ${UNDELIVERED_TEMPLATE} instead, so they can pick it up by hand.`,
              { code: f.code, details: f.details },
            );
            continue;
          }

          // Every recipient on the run page, one on the alert. The alert channel
          // throttles on the exact text it sends, so naming the school there
          // would turn an account-level problem — a lapsed bill fails *every*
          // send — into one Telegram message per school. The reason is the thing
          // that repeats; who it happened to is a click away on the run.
          ctx.log.error(`WhatsApp could not deliver to ${f.to} — ${f.reason}`, {
            code: f.code,
            details: f.details,
          });
          stranded.push(f);
        }

        // Handed off is handled: a human has the message and the link to answer
        // it, so there is nothing an alert would ask anyone to do and nothing a
        // retry could improve. The failure is still on the run page as a
        // warning, with the code and the recipient.
        if (stranded.length === 0) {
          return {
            relayed: false,
            reason: "the recipient's 24-hour window had closed — they were sent a template instead",
            handedOff: delivery.failed.map((f) => f.to),
          };
        }

        // Reported by failing the run rather than by messaging Telegram from
        // here: this is exactly the problem the runner's alert channel exists
        // for, and going through it buys the 🚨 format, the link back to this
        // run, and the 30-minute cooldown for free. The cost is the two retries
        // this workflow declares, which cannot fix a rejection Meta has already
        // decided — about six seconds of the relay's queue per failed message.
        const first = stranded[0]!;
        const more =
          stranded.length > 1
            ? `\n(and ${stranded.length - 1} more in the same delivery)`
            : "";
        throw new Error(
          `WhatsApp could not deliver a message — ${first.reason}` +
            `${first.code ? ` (${first.code})` : ""}` +
            `${first.details ? `\n${first.details}` : ""}${more}`,
        );
      }

      ctx.log.info("Not a text message — nothing to relay");
      return {
        relayed: false,
        reason: delivery.statuses > 0 ? "delivery status callback" : "not a text message",
      };
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

      await remember(ctx, sent.wamid, {
        to: teacher,
        from: SUPPORT_PHONE,
        fromName: "StudentQR",
        body: message.body,
      });

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

    await remember(ctx, forwarded.wamid, {
      to: SUPPORT_PHONE,
      from: message.from,
      fromName: message.name,
      body: message.body,
    });

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
