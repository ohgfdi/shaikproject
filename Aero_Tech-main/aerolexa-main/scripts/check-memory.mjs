#!/usr/bin/env node
/**
 * Memory guard for constrained CI runners (e.g., 8 GB / 2 vCPU boxes).
 * Fails fast with a clear message instead of letting next build get OOM-killed
 * mid-compile with a silent SIGTERM / BUILD_EXIT=1.
 *
 * Usage: node scripts/check-memory.mjs  (called from npm run build)
 *
 * Threshold: allows building only if free memory >= 2 GB.
 * Rationale: next build + prisma generate + bundle budgets needs ~4-5 GB headroom
 * on top of the OS + other processes. If free memory is below 2 GB, we abort early.
 */

import { totalmem, freemem } from "node:os";
import { exit } from "node:process";

// Threshold in bytes: 2 GiB
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

// Read free memory from OS
const total = totalmem();
const free = freemem();

// Convert to GB for the output message
const freeGB = Math.round(free / 1024 / 1024 / 1024);
const totalGB = Math.round(total / 1024 / 1024 / 1024);

if (free < MIN_FREE_BYTES) {
  console.error(`❌ Memory guard: Not enough free memory (${freeGB} GB free / ${totalGB} GB total).`);
  console.error(`   Required: at least 2 GB free for next build + prisma + bundle budgets.`);
  console.error(`   Tip: increase swap, add more RAM, or reduce concurrent processes.`);
  console.error(`   Current free: ${freeGB} GB, total: ${totalGB} GB`);
  exit(1);
} else {
  console.log(`✅ Memory guard: ${freeGB} GB free / ${totalGB} GB total — sufficient for build.`);
  exit(0);
}
