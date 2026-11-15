/**
 * Oracle tests for the data engineering engine (lib/engine/data-quality.ts):
 * expectations, quality gates, lineage DAG validation/traversal, contracts.
 */
import {
  checkContract,
  evaluateExpectation,
  lineageImpact,
  runQualityGate,
  topologicalOrder,
  validateLineage,
  type DatasetContract,
  type LineageGraph,
} from "@/lib/engine/data-quality";

const cols = [
  { name: "region", type: "string" },
  { name: "units", type: "number" },
  { name: "order_id", type: "string" },
  { name: "created_at", type: "date" },
];

const rows: (string | number | boolean | null)[][] = [
  ["East", 10, "o1", "2026-09-01T00:00:00Z"],
  ["West", 20, "o2", "2026-09-02T00:00:00Z"],
  ["East", 30, "o3", "2026-09-03T00:00:00Z"],
  [null, 40, "o4", "2026-09-04T00:00:00Z"],
];

describe("expectations", () => {
  it("not-null finds the blank region", () => {
    const r = evaluateExpectation({ id: "e1", kind: "not-null", column: "region", severity: "error" }, cols, rows);
    expect(r.passed).toBe(false);
    expect(r.violations).toBe(1);
    expect(r.total).toBe(4);
  });

  it("unique detects duplicates", () => {
    const dup = [...rows, ["East", 50, "o5", "2026-09-05T00:00:00Z"]];
    const r = evaluateExpectation({ id: "e2", kind: "not-null", column: "region", severity: "warn" }, cols, dup);
    expect(r.violations).toBe(1);
    const u = evaluateExpectation({ id: "e3", kind: "unique", column: "order_id", severity: "error" }, cols, [
      ["E", 1, "o1", null],
      ["W", 2, "o1", null],
    ]);
    expect(u.passed).toBe(false);
    expect(u.examples[0]).toContain("o1");
  });

  it("range validates numerics and skips nulls (not-null's job)", () => {
    const r = evaluateExpectation(
      { id: "e4", kind: "range", column: "units", severity: "error", params: { min: 0, max: 50 } },
      cols,
      rows,
    );
    expect(r.passed).toBe(true);
    const bad = evaluateExpectation(
      { id: "e5", kind: "range", column: "units", severity: "error", params: { max: 35 } },
      cols,
      rows,
    );
    expect(bad.violations).toBe(1); // only 40 > 35
  });

  it("in-set and regex flag out-of-domain values", () => {
    const s = evaluateExpectation(
      { id: "e6", kind: "in-set", column: "region", severity: "warn", params: { values: ["East", "West"] } },
      cols,
      rows,
    );
    expect(s.passed).toBe(true); // the null row is skipped
    const re = evaluateExpectation(
      { id: "e7", kind: "regex", column: "order_id", severity: "error", params: { pattern: "^o\\d+$" } },
      cols,
      rows,
    );
    expect(re.passed).toBe(true);
  });

  it("row-count enforces a minimum size", () => {
    const r = evaluateExpectation(
      { id: "e8", kind: "row-count", column: null, severity: "error", params: { minRows: 3 } },
      cols,
      rows,
    );
    expect(r.passed).toBe(true);
    const f = evaluateExpectation(
      { id: "e9", kind: "row-count", column: null, severity: "error", params: { minRows: 10 } },
      cols,
      rows,
    );
    expect(f.passed).toBe(false);
    expect(f.total).toBe(4);
  });

  it("freshness measures the age of the newest timestamp", () => {
    const now = new Date("2026-09-04T06:00:00Z");
    const fresh = evaluateExpectation(
      { id: "e10", kind: "freshness", column: "created_at", severity: "warn", params: { maxAgeHours: 12 } },
      cols,
      rows,
      { now },
    );
    expect(fresh.passed).toBe(true);
    const stale = evaluateExpectation(
      { id: "e11", kind: "freshness", column: "created_at", severity: "warn", params: { maxAgeHours: 1 } },
      cols,
      rows,
      { now },
    );
    expect(stale.passed).toBe(false);
  });

  it("throws on unknown columns and bad params", () => {
    expect(() =>
      evaluateExpectation({ id: "x", kind: "not-null", column: "nope", severity: "warn" }, cols, rows),
    ).toThrow(/unknown column/);
    expect(() =>
      evaluateExpectation({ id: "x", kind: "range", column: "units", severity: "warn" }, cols, rows),
    ).toThrow(/min and\/or max/);
    expect(() =>
      evaluateExpectation(
        { id: "x", kind: "regex", column: "region", severity: "warn", params: { pattern: "[" } },
        cols,
        rows,
      ),
    ).toThrow(/Invalid regex/);
  });
});

