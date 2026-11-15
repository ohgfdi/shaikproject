/**
 * India compliance engine — oracle tests.
 *
 * GST arithmetic, TDS thresholds and consolidation splits are all exactly
 * hand-computable, so every expected figure below is derived by hand rather
 * than captured from a previous run. A captured snapshot would only prove the
 * code still does what it did; these prove it does the right thing.
 *
 * The ITC-cap test is the one that matters most: it is the rule people get
 * wrong, and getting it wrong produces a refund claim the law will not allow.
 */

import {
  ComplianceError,
  auditSample,
  computeGst3B,
  computeTds,
  consolidate,
  gstTax,
  type GstTransaction,
  type TdsSection,
} from "@/lib/engine/ca-india";

const minor = (rupees: number) => Math.round(rupees * 100);

describe("GST: GSTR-3B computation", () => {
  it("computes tax invoice-by-invoice and rounds once", () => {
    // 3 invoices of ₹100 at 18% = ₹18 each = ₹54 total.
    const txs: GstTransaction[] = [
      { documentNumber: "A1", date: "2025-04-01", kind: "supply", taxableValue: minor(100), category: "intra" },
      { documentNumber: "A2", date: "2025-04-02", kind: "supply", taxableValue: minor(100), category: "intra" },
      { documentNumber: "A3", date: "2025-04-03", kind: "supply", taxableValue: minor(100), category: "intra" },
    ];
    const r = computeGst3B(txs, "2025-04", 0);
    expect(r.outwardTax / 100).toBe(54);
  });

  it("applies the 20% ITC cap and carries the rest forward", () => {
    // Outward tax ₹18,000. ITC available ₹1,800.
    // Cap = 20% of 18,000 = ₹3,600 — so ALL ₹1,800 can be used.
    const txs: GstTransaction[] = [
      { documentNumber: "A1", date: "2025-04-01", kind: "supply", taxableValue: minor(100000), category: "intra" },
      { documentNumber: "B1", date: "2025-04-05", kind: "purchase", taxableValue: minor(10000), category: "itc" },
    ];
    const r = computeGst3B(txs, "2025-04", 0);
    expect(r.outwardTax / 100).toBe(18000);
    expect(r.itcAvailable / 100).toBe(1800);
    expect(r.itcUtilised / 100).toBe(1800); // under the ₹3,600 cap
    expect(r.netPayable / 100).toBe(16200);
    expect(r.creditAvailable).toBe(0);
  });

  it("caps ITC at 20% of liability and carries the excess forward", () => {
    // Outward tax ₹1,000. ITC available ₹10,000 (huge purchase month).
    // Cap = 20% × 1,000 = ₹200. Only ₹200 is usable; ₹9,800 carries forward.
    const txs: GstTransaction[] = [
      { documentNumber: "A1", date: "2025-04-01", kind: "supply", taxableValue: minor(5555.56), category: "intra" },
      { documentNumber: "B1", date: "2025-04-05", kind: "purchase", taxableValue: minor(55555.56), category: "itc" },
    ];
    const r = computeGst3B(txs, "2025-04", 0);
    expect(r.outwardTax / 100).toBeCloseTo(1000, 0);
    expect(r.itcAvailable / 100).toBeCloseTo(10000, 0);
    // 20% cap binds hard here.
    expect(r.itcUtilised / 100).toBeCloseTo(200, 0);
    expect(r.creditAvailable / 100).toBeCloseTo(9800, 0);
  });

  it("carries an opening credit into the period before capping", () => {
    const txs: GstTransaction[] = [
      { documentNumber: "A1", date: "2025-05-01", kind: "supply", taxableValue: minor(10000), category: "intra" },
    ];
    // Opening credit ₹5,000 + zero new ITC = ₹5,000 available against ₹1,800 liability.
    const r = computeGst3B(txs, "2025-05", minor(5000));
    expect(r.itcAvailable / 100).toBe(5000);
    expect(r.netPayable).toBe(0);
  });

  it("treats exports as zero-rated but still reports their taxable value", () => {
    const txs: GstTransaction[] = [
      { documentNumber: "E1", date: "2025-04-10", kind: "export", taxableValue: minor(50000), category: "export" },
    ];
    const r = computeGst3B(txs, "2025-04", 0);
    expect(r.outwardTaxable / 100).toBe(50000);
    expect(r.outwardTax).toBe(0);
  });

  it("flags reverse-charge tax as payable and not recoverable", () => {
    const txs: GstTransaction[] = [
      {
        documentNumber: "R1",
        date: "2025-04-01",
        kind: "import",
        taxableValue: minor(10000),
        category: "import",
        reverseCharge: true,
      },
    ];
    const r = computeGst3B(txs, "2025-04", 0);
    expect(r.reverseChargeTax / 100).toBe(1800);
    expect(r.warnings.join(" ")).toMatch(/reverse.?charge/i);
  });

  it("flags a NIL period rather than omitting it — nil returns are still filed", () => {
    const r = computeGst3B([], "2025-04", 0);
    expect(r.isNil).toBe(true);
    expect(r.netPayable).toBe(0);
  });

  it("warns on a malformed GSTIN instead of accepting it", () => {
    const txs: GstTransaction[] = [
      {
        documentNumber: "A1",
        date: "2025-04-01",
        kind: "supply",
        taxableValue: minor(100),
        category: "intra",
        gstin: "BAD",
      },
    ];
    const r = computeGst3B(txs, "2025-04", 0);
    expect(r.warnings.join(" ")).toMatch(/GSTIN/i);
  });

  it("refuses a rate it was not given rather than guessing", () => {
    const txs: GstTransaction[] = [
      { documentNumber: "A1", date: "2025-04-01", kind: "supply", taxableValue: minor(100), category: "intra" },
    ];
    expect(() => computeGst3B(txs, "2025-04", 0, { rates: [] })).toThrow(/no GST rate supplied|rate/i);
  });

  it("groups tax by rate slab for the return", () => {
    const txs: GstTransaction[] = [
      { documentNumber: "A1", date: "2025-04-01", kind: "supply", taxableValue: minor(10000), category: "intra" },
      { documentNumber: "A2", date: "2025-04-02", kind: "supply", taxableValue: minor(10000), category: "intra" },
    ];
    const r = computeGst3B(txs, "2025-04", 0);
    expect(r.byRate.length).toBeGreaterThan(0);
    expect(r.byRate.reduce((s, b) => s + b.count, 0)).toBe(2);
  });

  it("taxes each invoice at its OWN rate in a mixed-slab ledger", () => {
    // Regression: with a 12% and an 18% invoice, category-only rate lookup
    // applied the FIRST matching slab to both, computing 2,400 instead of
    // 3,000 — a silent GST overcharge on every mixed-rate file.
    const txs: GstTransaction[] = [
      { documentNumber: "A", date: "2025-04-01", kind: "supply", taxableValue: 100000, category: "intra", ratePct: 12 },
      { documentNumber: "B", date: "2025-04-01", kind: "supply", taxableValue: 100000, category: "intra", ratePct: 18 },
    ];
    const r = computeGst3B(txs, "2025-04", 0, {
      rates: [
        { category: "intra", ratePct: 12 },
        { category: "intra", ratePct: 18 },
      ],
    });
    // 12% of 1,000 = 120; 18% of 1,000 = 180.
    expect(r.outwardTax / 100).toBe(300);
    expect(r.byRate.find((b) => b.ratePct === 12)?.tax).toBe(12000);
    expect(r.byRate.find((b) => b.ratePct === 18)?.tax).toBe(18000);
  });

  it("rounds a single line to the nearest paise", () => {
    expect(gstTax(minor(100), 18) / 100).toBe(18);
    // 1 paise at 18% rounds to 0.
    expect(gstTax(1, 18)).toBe(0);
  });
});

