import { DaxError } from "@/lib/engine/dax";
import type { DaxModel } from "@/lib/engine/dax";
import {
  materializeStarModel,
  evaluateMultiMeasure,
  evaluateMultiMeasureByCategory,
  resolveColumnName,
} from "@/lib/engine/dax-multi";

/**
 * Star schema fixture. All expected numbers are hand-computed from these
 * rows so the tests prove engine correctness (repo oracle convention).
 *
 * FACT Sales (7 rows):
 *   Date       CustomerId  Amount  Qty
 *   2024-01-05 C1          100     2
 *   2024-01-20 C2          200     1
 *   2024-02-10 C1          50      1
 *   2024-02-15 C3          300     3
 *   2024-02-20 C1          100     2
 *   2024-03-01 C2          400     4
 *   2023-01-10 C9          150     1   ← orphan key (C9 not in DimCustomer)
 *
 * DIM DimCustomer:
 *   CustomerId  Segment   Region
 *   C1          VIP       North
 *   C2          Regular   South
 *   C3          VIP       North
 */
const fact: DaxModel = {
  columns: ["Date", "CustomerId", "Amount", "Qty"],
  rows: [
    ["2024-01-05", "C1", 100, 2],
    ["2024-01-20", "C2", 200, 1],
    ["2024-02-10", "C1", 50, 1],
    ["2024-02-15", "C3", 300, 3],
    ["2024-02-20", "C1", 100, 2],
    ["2024-03-01", "C2", 400, 4],
    ["2023-01-10", "C9", 150, 1],
  ],
};

const dimCustomer: DaxModel = {
  columns: ["CustomerId", "Segment", "Region"],
  rows: [
    ["C1", "VIP", "North"],
    ["C2", "Regular", "South"],
    ["C3", "VIP", "North"],
  ],
};

const starInput = {
  fact,
  dimensions: [
    {
      name: "DimCustomer",
      model: dimCustomer,
      fromColumn: "CustomerId",
      toColumn: "CustomerId",
    },
  ],
};

/** Hand check: VIP = C1 (100+50+100) + C3 (300) = 550. Regular = C2 (200+400) = 600. Orphan C9 = 150. */
const VIP_TOTAL = 550;
const REGULAR_TOTAL = 600;
const ALL_TOTAL = 1300;

describe("materializeStarModel", () => {
  test("propagates dimension columns onto fact rows via the relationship", () => {
    const star = materializeStarModel(starInput);
    expect(star.model.columns).toContain("DimCustomer.Segment");
    expect(star.model.columns).toContain("DimCustomer.Region");
    expect(star.model.columns).toContain("DimCustomer.CustomerId");
    // Row 0 = C1 → VIP / North (first 7 cols: fact + customer dim; the auto
    // DimDate columns follow and are pinned by the calendar test below).
    expect(star.model.rows[0]!.slice(0, 7)).toEqual(["2024-01-05", "C1", 100, 2, "C1", "VIP", "North"]);
    // The auto date dimension materializes its calendar row onto the fact row.
    expect(star.model.columns).toContain("DimDate.date");
    expect(star.model.rows[0]!.slice(7)).toEqual([20240105, "2024-01-05", 2024, 1, 1, "January", 1, 5, 2024, "FY-Q1"]);
    // Orphan row keeps ALL customer-dim values BLANK — including the dim's
    // key column, since no dimension row matches (exact Power BI semantics).
    const orphan = star.model.rows[6]!;
    expect(orphan.slice(0, 7)).toEqual(["2023-01-10", "C9", 150, 1, null, null, null]);
    expect(orphan.slice(7)).toEqual([20230110, "2023-01-10", 2023, 1, 1, "January", 2, 2, 2023, "FY-Q1"]);
  });

  test("exposes unambiguous plain dimension names via colAliases; collisions must be qualified", () => {
    const star = materializeStarModel(starInput);
    expect(star.colAliases["Segment"]).toBe("DimCustomer.Segment");
    expect(star.colAliases["Region"]).toBe("DimCustomer.Region");
    // CustomerId exists on both fact and dim → NOT aliased; must be qualified.
    expect(star.colAliases["CustomerId"]).toBeUndefined();
    expect(resolveColumnName(star, "Segment")).toBe("DimCustomer.Segment");
    expect(resolveColumnName(star, "CustomerId")).toBe("CustomerId");
  });

  test("wires the auto date calendar over the fact's ISO date column", () => {
    const star = materializeStarModel(starInput);
    expect(star.dateColumn).toBe("Date");
    expect(star.model.calendar?.dateColumn).toBe("Date");
    // Full-year expansion starts the prior year (so SAMEPERIODLASTYEAR sees a
    // full prior period): 2022-01-01 … 2024-12-31, contiguous, incl. sparse gaps
    const dates = star.model.calendar!.dates;
    expect(dates[0]).toBe("2022-01-01");
    expect(dates[dates.length - 1]).toBe("2024-12-31");
    expect(dates).toHaveLength(1096); // 2022: 365 + 2023: 365 + 2024: 366 (leap)
    expect(dates).toContain("2024-06-15"); // a date absent from the sparse fact
  });

  test("rejects duplicate dimension names and bad join columns", () => {
    expect(() =>
      materializeStarModel({
        fact,
        dimensions: [
          { name: "D", model: dimCustomer, fromColumn: "CustomerId", toColumn: "CustomerId" },
          { name: "D", model: dimCustomer, fromColumn: "CustomerId", toColumn: "CustomerId" },
        ],
      }),
    ).toThrow(DaxError);
    expect(() =>
      materializeStarModel({
        fact,
        dimensions: [{ name: "DimX", model: dimCustomer, fromColumn: "Nope", toColumn: "CustomerId" }],
      }),
    ).toThrow(/not a column of the fact table/);
  });
});

