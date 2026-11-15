/**
 * Pilot readiness.
 *
 *   npm run pilot:readiness          # human checklist, exit 1 when blocked
 *   npm run pilot:readiness -- --json
 *
 * Answers one question: can this instance take a real firm's client data this
 * week? Blockers are conditions a pilot cannot start with (no paid entitlement,
 * mail printing to a log, a failed restore, RLS requested but unwired). Warnings
 * are conditions to state out loud in the pilot agreement.
 *
 * This is NOT a coverage score — see docs/capability-scorecard.md for that.
 */

import "dotenv/config";

import { assessPilot } from "../lib/server/pilot-readiness";
import { collectPilotSnapshot } from "../lib/server/pilot-snapshot";

async function main(): Promise<number> {
  const snapshot = await collectPilotSnapshot();
  const assessment = assessPilot(snapshot);

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ snapshot, assessment }, null, 2)}\n`);
    return assessment.verdict === "blocked" ? 1 : 0;
  }

  const marker: Record<string, string> = {
    blocker: "BLOCK",
    warning: "WARN ",
    info: "NOTE ",
    ok: "OK   ",
  };

  for (const check of assessment.checks) {
    process.stdout.write(`[${marker[check.level]}] ${check.id}: ${check.summary}\n`);
    if (check.remedy) process.stdout.write(`        fix: ${check.remedy}\n`);
  }

  process.stdout.write(
    `\n${assessment.verdict === "ready" ? "Pilot can start" : "Pilot BLOCKED"} — ` +
      `${assessment.blockers.length} blocker(s), ${assessment.warnings.length} warning(s).\n`,
  );
  if (assessment.nextActions.length > 0) {
    process.stdout.write("\nNext actions (in order):\n");
    assessment.nextActions.forEach((action, index) => {
      process.stdout.write(`  ${index + 1}. ${action}\n`);
    });
  }
  return assessment.verdict === "blocked" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`pilot-readiness: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
