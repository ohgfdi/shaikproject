import {
  parseCreditDate,
  parseRupeesToPaise,
  parseTdsCsv,
  parseTdsJson,
  parseTdsStatement,
  reconcileTdsCredits,
  type TdsCreditRow,
} from "@/lib/engine/tds-credit-recon";

const HEADER =
  "TAN,Deductor Name,Section,Financial Year,Quarter,Date,Amount Paid,TDS Deducted,TDS Deposited";

function row(over: Partial<TdsCreditRow> & Pick<TdsCreditRow, "tan" | "section" | "tds">): TdsCreditRow {
  return {
    deductorName: "Deductor",
    financialYear: "2026-27",
    quarter: "Q1",
    date: "2026-07-15",
    amountPaid: 100_000_00,
    tdsDeposited: null,
    form: null,
    status: null,
    source: "26AS",
    ...over,
  };
}

describe("statement parsing", () => {
  it("parses a quoted CSV with rupee amounts and Indian dates", () => {
    const parsed = parseTdsCsv(
      `${HEADER}\nABCD12345E,"Alpha, Pvt Ltd",194C,2026-27,Q1,15/07/2026,"1,00,000","1,000","1000"`,
    );

    expect(parsed.warnings).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      tan: "ABCD12345E",
      deductorName: "Alpha, Pvt Ltd",
      section: "194C",
      quarter: "Q1",
      date: "2026-07-15",
      amountPaid: 10_000_000,
      tds: 100_000,
      tdsDeposited: 100_000,
    });
  });

  it("rejects a CSV without a TAN or TDS column", () => {
    expect(() => parseTdsCsv("Deductor,Amount\nAlpha,1000")).toThrow(/TAN column/);
  });

  it("keeps readable rows and warns about a bad date", () => {
    const parsed = parseTdsCsv(`${HEADER}\nABCD12345E,Alpha,194C,2026-27,Q1,31/02/2026,1000,100,100`);

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.date).toBeNull();
    expect(parsed.warnings.join(" ")).toMatch(/unreadable date/);
  });

  it("parses a TRACES deductors/entries JSON export and inherits the TAN", () => {
    const parsed = parseTdsJson(
      JSON.stringify({
        deductors: [
          {
            tan: "ABCD12345E",
            name: "Alpha Pvt Ltd",
            entries: [
              {
                section: "194C",
                financialYear: "2026-27",
                quarter: "Q1",
                date: "2026-07-15",
                amountPaid: 100000,
                taxDeducted: 1000,
              },
            ],
          },
        ],
      }),
    );

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ tan: "ABCD12345E", deductorName: "Alpha Pvt Ltd", tds: 100_000 });
    expect(parsed.rows[0]).toBeDefined();
  });

  it("parses AIS-style nested arrays", () => {
    const parsed = parseTdsJson(
      JSON.stringify({
        tds_tcs: {
          tds: [
            { tan: "ABCD12345E", section: "194J", amount: "50,000", tax: "5,000", quarter: "2", date: "2026-10-05" },
          ],
        },
      }),
    );

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toBeDefined();
    expect(parsed.rows[0]).toMatchObject({ section: "194J", quarter: "Q2", tds: 500_000 });
  });

  it("auto-detects JSON vs CSV and normalises TAN/section spacing", () => {
    const parsed = parseTdsStatement(`${HEADER}\n abcd 12345 e ,Alpha,194 C(b),2026-27,Q3,2026-09-30,1000,100,100`);
    expect(parsed.rows[0]?.tan).toBe("ABCD12345E");
    expect(parsed.rows[0]?.section).toBe("194C(B)");
  });

  it("parses dates and rupee amounts defensively", () => {
    expect(parseCreditDate("2026-11-08")).toBe("2026-11-08");
    expect(parseCreditDate("08-11-2026")).toBe("2026-11-08");
    expect(parseCreditDate("not-a-date")).toBeNull();
    expect(parseRupeesToPaise("₹ 1,23,456.78")).toBe(12_345_678);
    expect(parseRupeesToPaise("")).toBe(0);
  });
});

