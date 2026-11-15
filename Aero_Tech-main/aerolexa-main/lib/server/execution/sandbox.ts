/**
 * Execution sandbox configuration — pure validation (no database).
 *
 * Every notebook/SQL run in Ledgerly executes in-process with explicit
 * resource bounds. This module validates those bounds before a run starts so
 * a misconfigured cell can never claim more than the workspace allows:
 *
 *   validateSandboxConfig(config) — throws with a specific message when a
 *     limit is out of range; fills defaults for omitted fields.
 *   hasSandboxTimedOut(startedAt, timeoutMs, now) — wall-clock deadline check.
 *
 * Bounds (mirroring the ExecutionSandbox defaults):
 *   memory  64 MB – 8 GB (default 512 MB)
 *   cpu     1 – 4 cores in ms/sec (default 100 ms/sec = 1 core)
 *   timeout 1 s – 1 h (default 5 min)
 *
 * When container/VM sandboxing lands, the registry (createSandbox / kill /
 * cleanup) should be re-added against real infrastructure — the validation
 * below is the contract every sandbox type must satisfy.
 */

import { ApiError } from "@/lib/auth/guard";

export interface SandboxConfig {
  organizationId: string;
  sandboxType: "container" | "process" | "vm";
  memoryLimitBytes?: number;
  cpuLimitMs?: number;
  wallClockTimeoutMs?: number;
}

const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024; // 512 MB
const MIN_MEMORY_BYTES = 64 * 1024 * 1024; // 64 MB
const MAX_MEMORY_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB
const DEFAULT_CPU_MS = 100; // 1 core (100 ms per second)
const MAX_CPU_MS = 400; // 4 cores
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MIN_TIMEOUT_MS = 1000; // 1 second
const MAX_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export interface ValidatedSandboxConfig extends Required<Omit<SandboxConfig, "organizationId" | "sandboxType">> {
  organizationId: string;
  sandboxType: SandboxConfig["sandboxType"];
}

/**
 * Validate a sandbox config against the resource bounds. Throws Error with a
 * specific message when a limit is out of range; fills defaults for omitted
 * fields. Returns the normalized config.
 */
export function validateSandboxConfig(config: SandboxConfig): ValidatedSandboxConfig {
  if (!config.organizationId) {
    throw new ApiError(
      400,
      "SANDBOX_CONFIG",
      "The execution sandbox requires an organizationId. What happened: the workspace context is missing. How to fix: ensure the request includes a valid workspace identifier.",
    );
  }

  const memoryLimitBytes = config.memoryLimitBytes ?? DEFAULT_MEMORY_BYTES;
  if (memoryLimitBytes > MAX_MEMORY_BYTES) {
    throw new ApiError(
      400,
      "SANDBOX_CONFIG",
      `Memory limit ${Math.round(memoryLimitBytes / 1024 / 1024)}MB exceeds the maximum of 8GB. What happened: the requested memory exceeds workspace limits. How to fix: reduce the memory limit to 8GB or less.`,
    );
  }
  if (memoryLimitBytes < MIN_MEMORY_BYTES) {
    throw new ApiError(
      400,
      "SANDBOX_CONFIG",
      `Memory limit ${Math.round(memoryLimitBytes / 1024 / 1024)}MB is below the minimum of 64MB. What happened: the requested memory is too low for execution. How to fix: increase the memory limit to at least 64MB.`,
    );
  }

  const cpuLimitMs = config.cpuLimitMs ?? DEFAULT_CPU_MS;
  if (cpuLimitMs > MAX_CPU_MS) {
    throw new ApiError(
      400,
      "SANDBOX_CONFIG",
      `CPU limit ${cpuLimitMs}ms/sec exceeds the maximum of 400ms/sec (4 cores). What happened: the requested CPU allocation exceeds workspace limits. How to fix: reduce the CPU limit to 400ms/sec or less.`,
    );
  }
  if (cpuLimitMs < 1) {
    throw new ApiError(
      400,
      "SANDBOX_CONFIG",
      `CPU limit ${cpuLimitMs}ms/sec is below the minimum of 100ms/sec (1 core). What happened: the requested CPU allocation is too low for execution. How to fix: increase the CPU limit to at least 100ms/sec.`,
    );
  }

  const wallClockTimeoutMs = config.wallClockTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (wallClockTimeoutMs > MAX_TIMEOUT_MS) {
    throw new ApiError(
      400,
      "SANDBOX_CONFIG",
      `Timeout ${Math.round(wallClockTimeoutMs / 1000)}s exceeds the maximum of 3600s (1 hour). What happened: the requested timeout exceeds workspace limits. How to fix: reduce the timeout to 1 hour or less.`,
    );
  }
  if (wallClockTimeoutMs < MIN_TIMEOUT_MS) {
    throw new ApiError(
      400,
      "SANDBOX_CONFIG",
      `Timeout ${Math.round(wallClockTimeoutMs / 1000)}s is below the minimum of 1s. What happened: the requested timeout is too short for execution. How to fix: increase the timeout to at least 1 second.`,
    );
  }

  return {
    organizationId: config.organizationId,
    sandboxType: config.sandboxType,
    memoryLimitBytes,
    cpuLimitMs,
    wallClockTimeoutMs,
  };
}

/** True when `now` is past the sandbox's wall-clock deadline. */
export function hasSandboxTimedOut(startedAt: Date, timeoutMs: number, now: Date = new Date()): boolean {
  return now.getTime() - startedAt.getTime() > timeoutMs;
}
