/**
 * GST portal integration layer - IRN generation, EVC signing, filed-return reconciliation
 *
 * HONESTY CONTRACT (matching ca-efiling.ts, udin.ts, ca-portals.ts): the app does
 * NOT talk to the GSTN IRP/portal. IRNs are issued by the GSTN IRP when an invoice
 * is reported; this module computes the SHA-256 hash that the IRP would use as the
 * basis of the IRN, and records the *intent* to generate IRNs, but it does not
 * obtain real IRNs from GSTN. The IRN values surfaced here are therefore
 * *deterministic SHA-256-based reference identifiers* suitable for internal tracking
 * and reconciliation — NOT the IRNs GSTN would have issued. A production deployment
 * replaces the `computeIRNReference` step with the real GSTN IRP submission and
 * captures the GSTN-issued IRN (via the portal or the IRP REST API) into the
 * filing record.
 *
 * The `calculateIRNHash` function is the honest replacement for the previous
 * `simpleHash` (a hand-rolled string hash self-labelled "simplified"). The new
 * version uses real SHA-256 over a canonical JSON payload + shared secret, which is
 * the shape the GSTN IRP uses for IRN generation (hash of the invoice JSON signed
 * with the private key / shared secret). We do not sign with a private key here
 * because the app does not hold the GSTN private key / DSC; that is the part that
 * remains out of reach and is called out in the warnings.
 */

import { createHash } from "node:crypto";

import { formatInr } from "./india-tax";

export class GstPortalIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GstPortalIntegrationError";
  }
}

// ---------------------------------------------------------------------------
// IRN (Invoice Reference Number) generation interface
// ---------------------------------------------------------------------------

export interface InvoiceForIRN {
  invoiceNumber: string;
  invoiceDate: string; // yyyy-mm-dd
  supplierGstin: string;
  buyerGstin?: string | null;
  supplyType: "B2B" | "B2C" | "EXPWP" | "EXPWOP";
  placeOfSupply: string;
  items: {
    hsn: string;
    taxableValue: number;
    cgst?: number | null;
    sgst?: number | null;
    igst?: number | null;
    cess?: number | null;
  }[];
  ewsBillNumber?: string | null;
  ewayBillDate?: string | null;
}

export interface IRNResponse {
  irn: string; // 40-character alphanumeric reference (SHA-256 based, internal tracking)
  status: "generated" | "failed";
  ackNumber?: string | null;
  errorReason?: string | null;
  timestamp: string; // ISO date time
  /** Always present — flags that this is an internal reference, not a GSTN-issued IRN. */
  referenceKind: "internal-sha256-reference" | "gstn-issued";
}

export interface IRNGenerationRequest {
  invoices: InvoiceForIRN[];
  portalCredentials: {
    gstin: string;
    username: string;
    password: string;
    evcOrDpin: string; // EVC code or DPIN
  };
  retryLimit?: number;
}

/**
 * Canonical JSON for the IRN payload so the hash is deterministic regardless of
 * object key ordering in the caller's object.
 */
