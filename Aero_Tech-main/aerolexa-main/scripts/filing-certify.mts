/**
 * Certify ONE filing attempt.
 *
 *   npm run filing:certify -- --file proof.json [--digest sha256]
 *   npm run filing:certify -- --run <complianceFilingRunId>
 *
 * This is the operational companion to `filing:conformance`: conformance asks
 * "is this deployment wired for live filing", while certify asks "did the
 * attempt I just made produce evidence I can defend". Exit codes:
 *
 *   0  the attempt is proven (live receipt + ack/IRN + digest recomputes)
 *   1  attempted, but not proven (offline receipt, failed check, missing ack)
 *   2  cannot be proven from this host (gateway is simulation / not configured)
 *
 * A single attempt can never certify a deployment — the verdict says "pilot"
 * even when every check passes. Deployment certification still needs
 * reconciliation against the portal.
 */

import "dotenv/config";

import { readFileSync } from "node:fs";
import path from "node:path";

import { filingGatewayHealth, filingGatewayPreflight } from "../lib/engine/filing/gateway";
import { certifyFilingAttempt } from "../lib/server/filing-certify";

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function readProofFile(file: string): unknown {
  const resolved = path.resolve(process.cwd(), file);
  try {
    return JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Could not read proof bundle ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readStoredProof(runId: string): Promise<{ proof: unknown; digest: string | null }> {
  // Imported lazily: --file mode must work without a database connection.
  const { prisma } = await import("../lib/db");
  const run = await prisma.complianceFilingRun.findUnique({
    where: { id: runId },
    select: { proofBundle: true, proofDigest: true, title: true },
  });
  if (!run) throw new Error(`No filing run with id ${runId}.`);
  if (!run.proofBundle) {
    throw new Error(`Run ${runId} (${run.title}) has no proof bundle yet — submit it to the portal first.`);
  }
  return { proof: run.proofBundle, digest: run.proofDigest };
}

async function main(): Promise<number> {
  const file = argValue("--file");
  const runId = argValue("--run");
  const digestArg = argValue("--digest");

  if (!file && !runId) {
    throw new Error("Usage: npm run filing:certify -- --file proof.json [--digest sha256] | --run <runId>");
  }

  const { proof, digest } = file
    ? { proof: readProofFile(file), digest: digestArg }
    : await readStoredProof(runId as string);

  const health = filingGatewayHealth();
  const preflight = health.liveEligible ? await filingGatewayPreflight() : null;
  const result = certifyFilingAttempt({
    health,
    preflight,
    proof,
    ...(digest ? { bundleDigest: digest } : {}),
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`filing certify: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
