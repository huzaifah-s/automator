import { fieldKey } from "./credentials.ts";
import { log } from "./logger.ts";
import { redact, registerSecret } from "./redact.ts";
import { secretValue } from "./secret-store.ts";
import { createState } from "./state.ts";
import type { WorkflowAlerts } from "./types.ts";

/**
 * Out-of-band notification for problems the *runner* notices — a run that
 * exhausted its retries, a run refused because a credential is not connected,
 * a workflow that would not load, a webhook being turned away at the door.
 *
 * This is deliberately not the same thing as a workflow messaging you from
 * inside its own flow. That is `ctx.telegram.send(...)`, it is part of what the
 * workflow does, and it only happens when the workflow is working. These fire
 * when it isn't.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. Nothing here may throw out. A broken alert channel must never fail a
 *      run, block a boot, or turn a rejected webhook into a 500. Every path
 *      ends in a log line.
 *   2. Everything sent is redacted first. This is one of the few places the
 *      runner composes text and sends it *out* — an error message can easily
 *      carry the URL that produced it, and Telegram puts its bot token in the
 *      URL.
 */

/* ------------------------------------------------------------- the channel */

export type AlertChannel =
  | { kind: "telegram"; credential: string | null; chatId: string | null }
  | { kind: "slack"; credential: string | null; channel: string }
  | { kind: "discord"; credential: string | null }
  | { kind: "webhook"; url: string };

/** Anything an alert can be attributed to. `LoadedWorkflow` satisfies it. */
export interface AlertTarget {
  name: string;
  alerts?: WorkflowAlerts;
}

/**
 * Parses `ALERT_CHANNEL` (or a workflow's own override) into a destination.
 *
 * The grammar is `<platform>` or `<platform>:<credential>[/<where>]`:
 *
 *   telegram                    the primary Telegram credential, its own chat
 *   telegram:the-mantra         that credential, the chat id it carries
 *   telegram:the-mantra/-100…   that credential, a specific chat
 *   slack:ops/#alerts           that credential's bot token, that channel
 *   slack:/#alerts              the primary Slack token, that channel
 *   discord:ops                 that credential's incoming webhook
 *   webhook:https://…           any Slack- or Discord-shaped incoming webhook
 *
 * Naming a credential means *only* that credential is consulted — a named
 * Telegram credential with no chat id is an error rather than a quiet fall back
 * to TELEGRAM_CHAT_ID, because the failure mode of guessing is alerts arriving
 * in somebody else's chat.
 *
 * Returns the reason as a string when the spec is unusable. Callers decide what
 * that is worth: a typo in a workflow file stops the boot, a typo in the
 * environment is a warning and no alerts.
 */
export function parseAlertChannel(spec: string): AlertChannel | string {
  const trimmed = spec.trim();
  if (trimmed === "") return `an alert channel cannot be empty`;

  const colon = trimmed.indexOf(":");
  const platform = (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
  const target = colon === -1 ? "" : trimmed.slice(colon + 1);

  // The URL is the whole target, and it contains both ":" and "/".
  if (platform === "webhook") {
    if (!/^https?:\/\//.test(target)) {
      return `webhook alerts need a full URL, got "${target}"`;
    }
    return { kind: "webhook", url: target };
  }

  const slash = target.indexOf("/");
  const credential = (slash === -1 ? target : target.slice(0, slash)) || null;
  const where = slash === -1 ? "" : target.slice(slash + 1);

  if (credential !== null && !/^[a-z0-9][a-z0-9-]*$/.test(credential)) {
    return `"${credential}" is not a credential name (lowercase letters, digits, dashes)`;
  }

  switch (platform) {
    case "telegram":
      return { kind: "telegram", credential, chatId: where || null };
    case "slack":
      if (!where) return `slack alerts need a channel, e.g. slack:${credential ?? ""}/#alerts`;
      return { kind: "slack", credential, channel: where };
    case "discord":
      return { kind: "discord", credential };
    default:
      return (
        `unknown alert platform "${platform}" — ` +
        `use telegram, slack, discord, or webhook:<url>`
      );
  }
}

/**
 * The default destination, read once. A bad value is a warning and no alerts
 * rather than a dead boot: an alerting mistake must not be the thing that stops
 * the runner from running.
 */
const configured: AlertChannel | null = (() => {
  const spec = process.env.ALERT_CHANNEL?.trim();
  if (spec) {
    const parsed = parseAlertChannel(spec);
    if (typeof parsed === "string") {
      log.warn(`ALERT_CHANNEL is ignored — ${parsed}`);
      return null;
    }
    return parsed;
  }
  // The knob this replaced. Still honoured so an existing deployment keeps
  // alerting across the upgrade without an env change.
  const legacy = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!legacy) return null;
  const parsed = parseAlertChannel(`webhook:${legacy}`);
  if (typeof parsed === "string") {
    log.warn(`ALERT_WEBHOOK_URL is ignored — ${parsed}`);
    return null;
  }
  return parsed;
})();