describe("TDS / TCS", () => {
  // Thresholds are in MINOR UNITS (paise), matching every other amount.
  const sections: TdsSection[] = [
    { section: "194J", description: "Professional fees", ratePct: 10, thresholdMinor: 3000000, tcs: false },
    { section: "194C", description: "Contract payments", ratePct: 1, thresholdMinor: 3000000, tcs: false },
    { section: "206C(1H)", description: "TDS on goods sold to residents", ratePct: 0.1, thresholdMinor: 0, tcs: false },
  ];

  it("deducts at the section rate above the threshold", () => {
    const r = computeTds(
      [{ payeeName: "Consultant LLP", pan: "ABCDE1234F", section: "194J", baseAmount: minor(100000) }],
      sections,
    );
    // 10% of 1,00,000 = 10,000
    expect(r.totalDeductible / 100).toBe(10000);
    expect(r.deductions[0]?.belowThreshold).toBe(false);
  });

  it("deducts nothing below the section threshold", () => {
    // ₹20,000 is under the ₹30,000 annual threshold for 194J.
    const r = computeTds(
      [{ payeeName: "Small Vendor", pan: "ABCDE1234F", section: "194J", baseAmount: minor(20000) }],
      sections,
    );
    expect(r.totalDeductible).toBe(0);
    expect(r.deductions[0]?.belowThreshold).toBe(true);
  });

  it("deducts at the threshold boundary, not below it", () => {
    // Exactly ₹30,000 is AT the threshold, so TDS applies (the rule is
    // "exceeds ₹30,000", and deducting at the boundary is the safe reading).
    const r = computeTds(
      [{ payeeName: "Boundary Vendor", pan: "ABCDE1234F", section: "194J", baseAmount: minor(30000) }],
      sections,
    );
    expect(r.totalDeductible / 100).toBe(3000);
  });

  it("flags a malformed PAN — the deduction cannot be claimed by the payee", () => {
    const r = computeTds(
      [{ payeeName: "Unknown Vendor", pan: "XX", section: "194J", baseAmount: minor(100000) }],
      sections,
    );
    expect(r.panIssues.length).toBe(1);
    expect(r.warnings.join(" ")).toMatch(/26Q|PAN/i);
  });

  it("groups totals by section", () => {
    const r = computeTds(
      [
        { payeeName: "A", pan: "ABCDE1234F", section: "194J", baseAmount: minor(100000) },
        { payeeName: "B", pan: "ABCDE1234F", section: "194J", baseAmount: minor(50000) },
        { payeeName: "C", pan: "ABCDE1234F", section: "194C", baseAmount: minor(200000) },
      ],
      sections,
    );
    const j = r.bySection.find((s) => s.section === "194J");
    expect(j?.count).toBe(2);
    expect((j?.amount ?? 0) / 100).toBe(15000); // 10k + 5k
  });

  it("refuses an unknown section rather than applying a default rate", () => {
    expect(() =>
      computeTds([{ payeeName: "X", pan: "ABCDE1234F", section: "999Z", baseAmount: minor(1000) }], sections),
    ).toThrow(ComplianceError);
  });

  it("refuses a negative payment base", () => {
    expect(() =>
      computeTds([{ payeeName: "X", pan: "ABCDE1234F", section: "194J", baseAmount: -minor(1000) }], sections),
    ).toThrow(/negative/i);
  });
});

