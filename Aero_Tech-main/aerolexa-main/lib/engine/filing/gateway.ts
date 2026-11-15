/**
 * Filing gateway provider selection + readiness.
 *
 * resolveFilingGateway() returns the single FilingGateway the app files
 * through, chosen by FILING_GATEWAY:
 *
 *   ""           → reference  (default; deterministic local IRN hash, no network)
 *   "reference"  → ReferenceFilingGateway
 *   "simulation" → FilingSimulator (deterministic, offline, envelope-faithful)
 *   "live"       → GstnIrpGateway / ItdEfilingGateway built from serverEnv
 *   credentials, chosen by FILING_CHANNEL.
 *
 * In live mode the zod cross-field check (lib/env.ts) guarantees the active
 * channel's credential set is fully present at BOOT — a half-configured live
 * deployment never reaches filing time. resolveFilingGateway() re-checks anyway
 * and throws a readable CredentialMissingError.
 */

import { serverEnv } from "@/lib/env";

import { normalizePem } from "./crypto";
import { CredentialMissingError, FilingConfigError } from "./errors";
import { DEFAULT_EFILING_FIELDS, GstnIrpGateway, ItdEfilingGateway, parseFieldCandidates } from "./irp";
import { FilingSimulator, ReferenceFilingGateway } from "./simulator";
import type {
  EfilingFieldMap,
  FilingChannel,
  FilingGateway,
  FilingGatewayHealth,
  FilingPreflightResult,
  GatewayAvailability,
  ProviderKind,
} from "./types";

export type { FilingGateway };

// Re-exported so operators/tests can normalise a pasted PEM through the same
// helper the live gateway uses to build its auth envelope.
export { normalizePem };

let memoized: FilingGateway | null = null;

/** Active provider without (re)building the gateway. */
export function filingProviderKind(): ProviderKind {
  const value = (serverEnv().FILING_GATEWAY || "reference").trim();
  return value === "live" ? "live" : value === "simulation" ? "simulation" : "reference";
}

export function filingChannel(): FilingChannel {
  const value = (serverEnv().FILING_CHANNEL || "irp-irn").trim();
  if (value === "efiling-return" || value === "efiling-audit" || value === "irp-irn") return value;
  return "irp-irn";
}

/**
 * Assemble the ERI response field map from env. Each variable is a
 * comma-separated list of dotted JSON paths; an unset variable falls back to the
 * documented default. This is what lets a deployment match its ERI registration
 * pack without a code change.
 */
export function efilingFieldMapFromEnv(): EfilingFieldMap {
  const env = serverEnv();
  return {
    token: parseFieldCandidates(env.FILING_EFILING_TOKEN_FIELD, DEFAULT_EFILING_FIELDS.token),
    ackNumber: parseFieldCandidates(env.FILING_EFILING_ACK_NUMBER_FIELD, DEFAULT_EFILING_FIELDS.ackNumber),
    ackDate: parseFieldCandidates(env.FILING_EFILING_ACK_DATE_FIELD, DEFAULT_EFILING_FIELDS.ackDate),
    status: parseFieldCandidates(env.FILING_EFILING_STATUS_FIELD, DEFAULT_EFILING_FIELDS.status),
    errorCode: parseFieldCandidates(env.FILING_EFILING_ERROR_CODE_FIELD, DEFAULT_EFILING_FIELDS.errorCode),
    errorMessage: parseFieldCandidates(env.FILING_EFILING_ERROR_MESSAGE_FIELD, DEFAULT_EFILING_FIELDS.errorMessage),
  };
}

function buildLiveGateway(): FilingGateway {
  const env = serverEnv();
  const channel = filingChannel();
  if (channel === "irp-irn") {
    if (
      !env.FILING_GSTIN ||
      !env.FILING_IRP_CLIENT_ID ||
      !env.FILING_IRP_CLIENT_SECRET ||
      !env.FILING_IRP_BASE_URL ||
      !env.FILING_IRP_PORTAL_USER ||
      !env.FILING_IRP_PORTAL_PASSWORD ||
      !env.FILING_IRP_PUBLIC_KEY
    ) {
      throw new CredentialMissingError(
        "irp-irn",
        [
          "FILING_GSTIN",
          "FILING_IRP_CLIENT_ID",
          "FILING_IRP_CLIENT_SECRET",
          "FILING_IRP_BASE_URL",
          "FILING_IRP_PORTAL_USER",
          "FILING_IRP_PORTAL_PASSWORD",
          "FILING_IRP_PUBLIC_KEY",
        ],
        { provider: "live" },
      );
    }
    return new GstnIrpGateway({
      irpBaseUrl: env.FILING_IRP_BASE_URL,
      authPath: env.FILING_IRP_AUTH_PATH || "/eivital/v1.04/auth",
      irpEndpointPath: env.FILING_IRP_ENDPOINT_PATH || "/eicore/v1.03/Invoice",
      gstin: env.FILING_GSTIN,
      clientId: env.FILING_IRP_CLIENT_ID,
      clientSecret: env.FILING_IRP_CLIENT_SECRET,
      portalUser: env.FILING_IRP_PORTAL_USER,
      portalPassword: env.FILING_IRP_PORTAL_PASSWORD,
      irpPublicKeyPem: normalizePem(env.FILING_IRP_PUBLIC_KEY),
      appKey: env.FILING_IRP_APP_KEY || undefined,
      gspAuthToken: env.FILING_IRP_GSP_AUTH_TOKEN || undefined,
      gspAuthSignature: env.FILING_IRP_GSP_AUTH_SIGNATURE || undefined,
      timeoutMs: env.FILING_TIMEOUT_MS,
    });
  }
  if (
    !env.FILING_EFILING_TOKEN_URL ||
    !env.FILING_EFILING_SUBMIT_URL ||
    !env.FILING_EFILING_CLIENT_ID ||
    !env.FILING_EFILING_CLIENT_SECRET
  ) {
    throw new CredentialMissingError(
      "efiling",
      [
        "FILING_EFILING_TOKEN_URL",
        "FILING_EFILING_SUBMIT_URL",
        "FILING_EFILING_CLIENT_ID",
        "FILING_EFILING_CLIENT_SECRET",
      ],
      { provider: "live" },
    );
  }
  return new ItdEfilingGateway({
    tokenUrl: env.FILING_EFILING_TOKEN_URL,
    submitUrl: env.FILING_EFILING_SUBMIT_URL,
    clientId: env.FILING_EFILING_CLIENT_ID,
    clientSecret: env.FILING_EFILING_CLIENT_SECRET,
    username: env.FILING_EFILING_USERNAME || undefined,
    password: env.FILING_EFILING_PASSWORD || undefined,
    fields: efilingFieldMapFromEnv(),
    submitBodyKey: env.FILING_EFILING_SUBMIT_BODY_KEY,
    timeoutMs: env.FILING_TIMEOUT_MS,
  });
}

