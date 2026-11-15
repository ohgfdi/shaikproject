"use client";

import { useEffect } from "react";

import { api } from "@/lib/client/api";

/**
 * Client error reporting (Phase 5.2).
 *
 * Captures uncaught errors and unhandled promise rejections and ships them to
 * `/api/errors`, where they are redacted, fingerprinted and de-duplicated
 * locally (see lib/server/error-tracking.ts). Self-hosted on purpose: a hosted
 * tracker would receive every stack frame and every URL, and for this app the
 * URL is an access capability.
 *
 * Design constraints:
 *  - **Never throws.** A reporter that crashes while reporting a crash turns a
 *    page error into a white screen.
 *  - **Never loops.** If the POST itself fails, the failure is swallowed, and
 *    `seen` guards against a reporter error re-entering the reporter.
 *  - **Samples.** Reporting every `console.error` would be noise; only genuine
 *    uncaught errors and rejections are captured.
 *  - **Session-scoped dedupe.** The same error from the same page is only sent
 *    once per session, so a render loop cannot flood the endpoint.
 */

const seen = new Set<string>();

/** Bound the dedupe set so a long session cannot grow it without limit. */
function markSeen(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > 100) seen.delete(seen.values().next().value as string);
  return true;
}

/** Path without its query string — the URL can carry a share token. */
function safePath(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname;
}

async function report(name: string, message: string, stack: string): Promise<void> {
  try {
    const key = `${name}:${message}`.slice(0, 200);
    if (!markSeen(key)) return;
    await api("/api/errors", {
      method: "POST",
      body: JSON.stringify({
        name: name.slice(0, 200),
        message: message.slice(0, 2_000),
        stack: (stack || "").slice(0, 20_000),
        path: safePath(),
      }),
    });
  } catch {
    // Reporting must never escalate. If the endpoint is down or the user is
    // signed out, the error is simply not reported.
  }
}

export function ErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const err = event.error;
      void report(err?.name ?? "Error", err?.message ?? event.message ?? "Uncaught error", err?.stack ?? "");
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      void report(
        (reason && typeof reason === "object" && "name" in reason
          ? String(reason.name)
          : "UnhandledRejection") as string,
        (reason && typeof reason === "object" && "message" in reason ? String(reason.message) : String(reason)).slice(
          0,
          2_000,
        ),
        (reason && typeof reason === "object" && "stack" in reason ? String(reason.stack) : "") ?? "",
      );
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
