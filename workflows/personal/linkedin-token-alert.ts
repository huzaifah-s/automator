import { cron, defineCredential, defineWorkflow } from "../../src/core/define.ts";

/**
 * Personal — LinkedIn token expiry reminder.
 *
 * The LinkedIn token behind `linkedin-poster` lives 60 days and cannot be
 * refreshed (self-serve apps get no refresh token), so the only fix is a
 * person regenerating it. This asks LinkedIn every morning when the token
 * expires and sends a Telegram nudge 7, 3 and 1 day(s) before, and every day
 * once it is dead — so the reminder arrives before a post fails, not after.
 *
 * Needs the optional Client ID and Client secret on the linkedin credential;
 * without them LinkedIn will not say when the token expires, and this logs
 * that and does nothing.
 */

const linkedin = defineCredential("linkedin", "huzaifah");
const telegram = defineCredential("telegram", "the-mantra");

const REMIND_AT_DAYS = new Set([7, 3, 1]);
const GENERATOR = "https://www.linkedin.com/developers/tools/oauth/token-generator";

export default defineWorkflow({
  name: "linkedin-token-alert",
  description: "Telegram nudge before the LinkedIn posting token expires",
  trigger: cron("0 9 * * *", { tz: "Asia/Kuala_Lumpur" }),
  retries: 2,
  timeoutMs: 60_000,

  async run(ctx) {
    const token = linkedin.access_token;
    const clientId = linkedin.client_id;
    const clientSecret = linkedin.client_secret;
    if (!token) return { checked: false, reason: "no token" };
    if (!clientId || !clientSecret) {
      ctx.log.warn("linkedin credential has no Client ID / secret — cannot ask when the token expires");
      return { checked: false, reason: "no client id/secret" };
    }

    const info = await ctx.step("introspect", async () => {
      const res = await ctx.http.post<{ active?: boolean; expires_at?: number }>(
        "https://www.linkedin.com/oauth/v2/introspectToken",
        new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token }),
        { headers: { "content-type": "application/x-www-form-urlencoded" }, private: true },
      );
      // Only the two fields that matter leave this step, so nothing about the
      // token is checkpointed.
      return { active: res?.active === true, expiresAt: res?.expires_at ?? null };
    });

    const daysLeft =
      info.expiresAt === null ? null : Math.floor((info.expiresAt * 1000 - Date.now()) / 86_400_000);
    const dead = !info.active || (daysLeft !== null && daysLeft < 0);

    if (!dead && (daysLeft === null || !REMIND_AT_DAYS.has(daysLeft))) {
      return { active: info.active, daysLeft, reminded: false };
    }

    const headline = dead
      ? "\u{1F534} <b>LinkedIn token is dead</b> — posts will fail until it is replaced."
      : `\u{23F3} <b>LinkedIn token expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}</b>`;

    await ctx.step("remind", () =>
      ctx.telegram.send(
        [
          headline,
          "",
          `1. ${GENERATOR}`,
          "2. Pick the app, tick openid, profile, w_member_social, generate",
          "3. Automator › Credentials › linkedin › huzaifah › paste into Access token",
        ].join("\n"),
        {
          token: telegram.token,
          chatId: process.env.TELEGRAM_CHAT_ID_HUZAIFAH ?? telegram.chat_id,
          parseMode: "HTML",
        },
      ),
    );

    return { active: info.active, daysLeft, reminded: true };
  },
});
