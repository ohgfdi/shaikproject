import {
  normaliseStatementDate,
  parseStatementAmount,
  parseStatementCsv,
} from "@/lib/engine/bank-statement-csv";

describe("bank statement CSV", () => {
  it("normalises the date forms banks actually export", () => {
    expect(normaliseStatementDate("2026-03-31")).toBe("2026-03-31");
    expect(normaliseStatementDate("31/03/2026")).toBe("2026-03-31");
    expect(normaliseStatementDate("1-4-2026")).toBe("2026-04-01");
    expect(normaliseStatementDate("31/13/2026")).toBeNull();
    expect(normaliseStatementDate("March 31")).toBeNull();
  });

  it("applies the Dr/Cr marker to the bank sign convention", () => {
    expect(parseStatementAmount("1234.50 Cr")).toBe(123450);
    expect(parseStatementAmount("Cr 1,234.50")).toBe(123450);
    expect(parseStatementAmount("1234.50 Dr")).toBe(-123450);
    // Brackets are a debit in bankers' notation; a bare number is a credit.
    expect(parseStatementAmount("(1234.50)")).toBe(-123450);
    expect(parseStatementAmount("-1234.50")).toBe(-123450);
    expect(parseStatementAmount("1,23,456.78")).toBe(12345678);
    expect(parseStatementAmount("not money")).toBeNull();
  });

  it("parses a statement, skipping the header and keeping quoted narrations", () => {
    const csv = [
      "Date,Narration,Amount,Reference",
      '2026-03-01,"NEFT from Sharma & Co, invoice 42",25000.00,UTR001',
      "02/03/2026,Cheque 004512 paid,1500.50 Dr,004512",
      "03/03/2026,Bank charges,25 Dr,",
    ].join("\n");

    const { rows, errors } = parseStatementCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { date: "2026-03-01", narration: "NEFT from Sharma & Co, invoice 42", amount: 2500000, reference: "UTR001" },
      { date: "2026-03-02", narration: "Cheque 004512 paid", amount: -150050, reference: "004512" },
      { date: "2026-03-03", narration: "Bank charges", amount: -2500, reference: null },
    ]);
  });

  it("reports every unparseable row instead of dropping it", () => {
    const csv = ["2026-03-01,Opening,1000 Cr", "bad-date,Cheque,100 Dr", "2026-03-02,Zero line,0"].join("\n");

    const { rows, errors } = parseStatementCsv(csv);
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([
      { line: 2, message: "“bad-date” is not a recognisable date." },
      { line: 3, message: "A zero-value bank line carries no information." },
    ]);
  });

  it("flags a line with too few columns", () => {
    const { rows, errors } = parseStatementCsv("2026-03-01,Only narration");
    expect(rows).toHaveLength(0);
    expect(errors[0]).toEqual({ line: 1, message: "Expected date, narration and amount columns." });
  });
});
