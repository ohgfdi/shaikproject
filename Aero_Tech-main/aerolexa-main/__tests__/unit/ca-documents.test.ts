/**
 * Document management & client portal engine — oracle tests.
 *
 * Retention periods are policy data, so the tests pin the ARITHMETIC (due
 * date, expiry window, conflict detection) and the SHARING rule, not the law.
 */

import {
  DEFAULT_REQUIRED_CATEGORIES,
  buildClientPortalView,
  buildDocumentRegister,
  daysBetween,
  retentionDueDate,
  type DocumentRecord,
} from "@/lib/engine/ca-documents";

function doc(over: Partial<DocumentRecord> & Pick<DocumentRecord, "id" | "category">): DocumentRecord {
  return {
    name: `doc-${over.id}`,
    clientId: "C1",
    clientName: "Sharma Textiles Pvt Ltd",
    engagementId: "ENG-1",
    uploadedAt: "2025-01-01",
    uploadedBy: "R. Iyer",
    version: 1,
    sizeBytes: 1_000,
    signed: true,
    sharedWithClient: true,
    ...over,
  };
}

describe("retentionDueDate", () => {
  it("adds whole 365-day years to the filed date", () => {
    expect(retentionDueDate("2025-01-01", 1)).toBe("2026-01-01");
    expect(retentionDueDate("2024-01-01", 1)).toBe("2024-12-31"); // 2024 is a leap year
    expect(retentionDueDate("2025-01-01", 0)).toBe("2025-01-01");
  });

  it("rejects a malformed date and a negative period", () => {
    expect(() => retentionDueDate("01-01-2025", 1)).toThrow(/yyyy-mm-dd/);
    expect(() => retentionDueDate("2025-01-01", -1)).toThrow(/negative/);
  });

  it("counts days between dates", () => {
    expect(daysBetween("2025-12-01", "2025-12-31")).toBe(30);
    expect(daysBetween("2025-12-31", "2025-12-01")).toBe(-30);
  });
});

describe("buildDocumentRegister", () => {
  const documents: DocumentRecord[] = [
    doc({ id: "D1", category: "engagement-letter", name: "EL-Sharma.pdf", uploadedAt: "2025-01-10", signed: true }),
    doc({ id: "D2", category: "financial-statement", name: "FS-FY25.pdf", uploadedAt: "2025-05-01", signed: true }),
    doc({ id: "D3", category: "tax-return", name: "ITR-FY25.pdf", uploadedAt: "2025-07-01", signed: false }),
    doc({
      id: "D4",
      category: "working-paper",
      name: "WP-1.xlsx",
      uploadedAt: "2025-03-01",
      version: 1,
      sharedWithClient: false,
    }),
    doc({
      id: "D5",
      category: "working-paper",
      name: "WP-1.xlsx",
      uploadedAt: "2025-04-01",
      version: 2,
      sharedWithClient: false,
    }),
    doc({ id: "D6", category: "other", name: "Old-minutes.pdf", uploadedAt: "2010-01-01", signed: false }),
  ];

  it("rolls up counts, bytes and per-client totals", () => {
    const r = buildDocumentRegister(documents, { asOfDate: "2026-10-16" });
    expect(r.totalDocuments).toBe(6);
    expect(r.totalBytes).toBe(6_000);
    expect(r.byCategory["working-paper"]).toBe(2);
    expect(r.byClient["C1"]).toBe(6);
  });

  it("computes a retention due date per record and marks expired ones", () => {
    const r = buildDocumentRegister(documents, { asOfDate: "2026-10-16" });
    const minutes = r.retention.find((x) => x.id === "D6")!;
    expect(minutes.retentionYears).toBe(6);
    expect(minutes.dueDate).toBe(retentionDueDate("2010-01-01", 6));
    expect(minutes.expired).toBe(true);
    expect(minutes.source).toMatch(/Practice policy/);
    expect(r.expired.map((x) => x.id)).toEqual(["D6"]);
    // Sorted by due date, soonest first.
    expect(r.retention[0]!.id).toBe("D6");
  });

  it("flags records expiring inside the window without calling them expired", () => {
    const r = buildDocumentRegister(documents, { asOfDate: "2025-12-01", expiringSoonDays: 60 });
    // The 6-year rule puts D6 (filed 2010-01-01) due on 2015-12-31 → long expired.
    expect(r.expired.map((x) => x.id)).toEqual(["D6"]);

    // A record filed 2020-01-01 falls due 2025-12-30 under the same 6-year rule:
    // 29 days before the as-of date, so expiring soon, not expired.
    const soon = doc({ id: "D7", category: "other", name: "Near-expiry.pdf", uploadedAt: "2020-01-01" });
    const r2 = buildDocumentRegister([soon], { asOfDate: "2025-12-01", expiringSoonDays: 60 });
    expect(r2.retention[0]!.dueDate).toBe("2025-12-30");
    expect(r2.retention[0]!.daysRemaining).toBe(29);
    expect(r2.expiringSoon.map((x) => x.id)).toEqual(["D7"]);
    expect(r2.expired).toHaveLength(0);
  });

  it("reports completeness against the required categories", () => {
    const complete = buildDocumentRegister(documents, { asOfDate: "2026-10-16" });
    expect(complete.completeness.required).toEqual([...DEFAULT_REQUIRED_CATEGORIES]);
    expect(complete.completeness.missing).toEqual([]);
    expect(complete.completeness.complete).toBe(true);

    const partial = buildDocumentRegister(
      documents.filter((d) => d.id === "D3"),
      { asOfDate: "2026-10-16" },
    );
    expect(partial.completeness.missing).toEqual(["engagement-letter", "financial-statement", "working-paper"]);
    expect(partial.completeness.complete).toBe(false);
  });

  it("detects version conflicts on the same document name for the same client", () => {
    const r = buildDocumentRegister(documents, { asOfDate: "2026-10-16" });
    expect(r.versionConflicts).toEqual([{ name: "WP-1.xlsx", clientId: "C1", versions: [1, 2] }]);
  });

  it("lists unsigned records and counts unshared ones", () => {
    const r = buildDocumentRegister(documents, { asOfDate: "2026-10-16" });
    expect(r.unsigned.map((u) => u.id).sort()).toEqual(["D3", "D6"]);
    expect(r.unshared).toBe(2); // the two WP versions
  });

  it("honours a caller-supplied retention table", () => {
    const r = buildDocumentRegister(documents, {
      asOfDate: "2026-10-16",
      rules: [{ category: "other", years: 30, source: "House policy" }],
    });
    const minutes = r.retention.find((x) => x.id === "D6")!;
    expect(minutes.retentionYears).toBe(30);
    expect(minutes.expired).toBe(false);
    expect(minutes.source).toBe("House policy");
  });
});