// An incoming webhook URL *is* the credential — anyone holding it can post as
// you. Every other channel authenticates with a stored credential the redactor
// already knows about; this one arrives as a bare env var, so say so here.
if (configured?.kind === "webhook") registerSecret(configured.url);

/** One line for the boot log, or null when nothing is configured. */
export function describeAlertChannel(): string | null {
  return configured && describe(configured);
}

function describe(channel: AlertChannel): string {
  switch (channel.kind) {
    case "telegram":
      return (
        `Telegram (${channel.credential ?? "primary credential"}` +
        `${channel.chatId ? `, chat ${channel.chatId}` : ""})`
      );
    case "slack":
      return `Slack ${channel.channel} (${channel.credential ?? "primary credential"})`;
    case "discord":
      return `Discord (${channel.credential ?? "primary credential"})`;
    case "webhook":
      // Never the URL: it is a credential, and this line goes to stdout.
      return `incoming webhook at ${new URL(channel.url).host}`;
  }
}

/**
 * Which channel an alert about this workflow goes to. `alerts: false` opts out
 * entirely; an object may name a different destination — one server pings
 * several brands, and a pblsh failure belongs in the pblsh chat.
 */
function channelFor(wf: AlertTarget | undefined): AlertChannel | null {
  const cfg = wf?.alerts;
  if (cfg === false) return null;
  if (typeof cfg === "object" && cfg.channel) {
    const parsed = parseAlertChannel(cfg.channel);
    // Unreachable through defineWorkflow(), which refuses a bad spec at import.
    if (typeof parsed === "string") {
      log.warn(`${wf?.name}: alert channel ignored — ${parsed}`);
      return null;
    }
    return parsed;
  }
  return configured;
}

/* ----------------------------------------------------------- the throttle */

/**
 * How long the same problem stays quiet after it has been reported once. A cron
 * that runs every five minutes and fails every time is one alert and a count,
 * not twelve messages an hour. 0 sends everything.
 */
const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS ?? 1_800_000);

interface Throttle {
  sentAt: number;
  /** Repeats swallowed since `sentAt`, reported with the next one that goes out. */
  suppressed: number;
}

/**
 * The counters live in the shared state namespace under a reserved prefix, like
 * "@poll:" and "@webhook:", so a restart-looping process cannot re-send the
 * same boot failure on every restart.
 *
 * The key is hashed rather than stored: it is built from a workflow name and an
 * error message, state is the one thing not redacted on the way to disk, and a
 * counter row has no reason to hold text at all.
 */
const throttleState = createState("@shared");

/** Decides whether this alert goes out, and how many it speaks for. */
async function claim(key: string): Promise<{ send: boolean; suppressed: number } | null> {
  if (COOLDOWN_MS <= 0) return { send: true, suppressed: 0 };

  const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 32);
  let send = false;
  let suppressed = 0;

  try {
    // update() runs its callback synchronously, which is the only reason two
    // concurrent failures cannot both decide they are the one that sends.
    await throttleState.update<Throttle>(
      `@alert:${hash}`,
      (current) => {
        const now = Date.now();
        if (!current || now - current.sentAt >= COOLDOWN_MS) {
          send = true;
          suppressed = current?.suppressed ?? 0;
          return { sentAt: now, suppressed: 0 };
        }
        return { sentAt: current.sentAt, suppressed: current.suppressed + 1 };
      },
      // Long enough that a slow repeat is still recognised as a repeat, short
      // enough that a problem fixed months ago does not sit in the table.
      { ttlSeconds: Math.ceil((COOLDOWN_MS / 1_000) * 4) },
    );
  } catch (err) {
    // A throttle that cannot read its own state must not swallow the alert.
    log.warn(`Alert throttle failed, sending anyway: ${String(err)}`);
    return { send: true, suppressed: 0 };
  }

  return { send, suppressed };
}

/* -------------------------------------------------------------- the alerts */

interface Alert {
  /** Groups repeats. Same problem, same key. */
  key: string;
  icon: string;
  title: string;
  workflow?: string;
  detail?: string | null;
  runId?: string;
}

const baseUrl = () => process.env.PUBLIC_URL?.replace(/\/+$/, "");

/** Long enough to be useful, short enough that a stack trace cannot flood a chat. */
const DETAIL_MAX = 1_000;

