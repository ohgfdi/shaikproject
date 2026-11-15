/**
 * Standalone job worker.
 *
 *   npm run worker
 *
 * Run this as its own process (one or more replicas) with the SAME
 * DATABASE_URL as the web app, and set JOB_WORKER_ENABLED=false on the web
 * replicas. That separation is what stops one firm's bulk filing burst from
 * starving another firm's scheduled reports.
 *
 * The process keeps itself alive with a heartbeat: the worker's own drain
 * interval is unref'd, so without a referenced timer Node would exit.
 */

import "dotenv/config";

import { prisma } from "../lib/db";
import { startJobWorker } from "../lib/server/job-worker";
import { startMailOutboxWorker } from "../lib/server/mail-outbox";
import { maybeStartScheduler } from "../lib/server/scheduler";

const HEARTBEAT_MS = 60_000;

process.stdout.write(
  [
    "[worker] starting standalone job worker",
    `[worker] database: ${(process.env.DATABASE_URL ?? "").split("@").pop() ?? "unset"}`,
    `[worker] scheduler: ${process.env.SCHEDULER_ENABLED === "true" ? "on" : "off"}`,
    "",
  ].join("\n"),
);

startJobWorker();
startMailOutboxWorker();
maybeStartScheduler();

const heartbeat = setInterval(() => {
  process.stdout.write(`[worker] alive at ${new Date().toISOString()}\n`);
}, HEARTBEAT_MS);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`[worker] ${signal} received — disconnecting\n`);
  clearInterval(heartbeat);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
