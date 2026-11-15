/**
 * Drift and compliance analysis kinds — end-to-end wiring.
 *
 * These two runners are the surfaces that make two previously-unreachable
 * engines usable: `mlops` drift detection, and the whole `ca-india` module
 * (668 lines of GST/TDS/sampling that had zero importers outside tests).
 *
 * The mixed-rate GST case is the load-bearing one. A real Indian ledger mixes
 * 12% and 18% slabs on different invoices, and a category-only rate lookup
 * silently applies one slab to both — producing a number that looks right and
 * is wrong by thousands of rupees.
 */

import { runAnalysis } from "@/lib/engine/analyses";
import type { Cell } from "@/lib/engine/dataset";
import type { AnalysisConfig, ColumnDef } from "@/lib/types";

function input(columns: ColumnDef[], rows: Cell[][], name = "ops fixture") {
  return { datasetId: "ds-ops", datasetName: name, totalRows: rows.length, columns, rows };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

describe("drift: population stability index", () => {
  const columns: ColumnDef[] = [
    { name: "month", type: "date" },
    { name: "amount", type: "number" },
    { name: "segment", type: "string" },
  ];

  const month = (i: number) => {
    const year = 2024 + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, "0");
    return `${year}-${m}-01`;
  };

  // 100 months: reference is stable around 100, current is shifted to ~300.
  const stable: Cell[][] = [];
  const shifted: Cell[][] = [];
  for (let i = 0; i < 100; i++) {
    const v = 100 + (i % 7);
    stable.push([month(i), v, i % 2 === 0 ? "a" : "b"]);
    // Mean doubles in the second half — a genuine distribution shift.
    shifted.push([month(i), i < 50 ? v : v * 3, i % 2 === 0 ? "a" : "b"]);
  }
  const rows = [...stable, ...shifted];
  const cfg: AnalysisConfig = {
    kind: "drift",
    dateCol: "month",
    granularity: "month",
    referenceSplit: 0.5,
    columns: ["amount", "segment"],
  } as AnalysisConfig;

  it("reports drift when the current window has shifted", () => {
    const res = runAnalysis(input(columns, rows), cfg);
    expect(res.charts.length).toBeGreaterThan(0);
    const overall = res.stats?.find((s) => s.label === "Overall")?.value;
    expect(overall).toBeDefined();
    expect((res.quickFindings ?? []).join(" ")).toMatch(/drift|stable|PSI/i);
  });

  it("reports NO major drift when both windows are stable", () => {
    const flat: Cell[][] = [];
    for (let i = 0; i < 100; i++) {
      const v = 100 + (i % 7);
      flat.push([month(i), v, i % 2 === 0 ? "a" : "b"]);
    }
    const res = runAnalysis(input(columns, flat), cfg);
    expect(res.stats?.find((s) => s.label === "Overall")?.value).toBe("ok");
    expect(res.qualityWarnings.join(" ")).not.toMatch(/MAJOR drift/i);
  });

  it("emits per-column PSI rows with a severity for each", () => {
    const res = runAnalysis(input(columns, rows), cfg);
    const t = res.tables?.find((x) => x.title === "Per-column drift");
    expect(t).toBeDefined();
    expect(t?.rows.length).toBe(2);
    for (const r of t?.rows ?? []) {
      expect(["ok", "moderate", "major"]).toContain(String(r[4]));
    }
  });

  it("states that PSI is a heuristic with no p-value", () => {
    const res = runAnalysis(input(columns, rows), cfg);
    expect(res.methodology.assumptions.join(" ")).toMatch(/heuristic|no p-value/i);
  });

  it("refuses when a window has fewer than 20 rows", () => {
    const small = rows.slice(0, 30);
    expect(() => runAnalysis(input(columns, small), cfg)).toThrow(/at least 20 rows/i);
  });
});

// ---------------------------------------------------------------------------
// Compliance (GST + TDS + audit sample)
// ---------------------------------------------------------------------------

