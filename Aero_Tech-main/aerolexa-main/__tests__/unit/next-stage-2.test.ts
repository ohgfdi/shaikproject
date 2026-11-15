import { parseClientImportCsv } from "@/lib/engine/client-import";
import { evaluateFilingSubmission, normalizeMode } from "@/lib/server/filing-rollout";
import type { ApprovalAuditBundle } from "@/lib/server/receipt-audit-bundle";
import { renderApprovalReceiptPdf } from "@/lib/server/receipt-pdf";

describe("filing rollout gate", () => {
  it("blocks a shadow client only on a live provider when enforced", () => {
    expect(
      evaluateFilingSubmission({ enforced: true, storedMode: "shadow", provider: "live" }),
    ).toMatchObject({ allowed: false, code: "FILING_SHADOW_ONLY" });
    expect(
      evaluateFilingSubmission({ enforced: true, storedMode: "live", provider: "live" }).allowed,
    ).toBe(true);
  });

  it("never blocks simulation, and does nothing until the gate is enforced", () => {
    expect(
      evaluateFilingSubmission({ enforced: true, storedMode: "shadow", provider: "simulation" }).allowed,
    ).toBe(true);
    expect(
      evaluateFilingSubmission({ enforced: false, storedMode: "shadow", provider: "live" }).allowed,
    ).toBe(true);
    expect(normalizeMode(null)).toBe("shadow");
    expect(normalizeMode("LIVE")).toBe("shadow");
  });
});

function bundle(): ApprovalAuditBundle {
  return {
    format: "ledgerly.approval-audit-bundle",
    version: 1,
    generatedAt: "2026-11-13T10:00:00.000Z",
    organization: { id: "org", name: "Firm & Co" },
    filing: {
      id: "run-1",
      taskId: "eng:GSTR-3B:Oct-2026:1",
      title: "GSTR-3B Oct 2026",
      authority: "GSTN",
      dueDate: "2026-11-20",
      stage: "client-approved",
      filedAt: null,
      acknowledgementReference: null,
      verificationStatus: "unverified",
      clientApprovedAt: "2026-11-13T09:00:00.000Z",
      clientApprovalDigest: "a".repeat(64),
      engagementName: "Sharma Textiles",
    },
    approval: {
      receipt: { version: 2 },
      digest: "a".repeat(64),
      digestMatches: true,
      checks: [{ id: "digest", label: "Receipt digest recomputes", ok: true, detail: "Matches." }],
      signatureVerified: null,
    },
    events: [
      {
        id: "ev-1",
        fromStage: "reviewed",
        toStage: "client-approved",
        note: "Approved in portal",
        actorId: "user-1",
        createdAt: "2026-11-13T09:00:00.000Z",
      },
    ],
    notes: ["Signature verification was not performed."],
  };
}

describe("receipt PDF", () => {
  it("writes a structurally valid PDF containing the bundle title", () => {
    const pdf = renderApprovalReceiptPdf(bundle());
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("APPROVAL AUDIT BUNDLE");
    expect(text).toContain("/Type /Page");
    expect(text).toContain("trailer");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("escapes parentheses in client names instead of corrupting the stream", () => {
    const input = bundle();
    input.filing.engagementName = "Sharma (Textiles) Pvt Ltd";
    const text = renderApprovalReceiptPdf(input).toString("latin1");
    expect(text).toContain("Sharma \\(Textiles\\) Pvt Ltd");
  });
});

describe("client CSV import", () => {
  const header = "name,code,gstin,entity,state,fy,gst,tds,staff,audit";

  it("parses quoted names, defaults and booleans", () => {
    const parsed = parseClientImportCsv(
      [
        header,
        '"Sharma, Textiles Pvt Ltd",ACME,27AAAAA0000A1Z5,company,maharashtra,2025-26,yes,yes,true,no',
      ].join("\n"),
      { defaultFinancialYear: "2025-26" },
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      name: "Sharma, Textiles Pvt Ltd",
      code: "ACME",
      entityKind: "company",
      gstRegistered: true,
      tdsDeductor: true,
      employsStaff: true,
      taxAuditApplicable: false,
    });
  });

  it("rejects a malformed GSTIN and an unknown entity kind by line", () => {
    const parsed = parseClientImportCsv(
      [header, "A,AA,123,company,,2025-26,,,,", "B,BB,,society,,2025-26,,,,"].join("\n"),
      { defaultFinancialYear: "2025-26" },
    );
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors.map((error) => error.line)).toEqual([2, 3]);
    expect(parsed.errors[0]?.message).toContain("GSTIN");
    expect(parsed.errors[1]?.message).toContain("Unknown entity kind");
  });

  it("rejects duplicate client codes inside the file", () => {
    const parsed = parseClientImportCsv(
      [header, "A,ACME,,company,,2025-26,,,,", "B,ACME,,llp,,2025-26,,,,"].join("\n"),
      { defaultFinancialYear: "2025-26" },
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.errors[0]?.message).toContain("already used on line 2");
  });

  it("requires the name column", () => {
    const parsed = parseClientImportCsv("code,gstin\nA,", { defaultFinancialYear: "2025-26" });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]?.message).toContain("name/client");
  });
});
