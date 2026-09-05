import {
  cron,
  defineCredential,
  defineOAuth,
  defineWorkflow,
  redact,
} from "../../src/core/define.ts";

/**
 * The Mantra — Threads — Token Auto-Refresh.
 *
 * Keeps the long-lived Threads token alive. A port of the n8n graph
 * "Threads — Token Auto-Refresh" (weekly schedule → data table get → Code →
 * IF → data table update / Telegram).
 *
 * The hazard this exists for: a Threads token that goes 60 days without a
 * refresh dies permanently. There is no recovery — only a full manual
 * re-auth, a new long-lived token with the `threads_delete` scope again.
 * Weekly runs leave roughly eight attempts of margin before that cliff, and
 * every failure alert says how many are actually left.
 *
 * The n8n version kept the token in a data table and refreshed it in a Code
 * node. Here it is an ordinary `defineOAuth` credential, which is a bigger
 * change than it sounds:
 *
 * 1. **The token is encrypted at rest and never reaches the run page.** The
 *    data table held it in the clear and the Code node passed it downstream as
 *    item data. Nothing in this file ever holds the token — `status()` returns
 *    dates, and `refresh()`'s return value is deliberately dropped.
 * 2. **Two runs cannot both spend it.** `defineOAuth` refreshes under a
 *    per-credential lock; two n8n executions overlapping would each read the
 *    same row and write over each other.
 * 3. **A failure is a failure.** The n8n Code node caught everything and
 *    returned `ok: false`, so the execution went green and only Telegram knew.
 *    Here the run goes red, retries, and `onFailure` sends the message.
 * 4. **Re-auth is a paste, not a schema.** When the token does die, pasting a
 *    new one into OAUTH_THREADS_HUZAIFAH_REFRESH_TOKEN changes the seed hash
 *    and the stored chain is abandoned on the next run — see oauth.ts.
 */

/**
 * The Threads token. `flow: "self"` because Threads has no client secret and
 * no separate refresh token: you trade the token you hold for a
 * later-expiring copy of itself, and that copy is what you send next time.
 *
 * The seed lives under OAUTH_THREADS_HUZAIFAH_REFRESH_TOKEN — the env var,
 * or the secret store, which is the better home because it can be set before
 * this file is ever deployed:
 *
 *     bun run secret -- set OAUTH_THREADS_HUZAIFAH_REFRESH_TOKEN
 *
 * Set it *first*. Unlike the runway alert's credentials, a missing secret
 * aborts the boot rather than marking one workflow blocked.
 *
 * The name identifies the *account*, not the brand or the workflow, because
 * that is what a token belongs to: this is the Threads account the founder
 * content posts from, carried over from n8n's THREADS_TOKEN_HUZAIFAH_S. A
 * second account — a brand one, or another person's — gets its own credential
 * and its own seed, and the two never share a stored token. The workflow lives
 * under the-mantra/ because that is the content operation it serves; those two
 * facts are allowed to differ.
 */
const threads = defineOAuth("threads-huzaifah", {
  tokenUrl: "https://graph.threads.net/refresh_access_token",
  flow: "self",
  grantType: "th_refresh_token",
  // Threads always sends expires_in; this is only what to believe if it ever
  // stops. 3600 — the default — would make every report below claim the token
  // dies within the hour.
  defaultTtlSeconds: 60 * 24 * 60 * 60,
});

/**
 * The Mantra's own bot, so the alert arrives from the same place as the
 * content runway nudge rather than from whichever bot happens to be primary.
 * Only its token is read; the destination is TELEGRAM_CHAT_ID_HUZAIFAH.
 */
const telegram = defineCredential("telegram", "the-mantra");

const TZ = "Asia/Kuala_Lumpur";

/** Threads refuses to refresh a token younger than this. */
const MIN_AGE_HOURS = 24;

/** Attempts left before the cliff, at one run a week. */
const DAYS_PER_ATTEMPT = 7;

/* ------------------------------------------------------------------ dates */

interface Dates {
  /** ISO, for anything mechanical. */
  expiresAt: string;
  /** The KL calendar date, for the human reading the alert. */
  expiresOn: string;
  daysLeft: number;
}

function describe(expiresAt: Date): Dates {
  return {
    expiresAt: expiresAt.toISOString(),
    expiresOn: new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(expiresAt),
    daysLeft: Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000),
  };
}

function hoursSince(at: Date): number {
  return (Date.now() - at.getTime()) / 3_600_000;
}

/** Telegram's HTML mode. Only these three, and the error text is arbitrary. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------------------------------------------------------------- workflow */

interface Outcome extends Dates {
  refreshed: boolean;
}

