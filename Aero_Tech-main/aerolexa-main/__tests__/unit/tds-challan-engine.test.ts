/**
 * TDS Challan Mapping & Bank Reconciliation Engine — tests.
 */

import {
  TdsChallanReceipt,
  TdsDeductionEvent,
  mapChallansToDeductions,
  reconcileChallans,
  challanCoverageSummary,
  verifyChallan,
  isValidBsrCode,
  isValidChallanSerial,
} from "@/lib/engine/tds-challan-engine";

function makeChallan(over: Partial<TdsChallanReceipt> = {}): TdsChallanReceipt {
  return {
    bsrCode: "0004329",
    challanSerial: "00345",
    dateOfDeposit: "2025-05-10",
    amount: 15_50_00,
    section: "194C",
    deducteePan: "AAAAA0000A",
    verified: false,
    ...over,
  };
}

function makeDeduction(over: Partial<TdsDeductionEvent> = {}): TdsDeductionEvent {
  return {
    id: over.id || `ded-${Math.random().toString(36).slice(2)}`,
    section: over.section || "194C",
    deducteePan: over.deducteePan || "AAAAA0000A",
    deducteeName: over.deducteeName || "Test Payee",
    grossAmount: over.grossAmount ?? 1_00_00_00,
    tdsAmount: over.tdsAmount ?? 2_00_00,
    dateOfDeduction: over.dateOfDeduction || "2025-05-15",
    dateOfPaymentOrCredit: over.dateOfPaymentOrCredit || "2025-05-15",
    status: over.status || "deducted",
    challanRef: over.challanRef ?? null,
    bsrCode: over.bsrCode ?? null,
    challanSerial: over.challanSerial ?? null,
    dateOfDeposit: over.dateOfDeposit ?? null,
    challanAmount: over.challanAmount ?? null,
    tracesVerified: over.tracesVerified ?? false,
    voucherId: over.voucherId ?? null,
    notes: over.notes ?? null,
  };
}

describe("isValidBsrCode", () => {
  it("accepts valid 7-digit BSR codes", () => {
    expect(isValidBsrCode("0004329")).toBe(true);
    expect(isValidBsrCode("1234567")).toBe(true);
    expect(isValidBsrCode("9999999")).toBe(true);
  });

  it("rejects invalid BSR codes", () => {
    expect(isValidBsrCode("123456")).toBe(false); // 6 digits
    expect(isValidBsrCode("12345678")).toBe(false); // 8 digits
    expect(isValidBsrCode("12345a7")).toBe(false); // non-digit
    expect(isValidBsrCode("")).toBe(false);
  });
});

describe("isValidChallanSerial", () => {
  it("accepts valid serial numbers", () => {
    expect(isValidChallanSerial("00345")).toBe(true);
    expect(isValidChallanSerial("ABC123")).toBe(true);
    expect(isValidChallanSerial("CH-123")).toBe(true);
    expect(isValidChallanSerial("1234567890")).toBe(true);
  });

  it("rejects invalid serial numbers", () => {
    expect(isValidChallanSerial("")).toBe(false);
    expect(isValidChallanSerial("abc@123")).toBe(false); // special char
  });
});

