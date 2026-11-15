/**
 * ITR-U (updated return) engine — oracle tests.
 *
 * The window is measured from the END of the relevant assessment year and the
 * s.140B rate applies to additional tax + interest. Every figure below is
 * hand-computed; money is integer paise.
 */

import {
  DEFAULT_140B_BANDS,
  addMonths,
  additionalTaxRatePct,
  bandForFilingDate,
  buildUpdatedReturn,
  endOfAssessmentYear,
  monthsBetween,
  validateItrUPayload,
} from "@/lib/engine/itr-u";

const p = (rupees: number) => rupees * 100;

describe("endOfAssessmentYear", () => {
  it("maps an AY label to 31 March of its second year", () => {
    expect(endOfAssessmentYear("2023-24")).toBe("2024-03-31");
    expect(endOfAssessmentYear("2025-26")).toBe("2026-03-31");
  });

  it("rejects a malformed or non-consecutive label", () => {
    expect(() => endOfAssessmentYear("2023/24")).toThrow(/2023-24/);
    expect(() => endOfAssessmentYear("2023-25")).toThrow(/consecutive/);
  });
});

describe("monthsBetween", () => {
  it("counts complete calendar months", () => {
    expect(monthsBetween("2024-03-31", "2025-03-31")).toBe(12);
    expect(monthsBetween("2024-03-31", "2025-04-01")).toBe(12); // 12 whole months + 1 day
    expect(monthsBetween("2024-03-31", "2024-04-30")).toBe(0); // day-of-month 30 < 31, so not a whole month
    expect(monthsBetween("2024-03-31", "2024-05-01")).toBe(1);
  });

  it("never returns a negative count", () => {
    expect(monthsBetween("2025-03-31", "2024-03-31")).toBe(0);
  });
});

describe("addMonths / bandForFilingDate", () => {
  it("adds calendar months and clamps to a short month", () => {
    expect(addMonths("2024-03-31", 12)).toBe("2025-03-31");
    expect(addMonths("2024-03-31", 24)).toBe("2026-03-31");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29"); // clamped, 2024 is a leap year
  });

  it("turns on whether the filing is AFTER the window close, not on whole months", () => {
    // The 12-month window from 2024-03-31 closes on 2025-03-31.
    expect(bandForFilingDate("2024-03-31", "2025-03-31")).toEqual({
      ratePct: 25,
      upToMonths: 12,
      windowEndsOn: "2025-03-31",
    });
    expect(bandForFilingDate("2024-03-31", "2025-04-01")?.ratePct).toBe(50);
    expect(bandForFilingDate("2024-03-31", "2026-03-31")?.ratePct).toBe(50);
    expect(bandForFilingDate("2024-03-31", "2026-04-01")?.ratePct).toBe(60);
    expect(bandForFilingDate("2024-03-31", "2028-03-31")?.ratePct).toBe(70);
    expect(bandForFilingDate("2024-03-31", "2028-04-01")).toBeNull();
  });
});

describe("additionalTaxRatePct", () => {
  it("walks the 25 / 50 / 60 / 70 bands", () => {
    expect(additionalTaxRatePct(0)).toBe(25);
    expect(additionalTaxRatePct(12)).toBe(25);
    expect(additionalTaxRatePct(13)).toBe(50);
    expect(additionalTaxRatePct(24)).toBe(50);
    expect(additionalTaxRatePct(25)).toBe(60);
    expect(additionalTaxRatePct(36)).toBe(60);
    expect(additionalTaxRatePct(37)).toBe(70);
    expect(additionalTaxRatePct(48)).toBe(70);
  });

  it("returns null past the last band", () => {
    expect(additionalTaxRatePct(49)).toBeNull();
  });

  it("exposes the four default bands", () => {
    expect(DEFAULT_140B_BANDS.map((b) => [b.upToMonths, b.ratePct])).toEqual([
      [12, 25],
      [24, 50],
      [36, 60],
      [48, 70],
    ]);
  });
});

