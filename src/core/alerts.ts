import { log } from "./logger.ts";

/**
 * Optional dead-simple failure notification: set ALERT_WEBHOOK_URL to a Slack
 * or Discord incoming webhook and every exhausted workflow posts to it.
 * Deliberately fire-and-forget — a broken alert channel must never fail a run.
 */
const url = process.env.ALERT_WEBHOOK_URL;
const baseUrl = process.env.PUBLIC_URL?.replace(/\/+$/, "");

export async function alertFailure(
  workflow: string,
  runId: string,
  error: Error,
): Promise<void> {
  if (!url) return;

  const link = baseUrl ? `\n${baseUrl}/runs/${runId}` : `\nrun ${runId}`;
  const text = `:rotating_light: *${workflow}* failed\n\`${error.message}\`${link}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // "text" is what both Slack and Discord incoming webhooks read.
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn(`Alert webhook returned ${res.status}`);
  } catch (err) {
    log.warn("Alert webhook failed", { error: String(err) });
  }
}
