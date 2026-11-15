/**
 * Filings to India's tax / GST portals — error taxonomy.
 *
 * Every portal round-trip fails into exactly one of these buckets so the API
 * layer can render a clean "what happened / how to fix" response and the job
 * worker can decide whether a retry is safe:
 *
 *   CredentialMissingError  — live mode requested but a secret is absent. A
 *     deployment fault, never a retryable submission fault (retrying will not
 *     conjure credentials). Fail readable at boot/use.
 *   FilingConfigError       — the gateway is misconfigured (bad endpoint, no
 *     signer). Same retry rule as above.
 *   PortalTransportError    — the request never reached the portal cleanly
 *     (DNS/TLS/timeout/gateway 5xx). Retryable with backoff.
 *   PortalRejectionError    — the portal answered with a business rejection
 *     (invalid invoice, GSTIN mismatch, rejection code, IRN already exists).
 *     Portals are idempotent on the once-token: resubmitting the SAME token is
 *     safe; submitting a CORRECTED payload requires a new token.
 */

export interface FilingErrorDetails {
  readonly provider: string;
  readonly channel: string;
  readonly onceToken?: string | null;
  readonly httpStatus?: number | null;
  readonly portalErrorCode?: string | null;
}

export abstract class FilingGatewayError extends Error {
  abstract readonly kind: "credential" | "config" | "transport" | "rejection";
  readonly details: FilingErrorDetails;
  readonly retryable: boolean;

  protected constructor(message: string, details: FilingErrorDetails, retryable: boolean) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    this.retryable = retryable;
  }
}

export class CredentialMissingError extends FilingGatewayError {
  readonly kind = "credential" as const;
  constructor(
    channel: string,
    missing: readonly string[],
    details: Omit<FilingErrorDetails, "channel"> = { provider: "unknown" },
  ) {
    super(
      `Live filing for "${channel}" is not configured: ${missing.join(", ")} are required. ` +
        "Set them in the environment (see docs/gst-portal-execution.md) or switch FILING_GATEWAY to simulation/reference.",
      { ...details, channel },
      false,
    );
  }
}

export class FilingConfigError extends FilingGatewayError {
  readonly kind = "config" as const;
  constructor(message: string, details: FilingErrorDetails) {
    super(message, details, false);
  }
}

export class PortalTransportError extends FilingGatewayError {
  readonly kind = "transport" as const;
  constructor(message: string, details: FilingErrorDetails) {
    super(message, details, true);
  }
}

export class PortalRejectionError extends FilingGatewayError {
  readonly kind = "rejection" as const;
  constructor(message: string, details: FilingErrorDetails) {
    super(message, details, false);
  }
}

export function isFilingGatewayError(err: unknown): err is FilingGatewayError {
  return err instanceof FilingGatewayError;
}
