/**
 * Oracle tests for the DAX coverage wave: FIRSTDATE/LASTDATE, the
 * STARTOF…/ENDOF… boundary family, ISEMPTY and CONTAINS — every expectation
 * hand-computed from the same fixture table as dax.test.ts.
 *
 * Fixture (ISO dates, Amount):
 *   2023-01-10 East A 150   ← prior-year row
 *   2024-01-05 East A 100
 *   2024-01-20 East B 200
 *   2024-02-10 East A 50
 *   2024-02-15 West A 300
 *   2024-02-20 West B 100
 *   2024-03-01 West A 400   ← latest visible date
 */
import { evaluateMeasure, SUPPORTED_DAX_FUNCTIONS } from "@/lib/engine/dax";
import type { DaxModel } from "@/lib/engine/dax";

const model: DaxModel = {
  columns: ["Date", "Region", "Product", "Amount", "Qty", "Returned"],
  rows: [
    ["2024-01-05", "East", "A", 100, 2, false],
    ["2024-01-20", "East", "B", 200, 1, true],
    ["2024-02-10", "East", "A", 50, 1, false],
    ["2024-02-15", "West", "A", 300, 3, false],
    ["2024-02-20", "West", "B", 100, 2, true],
    ["2024-03-01", "West", "A", 400, 4, false],
    ["2023-01-10", "East", "A", 150, 1, false],
  ],
};

describe("DAX coverage — date boundaries", () => {
  test("FIRSTDATE / LASTDATE anchor on the visible date range", () => {
    // FIRSTDATE with no incoming filter = earliest date in the whole table.
    expect(evaluateMeasure(model, "CALCULATE(MIN([Date]), FIRSTDATE([Date]))")).toBe("2023-01-10");
    expect(evaluateMeasure(model, "CALCULATE(MAX([Date]), LASTDATE([Date]))")).toBe("2024-03-01");
    // Scoped by an incoming filter: East rows only → latest East date.
    expect(
      evaluateMeasure(model, "CALCULATE(MAX([Date]), LASTDATE([Date]))", [{ column: "Region", values: ["East"] }]),
    ).toBe("2024-02-10");
  });

  test("LASTDATE + sales on the last date", () => {
    // Sales on the latest date (2024-03-01, West A 400).
    expect(evaluateMeasure(model, "CALCULATE(SUM([Amount]), LASTDATE([Date]))")).toBe(400);
  });

  test("STARTOFMONTH / ENDOFMONTH bind to the period containing the latest date", () => {
    // Latest = 2024-03-01 → STARTOFMONTH resolves to 2024-03-01 itself (the
    // earliest date at-or-after 2024-03-01); ENDOFMONTH to the latest date
    // at-or-before 2024-03-31, which is also 2024-03-01 in this table.
    expect(evaluateMeasure(model, "CALCULATE(MIN([Date]), STARTOFMONTH([Date]))")).toBe("2024-03-01");
    expect(evaluateMeasure(model, "CALCULATE(MAX([Date]), ENDOFMONTH([Date]))")).toBe("2024-03-01");
    // Month-to-date amount via the boundary: everything in March 2024.
    expect(evaluateMeasure(model, "CALCULATE(SUM([Amount]), DATESMTD([Date]))")).toBe(400);
  });

  test("STARTOFQUARTER / ENDOFQUARTER cover Q1 2024 (Jan–Mar)", () => {
    // Q1 2024 amounts: 100 + 200 + 50 + 300 + 100 + 400 = 1150
    expect(evaluateMeasure(model, "CALCULATE(SUM([Amount]), STARTOFQUARTER([Date]))")).toBe(100); // 2024-01-05
    expect(evaluateMeasure(model, "CALCULATE(SUM([Amount]), ENDOFQUARTER([Date]))")).toBe(400); // 2024-03-01
  });

  test("STARTOFYEAR / ENDOFYEAR cover 2024", () => {
    expect(evaluateMeasure(model, "CALCULATE(MIN([Date]), STARTOFYEAR([Date]))")).toBe("2024-01-05");
    expect(evaluateMeasure(model, "CALCULATE(MAX([Date]), ENDOFYEAR([Date]))")).toBe("2024-03-01");
    // FY sales: all 2024 rows = 1150 (the 2023 row excluded).
    expect(evaluateMeasure(model, "CALCULATE(SUM([Amount]), DATESYTD([Date]))")).toBe(1150);
  });
});

describe("DAX coverage — existence & membership", () => {
  test("ISEMPTY distinguishes empty from non-empty contexts", () => {
    // No filter excludes everything → not empty.
    expect(evaluateMeasure(model, "ISEMPTY(ALL())")).toBe(false);
    // A filter that matches nothing: no West row is in Product C.
    expect(evaluateMeasure(model, 'ISEMPTY(FILTER(ALL(), [Region] = "West" && [Product] = "C"))')).toBe(true);
  });

  test("CONTAINS matches exact rows across multiple pairs", () => {
    expect(evaluateMeasure(model, 'CONTAINS(ALL(), [Region], "East", [Product], "B")')).toBe(true);
    expect(evaluateMeasure(model, 'CONTAINS(ALL(), [Region], "North")')).toBe(false);
    // Numeric value match: Amount 450 does not exist.
    expect(evaluateMeasure(model, "CONTAINS(ALL(), [Amount], 450)")).toBe(false);
    expect(evaluateMeasure(model, "CONTAINS(ALL(), [Amount], 300)")).toBe(true);
  });

  test("new functions appear in the supported list (autocomplete contract)", () => {
    for (const fn of ["FIRSTDATE", "LASTDATE", "STARTOFMONTH", "ENDOFQUARTER", "ISEMPTY", "CONTAINS"]) {
      expect(SUPPORTED_DAX_FUNCTIONS).toContain(fn);
    }
  });
});
