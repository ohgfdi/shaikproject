import { auditEntriesToCsv, guardCsvField, type AuditCsvEntry } from "@/lib/engine/audit-csv";

describe("audit CSV export", () => {
  const base: AuditCsvEntry = {
    createdAt: "2026-09-23T10:00:00.000Z",
    type: "DATASET_UPLOADED",
    message: "Uploaded Q3 revenue.csv",
    actorName: "Ada Analyst",
    actorEmail: "ada@example.com",
    projectName: "Meridian",
    security: false,
  };

  it("produces RFC-4180 rows with a header", () => {
    const csv = auditEntriesToCsv([base]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("When (UTC),Type,Actor,Actor email,Project,Event,Security-relevant");
    expect(lines[1]).toContain("DATASET_UPLOADED");
    expect(lines[1]).toContain("ada@example.com");
  });

  it("quotes fields containing commas and doubles embedded quotes", () => {
    const csv = auditEntriesToCsv([{ ...base, message: 'Report "Q3, final" exported' }]);
    expect(csv).toContain('"Report ""Q3, final"" exported"');
  });

  it("guards formula injection with a leading apostrophe", () => {
    expect(guardCsvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(guardCsvField("@cmd")).toBe("'@cmd");
    expect(guardCsvField("+1")).toBe("'+1");
    expect(guardCsvField("normal text")).toBe("normal text");
  });

  it("marks security-relevant events and nulls as em dashes", () => {
    const csv = auditEntriesToCsv([{ ...base, actorName: null, security: true }]);
    const row = csv.trim().split("\r\n")[1]!;
    expect(row).toContain(",—,");
    expect(row.endsWith(",yes")).toBe(true);
  });

  it("is deterministic and uses CRLF line endings", () => {
    const a = auditEntriesToCsv([base, base]);
    const b = auditEntriesToCsv([base, base]);
    expect(a).toBe(b);
    expect(a.includes("\r\n")).toBe(true);
  });
});