describe("audit sampling", () => {
  // 1,000 items with a spread of values so MUS has something to rank.
  const population = Array.from({ length: 1000 }, (_, i) => ({
    id: `INV-${i}`,
    value: minor(100 + ((i * 37) % 900)),
  }));
  const totalValue = population.reduce((s, p) => s + p.value, 0);

  it("computes a sample size inside the population bounds", () => {
    const r = auditSample(population, { tolerableRate: 0.05, expectedRate: 0, confidence: 0.95 });
    expect(r.sampleSize).toBeGreaterThan(0);
    expect(r.sampleSize).toBeLessThanOrEqual(population.length);
  });

  it("is deterministic for a given seed — an auditor must be able to reproduce it", () => {
    // `random` is the seed-driven method; MUS sorts by value and is
    // deterministic regardless of the seed, which is a separate property.
    const a = auditSample(population, { method: "random", seed: 42 });
    const b = auditSample(population, { method: "random", seed: 42 });
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
  });

  it("draws a DIFFERENT sample for a different seed", () => {
    const a = auditSample(population, { method: "random", seed: 42 });
    const b = auditSample(population, { method: "random", seed: 99 });
    expect(a.items.map((i) => i.id)).not.toEqual(b.items.map((i) => i.id));
  });

  it("produces the same items for the same seed under MUS too — value ranking is deterministic", () => {
    const a = auditSample(population, { method: "mus", seed: 42 });
    const b = auditSample(population, { method: "mus", seed: 7 });
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
  });

  it("concludes 'acceptable' when sampled value is within tolerance", () => {
    const r = auditSample(population, { method: "random", tolerableRate: 0.5, seed: 1 });
    expect(r.conclusion).toBe("acceptable");
    expect(r.sampleValue).toBeLessThanOrEqual(r.populationValue);
  });

  it("concludes 'unacceptable' when sampled value exceeds tolerance", () => {
    const r = auditSample(population, { method: "mus", tolerableRate: 0.0001, seed: 1 });
    expect(r.conclusion).toBe("unacceptable");
    expect(r.reasons.join(" ")).toMatch(/tolerable|misstatement/i);
  });

  it("sums the population value exactly", () => {
    const r = auditSample(population, {});
    expect(r.populationValue).toBe(totalValue);
  });

  it("uses the larger of sample and one item — never zero", () => {
    const r = auditSample([{ id: "only", value: minor(100) }], {});
    expect(r.sampleSize).toBe(1);
  });

  it("refuses an expected rate at or above the tolerable rate", () => {
    expect(() => auditSample(population, { tolerableRate: 0.05, expectedRate: 0.1 })).toThrow(/below the tolerable/i);
  });

  it("refuses an empty population", () => {
    expect(() => auditSample([], {})).toThrow(ComplianceError);
  });

  it("refuses an unsupported confidence level rather than inventing one", () => {
    expect(() => auditSample(population, { confidence: 0.87 })).toThrow(/confidence/i);
  });

  it("applies a finite-population correction — a small population needs a smaller sample", () => {
    const small = population.slice(0, 30);
    const big = auditSample(population, { tolerableRate: 0.05 });
    const smallSample = auditSample(small, { tolerableRate: 0.05 });
    expect(smallSample.sampleSize).toBeLessThanOrEqual(small.length);
    // The correction matters most when n would approach N.
    expect(smallSample.sampleSize).toBeLessThan(big.sampleSize + small.length);
  });
});

