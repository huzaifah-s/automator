import type {
  PollCtx,
  Trigger,
  WebhookRegistration,
  WebhookVerifier,
  WorkflowDef,
} from "./types.ts";
import type { ZodType } from "zod";

/**
 * The only thing a workflow file has to export (as default).
 * Identity at runtime — it exists to pin down the types.
 */
export function defineWorkflow<Input = unknown>(
  def: WorkflowDef<Input>,
): WorkflowDef<Input> {
  if (!def.name?.trim()) throw new Error("Workflow is missing a name");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(def.name)) {
    throw new Error(
      `Workflow name "${def.name}" must be lowercase letters, digits, and dashes`,
    );
  }
  return def;
}

/** cron("0 9 * * *", { tz: "Asia/Kuala_Lumpur" }) — every day at 09:00. */
export function cron(expression: string, opts: { tz?: string } = {}): Trigger {
  return { kind: "cron", expression, tz: opts.tz ?? process.env.TZ };
}

/** webhook("stripe") mounts POST /hooks/stripe. */
export function webhook(
  path: string,
  opts: {
    method?: "GET" | "POST";
    schema?: ZodType;
    respond?: "async" | "sync";
    /** `false` opts out of the secret check — see types.ts. */
    secret?: string | false;
    /** Authenticates from the raw request instead of a shared secret. */
    verify?: WebhookVerifier;
    /** Creates and deletes the subscription at the provider — see README. */
    register?: WebhookRegistration;
  } = {},
): Trigger {
  return { kind: "webhook", path: path.replace(/^\/+/, ""), ...opts };
}

/**
 * poll("0 * * * *", { fetch, id }) — checks on a schedule and starts a run
 * only for the items it has never seen. Nothing new means no run at all.
 *
 *   trigger: poll("0 * * * *", {
 *     fetch: (ctx) => ctx.http.get("https://api.example.com/issues"),
 *     id: (issue) => issue.id,
 *   })
 *
 * ctx.input is the array of new items. Annotate the workflow to type it:
 * defineWorkflow<Issue[]>({ ... }).
 */
export function poll<T>(
  expression: string,
  opts: {
    fetch(ctx: PollCtx): Promise<T[]>;
    /** Stable identity per item. Defaults to a hash of the whole item. */
    id?(item: T): string | number;
    tz?: string;
    /** How many recent ids to remember. Default 500. */
    remember?: number;
    /** First ever poll: "skip" (default) baselines without running. */
    firstRun?: "skip" | "emit";
    /** Ceiling on fetch() itself. Default 60_000. */
    timeoutMs?: number;
  },
): Trigger {
  if (typeof opts?.fetch !== "function") {
    throw new Error("poll() needs a fetch function returning an array of items");
  }
  return {
    kind: "poll",
    expression,
    tz: opts.tz ?? process.env.TZ,
    fetch: opts.fetch as (ctx: PollCtx) => Promise<unknown[]>,
    id: opts.id as ((item: any) => string | number) | undefined,
    remember: opts.remember,
    firstRun: opts.firstRun,
    timeoutMs: opts.timeoutMs,
  };
}

/** Only ever runs when you press the button or use the CLI. */
export function manual(): Trigger {
  return { kind: "manual" };
}

export { defineSecrets, defineSecretGroup, optionalSecret } from "./secrets.ts";
export { defineCredential } from "./credentials.ts";
export type { CredentialValues } from "./credentials.ts";
export type { ProviderId } from "./providers.ts";
export {
  hmacSignature,
  isNotionHandshake,
  notionSignature,
  tallySignature,
  telegramSecretToken,
} from "./verify.ts";
/**
 * Scrubs known credentials out of a value. Everything a workflow writes to
 * SQLite or stdout is redacted already; this is for the one thing that isn't —
 * text a workflow composes and sends *out*, like a provider's error message
 * relayed into a Telegram alert.
 */
export { redact } from "./redact.ts";
export type { WebhookVerifier } from "./types.ts";
export { defineOAuth } from "../integrations/oauth.ts";
export type {
  Ctx,
  PollCtx,
  RegisterCtx,
  WebhookRegistration,
  WorkflowDef,
} from "./types.ts";
export type { StateClient, StateStore, StateSetOptions } from "./state.ts";
export type { OAuthConfig, OAuthCredential, TokenStatus } from "../integrations/oauth.ts";
export type {
  HttpOptions,
  PaginateOptions,
  Paged,
  PageInfo,
  NextPage,
} from "../integrations/http.ts";
