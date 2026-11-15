/**
 * E-filing submission engine — oracle tests.
 *
 * The signing-method matrix and acknowledgement→resubmission mapping are small
 * deterministic rules, so every expectation is stated directly rather than
 * captured. Two things are pinned because they were real defects:
 *
 *   1. The hyphenated `audit-report` form type is used consistently across the
 *      input union, the display-name table and the signing matrix. A mismatch
 *      between `audit-report` and `audit_report` is what broke the dispatcher.
 *   2. Routing through `runCaEngine` actually reaches the engine for that form
 *      type (the exact compile-time break this suite guards).
 */

import { prepareEfilingSubmission } from "@/lib/engine/ca-efiling";
import { runCaEngine } from "@/lib/engine/ca-financial-analysis";
import type { AnalysisConfig } from "@/lib/types";

const payload = { form: "ITR-1", ay: "2026-27" };

describe("prepareEfilingSubmission: signing-method matrix", () => {
  it("defaults an ITR to EVC and names the form", () => {
    const res = prepareEfilingSubmission({ formType: "itr", payload });

    expect(res.signingMethod).toBe("evc");
    expect(res.form.formType).toBe("itr");
    expect(res.form.formName).toBe("Income-tax return");
    expect(res.form.schemaVersion).toBe("1.0");
  });

  it("defaults an audit report to DSC with the hyphenated form type", () => {
    const res = prepareEfilingSubmission({ formType: "audit-report", payload });

    expect(res.signingMethod).toBe("dsc");
    expect(res.form.formType).toBe("audit-report");
    expect(res.form.formName).toBe("Audit report");
  });

  it("defaults a ROC form to DSC", () => {
    const res = prepareEfilingSubmission({ formType: "roc-form", payload });
    expect(res.signingMethod).toBe("dsc");
    expect(res.form.formName).toBe("ROC form");
  });

  it("names TDS and GST forms and defaults them to EVC", () => {
    const tds = prepareEfilingSubmission({ formType: "tds-statement", payload });
    expect(tds.form.formName).toBe("TDS statement");
    expect(tds.signingMethod).toBe("evc");

    const gst = prepareEfilingSubmission({ formType: "gst", payload });
    expect(gst.form.formName).toBe("GST return");
    expect(gst.signingMethod).toBe("evc");
  });

  it("honours an explicit signing method over the matrix", () => {
    const res = prepareEfilingSubmission({ formType: "itr", payload, signingMethod: "dsc" });
    expect(res.signingMethod).toBe("dsc");
  });
});

describe("prepareEfilingSubmission: payload checksum", () => {
  it("is a stable SHA-256 hex digest of the payload", () => {
    const a = prepareEfilingSubmission({ formType: "itr", payload });
    const b = prepareEfilingSubmission({ formType: "itr", payload: { form: "ITR-1", ay: "2026-27" } });

    expect(a.form.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(a.form.checksum).toBe(b.form.checksum);
  });

  it("changes when the payload changes", () => {
    const a = prepareEfilingSubmission({ formType: "itr", payload });
    const b = prepareEfilingSubmission({ formType: "itr", payload: { form: "ITR-2", ay: "2026-27" } });
    expect(a.form.checksum).not.toBe(b.form.checksum);
  });
});

describe("prepareEfilingSubmission: acknowledgement handling", () => {
  it("records an Error acknowledgement as a resubmission", () => {
    const res = prepareEfilingSubmission({
      formType: "gst",
      payload,
      acknowledgement: { ackNumber: "ACK-1", date: "2026-07-01", status: "Error" },
    });

    expect(res.resubmission.allowed).toBe(true);
    expect(res.resubmission.errorCode).toBe("Error");
    expect(res.resubmission.correctionNote).toBeTruthy();
  });

  it("records a Rejected acknowledgement as a resubmission", () => {
    const res = prepareEfilingSubmission({
      formType: "gst",
      payload,
      acknowledgement: { ackNumber: "ACK-2", date: "2026-07-02", status: "Rejected" },
    });

    expect(res.resubmission.allowed).toBe(true);
    expect(res.resubmission.errorCode).toBe("Rejected");
  });

  it("reports no resubmission when no acknowledgement is supplied", () => {
    const res = prepareEfilingSubmission({ formType: "gst", payload });
    expect(res.resubmission.allowed).toBe(false);
    expect(res.acknowledgement).toBeUndefined();
  });

  it("surfaces the DSC details and the honesty disclosures", () => {
    const dsc = { user: "partner", certificateSerial: "SER-123" };
    const res = prepareEfilingSubmission({ formType: "audit-report", payload, dsc });

    expect(res.dscDetails).toEqual(dsc);
    expect(res.warnings).toEqual([
      "Signing-method selection shown is the commonly referenced matrix; verify against the current e-filing portal requirements for the form type.",
      "This engine prepares a reproducible pre-submission payload with a real SHA-256 checksum; it does NOT lodge the return with the portal, and does not hold the DSC key material required to sign one.",
    ]);
    expect(res.methodology.length).toBeGreaterThanOrEqual(4);
    // The checksum must be a real 64-char SHA-256 hex, not the old 8-char placeholder.
    expect(res.form.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic regardless of object key order", () => {
    const a = prepareEfilingSubmission({
      formType: "itr",
      payload: { ay: "2026-27", form: "ITR-1", income: 1_000_000 },
    });
    const b = prepareEfilingSubmission({
      formType: "itr",
      payload: { income: 1_000_000, form: "ITR-1", ay: "2026-27" },
    });
    expect(a.form.checksum).toBe(b.form.checksum);
  });

  it("checksum is stable across repeated calls for the same payload", () => {
    const payload = { form: "ITR-1", ay: "2026-27", income: 1_000_000 };
    const a = prepareEfilingSubmission({ formType: "itr", payload });
    const b = prepareEfilingSubmission({ formType: "itr", payload });
    expect(a.form.checksum).toBe(b.form.checksum);
    expect(a.form.checksum).not.toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("runCaEngine: e-filing routing", () => {
  it("routes an audit-report config to the e-filing engine", () => {
    const res = runCaEngine({
      kind: "efiling",
      formType: "audit-report",
      payload,
      signingMethod: "dsc",
      dsc: null,
    } as AnalysisConfig) as ReturnType<typeof prepareEfilingSubmission>;

    expect(res.form.formType).toBe("audit-report");
    expect(res.form.formName).toBe("Audit report");
    expect(res.signingMethod).toBe("dsc");
  });
});