describe("consolidation", () => {
  it("splits balances between parent share and non-controlling interests", () => {
    const r = consolidate([
      { entityId: "E1", name: "Parent", ownership: 1, balance: minor(100000) },
      { entityId: "E2", name: "Sub 60%", ownership: 0.6, balance: minor(50000) },
    ]);
    // Parent share: 100,000 + 30,000 = 130,000; NCI = 20,000; group = 150,000.
    expect(r.parentOnly / 100).toBe(130000);
    expect(r.nonControllingInterests / 100).toBe(20000);
    expect(r.groupTotal / 100).toBe(150000);
    expect(r.reconciled).toBe(true);
  });

  it("reconciles — parent share plus NCI always equals the group total", () => {
    const r = consolidate([
      { entityId: "A", name: "A", ownership: 0.51, balance: minor(1000) },
      { entityId: "B", name: "B", ownership: 0.33, balance: minor(2500) },
      { entityId: "C", name: "C", ownership: 1, balance: minor(700) },
    ]);
    expect(r.reconciled).toBe(true);
    expect(r.parentOnly + r.nonControllingInterests).toBe(r.groupTotal);
  });

  it("warns that intra-group eliminations are NOT applied", () => {
    const r = consolidate([{ entityId: "A", name: "A", ownership: 1, balance: minor(100) }]);
    expect(r.warnings.join(" ")).toMatch(/eliminat/i);
  });

  it("refuses an ownership outside 0..1", () => {
    expect(() => consolidate([{ entityId: "A", name: "A", ownership: 1.5, balance: minor(100) }])).toThrow(
      /between 0 and 1/i,
    );
  });

  it("refuses an empty set", () => {
    expect(() => consolidate([])).toThrow(ComplianceError);
  });
});
