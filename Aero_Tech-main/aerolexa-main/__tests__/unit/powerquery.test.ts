import { applySteps, describeStep, evaluateCustomExpression, aggregateValues } from "@/lib/engine/powerquery";
import type { PQTable } from "@/lib/engine/powerquery";

function salesTable(): PQTable {
  return {
    columns: [
      { name: "Region", type: "string" },
      { name: "Product", type: "string" },
      { name: "Amount", type: "number" },
      { name: "Qty", type: "number" },
    ],
    rows: [
      ["East", "A", 100, 2],
      ["East", "B", 50, 1],
      ["West", "A", 200, 4],
      ["West", "B", null, 1],
      [null, "C", 25, 1],
    ],
  };
}

describe("Power Query engine — exact results", () => {
  test("groupBy computes exact sums, counts and averages", () => {
    const out = applySteps(salesTable(), [
      {
        id: "1",
        label: "Group",
        kind: "groupBy",
        groupBy: "Region",
        aggregations: [
          { column: "Amount", fn: "sum", as: "Total" },
          { column: "Amount", fn: "avg", as: "Avg" },
          { column: null, fn: "count", as: "Rows" },
        ],
      },
    ]);
    expect(out.columns.map((c) => c.name)).toEqual(["Region", "Total", "Avg", "Rows"]);
    const east = out.rows.find((r) => r[0] === "East");
    const west = out.rows.find((r) => r[0] === "West");
    expect(east).toEqual(["East", 150, 75, 2]); // 100+50, (100+50)/2
    expect(west).toEqual(["West", 200, 200, 2]); // null Amount excluded from avg
  });

  test("removeDuplicates keeps first occurrences only", () => {
    const out = applySteps(salesTable(), [{ id: "1", label: "d", kind: "removeDuplicates", columns: ["Region"] }]);
    expect(out.rows).toHaveLength(3); // East, West, null
    expect(out.rows[0]).toEqual(["East", "A", 100, 2]);
    expect(out.rows[2]).toEqual([null, "C", 25, 1]);
  });

  test("filterRows numeric comparisons and isEmpty", () => {
    const gt = applySteps(salesTable(), [
      { id: "1", label: "f", kind: "filterRows", column: "Amount", op: "gt", value: 60 },
    ]);
    expect(gt.rows.map((r) => r[2])).toEqual([100, 200]);

    const nonEmpty = applySteps(salesTable(), [
      { id: "1", label: "f", kind: "filterRows", column: "Region", op: "isNotEmpty" },
    ]);
    expect(nonEmpty.rows).toHaveLength(4);
  });

  test("sortRows handles nulls last regardless of direction", () => {
    const asc = applySteps(salesTable(), [
      { id: "1", label: "s", kind: "sortRows", column: "Amount", direction: "asc" },
    ]);
    expect(asc.rows.map((r) => r[2])).toEqual([25, 50, 100, 200, null]);
    const desc = applySteps(salesTable(), [
      { id: "1", label: "s", kind: "sortRows", column: "Amount", direction: "desc" },
    ]);
    expect(desc.rows.map((r) => r[2])).toEqual([200, 100, 50, 25, null]);
  });

  test("fillDown propagates last non-blank value", () => {
    const out = applySteps(salesTable(), [{ id: "1", label: "f", kind: "fillDown", column: "Region" }]);
    expect(out.rows[3]![0]).toBe("West"); // filled from row above
    expect(out.rows[4]![0]).toBe("West"); // stays West, not re-filled
  });

  test("custom column arithmetic with column refs", () => {
    const out = applySteps(salesTable(), [
      { id: "1", label: "c", kind: "addCustomColumn", name: "UnitPrice", expression: "[Amount] / [Qty]" },
    ]);
    expect(out.rows[0]![4]).toBe(50); // 100/2
    expect(out.rows[1]![4]).toBe(50); // 50/1
    expect(out.rows[3]![4]).toBeNull(); // null propagates through arithmetic
  });

  test("custom column IF and string concat", () => {
    const out = applySteps(salesTable(), [
      { id: "1", label: "c", kind: "addCustomColumn", name: "Band", expression: 'IF([Amount] >= 100, "High", "Low")' },
    ]);
    expect(out.rows[0]![4]).toBe("High");
    expect(out.rows[1]![4]).toBe("Low");
    expect(out.rows[4]![4]).toBe("Low"); // 25
  });

  test("evaluateCustomExpression standalone", () => {
    const cols = [
      { name: "A", type: "number" as const },
      { name: "B", type: "number" as const },
    ];
    expect(evaluateCustomExpression("[A] * [B] + 1", [3, 4], cols)).toBe(13);
    expect(evaluateCustomExpression('IF([A] > 2, "big", "small")', [1, 9], cols)).toBe("small");
    expect(evaluateCustomExpression("COALESCE([A], 0) + 5", [null, 1], cols)).toBe(5);
    expect(evaluateCustomExpression("ROUND(10 / 3, 2)", [0, 0], cols)).toBe(3.33);
  });

  test("unpivot then pivot round-trips sums", () => {
    const wide: PQTable = {
      columns: [
        { name: "Region", type: "string" },
        { name: "A", type: "number" },
        { name: "B", type: "number" },
      ],
      rows: [
        ["East", 10, 20],
        ["West", 30, 40],
      ],
    };
    const long = applySteps(wide, [
      {
        id: "1",
        label: "u",
        kind: "unpivot",
        valueColumns: ["A", "B"],
        nameValue: "Product",
        nameValueColumn: "Amount",
      },
    ]);
    expect(long.rows).toEqual([
      ["East", "A", 10],
      ["East", "B", 20],
      ["West", "A", 30],
      ["West", "B", 40],
    ]);
    const back = applySteps(long, [
      { id: "2", label: "p", kind: "pivot", attributeColumn: "Product", valueColumn: "Amount", aggregation: "sum" },
    ]);
    expect(back.rows).toEqual([
      ["East", 10, 20],
      ["West", 30, 40],
    ]);
  });

  test("changeType coerces and nulls bad values; errors:keep preserves", () => {
    const t: PQTable = {
      columns: [{ name: "N", type: "string" }],
      rows: [["12"], ["3.5"], ["abc"]],
    };
    const strict = applySteps(t, [{ id: "1", label: "t", kind: "changeType", column: "N", to: "number" }]);
    expect(strict.rows.map((r) => r[0])).toEqual([12, 3.5, null]);
    const keep = applySteps(t, [
      { id: "1", label: "t", kind: "changeType", column: "N", to: "number", errors: "keep" },
    ]);
    expect(keep.rows.map((r) => r[0])).toEqual([12, 3.5, "abc"]);
  });

  test("topN keeps highest values", () => {
    const out = applySteps(salesTable(), [
      { id: "1", label: "t", kind: "topN", column: "Amount", n: 2, direction: "top" },
    ]);
    expect(out.rows.map((r) => r[2])).toEqual([200, 100]);
  });

  test("aggregateValues median and stddev match reference numbers", () => {
    // median of [1,2,3,4] = 2.5; sample stddev = sqrt(((1-2.5)²+(2-2.5)²+(3-2.5)²+(4-2.5)²)/3) = sqrt(5/3) ≈ 1.29099
    expect(aggregateValues([1, 2, 3, 4], "median")).toBe(2.5);
    expect(aggregateValues([1, 2, 3, 4], "stddev")).toBeCloseTo(1.2909944487, 6);
  });

  test("describeStep produces audit labels", () => {
    expect(
      describeStep({
        id: "1",
        label: "x",
        kind: "groupBy",
        groupBy: "Region",
        aggregations: [{ column: "Amount", fn: "sum", as: "Total" }],
      }),
    ).toBe("Grouped by “Region” with sum(Amount) as Total");
  });

  test("steps are pure — source table is never mutated", () => {
    const t = salesTable();
    const snapshot = JSON.stringify(t);
    applySteps(t, [
      { id: "1", label: "r", kind: "removeColumns", columns: ["Qty"] },
      { id: "2", label: "f", kind: "filterRows", column: "Amount", op: "gt", value: 60 },
    ]);
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});
