import { z } from "zod";
import { defineSecrets, defineWorkflow, tallySignature, webhook } from "../../src/core/define.ts";

/**
 * PBLSH — Content Buyout Agreement.
 *
 * Tally posts a submission, the creator gets their signed copy as a PDF
 * attachment, and Huzaifah gets a Telegram summary. A port of the n8n graph
 * "Send signed agreement in PDF to creator" (webhook → download PDF → code →
 * Brevo → Telegram), collapsed into three steps.
 *
 * Configure the webhook in Tally as
 *   https://<PUBLIC_URL>/hooks/pblsh/agreement-signed?secret=<WEBHOOK_SECRET>
 * Tally's webhook form has no custom-header field, and the route keeps the
 * global secret check rather than opting out of it — the payload carries a
 * KTP number and bank details, so an unguessable path alone (which is all the
 * n8n version had) is not the guard this deserves.
 *
 * For the same reason, know what a run page for this workflow holds: the
 * captured trigger payload includes the KTP number, address, and bank
 * details, and Tally's signed `submissionPdfUrl` is a bearer link to the PDF
 * for as long as the token stays valid. Both are bounded by the dashboard's
 * basic auth and by RUN_RETENTION_DAYS, and `CAPTURE_DATA=false` switches
 * payload capture off runner-wide if that trade ever stops being acceptable.
 */

const secrets = defineSecrets({
  // Brevo's transactional API key — `xkeysib-…`, not the `xsmtpsib-…` SMTP
  // one. Only checked for length: which key types Brevo issues is their call,
  // and a boot that fails on a valid key is worse than one that doesn't.
  BREVO_API_KEY: z.string().min(20),
  // Tally's signing secret. It signs the body with this and sends only the
  // digest, so the shared WEBHOOK_SECRET could never match — see the verify
  // option on the trigger below.
  TALLY_SIGNING_SECRET: z.string().min(10),
});

/* ------------------------------------------------------------------ payload */

const tallyField = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  value: z.unknown(),
});

/**
 * Only the parts this workflow reads. Tally sends far more (headers, the
 * signature image, calculated fields); validating those would turn a form edit
 * into a 422 instead of a delivered agreement.
 */
const payload = z.object({
  eventType: z.string(),
  data: z.object({
    submissionId: z.string(),
    formName: z.string().optional(),
    submissionPdfUrl: z.string().url(),
    fields: z.array(tallyField),
  }),
});

type Field = z.infer<typeof tallyField>;

/**
 * The questions this workflow depends on, spelled out in one place because
 * they are the contract with the form. Renaming a question in Tally breaks
 * the lookup, and the error names the label so it is obvious what to fix.
 */
const LABEL = {
  agreementDate: "Date of this agreement",
  name: "Full name (as on KTP)",
  ktp: "KTP No.",
  dob: "Date of birth",
  email: "Email",
  whatsapp: "WhatsApp",
} as const;

const ATTACHMENT = "content-buyout-agreement.pdf";

/**
 * Tally identifies a field by its label. The n8n version read the Telegram
 * summary out of `fields[2]`, `fields[3]`, `fields[7]` … — so dragging a
 * question in the form editor would have sent the KTP number as the date of
 * birth, silently. Everything here goes through the label instead.
 */
function optional(fields: Field[], label: string): string | undefined {
  const value = fields.find((f) => f.label === label)?.value;
  if (value === null || value === undefined || value === "") return undefined;
  // A signature or file field is an array of uploads, never something to
  // print. `KTP No.` arrives as a JSON *number*, hence String() — and a NIK
  // from provinces 91-96 is 16 digits past 2^53, so its last digit can read
  // one off on the Telegram line. The attached PDF is the authoritative copy;
  // fixing it would mean reading the request body as text before JSON, which
  // the runner doesn't do for anyone.
  if (typeof value === "object") return undefined;
  return String(value);
}

function required(fields: Field[], label: string): string {
  const value = optional(fields, label);
  if (value === undefined) {
    throw new Error(
      `Tally submission has no "${label}" — the question was renamed, removed, ` +
        `or left blank, and the agreement cannot be delivered without it`,
    );
  }
  return value;
}

/** What the first step pins down, so a resume doesn't need `ctx.input`. */
interface Submission {
  submissionId: string;
  pdfUrl: string;
  name: string;
  email: string;
  formName?: string;
  agreementDate?: string;
  ktp?: string;
  dob?: string;
  whatsapp?: string;
}

/** Telegram's HTML mode needs these three, and "Tan & Sons" would break the
 * whole message without them. n8n's version was one apostrophe from that. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Whole years, from an ISO date. `null` for anything unparseable. */
function ageFrom(dob: string | undefined, now: Date): number | null {
  if (!dob) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const months = now.getUTCMonth() - born.getUTCMonth();
  if (months < 0 || (months === 0 && now.getUTCDate() < born.getUTCDate())) age--;
  return age >= 0 && age < 150 ? age : null;
}

/** The creator's copy. Same markup as the n8n node, with the name escaped. */
const copyEmail = (name: string) => `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#404040;max-width:480px;"><p style="font-size:15px;font-weight:700;letter-spacing:.08em;color:#171717;margin:0 0 20px;">PBLSH</p><p style="font-size:18px;font-weight:700;color:#171717;margin:0 0 12px;">Your copy of the agreement</p><p style="margin:0 0 20px;">Hi ${esc(name)} — thanks for submitting. By sending the form you agreed to our Content Buyout Agreement.<br>Keep this copy.</p><p style="font-size:11px;color:#737373;margin:24px 0 0;">PBLSH is a trading name of Inonity Sdn. Bhd.</p></div>`;