describe("evaluateMultiMeasure — star-model DAX", () => {
  test("aggregations over the fact", () => {
    expect(evaluateMultiMeasure(starInput, "SUM([Amount])")).toBe(ALL_TOTAL);
    expect(evaluateMultiMeasure(starInput, "COUNTROWS(ALL())")).toBe(7);
    expect(evaluateMultiMeasure(starInput, "DISTINCTCOUNT([CustomerId])")).toBe(4);
  });

  test("RELATED() inside an iterator returns the joined dimension value", () => {
    // VIP rows: 100+50+100+300 = 550
    expect(
      evaluateMultiMeasure(starInput, "SUMX(ALL(), IF(RELATED('DimCustomer'[Segment]) = \"VIP\", [Amount], 0))"),
    ).toBe(VIP_TOTAL);
  });

  test("table-qualified column references resolve to the joined dimension", () => {
    expect(evaluateMultiMeasure(starInput, "CALCULATE(SUM([Amount]), 'DimCustomer'[Segment] = \"VIP\")")).toBe(
      VIP_TOTAL,
    );
    expect(evaluateMultiMeasure(starInput, "CALCULATE(SUM([Amount]), 'DimCustomer'[Region] = \"South\")")).toBe(
      REGULAR_TOTAL,
    );
  });

  test("unqualified plain dimension names resolve through the alias map", () => {
    expect(evaluateMultiMeasure(starInput, 'CALCULATE(SUM([Amount]), [Segment] = "VIP")')).toBe(VIP_TOTAL);
  });

  test("incoming filters on dimension columns restrict the filter context", () => {
    // VIP rows only: 550
    expect(evaluateMultiMeasure(starInput, "SUM([Amount])", [{ column: "DimCustomer.Segment", values: ["VIP"] }])).toBe(
      VIP_TOTAL,
    );
    // Plain alias form works too
    expect(evaluateMultiMeasure(starInput, "SUM([Amount])", [{ column: "Segment", values: ["VIP"] }])).toBe(VIP_TOTAL);
  });

  test("orphan fact rows keep their measures (BLANK dimension attrs)", () => {
    // Removing the Segment filter must bring the C9 orphan row back: 1300
    expect(
      evaluateMultiMeasure(starInput, "CALCULATE(SUM([Amount]), ALL('DimCustomer'[Segment]))", [
        { column: "DimCustomer.Segment", values: ["VIP"] },
      ]),
    ).toBe(ALL_TOTAL);
  });

  test("by-category breakout over a dimension attribute", () => {
    const series = evaluateMultiMeasureByCategory(starInput, "SUM([Amount])", "DimCustomer.Segment");
    const vip = series.find((s) => s.category === "VIP");
    const reg = series.find((s) => s.category === "Regular");
    expect(vip?.value).toBe(VIP_TOTAL);
    expect(reg?.value).toBe(REGULAR_TOTAL);
    // Orphan row: BLANK Segment → category "" carries its own 150 (Power BI
    // shows this as "(Blank)"; filtering category "" must match BLANK cells).
    const blank = series.find((s) => s.category === "");
    expect(blank?.value).toBe(150);
  });

  test("time intelligence uses the auto date calendar on sparse facts", () => {
    // YTD 2024 through Mar: 100+200+50+300+100+400 = 1150 (2023 row excluded)
    expect(evaluateMultiMeasure(starInput, "TOTALYTD(SUM([Amount]), [Date])")).toBe(1150);
  });

  test("SAMEPERIODLASTYEAR over the contiguous calendar", () => {
    // Filter context Feb 2024 → same period last year = Feb 2023.
    // The fact's only 2023 row is 2023-01-10 (January), so Feb 2023 has no rows.
    const sly = evaluateMultiMeasure(starInput, "CALCULATE(SUM([Amount]), SAMEPERIODLASTYEAR([Date]))", [
      { column: "Date", values: ["2024-02-10", "2024-02-15", "2024-02-20"] },
    ]);
    expect(sly).toBe(0);
  });

  test("SAMEPERIODLASTYEAR finds prior-year rows when they exist", () => {
    // Filter context Jan 2024 → Jan 2023; the orphan 2023-01-10 row is still a fact row.
    const sly = evaluateMultiMeasure(starInput, "CALCULATE(SUM([Amount]), SAMEPERIODLASTYEAR([Date]))", [
      { column: "Date", values: ["2024-01-05", "2024-01-20"] },
    ]);
    expect(sly).toBe(150);
  });

  test("errors name the problem instead of guessing (no silent wrong answers)", () => {
    expect(() => evaluateMultiMeasure(starInput, "SUM([NoSuchColumn])")).toThrow(DaxError);
    expect(() => evaluateMultiMeasureByCategory(starInput, "SUM([Amount])", "NotAColumn")).toThrow(DaxError);
  });
});
