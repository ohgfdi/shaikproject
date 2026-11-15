/**
 * Deterministic government-portal simulator.
 *
 * Speaks the same response envelope as the live transports (GstnIrpGateway /
 * ItdEfilingGateway) so the entire submission lifecycle — prepare → transmit →
 * ack/IRN capture → campaign filed — is exercised offline and in tests without a
 * portal. Everything is deterministic:
 *
 *   - the IRN is the GSTN-formula reference hash of the canonical payload
 *   - acknowledgement numbers and dates derive from the payload digest
 *   - the SAME once-token always returns the SAME receipt (idempotent store)
 *
 * Honesty: receipts are labelled provider:"simulation" and the portal message
 * states plainly that no government portal was contacted.
 */

import { PortalRejectionError } from "./errors";
import { canonicalJson, irnReference, sha256Hex } from "./signing";
import type {
  FilingChannel,
  FilingGateway,
  FilingGatewayHealth,
  FilingReceipt,
  FilingStatus,
  FilingSubmissionRequest,
  GatewayAvailability,
  ProviderKind,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function deterministicAckDt(digest: string): string {
  const dayOffset = (parseInt(digest.slice(0, 8), 16) || 0) % 28;
  return new Date(Date.UTC(2026, 9, 1 + dayOffset, 9, 30, 0)).toISOString();
}

function simulationReceipt(request: FilingSubmissionRequest): { receipt: FilingReceipt; status: FilingStatus } {
  const canonical = canonicalJson(request.payload);
  const digest = sha256Hex(canonical);
  const irn = irnReference(canonical);
  const ackDt = deterministicAckDt(digest);

  if (request.channel === "irp-irn") {
    return {
      status: "filed",
      receipt: {
        provider: "simulation",
        channel: "irp-irn",
        status: "filed",
        token: request.token,
        reference: irn,
        irn,
        ackNumber: `NAPR${digest.slice(0, 12).toUpperCase()}`,
        ackDate: ackDt,
        portalMessage: `Simulation only — no GSTN IRP was contacted. Deterministic IRN and acknowledgement generated for the payload digest ${digest.slice(0, 16)}.`,
        submittedAt: new Date().toISOString(),
        digest,
        httpStatus: 200,
      },
    };
  }

  const ackNumber = `ITR-${request.ay ?? "20XX-XX"}-${digest.slice(0, 8).toUpperCase()}`;
  return {
    status: "filed",
    receipt: {
      provider: "simulation",
      channel: request.channel,
      status: "filed",
      token: request.token,
      reference: ackNumber,
      irn: null,
      ackNumber,
      ackDate: ackDt,
      portalMessage: `Simulation only — no income-tax portal was contacted. Deterministic acknowledgement generated for the payload digest ${digest.slice(0, 16)}.`,
      submittedAt: new Date().toISOString(),
      digest,
      httpStatus: 200,
    },
  };
}

export class FilingSimulator implements FilingGateway {
  readonly provider: ProviderKind = "simulation";
  private readonly store = new Map<string, FilingReceipt>();

  /**
   * Test-only escape hatch: a payload containing simulateRejection:true is
   * rejected by the simulator so suites can exercise the rejection path
   * without a portal.
   */
  async submit(request: FilingSubmissionRequest): Promise<FilingReceipt> {
    const previous = this.store.get(request.token);
    if (previous) return previous;

    const record = asRecord(request.payload);
    if (!record) {
      throw new PortalRejectionError("Simulator rejected the submission: payload must be a JSON object.", {
        provider: "simulation",
        channel: request.channel,
        onceToken: request.token,
        portalErrorCode: "SIM_PAYLOAD_NOT_OBJECT",
      });
    }
    if (record["simulateRejection"] === true) {
      throw new PortalRejectionError("Simulator rejected the submission: simulateRejection was set on the payload.", {
        provider: "simulation",
        channel: request.channel,
        onceToken: request.token,
        portalErrorCode: "SIM_TEST_REJECTION",
      });
    }

    const { receipt } = simulationReceipt(request);
    this.store.set(request.token, receipt);
    return receipt;
  }

  async status(request: FilingSubmissionRequest): Promise<FilingReceipt> {
    const stored = this.store.get(request.token);
    if (stored) return stored;
    const { receipt } = simulationReceipt(request);
    return { ...receipt, status: "accepted-pending" as const };
  }

  health(): FilingGatewayHealth | null {
    const availability: GatewayAvailability = { configured: true, provider: "simulation", missing: [] };
    return {
      provider: "simulation",
      channels: { "irp-irn": availability, "efiling-return": availability, "efiling-audit": availability },
      liveEligible: false,
      activeChannel: "irp-irn",
    };
  }
}

/**
 * Legacy deterministic provider: arrives at the local reference IRN (GSTN
 * formula) and stops. No network, no claim of transmission — this is exactly
 * what gst-portal-integration.ts documented before a production swap. Kept as
 * the default so an unconfigured deployment stays safe and predictable.
 */
export class ReferenceFilingGateway implements FilingGateway {
  readonly provider: ProviderKind = "reference";

  async submit(request: FilingSubmissionRequest): Promise<FilingReceipt> {
    const canonical = canonicalJson(request.payload);
    const digest = sha256Hex(canonical);
    const irn = irnReference(canonical);
    return {
      provider: "reference",
      channel: request.channel,
      status: "filed",
      token: request.token,
      reference: irn,
      irn,
      ackNumber: null,
      ackDate: null,
      portalMessage:
        "Reference IRN generated locally from the GSTN formula — nothing was transmitted. Set FILING_GATEWAY=simulation (offline) or =live with full credentials (see docs/gst-portal-execution.md) to actually file.",
      submittedAt: new Date().toISOString(),
      digest,
      httpStatus: null,
    };
  }

  health(): FilingGatewayHealth | null {
    const unavailable: GatewayAvailability = { configured: false, provider: "reference", missing: [] };
    return {
      provider: "reference",
      channels: { "irp-irn": unavailable, "efiling-return": unavailable, "efiling-audit": unavailable },
      liveEligible: false,
      activeChannel: "irp-irn",
    };
  }
}

export type { FilingChannel };
