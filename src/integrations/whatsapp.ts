import type { HttpClient } from "./http.ts";

/** What Meta gives back: one accepted message, identified by its `wamid`. */
export interface WhatsAppSent {
  /** `wamid.HBg…` — the id an inbound reply quotes back in `context.id`. */
  wamid: string;
  /** The number Meta actually routed to, after its own normalisation. */
  waId?: string;
}

export interface TemplateOptions {
  /** Recipient in international format, no `+` needed: `60199300195`. */
  to: string;
  /** The approved template's name, e.g. `notification_delivered`. */
  name: string;
  /** Template language code. Default `ms`. */
  language?: string;
  /**
   * Body parameters, in the order the template declares them. `undefined` and
   * blank become `"-"` — see the note on sanitise() for why that is here and
   * not at the call site.
   */
  params?: (string | number | null | undefined)[];
  /** A document header, for a template whose header is a file. */
  document?: { link: string; filename: string };
  /** Overrides WHATSAPP_PHONE_NUMBER_ID, for a second sending number. */
  phoneNumberId?: string;
}

export interface WhatsAppClient {
  /**
   * Sends an approved message template. This is the only way to open a
   * conversation: a business may send free-form text only inside the 24-hour
   * window an inbound message opens.
   */
  template(opts: TemplateOptions): Promise<WhatsAppSent>;
  /**
   * Sends plain text. Only delivers inside the 24-hour service window; outside
   * it Meta rejects the call rather than silently dropping it.
   */
  text(
    to: string,
    body: string,
    opts?: { phoneNumberId?: string; previewUrl?: boolean },
  ): Promise<WhatsAppSent>;
}

/**
 * WhatsApp Business Cloud API.
 *
 * Reads WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID. The Graph version
 * is pinned via WHATSAPP_API_VERSION so Meta's deprecation calendar cannot
 * change behaviour without a deploy.
 */
export function createWhatsApp(http: HttpClient): WhatsAppClient {
  const token = () => {
    const t = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!t) throw new Error("WHATSAPP_ACCESS_TOKEN is not set");
    return t;
  };

  const from = (override?: string) => {
    const id = override ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!id) throw new Error("WHATSAPP_PHONE_NUMBER_ID is not set");
    return id;
  };

  const version = () => process.env.WHATSAPP_API_VERSION ?? "v21.0";

  const send = async (phoneNumberId: string, payload: Record<string, unknown>) => {
    const res = await http.post<{
      contacts?: { wa_id?: string }[];
      messages?: { id?: string }[];
    }>(`https://graph.facebook.com/${version()}/${phoneNumberId}/messages`, payload, {
      headers: { authorization: `Bearer ${token()}` },
    });

    const wamid = res.messages?.[0]?.id;
    // Meta uses a 200 with no message id for some partial failures. A caller
    // that stores this id to correlate a later reply (see the relay workflow)
    // must not be handed an empty string and left to find out downstream.
    if (!wamid) throw new Error("WhatsApp accepted the request but returned no message id");
    return { wamid, waId: res.contacts?.[0]?.wa_id };
  };

  return {
    template({ to, name, language = "ms", params, document, phoneNumberId }) {
      const components: Record<string, unknown>[] = [];

      if (document) {
        components.push({
          type: "header",
          parameters: [{ type: "document", document }],
        });
      }
      if (params?.length) {
        components.push({
          type: "body",
          parameters: params.map((p) => ({ type: "text", text: sanitise(p) })),
        });
      }

      return send(from(phoneNumberId), {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalise(to),
        type: "template",
        template: {
          name,
          language: { code: language },
          ...(components.length ? { components } : {}),
        },
      });
    },

    text(to, body, opts = {}) {
      return send(from(opts.phoneNumberId), {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalise(to),
        type: "text",
        text: { body, preview_url: opts.previewUrl ?? false },
      });
    },
  };
}

/** Meta wants digits. A pasted `+60 12-345 6789` is the same number. */
function normalise(to: string): string {
  const digits = to.replace(/[^\d]/g, "");
  if (!digits) throw new Error(`"${to}" is not a usable WhatsApp number`);
  return digits;
}

/**
 * Meta rejects a template parameter that is empty, or that contains a newline,
 * a tab, or more than four consecutive spaces — error 132000, and the whole
 * send fails rather than the one placeholder rendering oddly.
 *
 * That makes flattening a value the *sender's* job, not the caller's. Doing it
 * per call site is how the n8n graph this replaces ended up with the same
 * address field newline-stripped in three workflows and raw in a fourth, which
 * is one edited spreadsheet cell away from an undeliverable notification.
 *
 * An empty value becomes `"-"` for the same reason: there is no way to send
 * "nothing" for a placeholder, so every caller would otherwise need its own
 * `?? "-"`, and the one that forgot would fail at send time on live data.
 */
function sanitise(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const flat = String(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim();
  return flat === "" ? "-" : flat;
}
