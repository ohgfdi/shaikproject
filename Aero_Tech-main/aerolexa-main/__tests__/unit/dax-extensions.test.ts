import { evaluateMeasure, evaluateMeasureByCategory, SUPPORTED_DAX_FUNCTIONS } from "@/lib/engine/dax";
import type { DaxModel } from "@/lib/engine/dax";

/**
 * Oracle tests for the extended DAX engine — VAR/RETURN, IN, literal tables,
 * CALCULATETABLE, TOPN, TREATAS, LOOKUPVALUE, stats/maths/text families and
 * the new time-intelligence functions.
 *
 * Every expected number is hand-computed from this fixture:
 *
 * Date       Region   Product  Amount  Qty
 * 2024-01-05 East     A        100     2
 * 2024-01-20 East     B        200     1
 * 2024-02-10 East     A         50     1
 * 2024-02-15 West     A        300     3
 * 2024-02-20 West     B        100     2
 * 2024-03-01 West     A        400     4
 * 2023-01-10 East     A        150     1
 */
const model: DaxModel = {
  columns: ["Date", "Region", "Product", "Amount", "Qty"],
  rows: [
    ["2024-01-05", "East", "A", 100, 2],
    ["2024-01-20", "East", "B", 200, 1],
    ["2024-02-10", "East", "A", 50, 1],
    ["2024-02-15", "West", "A", 300, 3],
    ["2024-02-20", "West", "B", 100, 2],
    ["2024-03-01", "West", "A", 400, 4],
    ["2023-01-10", "East", "A", 150, 1],
  ],
};

describe("DAX extensions — VAR/RETURN", () => {
  test("basic variable binds and is reused", () => {
    // Total = 1300; East = 500 → 500/1300 ≈ 0.3846
    const v = evaluateMeasure(
      model,
      'VAR Total = SUM([Amount]) VAR East = CALCULATE(SUM([Amount]), [Region] = "East") RETURN DIVIDE(East, Total)',
    );
    expect(v).toBeCloseTo(500 / 1300, 10);
  });

  test("variables evaluate eagerly in the surrounding context", () => {
    // Base binds SUM in the full context (1300) even though RETURN narrows to West.
    const v = evaluateMeasure(model, 'VAR Base = SUM([Amount]) RETURN CALCULATE(Base, [Region] = "West")');
    // West = 300+100+400 = 800; the variable was already computed → 1300.
    expect(v).toBe(1300);
  });

  test("later variables can reference earlier ones", () => {
    // Revenue 1300, Cost proxy Qty*10 = 140 → margin 1300-140 = 1160
    const v = evaluateMeasure(
      model,
      "VAR Rev = SUM([Amount]) VAR QtyTotal = SUMX(ALL(), [Qty]) VAR Cost = QtyTotal * 10 RETURN Rev - Cost",
    );
    expect(v).toBe(1160); // Qty total = 14 → Cost 140
  });

  test("VAR inside iterator rows", () => {
    // Per-row margin: Amount - Qty*20 → (100-40)+(200-20)+(50-20)+(300-60)+(100-40)+(400-80)+(150-20)
    //   = 60+180+30+240+60+320+130 = 1020
    const v = evaluateMeasure(model, "SUMX(ALL(), VAR m = [Qty] * 20 RETURN [Amount] - m)");
    expect(v).toBe(1020);
  });

  test("nested VAR scopes shadow correctly", () => {
    // Inner VAR X shadows outer: outer X=1, inner X=2 → SUM = 1 + 2 = 3
    const v = evaluateMeasure(model, "VAR X = 1 RETURN X + (VAR X = 2 RETURN X)");
    expect(v).toBe(3);
  });

  test("unknown variable raises a clear error", () => {
    expect(() => evaluateMeasure(model, "RETURN Nope + 1")).toThrow(/Unknown identifier/);
  });
});

describe("DAX extensions — IN and literal lists", () => {
  test("scalar IN evaluates membership", () => {
    // East rows: 100+200+50+150 = 500
    expect(evaluateMeasure(model, 'CALCULATE(SUM([Amount]), [Region] IN { "East" })')).toBe(500);
    expect(evaluateMeasure(model, 'CALCULATE(SUM([Amount]), [Region] IN { "East", "West" })')).toBe(1300);
    expect(evaluateMeasure(model, 'CALCULATE(SUM([Amount]), [Region] IN { "North" })')).toBe(0);
  });

  test("scalar IN in IF", () => {
    expect(evaluateMeasure(model, 'IF("East" IN { "East", "West" }, 1, 0)')).toBe(1);
    expect(evaluateMeasure(model, 'IF("N" IN { "East", "West" }, 1, 0)')).toBe(0);
  });

  test("numeric IN with mixed comparisons", () => {
    expect(evaluateMeasure(model, "CALCULATE(SUM([Amount]), [Amount] IN { 50, 100 })")).toBe(100 + 100 + 50); // 250
  });
});