export default defineWorkflow({
  name: "the-mantra-threads-token-auto-refresh",
  description: "Refreshes the long-lived Threads token before it can expire",
  // n8n's "every 7 days at hour 3". Pinned to KL so the server's zone, and a
  // move to another host, never shift it.
  trigger: cron("0 3 * * 1", { tz: TZ }),
  retries: 2,
  timeoutMs: 60_000,
  // A checkpoint that outlives the run is actively harmful here: resuming
  // this a day later from the dashboard would replay "already refreshed" and
  // skip the refresh the resume was asking for.
  checkpointTtlHours: 1,

  async run(ctx) {
    const outcome = await ctx.step<Outcome>("refresh the long-lived token", async () => {
      // Read inside the step, not before it. A retry re-runs this whole step,
      // so the age check below sees what the *previous attempt* stored — and
      // an attempt that reached Threads but lost the response on the way back
      // is then reported as the success it was, instead of failing on the
      // 24-hour rule and paging about a token that is perfectly healthy.
      const before = await threads.status();

      if (before?.refreshedAt && hoursSince(before.refreshedAt) < MIN_AGE_HOURS) {
        return { refreshed: false, ...describe(before.expiresAt) };
      }

      // The return value is a live credential and is dropped on purpose:
      // nothing in this workflow needs it, and a step result is checkpointed.
      await threads.refresh();

      const after = await threads.status();
      if (!after) {
        // refresh() resolved, so Threads accepted it — an empty store means
        // the write or the encryption failed, and the new token is simply
        // gone. Next week would start again from the seed, which by then is
        // a week closer to dying.
        throw new Error(
          "Threads accepted the refresh but nothing was stored — check OAUTH_ENCRYPTION_KEY",
        );
      }
      return { refreshed: true, ...describe(after.expiresAt) };
    });

    if (!outcome.refreshed) {
      ctx.log.info(
        `Token was refreshed less than ${MIN_AGE_HOURS}h ago — nothing to do`,
        { expiresOn: outcome.expiresOn, daysLeft: outcome.daysLeft },
      );
    } else {
      ctx.log.info(`Refreshed — the token now expires ${outcome.expiresOn}`, {
        daysLeft: outcome.daysLeft,
      });
    }

    // Silent on success, exactly like the n8n version: a weekly janitor that
    // pings every Monday stops being read by the third month.
    return outcome;
  },

  /**
   * Runs once, after every attempt has failed, and its own errors are logged
   * rather than thrown — which is why the alert lives here and not in a
   * try/catch around the step. A caught-and-rethrown failure would send this
   * message once per attempt.
   */
  async onFailure(ctx, error) {
    const status = await threads.status().catch(() => undefined);
    const dates = status ? describe(status.expiresAt) : undefined;

    const lines = [
      "\u{1F511} <b>Threads token refresh FAILED</b>",
      "",
      // The provider's own words, but redacted first: this text is composed
      // here and sent *out*, so it misses every redaction the runner does on
      // the way to disk — and for this flow the token travels in the URL.
      escapeHtml(redact(error.message)),
      "",
    ];

    // One array entry per line Telegram will actually show. Wrapping these in
    // the source instead would put the breaks in the middle of sentences.
    if (dates) {
      const attempts = Math.floor(dates.daysLeft / DAYS_PER_ATTEMPT);
      lines.push(
        `Stored token expires <b>${dates.expiresOn}</b> — ${dates.daysLeft} day(s) left, ` +
          `about ${attempts} more weekly attempt(s) before then.`,
        "",
        "Left unrefreshed past that date it dies permanently, and there is no " +
          "recovery — only a full manual re-auth: a new long-lived token, with the " +
          "<code>threads_delete</code> scope again, pasted into " +
          "<code>OAUTH_THREADS_HUZAIFAH_REFRESH_TOKEN</code>.",
      );
    } else {
      lines.push(
        "Nothing has been stored yet, so the token in " +
          "<code>OAUTH_THREADS_HUZAIFAH_REFRESH_TOKEN</code> is still the one in play, " +
          "expiring whenever it was originally issued to.",
        "",
        "A Threads token that goes 60 days without a refresh dies permanently, and " +
          "there is no recovery — only a full manual re-auth, with the " +
          "<code>threads_delete</code> scope again.",
      );
    }

    lines.push("", "Retrying next Monday.");

    await ctx.telegram.send(lines.join("\n"), {
      token: telegram.token,
      // Configuration rather than a secret, so it stays readable on the run
      // page. Shared with the runway alert and the pblsh workflow — all three
      // go to the same person. Unset, it falls back to the chat id on this
      // credential, never to another brand's default.
      chatId: process.env.TELEGRAM_CHAT_ID_HUZAIFAH ?? telegram.chat_id,
      parseMode: "HTML",
    });
  },
});
