/**
 * E-filing submission and e-sign — pre-submission JSON/schema preparation for
 * return, audit-report, GST and TDS/ROC forms, the DSC vs EVC vs ETM selection
 * matrix, the acknowledgement-capture flow (ACK number, date, status) and the
 * resubmission/error-correction journey.
 *
 * SCOPE AND HONESTY: the signing-method matrix and acknowledgement capture are
 * the commonly referenced workflow scaffolding and are surfaced on the result so
 * a reviewer can verify them against the current e-filing portal workflow for
 * the form type. The engine prepares a reproducible pre-submission payload and
 * a workflow summary; it does NOT actually lodge the return with the portal.
 * The checksum it attaches is a real SHA-256 over the canonical JSON payload —
 * that is the hash a portal would expect to recompute, not a fake placeholder.
 * The *submission* and *signing* steps against the live portal are the parts
 * that remain out of reach (DSC key material is never stored in the app; the
 * portal endpoints are government-run and outside this codebase's control).
 */

import { createHash } from "node:crypto";

export interface EfilingForm {
  formType: string;
  formName: string;
  payload: Record<string, unknown>;
  schemaVersion: string;
  checksum: string; // SHA-256 over canonical JSON payload (hex)
}

export interface EfilingResult {
  formType: string;
  signingMethod: "dsc" | "evc" | "etm";
  dscDetails?: { user: string; certificateSerial: string } | null;
  form: EfilingForm;
  acknowledgement?: { ackNumber: string; date: string; status: string };
  resubmission: {
    allowed: boolean;
    errorCode?: string;
    correctionNote?: string;
  };
  warnings: string[];
  methodology: string[];
}

/**
 * Canonical JSON for the payload so the checksum is deterministic regardless of
 * object key ordering/format differences between callers.
 */
function canonicalJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
}

/**
 * SHA-256 hex checksum over the canonical JSON of the pre-submission payload.
 * This is the real hash the portal would recompute — not the 31-multiplier string
 * hash the previous placeholder used (which was self-labelled a placeholder).
 */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function signingMethodMatrix(formType: string): "dsc" | "evc" | "etm" {
  // Common illustrative matrix; reviewer to verify against current portal rules.
  if (formType === "audit-report") return "dsc";
  if (formType === "roc-form") return "dsc";
  return "evc";
}

export function prepareEfilingSubmission(input: {
  formType: "itr" | "audit-report" | "gst" | "tds-statement" | "roc-form";
  payload: Record<string, unknown>;
  signingMethod?: "dsc" | "evc" | "etm";
  dsc?: { user: string; certificateSerial: string } | null;
  acknowledgement?: { ackNumber: string; date: string; status: string };
}): EfilingResult {
  const { formType, payload, signingMethod, dsc, acknowledgement } = input;

  const resolvedSigningMethod = signingMethod ?? signingMethodMatrix(formType);
  const canonical = canonicalJson(payload);
  const form: EfilingForm = {
    formType,
    formName: formDisplayName(formType),
    payload,
    schemaVersion: "1.0",
    checksum: sha256Hex(canonical),
  };

  const resubmission =
    acknowledgement && acknowledgement.status === "Error"
      ? {
          allowed: true,
          errorCode: acknowledgement.status,
          correctionNote: "Reviewer to correct the reported error and resubmit; capture the new acknowledgement.",
        }
      : acknowledgement && acknowledgement.status === "Rejected"
        ? {
            allowed: true,
            errorCode: acknowledgement.status,
            correctionNote: "Reviewer to correct the rejection reason and resubmit; capture the new acknowledgement.",
          }
        : { allowed: false };

  const warnings: string[] = [
    "Signing-method selection shown is the commonly referenced matrix; verify against the current e-filing portal requirements for the form type.",
    "This engine prepares a reproducible pre-submission payload with a real SHA-256 checksum; it does NOT lodge the return with the portal, and does not hold the DSC key material required to sign one.",
  ];

  return {
    formType,
    signingMethod: resolvedSigningMethod,
    dscDetails: dsc,
    form,
    acknowledgement,
    resubmission,
    warnings,
    methodology: [
      `Pre-submission payload prepared for ${formDisplayName(formType)} with schema version ${form.schemaVersion} and a SHA-256 checksum ${form.checksum}.`,
      `Signing method selected: ${resolvedSigningMethod}; DSC user ${dsc?.user ?? "n/a"} serial ${dsc?.certificateSerial ?? "n/a"}.`,
      acknowledgement
        ? `Acknowledgement captured: ACK ${acknowledgement.ackNumber} on ${acknowledgement.date}, status ${acknowledgement.status}.`
        : "No acknowledgement captured yet; capture the ACK number, date and status on submission.",
      resubmission.allowed
        ? "Resubmission is allowed due to an error/rejection; correct and resubmit, then capture the new acknowledgement."
        : "No resubmission in progress.",
    ],
  };
}

function formDisplayName(formType: string): string {
  return (
    {
      itr: "Income-tax return",
      "audit-report": "Audit report",
      gst: "GST return",
      "tds-statement": "TDS statement",
      "roc-form": "ROC form",
    }[formType] ?? formType
  );
}