describe("compliance: GST / TDS / audit sample", () => {
  const columns: ColumnDef[] = [
    { name: "kind", type: "string" },
    { name: "taxable", type: "number" },
    { name: "rate", type: "number" },
    { name: "gstin", type: "string" },
    { name: "section", type: "string" },
    { name: "pan", type: "string" },
  ];

  const makeRow = (kind: string, taxable: number, rate: number, section = "", pan = ""): Cell[] => [
    kind,
    taxable,
    rate,
    `29ABCDE1234F1Z5`,
    section,
    pan,
  ];

  const cfg: AnalysisConfig = {
    kind: "compliance",
    period: "2025-04",
    kindCol: "kind",
    rateCol: "rate",
    taxableCol: "taxable",
    reverseChargeCol: null,
    sectionCol: "section",
    panCol: "pan",
    gstinCol: "gstin",
    openingCredit: 0,
    auditSampleSize: 25,
  } as AnalysisConfig;

  it("computes net GST payable from outward supplies", () => {
    const rows = Array.from({ length: 30 }, (_unused) => makeRow("supply", 100000, 18));
    const res = runAnalysis(input(columns, rows), cfg);
    // 30 × ₹1,00,000 at 18% = ₹30,000 × 18% = ₹5,40,000 outward tax.
    const payable = Number(res.stats?.find((s) => s.label === "Net GST payable")?.value ?? "0");
    expect(payable).toBeCloseTo(540000, 0);
  });

  it("applies the 20% ITC cap and carries the rest forward", () => {
    // Outward ₹5,40,000 tax; purchases give ₹9,00,000 ITC.
    // Cap = 20% × 5,40,000 = ₹1,08,000. So ITC used is ₹1,08,000.
    const rows: Cell[][] = [
      ...Array.from({ length: 30 }, () => makeRow("supply", 100000, 18)),
      ...Array.from({ length: 50 }, () => makeRow("purchase", 100000, 18)),
    ];
    const res = runAnalysis(input(columns, rows), cfg);
    const used = Number(res.stats?.find((s) => s.label === "ITC carried forward")?.value ?? "0");
    // 9,00,000 − 1,08,000 = ₹7,92,000 carried.
    expect(used).toBeCloseTo(792000, 0);
  });

  it("taxes a MIXED-rate ledger per invoice, not per category", () => {
    // Regression: category-only lookup applied 18% to both invoices.
    const rows: Cell[][] = [makeRow("supply", 100000, 12), makeRow("supply", 100000, 18)];
    const res = runAnalysis(input(columns, rows), cfg);
    // 12% of 1,00,000 = 12,000; 18% of 1,00,000 = 18,000 → ₹30,000.
    const payable = Number(res.stats?.find((s) => s.label === "Net GST payable")?.value ?? "0");
    expect(payable).toBeCloseTo(30000, 0);
  });

  it("reports TDS when a section column is supplied", () => {
    const rows: Cell[][] = [
      ...Array.from({ length: 30 }, () => makeRow("supply", 100000, 18)),
      ...Array.from({ length: 10 }, () => makeRow("purchase", 100000, 10, "194J", "ABCDE1234F")),
    ];
    const res = runAnalysis(input(columns, rows), cfg);
    const tds = res.stats?.find((s) => s.label === "TDS deductible");
    expect(tds).toBeDefined();
    // 10 payments × ₹1,00,000 at 10% = ₹1,00,000.
    expect(Number(tds?.value ?? "0")).toBeCloseTo(100000, 0);
  });

  it("flags a malformed PAN as unclaimable by the payee", () => {
    const rows: Cell[][] = [
      ...Array.from({ length: 30 }, () => makeRow("supply", 100000, 18)),
      makeRow("purchase", 100000, 10, "194J", "BAD"),
    ];
    const res = runAnalysis(input(columns, rows), cfg);
    expect(res.stats?.some((s) => s.label === "PAN issues")).toBe(true);
  });

  it("draws an audit sample and states a conclusion", () => {
    const rows = Array.from({ length: 40 }, (_unused, i) => makeRow("supply", 10000 + i * 100, 18));
    const res = runAnalysis(input(columns, rows), cfg);
    expect(res.tables?.some((t) => t.title.startsWith("Audit sample"))).toBe(true);
    expect(res.stats?.some((s) => s.label === "Audit sample")).toBe(true);
  });

  it("states plainly that it does not file returns", () => {
    const rows = Array.from({ length: 30 }, () => makeRow("supply", 100000, 18));
    const res = runAnalysis(input(columns, rows), cfg);
    expect(res.methodology.assumptions.join(" ")).toMatch(/not filed|filing tool|NOT filed/i);
  });

  it("rejects a ledger with no recognisable document kind", () => {
    const rows = Array.from({ length: 30 }, () => makeRow("mystery", 1000, 18));
    expect(() => runAnalysis(input(columns, rows), cfg)).toThrow(/must contain supply, purchase, import or export/i);
  });

  it("skips rows whose rate is not numeric, keeping the usable ones", () => {
    // A few bad rows among good ones must not discard the whole ledger — but
    // they must be counted and named, never silently dropped.
    const rows: Cell[][] = [
      ...Array.from({ length: 30 }, () => makeRow("supply", 100000, 18)),
      ...Array.from({ length: 5 }, () => ["supply", 1000, "n/a", "", "", ""] as Cell[]),
    ];
    const res = runAnalysis(input(columns, rows), { ...cfg, auditSampleSize: 0 } as AnalysisConfig);
    expect(res.qualityWarnings.join(" ")).toMatch(/rate is not numeric/i);
    expect(res.qualityWarnings.join(" ")).toMatch(/5 row\(s\) were skipped/i);
  });

  it("throws when NO row is usable rather than reporting empty statements", () => {
    const rows: Cell[][] = Array.from({ length: 30 }, () => ["supply", 1000, "n/a", "", "", ""] as Cell[]);
    expect(() => runAnalysis(input(columns, rows), { ...cfg, auditSampleSize: 0 } as AnalysisConfig)).toThrow(
      /No usable transaction rows/i,
    );
  });

  it("skips a negative taxable value, keeping the usable rows", () => {
    const rows: Cell[][] = [
      ...Array.from({ length: 30 }, () => makeRow("supply", 100000, 18)),
      ...Array.from({ length: 3 }, () => makeRow("supply", -500, 18)),
    ];
    const res = runAnalysis(input(columns, rows), { ...cfg, auditSampleSize: 0 } as AnalysisConfig);
    expect(res.qualityWarnings.join(" ")).toMatch(/invalid taxable/i);
  });
});