describe("verifyChallan", () => {
  it("validates a correct challan", () => {
    const challan = makeChallan();
    const result = verifyChallan(challan);
    expect(result.valid).toBe(true);
    expect(result.bsrCodeValid).toBe(true);
    expect(result.challanSerialValid).toBe(true);
    expect(result.dateValid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("flags invalid BSR code", () => {
    const result = verifyChallan(makeChallan({ bsrCode: "12345" }));
    expect(result.valid).toBe(false);
    expect(result.bsrCodeValid).toBe(false);
    expect(result.issues.some((i) => i.includes("BSR code"))).toBe(true);
  });

  it("flags invalid date format", () => {
    const result = verifyChallan(makeChallan({ dateOfDeposit: "10-05-2025" }));
    expect(result.valid).toBe(false);
    expect(result.dateValid).toBe(false);
  });

  it("flags future date", () => {
    const result = verifyChallan(makeChallan({ dateOfDeposit: "2027-05-10" }));
    expect(result.valid).toBe(false);
    expect(result.dateInFuture).toBe(true);
  });
});

describe("mapChallansToDeductions", () => {
  it("maps deductions to challans by section and PAN", () => {
    const challans = [
      makeChallan({
        amount: 5_00_00,
        section: "194C",
        deducteePan: "AAAAA0000A",
        bsrCode: "0004329",
        challanSerial: "001",
      }),
      makeChallan({
        amount: 5_00_00,
        section: "194C",
        deducteePan: "BBBBB1111B",
        bsrCode: "0004329",
        challanSerial: "002",
      }),
    ];

    const deductions = [
      makeDeduction({
        tdsAmount: 2_00_00,
        section: "194C",
        deducteePan: "AAAAA0000A",
        id: "d1",
        dateOfDeduction: "2025-05-15",
      }),
      makeDeduction({
        tdsAmount: 2_00_00,
        section: "194C",
        deducteePan: "AAAAA0000A",
        id: "d2",
        dateOfDeduction: "2025-05-20",
      }),
      makeDeduction({
        tdsAmount: 2_00_00,
        section: "194C",
        deducteePan: "BBBBB1111B",
        id: "d3",
        dateOfDeduction: "2025-05-25",
      }),
    ];

    const { mappings, unmappedDeductions } = mapChallansToDeductions(challans, deductions);

    expect(mappings.length).toBe(2);
    expect(unmappedDeductions).toHaveLength(0);

    // First challan should cover d1 and d2 (same PAN, same section)
    const firstMapping = mappings.find((m) => m.challan.challanSerial === "001");
    expect(firstMapping?.deductions).toHaveLength(2);
    expect(firstMapping?.deductions.map((d) => d.id)).toContain("d1");
    expect(firstMapping?.deductions.map((d) => d.id)).toContain("d2");
    expect(firstMapping?.totalCovered).toBe(4_00_00);
    expect(firstMapping?.fullyUtilized).toBe(false); // ₹5,000 - ₹4,000 = ₹1,000 surplus

    // Second challan should cover d3
    const secondMapping = mappings.find((m) => m.challan.challanSerial === "002");
    expect(secondMapping?.deductions).toHaveLength(1);
    expect(secondMapping?.deductions[0]?.id).toBe("d3");
  });

  it("leaves deductions unmapped when no challan has sufficient balance", () => {
    const challans = [
      makeChallan({ amount: 3_00_00, section: "194C", deducteePan: "AAAAA0000A", challanSerial: "001" }),
    ];
    const deductions = [
      makeDeduction({ tdsAmount: 2_00_00, section: "194C", deducteePan: "AAAAA0000A", id: "d1" }),
      makeDeduction({ tdsAmount: 2_00_00, section: "194C", deducteePan: "AAAAA0000A", id: "d2" }),
    ];

    const { mappings, unmappedDeductions } = mapChallansToDeductions(challans, deductions);

    expect(mappings.length).toBe(1);
    expect(unmappedDeductions).toHaveLength(1); // d2 is unmapped (challan exhausted)
  });

  it("allows untagged challans to cover any deduction", () => {
    const challans = [makeChallan({ amount: 5_00_00, section: null, deducteePan: null, challanSerial: "001" })];
    const deductions = [
      makeDeduction({ tdsAmount: 2_00_00, section: "194C", deducteePan: "AAAAA0000A", id: "d1" }),
      makeDeduction({ tdsAmount: 2_00_00, section: "194J", deducteePan: "BBBBB1111B", id: "d2" }),
    ];

    const { mappings, unmappedDeductions } = mapChallansToDeductions(challans, deductions, {
      allowUntaggedMatch: true,
    });

    expect(unmappedDeductions).toHaveLength(0);
    expect(mappings[0]!.deductions).toHaveLength(2); // Both covered by untagged challan
  });

  it("does not match cross-section by default", () => {
    const challans = [
      makeChallan({ amount: 5_00_00, section: "194C", deducteePan: "AAAAA0000A", challanSerial: "001" }),
    ];
    const deductions = [makeDeduction({ tdsAmount: 2_00_00, section: "194J", deducteePan: "AAAAA0000A", id: "d1" })];

    const { mappings, unmappedDeductions } = mapChallansToDeductions(challans, deductions, {
      allowCrossSectionMatch: false,
    });

    expect(unmappedDeductions).toHaveLength(1); // d1 not covered (section mismatch)
    expect(mappings.length).toBe(0);
  });

  it("matches cross-section when allowed", () => {
    const challans = [
      makeChallan({ amount: 5_00_00, section: "194C", deducteePan: "AAAAA0000A", challanSerial: "001" }),
    ];
    const deductions = [makeDeduction({ tdsAmount: 2_00_00, section: "194J", deducteePan: "AAAAA0000A", id: "d1" })];

    const { mappings, unmappedDeductions } = mapChallansToDeductions(challans, deductions, {
      allowCrossSectionMatch: true,
    });

    expect(unmappedDeductions).toHaveLength(0);
    expect(mappings.length).toBe(1);
    expect(mappings[0]!.deductions[0]!.id).toBe("d1");
  });

  it("prefers earlier-dated challans when multiple candidates exist", () => {
    const challans = [
      makeChallan({
        amount: 5_00_00,
        section: "194C",
        deducteePan: "AAAAA0000A",
        challanSerial: "001",
        dateOfDeposit: "2025-06-10",
      }),
      makeChallan({
        amount: 5_00_00,
        section: "194C",
        deducteePan: "AAAAA0000A",
        challanSerial: "002",
        dateOfDeposit: "2025-05-10",
      }),
    ];
    const deductions = [
      makeDeduction({
        tdsAmount: 2_00_00,
        section: "194C",
        deducteePan: "AAAAA0000A",
        id: "d1",
        dateOfDeduction: "2025-05-15",
      }),
    ];

    const { mappings } = mapChallansToDeductions(challans, deductions);
    const usedChallan = mappings[0]!.deductions[0]!;
    expect(usedChallan.dateOfDeduction).toBe("2025-05-15");
    // The earlier-dated challan (002) should be preferred
    expect(mappings[0]!.challan.challanSerial).toBe("002");
  });
});

describe("reconcileChallans", () => {
  it("matches challans with bank entries", () => {
    const challans = [makeChallan({ amount: 15_50_00, challanSerial: "001", dateOfDeposit: "2025-05-10" })];
    const bankStatement = [{ date: "2025-05-10", description: "TDS DEPOSIT", amount: 15_50_00, ref: "BANK-REF-001" }];

    const entries = reconcileChallans(challans, bankStatement);
    expect(entries.length).toBe(1);
    expect(entries[0]!.status).toBe("matched");
    expect(entries[0]!.bankAmount).toBe(15_50_00);
    expect(entries[0]!.difference).toBe(0);
  });

  it("flags shortfall when bank credited less", () => {
    const challans = [makeChallan({ amount: 15_50_00, challanSerial: "001" })];
    const bankStatement = [{ date: "2025-05-10", description: "TDS DEPOSIT", amount: 15_00_00, ref: "BANK-REF-001" }];

    const entries = reconcileChallans(challans, bankStatement);
    expect(entries[0]!.status).toBe("short");
    expect(entries[0]!.difference).toBe(-50_00); // ₹500 short
  });

  it("flags excess when bank credited more", () => {
    const challans = [makeChallan({ amount: 15_50_00, challanSerial: "001" })];
    const bankStatement = [{ date: "2025-05-10", description: "TDS DEPOSIT", amount: 16_00_00, ref: "BANK-REF-001" }];

    const entries = reconcileChallans(challans, bankStatement);
    expect(entries[0]!.status).toBe("excess");
    expect(entries[0]!.difference).toBe(50_00); // ₹500 excess
  });

  it("flags unverified when no bank entry found", () => {
    const challans = [makeChallan({ amount: 15_50_00, challanSerial: "001" })];
    const bankStatement: { date: string; description: string; amount: number; ref: string }[] = [];

    const entries = reconcileChallans(challans, bankStatement);
    expect(entries[0]!.status).toBe("unverified");
  });
});

describe("challanCoverageSummary", () => {
  it("summarizes challan coverage", () => {
    const challans = [
      makeChallan({ amount: 5_00_00, challanSerial: "001", section: "194C", deducteePan: "AAAAA0000A" }),
      makeChallan({ amount: 5_00_00, challanSerial: "002", section: "194C", deducteePan: "BBBBB1111B" }),
    ];
    const deductions = [
      makeDeduction({ tdsAmount: 4_00_00, section: "194C", deducteePan: "AAAAA0000A", id: "d1" }),
      makeDeduction({ tdsAmount: 3_00_00, section: "194C", deducteePan: "BBBBB1111B", id: "d2" }),
    ];

    const { mappings, unmappedDeductions } = mapChallansToDeductions(challans, deductions);
    const summary = challanCoverageSummary(mappings, unmappedDeductions);

    expect(summary.totalChallans).toBe(2);
    expect(summary.totalChallanAmount).toBe(10_00_00);
    expect(summary.totalDeductionAmount).toBe(7_00_00);
    expect(summary.totalMappedAmount).toBe(7_00_00);
    expect(summary.totalUnmappedAmount).toBe(0);
    expect(summary.fullyUtilizedChallans).toBe(0); // None fully utilized
    expect(summary.partiallyUtilizedChallans).toBe(2);
    expect(summary.coveragePercentage).toBeCloseTo(70, 0); // 7,000 / 10,000 = 70%
  });
});