describe("buildUpdatedReturn", () => {
  const base = {
    pan: "AAAAA0000A",
    name: "Sharma Textiles Pvt Ltd",
    assessmentYear: "2023-24",
    originalReturnFiledDate: "2024-07-31",
    updatedReturnFilingDate: "2024-12-15", // 8 complete months after 2024-03-31 → 25% band
    originalTotalIncomeMinor: p(10_00_000),
    updatedTotalIncomeMinor: p(15_00_000),
    taxOnOriginalMinor: p(1_000),
    taxOnUpdatedMinor: p(2_500),
    interestOnUpdatedMinor: p(300),
    taxAlreadyPaidMinor: p(1_000),
    reasons: ["Incorrect reporting of interest income"],
  };

  it("computes the additional tax, the s.140B charge and the net payable", () => {
    const r = buildUpdatedReturn(base);
    expect(r.monthsElapsed).toBe(8);
    expect(r.bandRatePct).toBe(25);
    expect(r.additionalIncomeMinor).toBe(p(5_00_000));
    expect(r.additionalTaxOnIncomeMinor).toBe(p(1_500));
    expect(r.baseForAdditionalTaxMinor).toBe(p(1_800)); // 1,500 tax + 300 interest
    expect(r.additionalTax140BMinor).toBe(p(450)); // 25% of 1,800
    expect(r.totalLiabilityMinor).toBe(p(3_250)); // 2,500 + 300 + 450
    expect(r.netPayableMinor).toBe(p(2_250)); // less 1,000 already paid
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it("carries the figures into the payload with the band it applied", () => {
    const r = buildUpdatedReturn(base);
    expect(r.payload.form).toBe("ITR-U");
    expect(r.payload.assessmentYear).toBe("2023-24");
    expect(r.payload.tax.additionalTaxRatePct).toBe(25);
    expect(r.payload.tax.additionalTax140BMinor).toBe(p(450));
    expect(r.payload.income.additionalIncomeMinor).toBe(p(5_00_000));
    expect(r.payload.reason).toEqual(["Incorrect reporting of interest income"]);
    expect(r.payload.verification.filingDate).toBe("2024-12-15");
  });

  it("moves to the 60% band when the filing is three years late", () => {
    const r = buildUpdatedReturn({ ...base, updatedReturnFilingDate: "2026-06-01" });
    expect(r.monthsElapsed).toBe(26);
    expect(r.bandRatePct).toBe(60);
    expect(r.additionalTax140BMinor).toBe(p(1_080)); // 60% of 1,800
    expect(r.eligible).toBe(true);
  });

  it("blocks a filing past the end of the window and charges no additional tax", () => {
    const r = buildUpdatedReturn({ ...base, updatedReturnFilingDate: "2028-06-01" });
    expect(r.monthsElapsed).toBeGreaterThan(48);
    expect(r.bandRatePct).toBeNull();
    expect(r.additionalTax140BMinor).toBe(0);
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/48-month window \(it closed 2028-03-31\)/);
  });

  it("reports each factual blocker the caller flags", () => {
    const r = buildUpdatedReturn({
      ...base,
      pendingProceedings: true,
      searchOrSurvey: true,
      reducesReportedIncome: true,
      showsLoss: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.blockers).toHaveLength(4);
    expect(r.blockers.join(" ")).toMatch(/pending/);
    expect(r.blockers.join(" ")).toMatch(/search or survey/);
    expect(r.blockers.join(" ")).toMatch(/refund/);
    expect(r.blockers.join(" ")).toMatch(/loss/);
  });

  it("blocks an update that lowers the reported income even without the flag", () => {
    const r = buildUpdatedReturn({ ...base, updatedTotalIncomeMinor: p(8_00_000) });
    expect(r.additionalIncomeMinor).toBe(0);
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/cannot reduce reported income/);
  });

  it("accepts caller-supplied bands", () => {
    const r = buildUpdatedReturn({ ...base, bands: [{ upToMonths: 60, ratePct: 10 }] });
    expect(r.bandRatePct).toBe(10);
    expect(r.additionalTax140BMinor).toBe(p(180));
  });

  it("rejects malformed input", () => {
    expect(() => buildUpdatedReturn({ ...base, updatedReturnFilingDate: "15-12-2024" })).toThrow(/yyyy-mm-dd/);
    expect(() => buildUpdatedReturn({ ...base, taxOnUpdatedMinor: -1 })).toThrow(/non-negative/);
  });
});

describe("validateItrUPayload", () => {
  const good = buildUpdatedReturn({
    pan: "AAAAA0000A",
    name: "Sharma Textiles Pvt Ltd",
    assessmentYear: "2023-24",
    originalReturnFiledDate: "2024-07-31",
    updatedReturnFilingDate: "2024-12-15",
    originalTotalIncomeMinor: p(10_00_000),
    updatedTotalIncomeMinor: p(15_00_000),
    taxOnOriginalMinor: p(1_000),
    taxOnUpdatedMinor: p(2_500),
    interestOnUpdatedMinor: p(300),
    taxAlreadyPaidMinor: p(1_000),
    reasons: ["Incorrect reporting of interest income"],
  }).payload;

  it("accepts a payload the engine built", () => {
    const v = validateItrUPayload(good);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("rejects a bad PAN, a missing reason and a missing form", () => {
    expect(validateItrUPayload({ ...good, pan: "BADPAN" }).errors.join(" ")).toMatch(/pan/);
    expect(validateItrUPayload({ ...good, reason: [] }).errors.join(" ")).toMatch(/reason/);
    expect(validateItrUPayload({ ...good, form: "ITR-3" }).errors.join(" ")).toMatch(/ITR-U/);
    expect(validateItrUPayload(null).valid).toBe(false);
  });

  it("warns when no band was applied", () => {
    const v = validateItrUPayload({ ...good, tax: { ...good.tax, additionalTaxRatePct: null } });
    expect(v.valid).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/s.140B band/);
  });
});
