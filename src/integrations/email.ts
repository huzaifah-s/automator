import nodemailer, { type Transporter } from "nodemailer";

export interface EmailClient {
  send(msg: {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    from?: string;
    cc?: string | string[];
    replyTo?: string;
    attachments?: { filename: string; content: string | Buffer; contentType?: string }[];
  }): Promise<{ messageId: string }>;
}

let transport: Transporter | undefined;

/**
 * Plain SMTP — works with Gmail app passwords, Resend, Postmark, SES, or any
 * provider that speaks SMTP, without a vendor-specific SDK.
 */
function getTransport(): Transporter {
  if (transport) return transport;

  const host = process.env.SMTP_HOST;
  if (!host) throw new Error("SMTP_HOST is not set");

  const port = Number(process.env.SMTP_PORT ?? 587);
  transport = nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS; 587 upgrades via STARTTLS.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transport;
}

export function createEmail(): EmailClient {
  return {
    async send(msg) {
      const from = msg.from ?? process.env.SMTP_FROM ?? process.env.SMTP_USER;
      if (!from) throw new Error("No `from` given and neither SMTP_FROM nor SMTP_USER is set");

      const info = await getTransport().sendMail({ ...msg, from });
      return { messageId: info.messageId };
    },
  };
}
