import type { Ctx } from "../../src/core/define.ts";

/**
 * Starts the assistant's Claude routine now, instead of at the top of the
 * next hour — when you comment on a draft, send the bot a note, or somebody
 * whose chat is `always` writes to you.
 *
 * Configured by two values, and quietly off without either: the routine's
 * fire URL as the variable `ASSISTANT_ROUTINE_FIRE_URL`, and its token as the
 * secret `ASSISTANT_ROUTINE_TOKEN` — both shown once when you add an API
 * trigger to the routine at claude.ai/code/routines. The token is declared
 * with `defineSecrets` (optional) in the calling workflow and passed in, so it
 * is registered with the redactor and a new value is live on the next run.
 *
 * **At most one fire every two minutes.** A routine takes 30 fires an hour,
 * a fire is a whole session, and two sessions working the same drafts at
 * once is how one reply gets drafted twice. A fire asked for inside those
 * two minutes is not dropped but *owed*: its reason is kept, and
 * `firePending` — called every minute by `deliver-cards` — fires once for
 * everything owed as soon as the two minutes are up. Dropping it was how a
 * note sent while a session was already running waited up to an hour: that
 * session had read `questions` before the note arrived, and nothing started
 * another. The hourly schedule is still the mechanism; the fire is a
 * shortcut.
 *
 * Not retried: there is no idempotency key, so a retry after a lost reply is
 * a second session.
 */

const COOLDOWN_MS = 2 * 60_000;
const FIRED_AT = "personal-assistant:fired-at";
/** Reasons for fires asked for during the cooldown, not yet made. */
const OWED = "personal-assistant:fire-owed";
/** An owed fire older than this is left to the hourly run. */
const OWED_TTL_SECONDS = 30 * 60;

export async function fireAssistant(
  ctx: Pick<Ctx, "http" | "state" | "log">,
  token: string,
  reason: string,
): Promise<"fired" | "not configured" | "cooling down" | "failed"> {
  const url = process.env.ASSISTANT_ROUTINE_FIRE_URL;
  if (!url || !token) return "not configured";

  const last = await ctx.state.shared.get<number>(FIRED_AT);
  if (last !== undefined && Date.now() - last < COOLDOWN_MS) {
    const owed = (await ctx.state.shared.get<string[]>(OWED)) ?? [];
    if (!owed.includes(reason)) owed.push(reason);
    await ctx.state.shared.set(OWED, owed, { ttlSeconds: OWED_TTL_SECONDS });
    return "cooling down";
  }
  // Whatever was owed is covered by this session too.
  const owed = (await ctx.state.shared.get<string[]>(OWED)) ?? [];
  await ctx.state.shared.delete(OWED);
  return post(ctx, url, token, [...new Set([reason, ...owed])].join(" Also: "));
}

/**
 * Makes a fire that was asked for during the cooldown, once the cooldown is
 * over. "nothing owed" is the steady state.
 */
export async function firePending(
  ctx: Pick<Ctx, "http" | "state" | "log">,
  token: string,
): Promise<"fired" | "nothing owed" | "not configured" | "cooling down" | "failed"> {
  const url = process.env.ASSISTANT_ROUTINE_FIRE_URL;
  if (!url || !token) return "not configured";
  const owed = await ctx.state.shared.get<string[]>(OWED);
  if (!owed?.length) return "nothing owed";
  const last = await ctx.state.shared.get<number>(FIRED_AT);
  if (last !== undefined && Date.now() - last < COOLDOWN_MS) return "cooling down";
  await ctx.state.shared.delete(OWED);
  return post(ctx, url, token, owed.join(" Also: "));
}

async function post(
  ctx: Pick<Ctx, "http" | "state" | "log">,
  url: string,
  token: string,
  reason: string,
): Promise<"fired" | "failed"> {
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
