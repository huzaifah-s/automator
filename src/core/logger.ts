import { store } from "./db.ts";
import { redact } from "./redact.ts";

export type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

const COLOR: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

/** Writes to stdout and, when a run is in scope, into the run's log table. */
export function createLogger(scope: string, runId?: string): Logger {
  const emit = (level: Level, msg: string, data?: unknown) => {
    if (LEVELS[level] < threshold) return;

    const safeMsg = redact(msg);
    const safeData = data === undefined ? undefined : redact(data);

    const tag = `[${scope}]`;
    const head = useColor ? `${COLOR[level]}${level.padEnd(5)}${RESET}` : level.padEnd(5);
    const tail = safeData === undefined ? "" : ` ${inline(safeData)}`;
    console.log(`${new Date().toISOString()} ${head} ${tag} ${safeMsg}${tail}`);

    if (runId) store.log(runId, level, safeMsg, safeData);
  };

  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  };
}

function inline(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    const s = JSON.stringify(data);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(data);
  }
}

export const log = createLogger("automator");
