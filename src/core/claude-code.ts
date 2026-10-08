import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./logger.ts";
import { holdBack, isPractice } from "./practice.ts";

/**
 * Claude Code, run headless (`claude -p`) on his subscription — the one way
 * this server asks a model anything. Live Maria
 * (workflows/personal-assistant/_live.ts) runs it with the assistant's tools;
 * `askClaude` runs it with none, for a workflow or the endpoint that needs a
 * model to read something and say one thing back (learn-style, the draft
 * check in src/server/mcp-assistant.ts).
 *
 * Signed in with an OAuth token from `claude setup-token`
 * (`CLAUDE_CODE_OAUTH_TOKEN`, then `CLAUDE_CODE_OAUTH_TOKEN_2`), or — on a
 * developer's machine only — the CLI's own login with
 * `ASSISTANT_LIVE_LOGIN=1`. The CLI gets an empty home and an environment of
 * a handful of variables, **never this process's own**, which holds every
 * secret the server has.
 */

/** Every answer is Opus: he would rather wait seconds for one that checked (8 Oct). */
export const CLAUDE_MODEL = "claude-opus-5-5";
/** The CLI, installed in the image (Dockerfile). */
const CLAUDE = process.env.CLAUDE_CODE_BIN ?? "claude";

/** What one run of the CLI came back with. Text only on success. */
export interface ClaudeRun {
  why: "slow" | "failed" | "empty" | null;
  text: string;
  turns: number;
  tokens: number;
  /** Tool names it called, in order — never their arguments. */
  used: string[];
}

/** What a caller of the CLI needs from its run: somewhere to log, and a way to stop. */
export interface ClaudeCaller {
  log: Pick<Logger, "info" | "warn">;
  signal: AbortSignal;
}

/** ASSISTANT_LIVE_LOGIN=1: the CLI's own login, for a developer's machine. Never set it on the server. */
export const claudeOwnLogin = (): boolean => process.env.ASSISTANT_LIVE_LOGIN === "1";

/** An empty home for the CLI under the temp dir, readable by this user only. */
export function claudeHome(name: string): string {
  const home = join(tmpdir(), name);
  mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
  return home;
}

/**
 * The CLI's whole environment: a handful of variables, never this
 * process's own, which holds every secret the server has.
 */
function claudeEnv(home: string, oauthToken: string, ownLogin: boolean): Record<string, string> {
  return {
    ...(ownLogin
      ? // A Mac keeps the login in the keychain, which needs who the user is.
        Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR"].map((k) => [k, process.env[k] ?? ""]))
      : {
          PATH: process.env.PATH ?? "",
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        }),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** One run of the CLI on one account: `-p`, the prompt on stdin, stream-json out. */
export async function runClaude(
  ctx: ClaudeCaller,
  o: { home: string; args: string[]; prompt: string; oauthToken: string; ownLogin: boolean; deadline: number; who: string },
): Promise<ClaudeRun> {
  const run: ClaudeRun = { why: null, text: "", turns: 0, tokens: 0, used: [] };
  let timedOut = false;
  try {
    const proc = Bun.spawn([CLAUDE, ...o.args], {
      cwd: o.home,
      env: claudeEnv(o.home, o.oauthToken, o.ownLogin),
      stdin: new Blob([o.prompt]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const kill = () => proc.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.deadline);
    ctx.signal.addEventListener("abort", kill, { once: true });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", kill);

    // One JSON object per line: assistant turns (for the tool names) and,
    // last, the result.
    let result: { subtype?: string; is_error?: boolean; result?: string; num_turns?: number; usage?: Record<string, number> } | null = null;
    for (const raw of out.split("\n")) {
      if (!raw.startsWith("{")) continue;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? []) {
          if (b?.type === "tool_use") run.used.push(String(b.name).replace(/^mcp__assistant__/, ""));
        }
      } else if (msg.type === "result") result = msg;
    }
    if (result) {
      const u = result.usage ?? {};
      run.tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      run.turns = result.num_turns ?? 0;
    }
    if (timedOut) run.why = "slow";
    else if (!result || result.is_error || result.subtype !== "success") {
      run.why = "failed";
      // The CLI's own words ("Not logged in", a usage limit), or its exit — never the prompt.
      const said = result?.is_error ? String(result.result ?? "").slice(0, 120) : `exit ${proc.exitCode}`;
      ctx.log.warn(`${o.who} could not answer: ${result?.subtype ?? "no result"} — ${said}`);
    } else {
      run.text = String(result.result ?? "").trim();
      if (!run.text) run.why = "empty";
    }
  } catch (err) {
    ctx.log.warn(`${o.who} could not start Claude Code: ${String((err as Error)?.message).slice(0, 160)}`);
    run.why = "failed";
  }
  return run;
}

/**
 * One question to Claude with no tools at all — no MCP server, no shell.
 * Same account order as live Maria: the next is tried when one fails, which
 * is always safe here because nothing can have been done. Null when there
 * is no token, in a practice run, or on failure.
 */
export async function askClaude(
  ctx: ClaudeCaller,
  oauthTokens: readonly string[],
  q: { who: string; system: string; prompt: string; model?: string; effort?: "low" | "medium" | "high"; deadlineMs?: number },
): Promise<{ text: string; tokens: number } | null> {
  const ownLogin = claudeOwnLogin();
  const accounts = ownLogin ? [""] : oauthTokens.filter(Boolean);
  if (accounts.length === 0) return null;
  const model = q.model ?? CLAUDE_MODEL;
  if (isPractice()) {
    holdBack({ method: "SPAWN", url: `${CLAUDE} -p (${q.who}, ${model})`, body: { tools: 0 }, why: "starts Claude Code" });
    return null;
  }
  const home = claudeHome("maria-ask");
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--effort", q.effort ?? "low",
    "--system-prompt", q.system,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "project",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
  ];
  const started = Date.now();
  let tokens = 0;
  for (let i = 0; i < accounts.length; i++) {
    const left = (q.deadlineMs ?? 90_000) - (Date.now() - started);
    if (left < 15_000) break;
    const run = await runClaude(ctx, { home, args, prompt: q.prompt, oauthToken: accounts[i]!, ownLogin, deadline: left, who: `${q.who} (account ${i + 1})` });
    tokens += run.tokens;
    if (!run.why) return { text: run.text, tokens };
    if (run.why !== "failed") break;
  }
  return null;
}

/** A spawn the practice gate would hold, for a caller that runs the CLI itself (live Maria). */
export function holdClaudeSpawn(who: string, model: string, tools: number): void {
  holdBack({ method: "SPAWN", url: `${CLAUDE} -p (${who}, ${model})`, body: { tools }, why: "starts Claude Code, which acts through the assistant's tools" });
}