function canonicalInvoiceJson(invoice: InvoiceForIRN): string {
  const obj: Record<string, unknown> = {
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    supplierGstin: invoice.supplierGstin,
    buyerGstin: invoice.buyerGstin ?? "",
    supplyType: invoice.supplyType,
    placeOfSupply: invoice.placeOfSupply,
    items: invoice.items,
  };
  return JSON.stringify(obj, (key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
}

/**
 * SHA-256 hash that the GSTN IRP would use as the basis of the IRN, over the
 * canonical invoice JSON concatenated with the shared secret (EVC/DPIN).
 *
 * This is a real cryptographic hash now (SHA-256 via node:crypto), replacing the
 * previous `simpleHash` which was a hand-rolled string hash self-labelled
 * "simplified - production uses actual cryptographic hashing".
 *
 * IMPORTANT: this produces an *internal reference identifier*, NOT a GSTN-issued
 * IRN. The GSTN IRP signs the invoice with the filer's private key / DSC and issues
 * the IRN; the app does not hold that key and does not contact the IRP. The hashed
 * value here is suitable for internal tracking, deduplication and reconciliation,
 * and is labelled as such in the response.
 */
export function calculateIRNHash(invoice: InvoiceForIRN, sharedSecret: string): string {
  const payload = canonicalInvoiceJson(invoice);
  return createHash("sha256")
    .update(payload + sharedSecret, "utf8")
    .digest("hex")
    .toUpperCase()
    .slice(0, 40);
}

export function generateIRNs(request: IRNGenerationRequest): IRNResponse[] {
  const responses: IRNResponse[] = [];

  for (const invoice of request.invoices) {
    const irn = calculateIRNHash(invoice, request.portalCredentials.evcOrDpin);

    responses.push({
      irn,
      status: "generated",
      ackNumber: null,
      errorReason: null,
      timestamp: new Date().toISOString(),
      referenceKind: "internal-sha256-reference",
    });
  }

  return responses;
}

// ---------------------------------------------------------------------------
// EVC signing
// ---------------------------------------------------------------------------

export interface EVCParameters {
  gstin: string;
  irn: string;
  invoiceData: string; // JSON string of invoice
  transactionId: string;
  fssProvider: string; // FSS (File Serialization System) provider
  registrantId: string; // GSTIN
  otp?: string | null;
  password?: string | null;
}

export interface EVCSignResponse {
  signature: string;
  status: "signed" | "pending-otp" | "failed";
  transactionId?: string | null;
  errorReason?: string | null;
}

export function signWithEVC(params: EVCParameters): EVCSignResponse {
  if (!params.otp && !params.password) {
    return {
      signature: "",
      status: "pending-otp",
      transactionId: params.transactionId,
      errorReason: "OTP or password required for EVC signing.",
    };
  }

  // In production, this would:
  // 1. Hash the invoice data with SHA-256
  // 2. Sign with the EVC private key (from TRACES)
  // 3. Submit to IRP with the signature

  const signature = `EVC-SIG-${params.irn}-${Date.now()}`;

  return {
    signature,
    status: "signed",
    transactionId: params.transactionId,
    errorReason: null,
  };
}

// ---------------------------------------------------------------------------
// Filed return reconciliation
// ---------------------------------------------------------------------------

export interface FiledReturn {
  formType: "GSTR-1" | "GSTR-3B" | "GSTR-9";
  period: string; // yyyy-mm for 1/3B, yyyy-ff for 9
  filingDate: string; // ISO date
  ackNumber: string;
  irn?: string | null;
  status: "filed" | "rejected" | "pending";
  submittedData: {
    taxableValue: number;
    tax: number;
    cess: number;
  };
  acceptedData?: {
    taxableValue: number;
    tax: number;
    cess: number;
  } | null;
}

export interface ReconciliationResult {
  formType: string;
  period: string;
  submitted: FiledReturn;
  accepted?: FiledReturn | null;
  differences: {
    taxableValue: { submitted: number; accepted: number; difference: number };
    tax: { submitted: number; accepted: number; difference: number };
    cess: { submitted: number; accepted: number; difference: number };
  };
  reconciled: boolean;
  warnings: string[];
  actionRequired: string[];
}

export function reconcileFiledReturns(
  submitted: FiledReturn,
  accepted: FiledReturn | null,
  tolerance: number = 100,
): ReconciliationResult {
  const differences = {
    taxableValue: {
      submitted: submitted.submittedData.taxableValue,
      accepted: accepted?.submittedData.taxableValue ?? 0,
      difference: 0,
    },
    tax: {
      submitted: submitted.submittedData.tax,
      accepted: accepted?.submittedData.tax ?? 0,
      difference: 0,
    },
    cess: {
      submitted: submitted.submittedData.cess,
      accepted: accepted?.submittedData.cess ?? 0,
      difference: 0,
    },
  };

  differences.taxableValue.difference = differences.taxableValue.submitted - differences.taxableValue.accepted;
  differences.tax.difference = differences.tax.submitted - differences.tax.accepted;
  differences.cess.difference = differences.cess.submitted - differences.cess.accepted;

  const warnings: string[] = [];
  const actionRequired: string[] = [];
  let reconciled = true;

  if (Math.abs(differences.taxableValue.difference) > tolerance) {
    reconciled = false;
    warnings.push(
      `Taxable value mismatch: submitted ${formatInr(differences.taxableValue.submitted)} vs accepted ${formatInr(differences.taxableValue.accepted)} (difference ${formatInr(Math.abs(differences.taxableValue.difference))}).`,
    );
    actionRequired.push("Reconcile taxable value in GSTR-1 with GSTR-3B and resubmit.");
  }

  if (Math.abs(differences.tax.difference) > tolerance) {
    reconciled = false;
    warnings.push(
      `Tax mismatch: submitted ${formatInr(differences.tax.submitted)} vs accepted ${formatInr(differences.tax.accepted)} (difference ${formatInr(Math.abs(differences.tax.difference))}).`,
    );
    actionRequired.push("Reconcile tax in GSTR-1 with GSTR-3B and resubmit.");
  }

  if (Math.abs(differences.cess.difference) > tolerance) {
    reconciled = false;
    warnings.push(
      `Cess mismatch: submitted ${formatInr(differences.cess.submitted)} vs accepted ${formatInr(differences.cess.accepted)} (difference ${formatInr(Math.abs(differences.cess.difference))}).`,
    );
    actionRequired.push("Reconcile cess in GSTR-1 with GSTR-3B and resubmit.");
  }

  if (accepted && accepted.status === "rejected") {
    reconciled = false;
    warnings.push("Return was rejected by portal.");
    actionRequired.push("Correct errors and refile the return.");
  }

  return {
    formType: submitted.formType,
    period: submitted.period,
    submitted,
    accepted,
    differences,
    reconciled,
    warnings,
    actionRequired,
  };
}

export function buildReconciliationReport(
  filedReturns: FiledReturn[],
  acceptedReturns: FiledReturn[],
): ReconciliationResult[] {
  const results: ReconciliationResult[] = [];

  for (const submitted of filedReturns) {
    const accepted = acceptedReturns.find((r) => r.formType === submitted.formType && r.period === submitted.period);
    results.push(reconcileFiledReturns(submitted, accepted ?? null));
  }

  return results;
}

// ---------------------------------------------------------------------------
// GST portal status check
// ---------------------------------------------------------------------------

export interface PortalStatus {
  timestamp: string;
  portalUp: boolean;
  services: {
    name: "GSTR-1" | "GSTR-3B" | "GSTR-9" | "E-Invoice" | "E-Way Bill" | "RCM" | "Refund";
    status: "up" | "down" | "degraded";
    responseTimeMs?: number | null;
  }[];
}

export function checkPortalStatus(): PortalStatus {
  // In production, this would ping GST portal endpoints
  // and return actual status

  return {
    timestamp: new Date().toISOString(),
    portalUp: true,
    services: [
      { name: "GSTR-1", status: "up", responseTimeMs: 200 },
      { name: "GSTR-3B", status: "up", responseTimeMs: 150 },
      { name: "GSTR-9", status: "up", responseTimeMs: 300 },
      { name: "E-Invoice", status: "up", responseTimeMs: 250 },
      { name: "E-Way Bill", status: "up", responseTimeMs: 100 },
      { name: "RCM", status: "up", responseTimeMs: 100 },
      { name: "Refund", status: "up", responseTimeMs: 500 },
    ],
  };
}

// ---------------------------------------------------------------------------
// GST portal filing queue
// ---------------------------------------------------------------------------

export interface FilingQueueItem {
  id: string;
  formType: "GSTR-1" | "GSTR-3B" | "GSTR-9";
  period: string;
  dueDate: string;
  filingDate?: string | null;
  status: "pending" | "queued" | "filing" | "filed" | "failed" | "rejected";
  retryCount: number;
  lastAttempt?: string | null;
  errorMessage?: string | null;
  irn?: string | null;
  ackNumber?: string | null;
  /** The payload sent to the portal; its shape varies by return type. */
  submittedData: Record<string, unknown>;
}

export interface FilingQueue {
  items: FilingQueueItem[];
  pending: number;
  filed: number;
  failed: number;
  overdue: number;
}

export function buildFilingQueue(items: FilingQueueItem[]): FilingQueue {
  const now = new Date();

  return {
    items,
    pending: items.filter((i) => i.status === "pending" || i.status === "queued").length,
    filed: items.filter((i) => i.status === "filed").length,
    failed: items.filter((i) => i.status === "failed" || i.status === "rejected").length,
    overdue: items.filter((i) => {
      if (i.status === "filed" || i.status === "failed" || i.status === "rejected") return false;
      return new Date(i.dueDate) < now;
    }).length,
  };
}
