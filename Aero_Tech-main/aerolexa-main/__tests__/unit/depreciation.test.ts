/**
 * India depreciation engine — oracle tests.
 *
 * SLM/WDV and the half-year rule are all hand-computable, so the expected
 * figures below are derived by hand. The half-year rule and the u/s 50
 * short-term gain are the two that trip people up; both are pinned exactly.
 */

import { DepreciationError, companiesActDepreciation, incomeTaxDepreciation } from "@/lib/engine/depreciation";
import { INR } from "@/lib/engine/india-tax";

const r = (minor: number) => minor / 100;

describe("Companies Act depreciation", () => {
  it("charges SLM on cost less residual over the useful life", () => {
    const res = companiesActDepreciation({ cost: INR(100000), usefulLifeYears: 10, method: "slm" });
    expect(r(res.residualValue)).toBe(5000); // 5% default
    expect(r(res.depreciableAmount)).toBe(95000);
    expect(r(res.annualDepreciation)).toBe(9500);
  });

  it("pro-rates SLM by days", () => {
    // 1 Oct 2024 → 31 Mar 2025 = 181 days; 9,500 × 181/365 = 4,710.9589 → 4,710.96 (paise precision).
    const res = companiesActDepreciation({
      cost: INR(100000),
      usefulLifeYears: 10,
      method: "slm",
      from: "2024-10-01",
      to: "2025-03-31",
    });
    expect(res.days).toBe(181);
    expect(r(res.periodDepreciation)).toBeCloseTo(4710.96, 2);
  });

  it("derives the WDV rate from the residual value", () => {
    // rate = 1 − 0.05^(1/3) = 63.16%; charge on ₹1,00,000 = ₹63,160.
    const res = companiesActDepreciation({ cost: INR(100000), usefulLifeYears: 3, method: "wdv" });
    expect(res.ratePct).toBeCloseTo(63.16, 1);
    expect(r(res.annualDepreciation)).toBeCloseTo(63160, 0);
  });

  it("refuses a residual value above the 5% ceiling", () => {
    expect(() =>
      companiesActDepreciation({ cost: INR(100000), usefulLifeYears: 5, method: "slm", residualValuePct: 6 }),
    ).toThrow(DepreciationError);
  });

  it("charges WDV on the opening carrying amount, not on cost again", () => {
    // Schedule II rate = 1 − 0.05^(1/3) = 63.16%, fixed by the ORIGINAL cost and
    // residual. Year 1 charges it on ₹1,00,000 (₹63,159.70); year 2 must charge
    // the same rate on the ₹36,840.30 that is left, not another ₹63,159.70.
    const rate = 1 - Math.pow(0.05, 1 / 3);
    const year1 = companiesActDepreciation({ cost: INR(100000), usefulLifeYears: 3, method: "wdv" });
    const year1Charge = Math.round(INR(100000) * rate);
    expect(year1.periodDepreciation).toBe(year1Charge);

    const openingYear2 = INR(100000) - year1Charge;
    const year2 = companiesActDepreciation({
      cost: INR(100000),
      usefulLifeYears: 3,
      method: "wdv",
      openingWdv: openingYear2,
    });
    expect(year2.openingWdv).toBe(openingYear2);
    expect(year2.periodDepreciation).toBe(Math.round(openingYear2 * rate));
    expect(year2.periodDepreciation).toBeLessThan(year1.periodDepreciation);
  });

  it("stops SLM at the residual value", () => {
    // ₹1,00,000 over 10 years = ₹9,500 p.a., but only ₹500 of depreciable value is left.
    const res = companiesActDepreciation({
      cost: INR(100000),
      usefulLifeYears: 10,
      method: "slm",
      openingWdv: INR(5500),
    });
    expect(res.periodDepreciation).toBe(INR(500));
    expect(res.openingWdv - res.periodDepreciation).toBe(INR(5000));
  });

  it("refuses a WDV rate at a zero residual (the formula degenerates to 100%)", () => {
    expect(() =>
      companiesActDepreciation({ cost: INR(100000), usefulLifeYears: 5, method: "wdv", residualValuePct: 0 }),
    ).toThrow(/non-zero residual/);
  });
});