describe("reconcileTdsCredits", () => {
  it("matches a credit within ₹1 tolerance and reports a zero difference", () => {
    const recon = reconcileTdsCredits({
      statement: [row({ tan: "ABCD12345E", section: "194C", tds: 100_000 })],
      books: [row({ tan: "ABCD12345E", section: "194C", tds: 100_050, source: "books" })],
    });

    expect(recon.counts.matched).toBe(1);
    expect(recon.rows[0]?.verdict).toBe("matched");
    expect(recon.rows[0]?.difference).toBe(50);
    expect(recon.totals.netDifference).toBe(50);
  });

  it("flags a rate difference as an amount mismatch, not two absences", () => {
    const recon = reconcileTdsCredits({
      statement: [row({ tan: "ABCD12345E", section: "194C", tds: 1_000_00 })],
      books: [row({ tan: "ABCD12345E", section: "194C", tds: 1_200_00, source: "books" })],
    });

    expect(recon.counts["amount-mismatch"]).toBe(1);
    expect(recon.counts["missing-in-books"]).toBe(0);
    expect(recon.counts["missing-in-statement"]).toBe(0);
    expect(recon.totals.excessClaimTds).toBe(200_00);
    expect(recon.rows[0]?.notes.join(" ")).toMatch(/books higher/);
  });

  it("reports unclaimed and unsupported credits separately", () => {
    const recon = reconcileTdsCredits({
      statement: [
        row({ tan: "ABCD12345E", section: "194C", tds: 1_000_00 }),
        row({ tan: "WXYZ98765Q", section: "194J", tds: 500_00, quarter: "Q2", date: "2026-10-10" }),
      ],
      books: [
        row({ tan: "ABCD12345E", section: "194C", tds: 1_000_00, source: "books" }),
        row({ tan: "PQRS45678T", section: "194I", tds: 300_00, quarter: "Q3", source: "books" }),
      ],
    });

    expect(recon.counts.matched).toBe(1);
    expect(recon.counts["missing-in-books"]).toBe(1);
    expect(recon.counts["missing-in-statement"]).toBe(1);
    expect(recon.totals.unclaimedTds).toBe(500_00);
    expect(recon.totals.unsupportedTds).toBe(300_00);
    expect(recon.totals.netDifference).toBe(-200_00);
    expect(recon.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("excludes exact duplicates from the usable totals", () => {
    const recon = reconcileTdsCredits({
      statement: [
        row({ tan: "ABCD12345E", section: "194C", tds: 1_000_00 }),
        row({ tan: "ABCD12345E", section: "194C", tds: 1_000_00 }),
      ],
      books: [row({ tan: "ABCD12345E", section: "194C", tds: 1_000_00, source: "books" })],
    });

    expect(recon.counts.matched).toBe(1);
    expect(recon.counts["duplicate-statement"]).toBe(1);
    expect(recon.totals.statementTds).toBe(2_000_00);
    expect(recon.totals.duplicateStatementTds).toBe(1_000_00);
    expect(recon.totals.booksTds).toBe(1_000_00);
  });

  it("warns when TDS was deducted but not deposited in full", () => {
    const recon = reconcileTdsCredits({
      statement: [row({ tan: "ABCD12345E", section: "194C", tds: 1_000_00, tdsDeposited: 400_00 })],
      books: [row({ tan: "ABCD12345E", section: "194C", tds: 1_000_00, source: "books" })],
    });

    expect(recon.warnings.join(" ")).toMatch(/deducted but not deposited/);
  });

  it("does not pair different quarters even in the same bucket", () => {
    const recon = reconcileTdsCredits({
      statement: [row({ tan: "ABCD12345E", section: "194C", tds: 1_000_00, quarter: "Q1" })],
      books: [row({ tan: "ABCD12345E", section: "194C", tds: 2_000_00, quarter: "Q2", source: "books" })],
    });

    expect(recon.counts["amount-mismatch"]).toBe(0);
    expect(recon.counts["missing-in-books"]).toBe(1);
    expect(recon.counts["missing-in-statement"]).toBe(1);
  });
});