/** The one FilingGateway the app files through (stable for process lifetime). */
export function resolveFilingGateway(reload = false): FilingGateway {
  if (!reload && memoized) return memoized;
  const provider = filingProviderKind();
  let gateway: FilingGateway;
  if (provider === "simulation") {
    gateway = new FilingSimulator();
  } else if (provider === "live") {
    gateway = buildLiveGateway();
  } else {
    gateway = new ReferenceFilingGateway();
  }
  memoized = gateway;
  return gateway;
}

/** Test-only: drop the memoized gateway so provider env changes take effect. */
export function __resetFilingGatewayForTests(): void {
  memoized = null;
}

function availability(
  configured: boolean,
  provider: ProviderKind | "n/a",
  missing: readonly string[],
): GatewayAvailability {
  return { configured, provider, missing };
}

/**
 * Readiness report used by the API and the coverage self-audit: what provider
 * is active, which channels are live-capable, and what would be needed to go
 * live.
 */
export function filingGatewayHealth(): FilingGatewayHealth {
  const provider = filingProviderKind();
  const env = serverEnv();

  const credentialNames: Record<FilingChannel, readonly string[]> = {
    "irp-irn": [
      "FILING_GSTIN",
      "FILING_IRP_CLIENT_ID",
      "FILING_IRP_CLIENT_SECRET",
      "FILING_IRP_BASE_URL",
      "FILING_IRP_ENDPOINT_PATH",
      "FILING_IRP_AUTH_PATH",
      "FILING_IRP_PUBLIC_KEY",
      "FILING_IRP_PORTAL_USER",
      "FILING_IRP_PORTAL_PASSWORD",
    ] as const,
    "efiling-return": [
      "FILING_EFILING_TOKEN_URL",
      "FILING_EFILING_SUBMIT_URL",
      "FILING_EFILING_CLIENT_ID",
      "FILING_EFILING_CLIENT_SECRET",
    ] as const,
    "efiling-audit": [
      "FILING_EFILING_TOKEN_URL",
      "FILING_EFILING_SUBMIT_URL",
      "FILING_EFILING_CLIENT_ID",
      "FILING_EFILING_CLIENT_SECRET",
    ] as const,
  };
  const names = Object.keys(credentialNames) as FilingChannel[];

  const channels = {} as FilingGatewayHealth["channels"];
  for (const channel of names) {
    const missing = credentialNames[channel].filter((key) => String(env[key as keyof typeof env] ?? "").trim() === "");
    channels[channel] = availability(missing.length === 0, provider, missing);
  }

  const activeChannel = filingChannel();
  return { provider, channels, liveEligible: provider === "live", activeChannel };
}

/**
 * Preflight the live credential handshake WITHOUT filing anything. Offline
 * providers report that there is nothing to verify; a live gateway runs its
 * auth/token exchange only (see `FilingGateway.preflight`). Safe to call from
 * the operator UI — it never creates an IRN or lodges a return.
 */
export async function filingGatewayPreflight(): Promise<FilingPreflightResult> {
  const provider = filingProviderKind();
  const channel = filingChannel();
  const checkedAt = new Date().toISOString();

  if (provider !== "live") {
    return {
      provider,
      channel,
      ok: false,
      detail: `Filing provider is "${provider}" — the live credential handshake is not exercised. Set FILING_GATEWAY=live to test portal credentials.`,
      sandbox: false,
      httpStatus: null,
      checkedAt,
    };
  }

  const gateway = resolveFilingGateway();
  if (!gateway.preflight) {
    return {
      provider: "live",
      channel,
      ok: false,
      detail: "The active gateway exposes no preflight probe.",
      sandbox: false,
      httpStatus: null,
      checkedAt,
    };
  }

  const report = await gateway.preflight();
  return { ...report, channel };
}

export { CredentialMissingError, FilingConfigError };