describe("DAX extensions — CALCULATETABLE / TOPN / TREATAS", () => {
  test("CALCULATETABLE over ALL: filter args are overridden by ALL's filter removal", () => {
    // Honest DAX semantics: ALL() as the table expression removes filters in
    // the MODIFIED context, so the [Region]="East" filter arg has no effect.
    // This documents the interaction rather than hiding it.
    expect(evaluateMeasure(model, 'COUNTROWS(CALCULATETABLE(ALL(), [Region] = "East"))')).toBe(7);
  });

  test("COUNTROWS over CALCULATETABLE(VALUES(Region)) respects filter args", () => {
    expect(evaluateMeasure(model, 'COUNTROWS(CALCULATETABLE(VALUES([Region]), [Region] = "East"))')).toBe(1);
    expect(evaluateMeasure(model, "COUNTROWS(CALCULATETABLE(VALUES([Region])))")).toBe(2);
  });

  test("CALCULATETABLE + COUNTROWS over a column table", () => {
    // VALUES(Region) in the East context = 1 row.
    expect(evaluateMeasure(model, 'COUNTROWS(CALCULATETABLE(VALUES([Region]), [Region] = "East"))')).toBe(1);
  });

  test("TOPN keeps the top n rows by order expression", () => {
    // Top 2 amounts: 400, 300.
    expect(evaluateMeasure(model, "SUMX(TOPN(2, ALL(), [Amount]), [Amount])")).toBe(700);
    // Top 1: just 400.
    expect(evaluateMeasure(model, "SUMX(TOPN(1, ALL(), [Amount]), [Amount])")).toBe(400);
  });

  test("TOPN is tie-inclusive", () => {
    // Amounts desc: 400, 300, 200, 150, 100, 100, 50. Top 4 → boundary 150;
    // no other row ties 150 → exactly 400+300+200+150 = 1050.
    expect(evaluateMeasure(model, "SUMX(TOPN(4, ALL(), [Amount]), [Amount])")).toBe(1050);
  });

  test("TOPN ascending order is tie-inclusive", () => {
    // Amounts asc: 50, 100, 100, 150, 200, 300, 400. Bottom 2 → 50, 100, but
    // the second 100 ties the boundary and is included → 50+100+100 = 250.
    expect(evaluateMeasure(model, "SUMX(TOPN(2, ALL(), [Amount], TRUE), [Amount])")).toBe(250);
  });

  test("TREATAS applies literal values as filters", () => {
    expect(evaluateMeasure(model, 'CALCULATE(SUM([Amount]), TREATAS({ "East" }, [Region]))')).toBe(500);
    expect(evaluateMeasure(model, 'CALCULATE(SUM([Amount]), TREATAS({ "East", "West" }, [Region]))')).toBe(1300);
  });

  test("TREATAS over VALUES", () => {
    // VALUES(Product) visible in East-A context = {A}; applied to Region — no
    // match on "A" → 0 rows... but as a filter on Region, {"A"} matches nothing.
    const v = evaluateMeasure(
      model,
      'CALCULATE(CALCULATE(SUM([Amount]), TREATAS(VALUES([Product]), [Region])), [Region] = "East", [Product] = "A")',
    );
    expect(v).toBe(0);
  });
});

describe("DAX extensions — LOOKUPVALUE and info functions", () => {
  test("LOOKUPVALUE finds the first match", () => {
    // Product B first appears on 2024-01-20.
    expect(evaluateMeasure(model, 'LOOKUPVALUE([Date], [Product], "B")')).toBe("2024-01-20");
    expect(evaluateMeasure(model, 'LOOKUPVALUE([Amount], [Date], "2024-03-01")')).toBe(400);
  });

  test("LOOKUPVALUE alternate result on no match", () => {
    expect(evaluateMeasure(model, 'LOOKUPVALUE([Amount], [Region], "Nowhere", 0)')).toBe(0);
    expect(evaluateMeasure(model, 'LOOKUPVALUE([Amount], [Region], "Nowhere")')).toBe(null);
  });

  test("ISNUMBER / ISTEXT / ISLOGICAL", () => {
    expect(evaluateMeasure(model, "ISNUMBER(SUM([Amount]))")).toBe(true);
    expect(evaluateMeasure(model, "ISTEXT(MAX([Region]))")).toBe(true);
    expect(evaluateMeasure(model, "ISLOGICAL(TRUE())")).toBe(true);
    expect(evaluateMeasure(model, "ISNUMBER(MAX([Region]))")).toBe(false);
  });
});

