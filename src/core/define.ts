import type { Trigger, WorkflowDef } from "./types.ts";
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
    secret?: string;
  } = {},
): Trigger {
  return { kind: "webhook", path: path.replace(/^\/+/, ""), ...opts };
}

/** Only ever runs when you press the button or use the CLI. */
export function manual(): Trigger {
  return { kind: "manual" };
}

export { defineSecrets, defineSecretGroup, optionalSecret } from "./secrets.ts";
export type { Ctx, WorkflowDef } from "./types.ts";
export type { StateClient, StateStore, StateSetOptions } from "./state.ts";