/* ----------------------------------------------------------------- workflow */

export default defineWorkflow<z.infer<typeof payload>>({
  name: "pblsh-send-signed-agreement",
  description: "Emails a Tally signer their agreement PDF and pings Telegram",
  trigger: webhook("pblsh/agreement-signed", {
    method: "POST",
    schema: payload,
    // Authenticates Tally by its signature rather than a token in the URL:
    // Tally has nowhere to put a custom header, and a secret in the query
    // string is a secret in every access log between here and them.
    verify: tallySignature(secrets.TALLY_SIGNING_SECRET),
  }),
  // A signed agreement must not be dropped, so two submissions landing
  // together queue rather than the second being skipped.
  onOverlap: "queue",
  retries: 3,
  timeoutMs: 120_000,

  async run(ctx) {
    // Everything derived from the payload is read *inside* a step: a resumed
    // run has no `ctx.input`, so read at the top of run() this would look up
    // an empty object and fail with the labels missing. From the checkpoint
    // the recorded answer comes back instead.
    const submission = await ctx.step<Submission | { ignored: string }>(
      "read submission",
      async () => {
        const { eventType, data } = ctx.input;
        if (eventType !== "FORM_RESPONSE") return { ignored: eventType };

        const fields = data.fields;
        return {
          submissionId: data.submissionId,
          pdfUrl: data.submissionPdfUrl,
          name: required(fields, LABEL.name),
          email: required(fields, LABEL.email),
          formName: data.formName,
          agreementDate: optional(fields, LABEL.agreementDate),
          ktp: optional(fields, LABEL.ktp),
          dob: optional(fields, LABEL.dob),
          whatsapp: optional(fields, LABEL.whatsapp),
        };
      },
    );

    if ("ignored" in submission) {
      ctx.log.info(`Ignoring ${submission.ignored}`);
      return submission;
    }

    ctx.log.info("Agreement signed", {
      submissionId: submission.submissionId,
      form: submission.formName,
    });

    // `checkpoint: false`, and the PDF leaves through `pdf` rather than
    // through the result: a few hundred KB of base64 as a step result would
    // be truncated on the way into SQLite and leave the run page carrying a
    // useless copy of it. A *checkpointed* step whose value escapes by closure
    // comes back empty on a resume, so this one always re-runs — which is
    // cheap, and the only combination of the two that is correct.
    let pdf: Buffer | undefined;
    const { bytes } = await ctx.step(
      "download signed pdf",
      async () => {
        const body = await ctx.http.get<ArrayBuffer>(submission.pdfUrl, {
          as: "buffer",
          timeoutMs: 60_000,
        });
        pdf = Buffer.from(body);
        return { bytes: pdf.byteLength };
      },
      { input: { submissionId: submission.submissionId }, checkpoint: false },
    );

    if (!pdf?.byteLength) throw new Error("Tally served an empty PDF");
    const base64 = pdf.toString("base64");

    const sent = await ctx.step(
      "email the creator",
      () =>
        ctx.http.post<{ messageId: string }>(
          "https://api.brevo.com/v3/smtp/email",
          {
            // The sending domain is verified in Brevo; replies go to a mailbox
            // a person reads. Both are configuration of this one agreement
            // flow, so they live in the file, not the environment.
            sender: { name: "Huzaifah at PBLSH", email: "agreements@mail.pblsh.world" },
            replyTo: { name: "Support Team", email: "support@pblsh.world" },
            to: [{ email: submission.email, name: submission.name }],
            subject: "Your copy of the agreement — PBLSH",
            htmlContent: copyEmail(submission.name),
            attachment: [{ content: base64, name: ATTACHMENT }],
          },
          { headers: { "api-key": secrets.BREVO_API_KEY }, timeoutMs: 60_000 },
        ),
      // The recorded request body is the whole base64 attachment, so past
      // CAPTURE_MAX_BYTES the run page stores a prefix of it and nothing
      // else. The step input is the part actually worth reading back.
      { input: { to: submission.email, bytes } },
    );

    const age = ageFrom(submission.dob, new Date());
    await ctx.step("tell huzaifah", () =>
      ctx.telegram.send(
        `✍️ <b>PBLSH - Agreement signed</b>\n\n` +
          `<b>${esc(submission.name)}</b>\n` +
          `KTP No.: ${esc(submission.ktp ?? "—")}\n` +
          `DOB: ${esc(submission.dob ?? "—")}${age === null ? " (age?)" : ` (${age} y/o)`}\n` +
          `WhatsApp: ${esc(submission.whatsapp ?? "—")}\n` +
          `Email: ${esc(submission.email)}\n\n` +
          `Dated ${esc(submission.agreementDate ?? "—")}`,
        {
          // Configuration, not a secret: declaring the chat id would blank it
          // out of every run page. Unset, the integration's TELEGRAM_CHAT_ID
          // is used.
          chatId: process.env.TELEGRAM_CHAT_ID_HUZAIFAH,
          parseMode: "HTML",
        },
      ),
    );

    return {
      submissionId: submission.submissionId,
      emailedTo: submission.email,
      messageId: sent.messageId,
      pdfBytes: bytes,
    };
  },
});
