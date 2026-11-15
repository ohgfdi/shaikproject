/**
 * Next.js instrumentation entrypoint (runs once when the Node server boots).
 *
 * Starts the in-process scheduled-report poller when the scheduler module is
 * enabled (SCHEDULER_ENABLED=true, or the default pro deployment profile).
 * The import is dynamic so the scheduler code only loads on Node, never in the
 * Edge runtime, and `maybeStartScheduler` itself no-ops when the module is off.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Boot log: one structured line naming the storage driver + scheduler
    // state — the first thing to check when operating multiple replicas.
    const { logStorageConfig } = await import("@/lib/server/storage");
    logStorageConfig();
    const { maybeStartScheduler } = await import("@/lib/server/scheduler");
    maybeStartScheduler();

    // Boot-time row-level-security gate. A contradiction (RLS_ENABLED on a
    // database where the request is a no-op) refuses to boot instead of letting
    // the operator believe isolation is enforced. Production warnings are
    // printed once and stay visible in /api/health; they do not kill a working
    // instance.
    const { assertRlsBootFindings, rlsBootFindings } = await import("@/lib/server/rls-boot-gate");
    const rlsFindings = rlsBootFindings(process.env);
    for (const finding of rlsFindings) {
      const line = `[boot] ${finding.code}: ${finding.message} Remedy: ${finding.remedy}`;
      if (finding.level === "error") console.error(line);
      else console.warn(line);
    }
    assertRlsBootFindings(rlsFindings);

    // Durable job-queue worker (ROADMAP 5.4) when JOB_WORKER_ENABLED=true:
    // drains the JobQueue table with atomic claims, leases, exponential
    // backoff and crash recovery. Independent flag so deployments opt in.
    const { maybeStartJobWorker } = await import("@/lib/server/job-worker");
    maybeStartJobWorker();

    // Notification digest (ROADMAP 7.3) when DIGEST_ENABLED=true: bundles
    // each user's unread notifications into one periodic email. The in-app
    // bell stays the system of record; the digest is a convenience copy.
    const { maybeStartDigestScheduler } = await import("@/lib/server/notify-digest");
    maybeStartDigestScheduler();

    // Weekly partner digest when PARTNER_DIGEST_ENABLED=true: one email per
    // firm per week with deadlines, WIP, receivables and collected money. The
    // send date is persisted on the Organization, so restarts do not re-send.
    const { maybeStartPartnerDigestScheduler } = await import("@/lib/server/partner-digest");
    maybeStartPartnerDigestScheduler();

    // Graceful shutdown: release every shared subprocess on SIGTERM/SIGINT.
    // Guards: (a) installed once per process, not once per register() call —
    // dev re-runs register() on server restarts and handlers otherwise
    // accumulate; (b) silent when nothing was launched, so ordinary dev
    // Ctrl+C no longer prints a scary shutdown line; (c) each dispose is a
    // safe no-op when its singleton was never initialized.
    const { closeBrowser, isBrowserRunning } = await import("@/lib/export/pdf");
    const { disposeDuckDb } = await import("@/lib/engine/duckdb/server");
    const { disposeTrainingWorker } = await import("@/lib/engine/training-worker");
    // Guard lives on globalThis, not process.env: env properties in modern
    // Node are non-configurable (defineProperty throws), and globalThis
    // survives register() re-runs within one server process.
    const g = globalThis as { __LEXA_SHUTDOWN_HOOKS__?: boolean };
    if (!g.__LEXA_SHUTDOWN_HOOKS__) {
      g.__LEXA_SHUTDOWN_HOOKS__ = true;
      for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, async () => {
          // Disposals are always safe no-ops when their singleton never ran,
          // so they stay unconditional; only the log is conditional — it prints
          // once, exactly when there is a real subprocess to release.
          if (isBrowserRunning()) {
            console.log(`[shutdown] Signal ${sig} received — releasing export browser…`);
          }
          await Promise.allSettled([closeBrowser(), disposeDuckDb(), disposeTrainingWorker()]);
        });
      }
    }
  }
}
