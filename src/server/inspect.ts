/**
 * Decisions the HTTP routes and the MCP tools both have to make, in one place
 * so they cannot drift. Nothing here writes; each function answers a question
 * about the current registry and store.
 *
 * This module exists because there are now three callers for each of these —
 * the HTML dashboard, the JSON API, and `mcp.ts` — and a third copy of "why a
 * replay is refused" is exactly how one of them quietly starts lying.
 */

import { store } from "../core/db.ts";
import { isTruncated } from "../core/capture.ts";
import { credentialReady } from "../core/credentials.ts";
import type { Registry } from "../core/loader.ts";
import type { LoadedWorkflow, RunRecord } from "../core/types.ts";

export type ReplayPlan =
  | { run: RunRecord; wf: LoadedWorkflow; input: unknown }
  | { error: string; code: 404 | 409 };

/**
 * Everything that can stop a replay, decided in one place so the HTML, JSON
 * and MCP routes can't drift. Each refusal names its cause: a replay that
 * quietly substituted `{}` for a missing input would look like it worked.
 */
export function planReplay(registry: Registry, id: string): ReplayPlan {
  const run = store.getRun(id);
  if (!run) return { error: "Unknown run", code: 404 };

  const wf = registry.get(run.workflow);
  if (!wf) return { error: `Workflow "${run.workflow}" no longer exists`, code: 409 };

  if (!run.input) {
    return {
      error:
        "This run has no recorded input — it predates the input column, or " +
        "CAPTURE_DATA was off when it ran.",
      code: 409,
    };
  }
  if (isTruncated(run.input)) {
    return {
      error:
        "This run's input was too large to record whole (CAPTURE_MAX_BYTES), " +
        "so replaying it would feed the workflow a truncated payload.",
      code: 409,
    };
  }

  try {
    return { run, wf, input: JSON.parse(run.input) };
  } catch {
    return { error: "This run's recorded input is not readable back", code: 409 };
  }
}

/**
 * Which workflows cannot run because a credential they declared has not been
 * connected, keyed by name. Computed per call rather than cached: connecting
 * one on the Credentials tab has to clear the badge without a restart.
 */
export function workflowsBlockedBy(registry: Registry): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const w of registry.all()) {
    const missing = (w.credentials ?? []).filter((ref) => {
      const [provider, id] = ref.split(":");
      return !credentialReady(provider!, id!);
    });
    if (missing.length > 0) out.set(w.name, missing);
  }
  return out;
}
