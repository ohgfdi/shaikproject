/**
 * Fixed asset register — oracle tests.
 *
 * Hand-computed FY 2025-26 examples. Pinned exactly below:
 *   - SLM on ₹15,00,000 plant (15y, 5% residual): annual 95,000, full-FY
 *     period = 95,000; on a 10y furniture asset acquired mid-year, days-based
 *     pro-rating.
 *   - Half-year rule: put to use 2025-10-01 = exactly 180 days → full rate;
 *     2025-10-03 → 179 days → half rate.
 *   - Disposal: book loss at asset level; u/s 50 STCG only when proceeds
 *     exceed the whole block.
 *   - Caller-supplied taxOpeningWdv suppresses the derived-opening warning.
 */

import { buildAssetRegister, type Asset } from "@/lib/engine/fixed-assets";
import { INR } from "@/lib/engine/india-tax";

const base = (over: Partial<Asset> & Pick<Asset, "id" | "taxBlock" | "bookClass">): Asset => ({
  name: `Asset ${over.id}`,
  cost: INR(100000),
  acquisitionDate: "2025-04-01",
  putToUseDate: "2025-04-01",
  openingBookDepreciation: 0,
  ...over,
});

describe("book side (Companies Act SLM)", () => {
  it("depreciates a full-year plant asset: 15y, 5% residual", () => {
    const reg = buildAssetRegister({
      fy: "2025-26",
      assets: [base({ id: "P1", taxBlock: "plant-machinery", bookClass: "plant-machinery", cost: INR(1500000) })],
    });
    // (15,00,000 − 75,000) ÷ 15 = 95,000 p.a.; full FY charged inclusive (nextDay end).
    expect(reg.rows[0]!.book.depreciation).toBe(INR(95000));
    expect(reg.rows[0]!.book.closingWdv).toBe(INR(1500000) - INR(95000));
    expect(reg.book.depreciation).toBe(INR(95000));
    expect(reg.book.closingNetBlock).toBe(INR(1500000) - INR(95000));
  });

  it("pro-rates a mid-year acquisition by days", () => {
    const reg = buildAssetRegister({
      fy: "2025-26",
      assets: [
        base({
          id: "F1",
          taxBlock: "furniture",
          bookClass: "furniture",
          cost: INR(100000),
          acquisitionDate: "2025-07-01",
          putToUseDate: "2025-07-01",
        }),
      ],
    });
    // Furniture 10y: (1,00,000 − 5,000) ÷ 10 = 9,500 p.a.; Jul 1 → Apr 1 (exclusive end
    // = inclusive Mar 31) = 274 days → round(9,500 × 274/365) = ₹7,131.51.
    expect(reg.rows[0]!.book.depreciation).toBe(INR(7131.51));
  });

  it("books an asset-level loss on disposal but keeps tax treatment at the block", () => {
    const reg = buildAssetRegister({
      fy: "2025-26",
      assets: [
        base({
          id: "P2",
          taxBlock: "plant-machinery",
          bookClass: "plant-machinery",
          cost: INR(1500000),
          openingBookDepreciation: INR(95000),
          disposal: { date: "2025-12-31", saleProceeds: INR(1200000) },
        }),
      ],
      // Full-year SLM would be 95,000; Apr 1 → Dec 31 = 274 days →
      // round(95,000 × 274/365) = round(71,301.37) = 71,301.
    });
    const row = reg.rows[0]!;
    expect(row.disposed).toBe(true);
    // Book: opening WDV ₹14,05,000 (15,00,000 − 95,000); SLM Apr 1 → Jan 1
    // (275 days) = ₹71,575.34 → WDV ₹13,33,424.66; proceeds ₹12,00,000 → book
    // loss ₹1,33,424.66.
    expect(row.book.disposalEffect).toBe(INR(133424.66));
    expect(row.book.closingWdv).toBe(0);
  });
});

