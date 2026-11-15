/**
 * Filing conformance runner.
 *
 * This is the operator's repeatable proof that the filing path is wired
 * correctly — not a claim that a portal was contacted. It has three modes:
 *
 *   npm run filing:conformance                 # readiness + credential preflight
 *   npm run filing:conformance -- --sign file  # sign a payload with the DSC service
 *   npm run filing:conformance -- --submit file# preflight, then submit ONE payload
 *
 * Exit codes are meaningful for CI:
 *   0  the requested check passed
 *   1  the check failed (portal rejected, signature invalid, no ack returned)
 *   2  not configured / skipped (e.g. provider is simulation) — never green
 *
 * The runner deliberately does NOT write to the database and does NOT create a
 * filing run. Use it in the sandbox before the first pilot, and in CI with
 * FILING_GATEWAY=simulation to prove the envelope/exit-code contract.
 */

import "dotenv/config";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { filingGatewayHealth, filingGatewayPreflight, resolveFilingGateway } from "../lib/engine/filing/gateway";
import { signFilingPayload } from "../lib/engine/filing/signing";
import { filingSigningReadiness, resolveFilingSigner, resolveSigningAccount } from "../lib/engine/filing/signing-service";
import type { FilingChannel, FilingSubmissionRequest } from "../lib/engine/filing/types";

type Mode = "preflight" | "sign" | "submit";

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function mode(): Mode {
  if (process.argv.includes("--sign")) return "sign";
  if (process.argv.includes("--submit")) return "submit";
  return "preflight";
}

function channel(): FilingChannel {
  const raw = (process.env.FILING_CHANNEL || "irp-irn").trim();
  if (raw === "irp-irn" || raw === "efiling-return" || raw === "efiling-audit") return raw;
  throw new Error(`Unknown FILING_CHANNEL "${raw}" (expected irp-irn | efiling-return | efiling-audit).`);
}

function loadPayload(file: string | null): unknown {
  if (!file) throw new Error("--submit/--sign needs a JSON payload path.");
  const resolved = path.resolve(process.cwd(), file);
  try {
    return JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Could not read JSON payload ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function signOrExplain(payload: unknown) {
  const signer = resolveFilingSigner();
  const account = resolveSigningAccount();
  if (!signer || !account) {
    const readiness = filingSigningReadiness();
    throw new Error(
      `DSC signing is not configured (missing: ${readiness.missing.join(", ") || "unknown"}). ` +
        "Set FILING_SIGNING_URL, FILING_SIGNING_TOKEN, FILING_SIGNING_USER and FILING_SIGNING_CERT_SERIAL.",
    );
  }
  return signFilingPayload(signer, account, payload);
}

async function main() {
  const selected = mode();
  const ch = channel();

  if (selected === "sign") {
    const payload = loadPayload(argValue("--sign"));
    const signature = await signOrExplain(payload);
    print({ ok: true, mode: "sign", channel: ch, signature });
    return 0;
  }

  if (selected === "submit") {
    const payload = loadPayload(argValue("--submit"));
    const health = filingGatewayHealth();
    if (!health.liveEligible) {
      // Simulation is allowed here: it proves the request/response contract
      // without contacting a portal, and the receipt says so explicitly.
      const receipt = await resolveFilingGateway().submit({
        channel: ch,
        payload,
        token: randomUUID(),
      } satisfies FilingSubmissionRequest);
      print({ ok: receipt.status === "filed", mode: "submit", provider: receipt.provider, receipt });
      return receipt.status === "filed" ? 0 : 1;
    }

    const preflight = await filingGatewayPreflight();
    if (!preflight.ok) {
      print({ ok: false, mode: "submit", stage: "preflight", preflight });
      return 1;
    }
    const signature = ch === "efiling-audit" ? await signOrExplain(payload) : undefined;
    const receipt = await resolveFilingGateway().submit({
      channel: ch,
      payload,
      token: randomUUID(),
      ...(signature ? { signature } : {}),
    } satisfies FilingSubmissionRequest);
    const accepted = receipt.status === "filed" && Boolean(receipt.ackNumber || receipt.irn);
    print({ ok: accepted, mode: "submit", stage: "submit", provider: receipt.provider, receipt });
    return accepted ? 0 : 1;
  }

  const health = filingGatewayHealth();
  const signing = filingSigningReadiness();
  if (!health.liveEligible) {
    print({
      ok: false,
      mode: "preflight",
      skipped: true,
      reason: `FILING_GATEWAY is "${health.provider}" — no live credential handshake is exercised. Set FILING_GATEWAY=live with real credentials to run the real preflight.`,
      health,
      signing,
    });
    return 2;
  }
  const preflight = await filingGatewayPreflight();
  print({ ok: preflight.ok, mode: "preflight", preflight, health, signing });
  return preflight.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // Fail readable: the operator needs the variable/portal message, not a stack.
    process.stderr.write(`filing conformance: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