describe("DAX extensions — statistics", () => {
  test("MEDIAN hand-computed", () => {
    // Amounts sorted: 50, 100, 100, 150, 200, 300, 400 → median 150
    expect(evaluateMeasure(model, "MEDIAN([Amount])")).toBe(150);
  });

  test("PRODUCT hand-computed", () => {
    // Qty values 2,1,1,3,2,4,1 → 2*1*1*3*2*4*1 = 48
    expect(evaluateMeasure(model, "PRODUCT([Qty])")).toBe(48);
  });

  test("COUNTBLANK counts empty cells", () => {
    const m: DaxModel = {
      columns: ["A", "B"],
      rows: [
        [1, null],
        [2, ""],
        [3, 5],
        [4, null],
      ],
    };
    expect(evaluateMeasure(m, "COUNTBLANK([B])")).toBe(3);
  });

  test("VAR.P / VAR.S population vs sample", () => {
    // Qty values: 2,1,1,3,2,4,1 → mean 2; squared devs: 0,1,1,1,0,4,1 = 8
    expect(evaluateMeasure(model, "VAR.P([Qty])")).toBeCloseTo(8 / 7, 10);
    expect(evaluateMeasure(model, "VAR.S([Qty])")).toBeCloseTo(8 / 6, 10);
    expect(evaluateMeasure(model, "STDEV.P([Qty])")).toBeCloseTo(Math.sqrt(8 / 7), 10);
    expect(evaluateMeasure(model, "STDEV.S([Qty])")).toBeCloseTo(Math.sqrt(8 / 6), 10);
  });

  test("statistics respect the filter context", () => {
    // West amounts 300,100,400 → median 300
    expect(evaluateMeasure(model, "MEDIAN([Amount])", [{ column: "Region", values: ["West"] }])).toBe(300);
  });
});

describe("DAX extensions — maths", () => {
  test("ROUND family", () => {
    expect(evaluateMeasure(model, "ROUND(2.567, 2)")).toBe(2.57);
    expect(evaluateMeasure(model, "ROUNDUP(2.1, 0)")).toBe(3);
    expect(evaluateMeasure(model, "ROUNDDOWN(2.9, 0)")).toBe(2);
    expect(evaluateMeasure(model, "TRUNC(-2.9)")).toBe(-2);
    expect(evaluateMeasure(model, "INT(-2.1)")).toBe(-3);
  });

  test("MOD keeps the divisor's sign", () => {
    expect(evaluateMeasure(model, "MOD(7, 3)")).toBe(1);
    expect(evaluateMeasure(model, "MOD(-7, 3)")).toBe(2);
  });

  test("FLOOR / CEILING with significance", () => {
    expect(evaluateMeasure(model, "FLOOR(7, 3)")).toBe(6);
    expect(evaluateMeasure(model, "CEILING(7, 3)")).toBe(9);
    expect(evaluateMeasure(model, "FLOOR(2.5)")).toBe(2);
    expect(evaluateMeasure(model, "CEILING(2.5)")).toBe(3);
  });

  test("SQRT / POWER / EXP / LN / LOG", () => {
    expect(evaluateMeasure(model, "SQRT(16)")).toBe(4);
    expect(evaluateMeasure(model, "POWER(2, 10)")).toBe(1024);
    expect(evaluateMeasure(model, "EXP(0)")).toBe(1);
    expect(evaluateMeasure(model, "LN(EXP(3))")).toBeCloseTo(3, 10);
    expect(evaluateMeasure(model, "LOG(1000)")).toBeCloseTo(3, 10);
    expect(evaluateMeasure(model, "LOG(8, 2)")).toBeCloseTo(3, 10);
  });

  test("SQRT of a negative is an explicit error (no silent NaN)", () => {
    expect(() => evaluateMeasure(model, "SQRT(-1)")).toThrow(/negative/);
  });

  test("XOR and COALESCE", () => {
    expect(evaluateMeasure(model, "XOR(TRUE(), FALSE())")).toBe(true);
    expect(evaluateMeasure(model, "XOR(TRUE(), TRUE())")).toBe(false);
    expect(evaluateMeasure(model, "COALESCE(BLANK(), BLANK(), 7)")).toBe(7);
  });
});

