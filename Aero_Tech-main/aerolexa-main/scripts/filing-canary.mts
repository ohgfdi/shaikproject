/**
 * Filing canary rehearsal.
 *
 *   npm run filing:canary -- --payload filing.json
 *   npm run filing:canary -- --payload filing.json --submit
 *
 * Produces one JSON evidence file with:
 *   - gateway/channel readiness and signing readiness,
 *   - the shadow plan (payload digest, blockers),
 *   - the live credential preflight when the gateway is live,
 *   - the portal receipt only when `--submit` was explicitly requested.
 *
 * Safety rules:
 *   - no submission by default;
 *   - a live submission additionally requires `--confirm-live` AND
 *     `CANARY_ALLOW_LIVE=true`, so a stray flag in CI cannot file a real return;
 *   - exit 0 means evidence was produced (even if blockers were found),
 *     exit 1 means a requested submission failed, exit 2 means refused.
 *
 * Nothing is written to the database. This runner is for the operator and CI,
 * not for a filing run's audit trail (which `submitFilingRun` owns).
 */

import "dotenv/config";

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  filingChannel,
  filingGatewayHealth,
  filingGatewayPreflight,
  resolveFilingGateway,
} from "../lib/engine/filing/gateway";
import { buildFilingShadowPlan } from "../lib/engine/filing/shadow";
import { filingSigningReadiness } from "../lib/engine/filing/signing-service";

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function loadPayload(file: string | null): unknown {
  if (!file) throw new Error("--payload <file.json> is required.");
  const resolved = path.resolve(process.cwd(), file);
  try {
    return JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Could not read ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<number> {
  const payload = loadPayload(arg("--payload"));
  const wantsSubmit = process.argv.includes("--submit");
  const confirmLive = process.argv.includes("--confirm-live");
  const provider = filingGatewayHealth().provider;
  const live = provider === "live";

  if (wantsSubmit && live && (!confirmLive || process.env.CANARY_ALLOW_LIVE !== "true")) {
    process.stderr.write(
      "Refusing a live submission: pass --confirm-live and set CANARY_ALLOW_LIVE=true. " +
        "Use the rehearsal without --submit first and have a reconciled acknowledgement plan.\n",
    );
    return 2;
  }

  const health = filingGatewayHealth();
  const channel = filingChannel();
  const availability = health.channels[channel];
  const signing = filingSigningReadiness();
  const token = `canary-${randomUUID()}`;

  const plan = buildFilingShadowPlan({
    channel,
    provider,
    payload,
    token,
    providerConfigured: Boolean(availability?.configured),
    missingCredentials: availability?.missing ?? [],
    signingRequired: channel === "efiling-audit",
    signingConfigured: signing.configured,
  });

  const preflight = live ? await filingGatewayPreflight() : null;
  if (live && preflight && !preflight.ok) {
    process.stderr.write(`Live credential preflight failed: ${preflight.detail}\n`);
  }

  let receipt = null;
  if (wantsSubmit) {
    receipt = await resolveFilingGateway().submit({ channel, payload, token });
  }

  const evidence = {
    format: "ledgerly.filing-canary",
    version: 1,
    generatedAt: new Date().toISOString(),
    channel,
    provider,
    signing,
    plan,
    preflight,
    receipt,
    operator: {
      submitted: wantsSubmit,
      liveSubmission: wantsSubmit && live,
      confirmLive: live ? confirmLive : false,
      allowLiveEnv: process.env.CANARY_ALLOW_LIVE === "true",
    },
    notes: [
      "A shadow plan is not portal validation.",
      "No database row was created; this file is operator/CI evidence, not a filing run.",
      plan.blockers.length > 0
        ? "Blockers are listed in plan.blockers and must be fixed before a live canary."
        : "The plan has no blocking items.",
    ],
  };

  const out = arg("--out") ?? path.join("verification", `filing-canary-${Date.now()}.json`);
  mkdirSync(path.dirname(path.resolve(process.cwd(), out)), { recursive: true });
  writeFileSync(path.resolve(process.cwd(), out), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({ ok: true, out, plan: plan.summary, receipt: receipt?.status ?? null }, null, 2)}\n`);

  if (!wantsSubmit) return 0;
  const accepted = receipt?.status === "filed" && Boolean(receipt.ackNumber || receipt.irn);
  return accepted ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`filing canary: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
