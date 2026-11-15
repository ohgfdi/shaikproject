/**
 * Filing gateway contract — the stable seam between the app and India's
 * government portals (GSTN IRP for IRN generation, income-tax e-filing for
 * return/audit lodgement).
 *
 * Three providers implement this contract:
 *
 *   live       — real HTTPS round-trips to the portals (GstnIrpGateway /
 *                ItdEfilingGateway in irp.ts). Activates ONLY when every
 *                required credential is present; fails readable otherwise.
 *   simulation — deterministic in-process simulator (simulator.ts) that speaks
 *                the same response envelope, so the whole submission lifecycle
 *                is exercised offline and in tests without a portal.
 *   reference  — the legacy deterministic SHA-256 IRN-reference behaviour
 *                (gst-portal-integration.ts). No network, no fake claims.
 *
 * Every submission carries a once-token: portals dedupe on it, the app retries
 * with it, and resubmitting the same token returns the original receipt.
 */

import type { FilingSignatureEnvelope, SigningAccount, SigningService } from "./signing";

export type FilingChannel = "irp-irn" | "efiling-return" | "efiling-audit";

export type FilingStatus = "filed" | "accepted-pending" | "rejected" | "error";

export type ProviderKind = "live" | "simulation" | "reference";

export interface FilingSubmissionRequest {
  readonly channel: FilingChannel;
  /** Canonicalisable JSON document (GSTR-1 invoice map / ITR JSON). */
  readonly payload: unknown;
  /** Once-only token — idempotency across retries and duplicate calls. */
  readonly token: string;
  /** GSTIN of the taxpayer whose invoice is being IRN'd (irp-irn channel). */
  readonly gstin?: string;
  /** Assessment year, e.g. "2026-27" (efiling channel). */
  readonly ay?: string;
  /** IRP document type hint (INV/CHL/etc.) — informational. */
  readonly docType?: string;
  /** External DSC signing service; required for efiling-audit / dsc-signed keeps. */
  readonly signer?: SigningService;
  readonly signingAccount?: SigningAccount;
  /** Detached signature over the canonical payload (produced once, before submit). */
  readonly signature?: FilingSignatureEnvelope;
}

export interface FilingReceipt {
  readonly provider: ProviderKind;
  readonly channel: FilingChannel;
  readonly status: FilingStatus;
  readonly token: string;
  /** Gateway/payer reference. Corporate certificate serial on dsc-signed keeps. */
  readonly reference: string;
  /** GSTN-issued IRN (irp-irn channel). */
  readonly irn: string | null;
  /** Portal acknowledgement number. */
  readonly ackNumber: string | null;
  readonly ackDate: string | null;
  readonly portalMessage: string | null;
  readonly submittedAt: string;
  /** SHA-256 hex of the canonical payload — audit anchor for non-repudiation. */
  readonly digest: string;
  /** HTTP status when the portal was reached, else null. */
  readonly httpStatus: number | null;
}

export interface GatewayAvailability {
  readonly configured: boolean;
  readonly provider: ProviderKind | "n/a";
  readonly missing: readonly string[];
}

export interface FilingGatewayHealth {
  readonly provider: ProviderKind;
  readonly channels: Record<FilingChannel, GatewayAvailability>;
  readonly liveEligible: boolean;
  readonly activeChannel: FilingChannel | "none";
}

/**
 * Result of a credential preflight: a live-only probe that runs the portal's
 * auth handshake (and nothing else) so an operator can prove their credentials
 * work WITHOUT filing a real document.
 */
export interface FilingPreflightResult {
  readonly provider: ProviderKind;
  readonly channel: FilingChannel | "none";
  /** True when the credential handshake completed against the live portal. */
  readonly ok: boolean;
  /** What was checked, in operator language. */
  readonly detail: string;
  /** True when the configured endpoint is a sandbox host (no real filing). */
  readonly sandbox: boolean;
  readonly httpStatus: number | null;
  readonly checkedAt: string;
}

/** A ready-to-talk implementation of the FilingGateway contract. */
export interface FilingGateway {
  readonly provider: ProviderKind;
  /** Submit once. Same token ⇒ same receipt. */
  submit(request: FilingSubmissionRequest): Promise<FilingReceipt>;
  /** Query the current state of a prior submission (live portals). */
  status?(request: FilingSubmissionRequest): Promise<FilingReceipt>;
  /**
   * Exercise the credential handshake only (no document filed). Live gateways
   * implement it; the offline providers leave it undefined.
   */
  preflight?(): Promise<FilingPreflightResult>;
  health(): FilingGatewayHealth | null;
}

/** Live IRP connection settings (from serverEnv, zod-gated). */
export interface IrpConnectionConfig {
  /** Base host — GSTN runs einvoice1..einvoice6.gst.gov.in (sandbox: einv-apisandbox.nic.in). */
  readonly irpBaseUrl: string;
  /** Token endpoint path, e.g. "/eivital/v1.04/auth". */
  readonly authPath: string;
  /** IRN-generation endpoint path, e.g. "/eicore/v1.03/Invoice". */
  readonly irpEndpointPath: string;
  readonly gstin: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** IRP portal username/password — the credentials granted in the auth handshake. */
  readonly portalUser: string;
  readonly portalPassword: string;
  /**
   * PEM of the IRP's RSA public key. The auth envelope is encrypted to it, so
   * a live deployment cannot build a request without it (fail-closed).
   */
  readonly irpPublicKeyPem: string;
  /** Optional fixed AppKey; when absent a fresh one is minted per auth round-trip. */
  readonly appKey?: string;
  /** Optional GSP-level signature headers (only for GSP-mediated access). */
  readonly gspAuthToken?: string;
  readonly gspAuthSignature?: string;
  readonly timeoutMs: number;
}

/**
 * Field-path map for the income-tax e-filing (ERI) transport. Each entry is an
 * ordered list of dotted JSON paths; the first one present in a response wins.
 * Defaults cover the documented shape, and a deployment overrides them with the
 * paths from its ERI registration pack via env — so a portal whose field names
 * differ needs no code change.
 */
export interface EfilingFieldMap {
  /** Path to the access token in the token-endpoint response. */
  readonly token: readonly string[];
  readonly ackNumber: readonly string[];
  readonly ackDate: readonly string[];
  readonly status: readonly string[];
  readonly errorCode: readonly string[];
  readonly errorMessage: readonly string[];
}

/** Live e-filing connection settings (from serverEnv, zod-gated). */
export interface EfilingConnectionConfig {
  readonly tokenUrl: string;
  readonly submitUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Session-login grant for the ERI flow; without it the transport uses client_credentials. */
  readonly username?: string;
  readonly password?: string;
  /** Override the ERI response field paths (defaults to DEFAULT_EFILING_FIELDS). */
  readonly fields?: EfilingFieldMap;
  /** Key the ITR JSON is wrapped under in the submit body; "" posts it raw. */
  readonly submitBodyKey?: string;
  readonly timeoutMs: number;
  readonly apiVersion?: string;
}