async function send(wf: AlertTarget | undefined, alert: Alert): Promise<void> {
  const channel = channelFor(wf);
  if (!channel) return;

  const claimed = await claim(`${channel.kind}|${alert.key}`);
  if (!claimed?.send) return;

  const lines = [`${alert.icon} ${alert.workflow ? `${alert.workflow}: ` : ""}${alert.title}`];
  if (alert.detail) lines.push(alert.detail.slice(0, DETAIL_MAX));
  if (claimed.suppressed > 0) {
    lines.push(`(${claimed.suppressed} more since the last alert about this)`);
  }
  const base = baseUrl();
  if (alert.runId) lines.push(base ? `${base}/runs/${alert.runId}` : `run ${alert.runId}`);
  else if (base) lines.push(base);

  // The one place the runner composes text and sends it somewhere it cannot
  // take back. Redact before it leaves the process, not after.
  const text = redact(lines.join("\n"));

  try {
    await deliver(channel, text);
  } catch (err) {
    // Note that the throttle has already been stamped: a channel that is down
    // costs this alert, not the next thirty minutes of retries against it.
    log.warn(`Alert to ${describe(channel)} failed: ${redact(String(err))}`);
  }
}

/** A run that used up every attempt. Includes a poll whose fetch() threw. */
export function alertFailure(wf: AlertTarget, runId: string, error: Error): Promise<void> {
  return send(wf, {
    key: `failure|${wf.name}|${error.message}`,
    icon: "🚨",
    title: "failed",
    workflow: wf.name,
    detail: error.message,
    runId,
  });
}

/** A run refused at the door because a credential it declares is not connected. */
export function alertBlocked(wf: AlertTarget, runId: string, message: string): Promise<void> {
  return send(wf, {
    key: `blocked|${wf.name}|${message}`,
    icon: "🔌",
    title: "could not run",
    workflow: wf.name,
    detail: message,
    runId,
  });
}

/**
 * A webhook delivery turned away before any run existed. Fire-and-forget: the
 * caller is mid-request and its 401 does not wait on a chat message.
 */
export function alertRejection(
  wf: AlertTarget,
  path: string,
  reason: string,
  detail?: string | null,
): void {
  void send(wf, {
    key: `rejected|${wf.name}|${path}|${reason}`,
    icon: "⛔",
    title: `rejected a delivery to /hooks/${path} — ${reason}`,
    workflow: wf.name,
    detail,
  });
}

/**
 * Something went wrong bringing the runner up: a workflow that would not load,
 * a credential nothing can run without, a webhook subscription that failed to
 * register. `wf` is present when the problem belongs to one workflow, so its
 * own opt-out and channel still apply.
 */
export function alertBoot(
  title: string,
  detail?: string | null,
  wf?: AlertTarget,
): Promise<void> {
  return send(wf, {
    key: `boot|${wf?.name ?? "-"}|${title}|${detail ?? ""}`,
    icon: "⚠️",
    title,
    workflow: wf?.name,
    detail,
  });
}

/* ------------------------------------------------------------- delivery */

const DELIVER_TIMEOUT_MS = 10_000;

async function deliver(channel: AlertChannel, text: string): Promise<void> {
  switch (channel.kind) {
    case "telegram": {
      const token = credentialField(channel.credential, "telegram", "token", "TELEGRAM_BOT_TOKEN");
      const chatId =
        channel.chatId ??
        credentialField(channel.credential, "telegram", "chat_id", "TELEGRAM_CHAT_ID");
      // Plain text on purpose: an error message is arbitrary, and one stray
      // underscore in a Markdown payload is a 400 from Telegram instead of an
      // alert.
      await post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
      });
      return;
    }
    case "slack": {
      const token = credentialField(channel.credential, "slack", "token", "SLACK_BOT_TOKEN");
      const res = await post(
        "https://slack.com/api/chat.postMessage",
        { channel: channel.channel, text },
        { authorization: `Bearer ${token}` },
      );
      // Slack answers 200 with ok:false for a dead token.
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!body.ok) throw new Error(`Slack refused the message — ${body.error ?? "unknown"}`);
      return;
    }
    case "discord": {
      const url = credentialField(
        channel.credential,
        "discord",
        "webhook_url",
        "DISCORD_WEBHOOK_URL",
      );
      await post(url, { content: text });
      return;
    }
    case "webhook":
      // "text" is what Slack reads, "content" is what Discord reads. Sending
      // both is what let one URL work for either, and still does.
      await post(channel.url, { text, content: text });
      return;
  }
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

/**
 * One field of the credential the channel names, or the environment when it
 * names none. A named credential is never topped up from the environment: the
 * point of naming it is that this is the bot that sends, and the chat that
 * receives.
 */
function credentialField(
  credential: string | null,
  provider: string,
  field: string,
  envName: string,
): string {
  const value = credential
    ? secretValue(fieldKey(provider, credential, field))
    : process.env[envName];
  if (!value) {
    throw new Error(
      credential
        ? `credential ${provider}:${credential} has no ${field} — connect it on the Credentials tab`
        : `${envName} is not set, and no ${provider} credential is marked primary`,
    );
  }
  return value;
}
