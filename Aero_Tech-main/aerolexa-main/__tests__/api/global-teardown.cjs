const { existsSync, readFileSync, rmSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const scratch = path.join(root, "data", "api-test");

// Only tear down if the server was booted (pid file exists).
module.exports = async function globalTeardown() {
  // Do not tear down a server owned by a *different* Jest process. Two
  // concurrent runs share data/api-test, and the unit-suite run must not kill
  // the API run's server (or delete its scratch dir) just because a pid file
  // from that run is present.
  if (process.env.__LEDGERLY_API_SERVER_BOOTED !== "1") {
    console.log("[api] This run did not boot the API server — skipping teardown.");
    return;
  }
  const pidFile = path.join(scratch, "server.pid");
  if (!existsSync(pidFile)) {
    console.log("[api] No server pid file found — skipping teardown (likely unit test suite).");
    return;
  }
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    // negative pid = whole process group (spawned detached in global-setup)
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  // Small grace period so the port frees before the next suite run.
  await new Promise((r) => setTimeout(r, 800));
  // Only clean api-test data if we bootstrapped it.
  if (existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
};