describe("Income tax depreciation (block WDV)", () => {
  it("charges the block rate on the opening WDV", () => {
    const res = incomeTaxDepreciation({ openingWdv: INR(100000), ratePct: 15, fy: "2024-25" });
    expect(r(res.normalDepreciation)).toBe(15000);
    expect(r(res.closingWdv)).toBe(85000);
  });

  it("gives a full year's rate to an asset used 180 days or more", () => {
    const res = incomeTaxDepreciation({
      openingWdv: 0,
      ratePct: 15,
      fy: "2024-25",
      additions: [{ amount: INR(100000), putToUseDate: "2024-04-01" }],
    });
    expect(res.fullRateAdditions).toBe(INR(100000));
    expect(res.halfRateAdditions).toBe(0);
    expect(r(res.normalDepreciation)).toBe(15000);
    expect(r(res.closingWdv)).toBe(85000);
  });

  it("halves the rate for an asset used under 180 days", () => {
    // 1 Jan 2025 → 31 Mar 2025 = 89 days → half of 15% = 7.5% → ₹7,500.
    const res = incomeTaxDepreciation({
      openingWdv: 0,
      ratePct: 15,
      fy: "2024-25",
      additions: [{ amount: INR(100000), putToUseDate: "2025-01-01" }],
    });
    expect(res.halfRateAdditions).toBe(INR(100000));
    expect(r(res.normalDepreciation)).toBe(7500);
    expect(r(res.closingWdv)).toBe(92500);
  });

  it("reduces the block by sale proceeds", () => {
    const res = incomeTaxDepreciation({
      openingWdv: INR(100000),
      ratePct: 15,
      fy: "2024-25",
      saleProceeds: INR(40000),
    });
    expect(r(res.normalDepreciation)).toBe(15000);
    expect(r(res.closingWdv)).toBe(45000); // 1,00,000 − 40,000 − 15,000
  });

  it("adds 32(1)(iia) additional depreciation on eligible new plant", () => {
    const res = incomeTaxDepreciation({
      openingWdv: 0,
      ratePct: 15,
      fy: "2024-25",
      additions: [{ amount: INR(100000), putToUseDate: "2024-04-01", additionalEligible: true }],
      additionalDepreciationPct: 20,
    });
    expect(r(res.normalDepreciation)).toBe(15000);
    expect(r(res.additionalDepreciation)).toBe(20000);
    expect(r(res.totalDepreciation)).toBe(35000);
    expect(r(res.closingWdv)).toBe(65000);
  });

  it("counts the 180 days inclusively: 3 October is the last full-rate day", () => {
    const full = incomeTaxDepreciation({
      openingWdv: 0,
      ratePct: 15,
      fy: "2024-25",
      additions: [{ amount: INR(100000), putToUseDate: "2024-10-03" }],
    });
    expect(full.fullRateAdditions).toBe(INR(100000));
    expect(full.halfRateAdditions).toBe(0);

    const half = incomeTaxDepreciation({
      openingWdv: 0,
      ratePct: 15,
      fy: "2024-25",
      additions: [{ amount: INR(100000), putToUseDate: "2024-10-04" }],
    });
    expect(half.halfRateAdditions).toBe(INR(100000));
    expect(half.fullRateAdditions).toBe(0);
  });

  it("rejects an addition put to use outside the financial year", () => {
    expect(() =>
      incomeTaxDepreciation({
        openingWdv: 0,
        ratePct: 15,
        fy: "2024-25",
        additions: [{ amount: INR(100000), putToUseDate: "2025-04-01" }],
      }),
    ).toThrow(/after FY/);
    expect(() =>
      incomeTaxDepreciation({
        openingWdv: 0,
        ratePct: 15,
        fy: "2024-25",
        additions: [{ amount: INR(100000), putToUseDate: "2024-03-31" }],
      }),
    ).toThrow(/opening block/);
  });

  it("recognises a u/s 50 short-term gain when the block goes negative", () => {
    const res = incomeTaxDepreciation({
      openingWdv: 0,
      ratePct: 15,
      fy: "2024-25",
      additions: [{ amount: INR(100000), putToUseDate: "2024-04-01" }],
      saleProceeds: INR(120000),
    });
    expect(r(res.shortTermCapitalGain)).toBe(35000); // 1,20,000 − 1,00,000 + 15,000
    expect(res.closingWdv).toBe(0);
  });
});
