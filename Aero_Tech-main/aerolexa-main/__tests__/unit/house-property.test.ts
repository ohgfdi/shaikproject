/**
 * House-property head — oracle tests.
 *
 * Pins the three rules that are most often got wrong:
 *   - a self-occupied house has NIL annual value (s.23(2)); only the interest
 *     under 24(b) survives, capped at ₹2,00,000;
 *   - a let-out house uses the HIGHER of expected rent and actual rent, less
 *     municipal taxes, then the 30% deduction under 24(a), with full interest;
 *   - a current-year loss sets off against other heads only up to ₹2,00,000
 *     (s.71(3A)); the balance is carried forward for eight AYs.
 *
 * All figures are hand-computed and in paise.
 */

import { computeHousePropertyAggregate, computeProperty } from "@/lib/engine/income-head-house-property";
import { INR } from "@/lib/engine/india-tax";

const r = (minor: number) => minor / 100;

const baseProperty = {
  id: "HP-1",
  status: "let-out" as const,
  municipalValue: INR(600000),
  fairRent: INR(660000),
  standardRent: INR(700000),
  rentReceived: INR(720000),
  municipalTaxPaid: INR(20000),
  interestOnHousingLoan: INR(250000),
};

describe("let-out property", () => {
  it("uses the higher of expected rent and actual rent, then 24(a) and full 24(b)", () => {
    const res = computeProperty(baseProperty);
    expect(r(res.expectedRent)).toBe(660000); // max(MV, FR) capped by standard rent
    expect(r(res.nav)).toBe(700000); // 7,20,000 − 20,000 municipal tax
    expect(r(res.standardDeduction30)).toBe(210000);
    expect(r(res.totalDeductionUnder24)).toBe(250000); // full interest, no cap
    expect(r(res.incomeFromHouseProperty)).toBe(240000);
    expect(res.lossFromHouseProperty).toBe(0);
  });

  it("adds unrealized rent realized in the year to the actual rent", () => {
    const res = computeProperty({
      ...baseProperty,
      municipalValue: INR(400000),
      fairRent: undefined,
      standardRent: undefined,
      rentReceived: INR(500000),
      unrealizedRealized: INR(50000),
      municipalTaxPaid: INR(10000),
      interestOnHousingLoan: 0,
    });
    // GAV max(4,00,000, 5,50,000) = 5,50,000; NAV 5,40,000; 30% = 1,62,000.
    expect(r(res.nav)).toBe(540000);
    expect(r(res.incomeFromHouseProperty)).toBe(378000);
  });
});

describe("self-occupied property", () => {
  it("has nil annual value and only the 24(b) interest survives", () => {
    const res = computeProperty({
      id: "HP-SO",
      status: "self-occupied",
      municipalValue: INR(500000),
      rentReceived: 0,
      municipalTaxPaid: 0,
      interestOnHousingLoan: INR(150000),
    });
    expect(res.nav).toBe(0);
    expect(res.standardDeduction30).toBe(0);
    expect(r(res.incomeFromHouseProperty)).toBe(-150000);
    expect(r(res.lossFromHouseProperty)).toBe(150000);
  });

  it("caps self-occupied interest at ₹2,00,000 including pre-construction interest", () => {
    const res = computeProperty({
      id: "HP-SO2",
      status: "self-occupied",
      municipalValue: INR(500000),
      rentReceived: 0,
      municipalTaxPaid: 0,
      interestOnHousingLoan: INR(200000),
      preConstructionInterest: INR(60000),
    });
    expect(r(res.totalDeductionUnder24)).toBe(200000);
    expect(r(res.lossFromHouseProperty)).toBe(200000);
  });

  it("honours a caller-supplied lower ceiling (pre-1999 loan)", () => {
    const res = computeProperty({
      id: "HP-SO3",
      status: "self-occupied",
      municipalValue: INR(300000),
      rentReceived: 0,
      municipalTaxPaid: 0,
      interestOnHousingLoan: INR(45000),
      interestCeiling: INR(30000),
    });
    expect(r(res.totalDeductionUnder24)).toBe(30000);
  });
});

describe("aggregate and loss discipline", () => {
  it("nets a self-occupied loss against let-out income", () => {
    const res = computeHousePropertyAggregate(
      {
        ay: "2025-26",
        regimeLabel: "old",
        properties: [
          baseProperty,
          {
            id: "HP-SO",
            status: "self-occupied",
            municipalValue: INR(500000),
            rentReceived: 0,
            municipalTaxPaid: 0,
            interestOnHousingLoan: INR(200000),
          },
        ],
      },
      0,
    );
    expect(r(res.totalIncomeFromHouseProperty)).toBe(40000); // 2,40,000 − 2,00,000
    expect(res.totalLossFromHouseProperty).toBe(0);
    expect(res.lossSetOffAgainstOtherHeadsThisYear).toBe(0);
    expect(r(res.netIncomeAfterSetOff)).toBe(40000);
  });

  it("caps set-off against other heads at ₹2,00,000 and carries the rest forward", () => {
    const res = computeHousePropertyAggregate(
      {
        ay: "2025-26",
        regimeLabel: "old",
        properties: [
          {
            id: "SO-1",
            status: "self-occupied",
            municipalValue: INR(1000000),
            rentReceived: 0,
            municipalTaxPaid: 0,
            interestOnHousingLoan: INR(200000),
          },
          {
            id: "SO-2",
            status: "self-occupied",
            municipalValue: INR(1000000),
            rentReceived: 0,
            municipalTaxPaid: 0,
            interestOnHousingLoan: INR(200000),
          },
        ],
      },
      0,
    );
    expect(r(res.totalLossFromHouseProperty)).toBe(400000);
    expect(r(res.lossSetOffAgainstOtherHeadsThisYear)).toBe(200000);
    expect(r(res.lossToBeCarriedForwardToNextYear)).toBe(200000);
  });

  it("sets brought-forward loss only against house-property income", () => {
    const res = computeHousePropertyAggregate(
      {
        ay: "2025-26",
        regimeLabel: "old",
        properties: [baseProperty],
      },
      INR(100000),
    );
    expect(r(res.lossSetOffAgainstHousePropertyThisYear)).toBe(100000);
    expect(r(res.netIncomeAfterSetOff)).toBe(140000); // 2,40,000 − 1,00,000
    expect(r(res.lossToBeCarriedForwardToNextYear)).toBe(0);
  });
});
