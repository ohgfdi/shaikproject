import { evaluateMeasure, evaluateMeasureByCategory, validateMeasure, SUPPORTED_DAX_FUNCTIONS } from "@/lib/engine/dax";
import type { DaxModel } from "@/lib/engine/dax";

/**
 * Sales fact table with ISO dates. All expected numbers below are
 * hand-computed from this table so the tests prove engine correctness.
 *
 * Date       Region   Product  Amount  Qty  Returned
 * 2024-01-05 East     A        100     2    false
 * 2024-01-20 East     B        200     1    true
 * 2024-02-10 East     A         50     1    false
 * 2024-02-15 West     A        300     3    false
 * 2024-02-20 West     B        100     2    true
 * 2024-03-01 West     A        400     4    false
 * 2023-01-10 East     A        150     1    false   (prior year for YoY)
 */
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

describe("DAX engine — exact filter-context results", () => {
  test("basic aggregations", () => {
    expect(evaluateMeasure(model, "SUM([Amount])")).toBe(1300);
    expect(evaluateMeasure(model, "AVERAGE([Amount])")).toBeCloseTo(1300 / 7, 10);
    expect(evaluateMeasure(model, "COUNTROWS(ALL())")).toBe(7);
    expect(evaluateMeasure(model, "DISTINCTCOUNT([Region])")).toBe(2);
    expect(evaluateMeasure(model, "MIN([Amount])")).toBe(50);
    expect(evaluateMeasure(model, "MAX([Amount])")).toBe(400);
  });

  test("incoming filters restrict the filter context", () => {
    // East rows: 100 + 200 + 50 + 150 (the 2023 East row) = 500
    expect(evaluateMeasure(model, "SUM([Amount])", [{ column: "Region", values: ["East"] }])).toBe(500);
    expect(
      evaluateMeasure(model, "SUM([Amount])", [
        { column: "Region", values: ["East"] },
        { column: "Product", values: ["A"] },
      ]),
    ).toBe(300); // 100 + 50 + 150
  });

  test("CALCULATE overrides filters", () => {
    // All-region sales but filtered to East via CALCULATE (2023 row included)
    expect(evaluateMeasure(model, 'CALCULATE(SUM([Amount]), [Region] = "East")')).toBe(500);
    expect(evaluateMeasure(model, 'CALCULATE(SUM([Amount]), [Region] = "East", [Product] = "B")')).toBe(200);
    // Numeric predicates
    expect(evaluateMeasure(model, "CALCULATE(SUM([Amount]), [Amount] > 150)")).toBe(900); // 200+300+400
  });

  test("CALCULATE with ALL removes filters (denominator pattern)", () => {
    // % of total: East sales (500, incl. 2023) over all sales (1300)
    const pct = evaluateMeasure(
      model,
      'DIVIDE(CALCULATE(SUM([Amount]), [Region] = "East"), CALCULATE(SUM([Amount]), ALL([Region])))',
    );
    expect(pct).toBeCloseTo(500 / 1300, 10);
  });

  test("iterators compute row by row", () => {
    // SUMX price*qty: 100*2 + 200*1 + 50*1 + 300*3 + 100*2 + 400*4 + 150*1 = 3300
    expect(evaluateMeasure(model, "SUMX(ALL(), [Amount] * [Qty])")).toBe(3300);
    // AVERAGEX over non-blank amounts = 1300/7
    expect(evaluateMeasure(model, "AVERAGEX(ALL(), [Amount])")).toBeCloseTo(1300 / 7, 10);
  });

  test("time intelligence: TOTALYTD matches manual computation", () => {
    // YTD through 2024-03-01: Jan(300) + Feb(450) + Mar(400) = 1150
    // (the 2023 row is outside YTD 2024)
    expect(evaluateMeasure(model, "TOTALYTD(SUM([Amount]), [Date])")).toBe(1150);
  });

  test("TOTALYTD respects incoming filter context", () => {
    // YTD for West only: 300 + 100 + 400 = 800
    expect(evaluateMeasure(model, "TOTALYTD(SUM([Amount]), [Date])", [{ column: "Region", values: ["West"] }])).toBe(
      800,
    );
  });

  test("SAMEPERIODLASTYEAR shifts the visible dates", () => {
    // Slicer equivalent: filter context is Jan-Feb 2024. Same period last year
    // = Jan-Feb 2023; the fact table has one 2023 row: 2023-01-10 → 150.
    const val = evaluateMeasure(model, "CALCULATE(SUM([Amount]), SAMEPERIODLASTYEAR([Date]))", [
      { column: "Date", values: ["2024-01-05", "2024-01-20", "2024-02-10", "2024-02-15", "2024-02-20"] },
    ]);
    expect(val).toBe(150);
  });

  test("PREVIOUSMONTH picks the prior month's rows", () => {
    // Filter context is March 2024 (via a nested CALCULATE intersection),
    // then PREVIOUSMONTH widens to February: 50+300+100 = 450.
    const val = evaluateMeasure(
      model,
      'CALCULATE(CALCULATE(SUM([Amount]), PREVIOUSMONTH([Date])), [Date] >= "2024-03-01", [Date] <= "2024-03-31")',
    );
    expect(val).toBe(450);
  });

  test("by-category evaluation returns one value per category", () => {
    const series = evaluateMeasureByCategory(model, "SUM([Amount])", "Region");
    const east = series.find((s) => s.category === "East");
    const west = series.find((s) => s.category === "West");
    expect(east?.value).toBe(500); // 100+200+50+150
    expect(west?.value).toBe(800); // 300+100+400
    expect(series).toHaveLength(2);
  });

  test("CALCULATE + nested FILTER emulates value-level date filters", () => {
    // March 2024 sales via FILTER over ALL dates: 400
    const val = evaluateMeasure(
      model,
      'CALCULATE(SUM([Amount]), FILTER(ALL([Date]), [Date] >= "2024-03-01" && [Date] <= "2024-03-31"))',
    );
    expect(val).toBe(400);
  });

  test("IF and SWITCH evaluate branch outcomes", () => {
    expect(evaluateMeasure(model, 'IF(SUM([Amount]) > 1000, "big", "small")')).toBe("big");
    expect(evaluateMeasure(model, 'SWITCH(TRUE() , 1 = 1, "yes")')).toBe("yes");
  });

  test("RANKX ranks a category within its peers", () => {
    // Region totals: West 800, East 500. Ranking East against ALL regions
    // (VALUES would only see East after the filter) → rank 2 descending.
    const rank = evaluateMeasure(model, 'CALCULATE(RANKX(ALL([Region]), SUM([Amount])), [Region] = "East")');
    expect(rank).toBe(2);
  });

  test("DIVIDE returns alternate on zero denominator instead of error", () => {
    expect(evaluateMeasure(model, "DIVIDE(10, 0, -1)")).toBe(-1);
    expect(evaluateMeasure(model, "DIVIDE(10, 2)")).toBe(5);
  });

  test("validateMeasure rejects malformed expressions", () => {
    expect(validateMeasure("SUM([Amount]").length).toBeGreaterThan(0);
    expect(validateMeasure("SUM([Amount])")).toHaveLength(0);
    expect(validateMeasure("FROBNICATE([Amount])")).toHaveLength(0); // parses; eval will error
  });

  test("unknown functions raise a DaxError naming support", () => {
    expect(() => evaluateMeasure(model, "FROBNICATE([Amount])")).toThrow(/not supported/);
  });

  test("SUPPORTED_DAX_FUNCTIONS includes time intelligence", () => {
    expect(SUPPORTED_DAX_FUNCTIONS).toContain("CALCULATE");
    expect(SUPPORTED_DAX_FUNCTIONS).toContain("SAMEPERIODLASTYEAR");
  });
});
