import type { Ctx } from "../../src/core/define.ts";

/**
 * Starts the assistant's Claude routine now, instead of at the top of the
 * next hour — when you comment on a draft, send the bot a note, or somebody
 * whose chat is `always` writes to you.
 *
 * Configured by two values, and quietly off without either: the routine's
 * fire URL as the variable `ASSISTANT_ROUTINE_FIRE_URL`, and its token as the
 * secret `ASSISTANT_ROUTINE_TOKEN` — both shown once when you add an API
 * trigger to the routine at claude.ai/code/routines. The token is read with
 * `optionalSecret` in the calling workflow and passed in, so that file's
 * import registers it with the redactor.
 *
 * **At most one fire every two minutes.** A routine takes 30 fires an hour,
 * a fire is a whole session, and two sessions working the same drafts at
 * once is how one reply gets drafted twice. A comment made while a run is
 * still going is picked up by that run or the next one — the fire is a
 * shortcut, never the only way work gets done; the hourly schedule is.
 *
 * Not retried: there is no idempotency key, so a retry after a lost reply is
 * a second session.
 */

const COOLDOWN_MS = 2 * 60_000;
const FIRED_AT = "personal-assistant:fired-at";

export async function fireAssistant(
  ctx: Pick<Ctx, "http" | "state" | "log">,
  token: string,
  reason: string,
): Promise<"fired" | "not configured" | "cooling down" | "failed"> {
  const url = process.env.ASSISTANT_ROUTINE_FIRE_URL;
  if (!url || !token) return "not configured";

  const last = await ctx.state.shared.get<number>(FIRED_AT);
  if (last !== undefined && Date.now() - last < COOLDOWN_MS) return "cooling down";
  await ctx.state.shared.set(FIRED_AT, Date.now(), { ttlSeconds: 600 });

  try {
    await ctx.http.post(
      url,
      // The reason, never message text: it becomes the opening of a session
      // whose log is kept on claude.ai.
      { text: reason },
      {
        headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
        retries: 0,
      },
    );
    return "fired";
  } catch (err) {
    // The hourly run will get to it; a fire that did not happen is a delay,
    // not a failure of whatever asked for it.
    ctx.log.warn(`Could not start the assistant early: ${String((err as Error)?.message).slice(0, 160)}`);
    return "failed";
  }
}