describe("book side (Companies Act WDV)", () => {
  it("charges each year on the carrying amount, not on cost again", () => {
    const rate = 1 - Math.pow(0.05, 1 / 15); // Schedule II rate for 15-year plant
    const reg = buildAssetRegister({
      fy: "2025-26",
      method: "wdv",
      assets: [
        base({
          id: "P3",
          taxBlock: "plant-machinery",
          bookClass: "plant-machinery",
          cost: INR(1500000),
          acquisitionDate: "2024-04-01",
          putToUseDate: "2024-04-01",
          openingBookDepreciation: INR(950000), // carrying amount ₹5,50,000 at FY start
        }),
      ],
    });
    const row = reg.rows[0]!;
    expect(row.book.openingWdv).toBe(INR(550000));
    expect(row.book.depreciation).toBe(Math.round(INR(550000) * rate));
    expect(row.book.depreciation).toBeLessThan(INR(100000)); // not 18.1% of ₹15,00,000
    expect(row.book.closingWdv).toBe(INR(550000) - row.book.depreciation);
  });
});

describe("tax side (block WDV)", () => {
  it("keeps an asset sold during the year in the opening block", () => {
    // Held at 1 April: ₹10,00,000 in the block. Sold 30 Sep for ₹6,00,000.
    // Opening 10,00,000, no addition, depreciation 15% = 1,50,000,
    // proceeds 6,00,000 → closing 2,50,000 and NO s.50 gain.
    const reg = buildAssetRegister({
      fy: "2025-26",
      assets: [
        base({
          id: "P4",
          taxBlock: "plant-machinery",
          bookClass: "plant-machinery",
          cost: INR(1000000),
          acquisitionDate: "2024-06-01",
          putToUseDate: "2024-06-01",
          disposal: { date: "2025-09-30", saleProceeds: INR(600000) },
        }),
      ],
    });
    const plant = reg.taxBlocks.find((b) => b.block === "plant-machinery")!;
    expect(plant.openingWdv).toBe(INR(1000000));
    expect(plant.fullRateAdditions).toBe(0);
    expect(plant.saleProceeds).toBe(INR(600000));
    expect(plant.depreciation).toBe(INR(150000));
    expect(plant.closingWdv).toBe(INR(250000));
    expect(plant.shortTermCapitalGain).toBe(0);
  });

  it("ignores a disposal that falls outside the financial year", () => {
    const reg = buildAssetRegister({
      fy: "2025-26",
      assets: [
        base({
          id: "P5",
          taxBlock: "plant-machinery",
          bookClass: "plant-machinery",
          acquisitionDate: "2023-04-01",
          putToUseDate: "2023-04-01",
          disposal: { date: "2024-11-30", saleProceeds: INR(800000) }, // prior FY
        }),
      ],
      taxOpeningWdv: { "plant-machinery": INR(500000) },
    });
    const plant = reg.taxBlocks.find((b) => b.block === "plant-machinery")!;
    expect(plant.saleProceeds).toBe(0);
    expect(plant.shortTermCapitalGain).toBe(0);
    expect(plant.depreciation).toBe(INR(75000));
    expect(reg.rows).toHaveLength(0);
    expect(reg.warnings.some((w) => w.includes("before FY"))).toBe(true);
  });

  it("excludes an asset acquired after the financial year ends", () => {
    const reg = buildAssetRegister({
      fy: "2025-26",
      assets: [
        base({
          id: "P6",
          taxBlock: "plant-machinery",
          bookClass: "plant-machinery",
          acquisitionDate: "2026-05-01",
          putToUseDate: "2026-05-01",
        }),
      ],
      taxOpeningWdv: { "plant-machinery": 0 },
    });
    expect(reg.rows).toHaveLength(0);
    expect(reg.taxBlocks[0]!.fullRateAdditions).toBe(0);
    expect(reg.warnings.some((w) => w.includes("after FY"))).toBe(true);
  });

  it("applies the half-year rule at the 180-day boundary (3 Oct is the last full-rate day)", () => {
    // Days are counted inclusively from put-to-use through 31 March:
    //   2025-10-03 → 3 Oct..31 Mar = 180 days → NOT less than 180 → full rate.
    //   2025-10-04 → 179 days → half rate.
    const reg = buildAssetRegister({
      fy: "2025-26",
      assets: [
        base({ id: "A1", taxBlock: "computers", bookClass: "electrical", putToUseDate: "2025-10-03" }),
        base({ id: "A2", taxBlock: "computers", bookClass: "electrical", putToUseDate: "2025-10-04" }),
      ],
      taxOpeningWdv: { computers: 0 },
    });
    const computers = reg.taxBlocks.find((b) => b.block === "computers")!;
    expect(computers.fullRateAdditions).toBe(INR(100000));
    expect(computers.halfRateAdditions).toBe(INR(100000));
    // Depreciation: 40% of 1,00,000 = 40,000 + 20% of 1,00,000 = 20,000 → 60,000.
    expect(computers.depreciation).toBe(INR(60000));
    expect(computers.closingWdv).toBe(INR(140000));
  });

  it("books STCG u/s 50 only when proceeds exceed the whole block", () => {
    // Block: opening 0, single asset sold for 1,20,000 → proceeds exceed block
    // by 1,20,000 (nothing to depreciate).
    const reg = buildAssetRegister({
      fy: "2025-26",
      assets: [
        base({
          id: "S1",
          taxBlock: "vehicles",
          bookClass: "vehicles",
          cost: INR(100000),
          openingBookDepreciation: INR(50000),
          disposal: { date: "2025-11-30", saleProceeds: INR(120000) },
        }),
      ],
      taxOpeningWdv: { vehicles: 0 },
    });
    const vehicles = reg.taxBlocks.find((b) => b.block === "vehicles")!;
    expect(vehicles.shortTermCapitalGain).toBe(INR(120000));
    expect(reg.warnings.some((w) => w.includes("u/s 50"))).toBe(true);
  });

  it("warns when the tax opening WDV was derived rather than supplied", () => {
    const reg = buildAssetRegister({
      fy: "2025-26",
      assets: [base({ id: "P1", taxBlock: "plant-machinery", bookClass: "plant-machinery" })],
    });
    const plant = reg.taxBlocks.find((b) => b.block === "plant-machinery")!;
    expect(plant.openingWdvDerived).toBe(true);
    expect(reg.warnings.some((w) => w.includes("DERIVED"))).toBe(true);
  });

  it("suppresses the derived warning when taxOpeningWdv is supplied", () => {
    const reg = buildAssetRegister({
      fy: "2025-26",
      assets: [
        base({
          id: "P1",
          taxBlock: "plant-machinery",
          bookClass: "plant-machinery",
          putToUseDate: "2024-04-01",
          acquisitionDate: "2024-04-01",
        }),
      ],
      taxOpeningWdv: { "plant-machinery": INR(500000) },
    });
    const plant = reg.taxBlocks.find((b) => b.block === "plant-machinery")!;
    expect(plant.openingWdvDerived).toBe(false);
    // Brought-forward ₹5,00,000, no current-year addition → 15% = ₹75,000.
    expect(plant.depreciation).toBe(INR(75000));
    expect(plant.closingWdv).toBe(INR(425000));
  });
});

describe("validation", () => {
  it("rejects a malformed FY, unknown classes/blocks and >5% residual", () => {
    expect(() => buildAssetRegister({ fy: "2025", assets: [] })).toThrow(/fy/);
    expect(() =>
      buildAssetRegister({
        fy: "2025-26",
        assets: [base({ id: "X", bookClass: "nope", taxBlock: "plant-machinery" })],
      }),
    ).toThrow(/book class/);
    expect(() =>
      buildAssetRegister({
        fy: "2025-26",
        assets: [base({ id: "X", bookClass: "plant-machinery", taxBlock: "nope" })],
      }),
    ).toThrow(/tax block/);
    expect(() => buildAssetRegister({ fy: "2025-26", assets: [], residualPct: 6 })).toThrow(/Residual/);
  });
});
