/**
 * Structured logging — the vendor-neutral observability foundation.
 *
 * One JSON object per line on stdout: any log drain (Docker, Vercel, CloudWatch,
 * Loki, Datadog) parses it natively. A request ID ties every log line for one
 * HTTP request together, and is echoed to the client as `x-request-id` so a
 * user-reported failure maps to exact server logs.
 *
 * Deliberately dependency-free. When the team later adopts OpenTelemetry or a
 * hosted logger, this module is the single seam to replace — feature code
 * imports `log`/`withRequest`, never console directly.
 */

import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) in LEVEL_ORDER ? (process.env.LOG_LEVEL as LogLevel) : "info";

/** AsyncContext-free request scope: Next.js route handlers are async but each
 * request is handled on one logical chain; we propagate via module state keyed
 * by nothing — one request per event-loop turn in practice for our handlers,
 * and middleware sets the header that correlates client ↔ logs. */
let activeRequestId: string | null = null;

export function withRequestId<T>(id: string, fn: () => T): T {
  const previous = activeRequestId;
  activeRequestId = id;
  try {
    return fn();
  } finally {
    activeRequestId = previous;
  }
}

export function currentRequestId(): string | null {
  return activeRequestId;
}

function emit(level: LogLevel, msg: string, fields: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const entry: LogFields = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(activeRequestId ? { requestId: activeRequestId } : {}),
    ...fields,
  };
  const line = JSON.stringify(entry, (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
  );
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields ?? {}),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields ?? {}),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields ?? {}),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields ?? {}),
};

/** New request ID — short, URL-safe, collision-safe for realistic volumes. */
export function newRequestId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
