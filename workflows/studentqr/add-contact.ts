import { z } from "zod";
import { defineWorkflow, webhook } from "../../src/core/define.ts";

/**
 * StudentQR — record a WhatsApp contact.
 *
 * Adds a row to the "Contacts" tab of the StudentQR inbox spreadsheet the
 * first time a number is seen, so the human-facing inbox has a name against
 * it. A port of the n8n graph "StudentQR - Add new user contact".
 *
 * Every other StudentQR workflow calls this through `ctx.run()` rather than by
 * POSTing its own webhook, which is what n8n had to do. The route stays for
 * anything outside this repo that still calls it — but note that unlike the
 * n8n one, which was guarded by nothing but an unguessable path, it now takes
 * the shared WEBHOOK_SECRET like every other route here. An external caller
 * needs `?secret=…` added.
 */

/**
 * The inbox spreadsheet. Configuration rather than a secret: it is an id in a
 * URL, the service account is what actually grants access, and blanking it out
 * of every run page would make "which sheet did this write to" unanswerable.
 *
 * Share the sheet with the service account in GOOGLE_SERVICE_ACCOUNT_JSON.
 */
const SHEET = process.env.STUDENTQR_INBOX_SHEET_ID ?? "1x7L4hzDWUVhb4HPhyK1sEh-HJx2UpYc66cI0Fbe-IGw";

/** A, B, C, D, E — the column order the tab was built with. */
const TAB = "Contacts";

/**
 * The two derived columns are spreadsheet formulas, copied verbatim from the
 * n8n node. They read the "Messages" tab, which nothing in this repo writes:
 * the message log was already disconnected in the n8n graph when it was
 * exported, and was left out of this port deliberately. Anything else that
 * still appends to that tab keeps these cells working; nothing does, and they
 * render empty, which is the same thing they did before.
 *
 * `INDIRECT("A" & ROW())` is the row's own WhatsApp ID, so the formula is
 * identical in every row and survives being appended anywhere.
 */
const LAST_TEXT =
  '=IFERROR(   LET(     last_row, INDEX(SORT(FILTER(ROW(Messages!C:C), Messages!A:A = INDIRECT("A" & ROW())), 1, FALSE), 1),' +
  '     message_type, INDEX(Messages!C:C, last_row),     message_text, INDEX(Messages!B:B, last_row),' +
  '     IF(message_type = 1,        "You: " & message_text,        message_text)   ),   "" )';
const LAST_TIMESTAMP =
  '=IFERROR(INDEX(SORT(FILTER(Messages!D:D, Messages!A:A = INDIRECT("A" & ROW())), 1, FALSE), 1), "")';

const payload = z.object({
  /** The teacher's WhatsApp number. Meta calls this a wa_id. */
  phone_number_id: z.union([z.string(), z.number()]),
  name: z.string().optional(),
});

export default defineWorkflow<z.infer<typeof payload>>({
  name: "studentqr-add-contact",
  description: "Adds a WhatsApp number to the StudentQR inbox contacts sheet, once",
  trigger: webhook("studentqr/add-contact", { method: "POST", schema: payload }),
  /**
   * Two reasons this cannot be the default "skip".
   *
   * `ctx.run()` throws when the child it called was skipped, so a second
   * notification landing while the first one's contact write is in flight
   * would fail an otherwise healthy run — and eight workflows call this one.
   *
   * And the body is a read followed by a write. Two concurrent runs for the
   * same new number would both find it absent and both append it. Queueing is
   * what makes "once" true.
   */
  onOverlap: "queue",
  retries: 2,
  timeoutMs: 60_000,

  async run(ctx) {
    // Read inside a step: a resumed run has no ctx.input, and from the
    // checkpoint the recorded answer comes back instead of an empty object.
    const contact = await ctx.step("read contact", async () => {
      const parsed = payload.safeParse(ctx.input);
      if (!parsed.success) {
        // Reachable only through ctx.run(), which does not go through the
        // trigger's schema the way the HTTP route does.
        throw new Error(
          `add-contact was called without a usable phone number — ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        );
      }
      const phone = String(parsed.data.phone_number_id).replace(/[^\d]/g, "");
      if (!phone) throw new Error("add-contact was called with an empty phone number");
      return { phone, name: parsed.data.name?.trim() || "-" };
    });

    const known = await ctx.step(
      "look for the number",
      async () => {
        const rows = await ctx.sheets.read(SHEET, `${TAB}!A:A`);
        // Sheets returns the cell as typed. A number pasted without its
        // country code comes back as a number-ish string either way, so both
        // sides are reduced to digits before comparing.
        return rows.some((r) => (r[0] ?? "").replace(/[^\d]/g, "") === contact.phone);
      },
      { input: { phone: contact.phone } },
    );

    if (known) {
      ctx.log.info("Already in the contacts sheet — nothing to add");
      return { phone: contact.phone, added: false };
    }

    await ctx.step(
      "append the contact",
      () =>
        ctx.sheets.append(SHEET, `${TAB}!A:E`, [
          [contact.phone, contact.name, LAST_TEXT, LAST_TIMESTAMP, "FALSE"],
        ]),
      { input: { phone: contact.phone, name: contact.name } },
    );

    return { phone: contact.phone, name: contact.name, added: true };
  },
});