describe("buildClientPortalView", () => {
  const documents: DocumentRecord[] = [
    doc({ id: "D1", category: "financial-statement", name: "FS-FY25.pdf", uploadedAt: "2025-05-01" }),
    doc({ id: "D2", category: "working-paper", name: "WP-1.xlsx", sharedWithClient: false }),
    doc({ id: "D3", category: "tax-return", name: "ITR-FY25.pdf", uploadedAt: "2025-07-01", signed: false }),
    doc({
      id: "D4",
      category: "other",
      name: "Other-client.pdf",
      clientId: "C2",
      clientName: "Beta Traders",
      uploadedAt: "2025-06-01",
    }),
  ];

  it("exposes only the documents shared with the client, grouped into folders", () => {
    const view = buildClientPortalView({ clientId: "C1", clientName: "Sharma Textiles Pvt Ltd" }, documents);
    expect(view.visibleDocumentIds).toEqual(["D1", "D3"]); // D2 unshared, D4 belongs to another client
    expect(view.folders.map((f) => f.category)).toEqual(["financial-statement", "tax-return"]);
    expect(view.sharedCount).toBe(2);
    expect(view.totalBytes).toBe(2_000);
  });

  it("produces the checklist of what is still awaited from the client", () => {
    const view = buildClientPortalView({ clientId: "C1", clientName: "Sharma Textiles Pvt Ltd" }, documents, {
      awaiting: ["kyc", "engagement-letter"],
    });
    expect(view.awaitingFromClient).toEqual(["kyc", "engagement-letter"]);
    expect(view.checklist).toEqual([
      "Upload / confirm the kyc for Sharma Textiles Pvt Ltd.",
      "Upload / confirm the engagement letter for Sharma Textiles Pvt Ltd.",
    ]);
  });

  it("returns an empty portal for a client with no shared documents", () => {
    const view = buildClientPortalView({ clientId: "C9", clientName: "Nobody" }, documents);
    expect(view.sharedCount).toBe(0);
    expect(view.folders).toEqual([]);
    expect(view.visibleDocumentIds).toEqual([]);
  });
});