describe("DAX extensions — text", () => {
  test("LEN / LEFT / RIGHT / MID", () => {
    expect(evaluateMeasure(model, 'LEN("Ledgerly")')).toBe(8);
    expect(evaluateMeasure(model, 'LEFT("Ledgerly", 3)')).toBe("Led");
    expect(evaluateMeasure(model, 'RIGHT("Ledgerly", 3)')).toBe("rly");
    expect(evaluateMeasure(model, 'MID("Ledgerly", 2, 4)')).toBe("edge");
  });

  test("UPPER / LOWER / TRIM", () => {
    expect(evaluateMeasure(model, 'UPPER("abc")')).toBe("ABC");
    expect(evaluateMeasure(model, 'LOWER("ABC")')).toBe("abc");
    expect(evaluateMeasure(model, 'TRIM("  hello   world  ")')).toBe("hello world");
  });

  test("CONCATENATE / SUBSTITUTE / CONTAINSSTRING", () => {
    expect(evaluateMeasure(model, 'CONCATENATE("Q", 1)')).toBe("Q1");
    expect(evaluateMeasure(model, 'SUBSTITUTE("a-b-c", "-", "+")')).toBe("a+b+c");
    expect(evaluateMeasure(model, 'SUBSTITUTE("a-b-c", "-", "+", 2)')).toBe("a-b+c");
    expect(evaluateMeasure(model, 'CONTAINSSTRING("Ledgerly", "dger")')).toBe(true);
    expect(evaluateMeasure(model, 'CONTAINSSTRING("Ledgerly", "zzz")')).toBe(false);
  });

  test("CONCATENATEX joins row values", () => {
    // Distinct regions visible via ALL: East, West.
    const v = evaluateMeasure(model, 'CONCATENATEX(ALL([Region]), [Region], ", ")');
    expect(v).toBe("East, West");
  });

  test("text on aggregates", () => {
    // 1300 formatted with 0 decimals → "1300"
    expect(evaluateMeasure(model, 'LEFT(SUM([Amount]) & "", 2)')).toBe("13");
  });
});

describe("DAX extensions — time intelligence additions", () => {
  test("NEXTMONTH returns the full next month", () => {
    // Latest visible date 2024-03-01 → next month = April 2024; no rows → 0.
    expect(evaluateMeasure(model, "CALCULATE(SUM([Amount]), NEXTMONTH([Date]))")).toBe(0);
  });

  test("NEXTMONTH with an explicit January context", () => {
    // January context (latest 2024-01-20) → NEXTMONTH = all of February.
    const v = evaluateMeasure(
      model,
      'CALCULATE(CALCULATE(SUM([Amount]), NEXTMONTH([Date])), [Date] >= "2024-01-01", [Date] <= "2024-01-31")',
    );
    expect(v).toBe(450); // Feb: 50 + 300 + 100
  });

  test("DATESBETWEEN inclusive bounds", () => {
    const v = evaluateMeasure(model, 'CALCULATE(SUM([Amount]), DATESBETWEEN([Date], "2024-02-10", "2024-02-20"))');
    expect(v).toBe(50 + 300 + 100); // 450
  });

  test("DATESINPERIOD day window", () => {
    const v = evaluateMeasure(model, 'CALCULATE(SUM([Amount]), DATESINPERIOD([Date], "2024-02-10", 10, DAY))');
    expect(v).toBe(50 + 300 + 100); // 2024-02-10..19 inclusive → 450
  });

  test("DATESINPERIOD month window backwards (start date inclusive)", () => {
    // Window: 2024-02-01 .. 2024-03-01 (both ends inclusive) → all Feb rows
    // PLUS the 2024-03-01 row itself.
    const v = evaluateMeasure(model, 'CALCULATE(SUM([Amount]), DATESINPERIOD([Date], "2024-03-01", -1, MONTH))');
    expect(v).toBe(450 + 400); // Feb 450 + Mar 400 = 850
  });
});

describe("DAX extensions — composition", () => {
  test("VAR + TOPN + iterator (share of top-2 revenue)", () => {
    const v = evaluateMeasure(
      model,
      "VAR Top2 = SUMX(TOPN(2, ALL(), [Amount]), [Amount]) VAR Total = CALCULATE(SUM([Amount]), ALL()) RETURN DIVIDE(Top2, Total)",
    );
    expect(v).toBeCloseTo(700 / 1300, 10);
  });

  test("by-category still works with VAR measures", () => {
    const series = evaluateMeasureByCategory(
      model,
      "VAR Reg = CALCULATE(SUM([Amount]), ALL([Region])) RETURN DIVIDE(SUM([Amount]), Reg)",
      "Region",
    );
    const east = series.find((s) => s.category === "East");
    const west = series.find((s) => s.category === "West");
    expect(east?.value).toBeCloseTo(500 / 1300, 10);
    expect(west?.value).toBeCloseTo(800 / 1300, 10);
  });

  test("SUPPORTED_DAX_FUNCTIONS lists the new families", () => {
    for (const fn of [
      "VAR",
      "CALCULATETABLE",
      "TOPN",
      "TREATAS",
      "LOOKUPVALUE",
      "MEDIAN",
      "STDEV.P",
      "NEXTMONTH",
      "DATESBETWEEN",
    ]) {
      expect(SUPPORTED_DAX_FUNCTIONS).toContain(fn);
    }
  });
});