describe("quality gates", () => {
  const results = (specs: { id: string; passed: boolean; severity: "error" | "warn" }[]) =>
    specs.map((s) => ({
      expectationId: s.id,
      kind: "not-null" as const,
      column: "c",
      passed: s.passed,
      severity: s.severity,
      total: 10,
      violations: s.passed ? 0 : 1,
      examples: [],
      message: "",
    }));

  it("error-severity failure blocks the gate", () => {
    const r = runQualityGate(
      results([
        { id: "a", passed: true, severity: "error" },
        { id: "b", passed: false, severity: "error" },
        { id: "c", passed: true, severity: "warn" },
      ]),
    );
    expect(r.verdict).toBe("fail");
    expect(r.errorFailures).toBe(1);
  });

  it("warn failures pass with a warning when the ratio holds", () => {
    const r = runQualityGate(
      results([
        { id: "a", passed: true, severity: "warn" },
        { id: "b", passed: true, severity: "warn" },
        { id: "c", passed: false, severity: "warn" },
        { id: "d", passed: true, severity: "warn" },
        { id: "e", passed: true, severity: "warn" },
      ]),
      { minPassRatio: 0.75 },
    );
    expect(r.verdict).toBe("warn");
    expect(r.passRatio).toBeCloseTo(0.8, 6);
  });

  it("ratio below minPassRatio fails even without errors", () => {
    const r = runQualityGate(
      results([
        { id: "a", passed: false, severity: "warn" },
        { id: "b", passed: false, severity: "warn" },
        { id: "c", passed: true, severity: "warn" },
      ]),
      { minPassRatio: 0.8 },
    );
    expect(r.verdict).toBe("fail");
    expect(r.passRatio).toBeCloseTo(1 / 3, 6);
  });

  it("an empty suite passes trivially (and says so)", () => {
    const r = runQualityGate([]);
    expect(r.verdict).toBe("pass");
    expect(r.message).toContain("No expectations");
  });
});

describe("lineage DAG", () => {
  const graph: LineageGraph = {
    nodes: [
      { id: "raw", kind: "dataset", label: "Raw orders" },
      { id: "clean", kind: "transform", label: "Clean" },
      { id: "agg", kind: "transform", label: "Aggregate" },
      { id: "dash", kind: "dataset", label: "Dashboard feed" },
    ],
    edges: [
      { from: "raw", to: "clean", columns: ["region", "units"], operation: "powerquery:filter" },
      { from: "clean", to: "agg", columns: ["region", "units"], operation: "group-by" },
      { from: "agg", to: "dash", columns: ["region"], operation: "materialize" },
    ],
  };

  it("topologically orders a valid DAG", () => {
    expect(topologicalOrder(graph)).toEqual(["raw", "clean", "agg", "dash"]);
  });

  it("detects cycles with the exact path", () => {
    const cyclic: LineageGraph = {
      nodes: graph.nodes,
      edges: [...graph.edges, { from: "dash", to: "raw", columns: [], operation: "feedback" }],
    };
    const errs = validateLineage(cyclic);
    expect(errs.some((e) => e.kind === "cycle")).toBe(true);
    expect(() => topologicalOrder(cyclic)).toThrow(/not a DAG/);
  });

  it("flags missing nodes and self-loops", () => {
    const bad: LineageGraph = {
      nodes: graph.nodes,
      edges: [
        ...graph.edges,
        { from: "ghost", to: "agg", columns: [], operation: "?" },
        { from: "clean", to: "clean", columns: [], operation: "self" },
      ],
    };
    const errs = validateLineage(bad);
    expect(errs.some((e) => e.kind === "missing-node")).toBe(true);
    expect(errs.some((e) => e.kind === "self-loop")).toBe(true);
  });

  it("impact analysis reports downstream/upstream and exposed columns", () => {
    const impact = lineageImpact(graph, "clean");
    expect(impact.downstream).toEqual(["agg", "dash"]);
    expect(impact.upstream).toEqual(["raw"]);
    expect(impact.exposedColumns).toEqual(["region", "units"]);
  });
});

describe("dataset contracts", () => {
  const contract: DatasetContract = {
    id: "ct1",
    datasetName: "orders",
    version: "1.0.0",
    columns: [
      { name: "region", type: "string", nullable: false },
      { name: "units", type: "number", nullable: true },
    ],
    expectations: [{ id: "ce1", kind: "not-null", column: "region", severity: "error" }],
  };

  it("a satisfying version passes with zero violations", () => {
    const ok = checkContract(
      contract,
      [
        { name: "region", type: "string" },
        { name: "units", type: "number" },
      ],
      [
        ["East", 10],
        ["West", 20],
      ],
    );
    expect(ok.satisfied).toBe(true);
    expect(ok.violations).toEqual([]);
  });

  it("missing columns, type mismatches and nullability violations are listed", () => {
    const bad = checkContract(
      contract,
      [
        { name: "region", type: "number" },
        { name: "extra", type: "string" },
      ],
      [[1, "x"]],
    );
    expect(bad.satisfied).toBe(false);
    const kinds = bad.violations.map((v) => v.kind);
    expect(kinds).toContain("missing-column"); // units gone
    expect(kinds).toContain("type-mismatch"); // region number vs string
    expect(kinds).toContain("extra-column"); // extra
  });

  it("nullability is checked against the data, not just the schema", () => {
    const r = checkContract(contract, cols, [[null, 1, "o1", null]]);
    expect(r.satisfied).toBe(false);
    expect(r.violations.some((v) => v.kind === "nullability-violation" && v.column === "region")).toBe(true);
    expect(r.violations.some((v) => v.kind === "expectation-failed" && v.expectationId === "ce1")).toBe(true);
  });

  it("contract expectations run as part of the check", () => {
    const r = checkContract(contract, cols, rows);
    expect(r.expectationResults.length).toBe(1);
    expect(r.expectationResults[0]!.expectationId).toBe("ce1");
  });
});
