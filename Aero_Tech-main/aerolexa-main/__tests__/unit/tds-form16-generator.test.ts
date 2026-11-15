/**
 * Form 16 / Form 16A Generation — tests.
 */

import {
  generateForm16PartA,
  generateForm16PartB,
  generateForm16A,
  validateForm16Certificate,
  computeOldRegimeTax,
  quarterDateRange,
  certificateSummaryForDeductee,
  TdsCertificate,
} from "@/lib/engine/tds-form16-generator";

describe("computeOldRegimeTax", () => {
  it("computes tax for income below ₹2,50,000 (nil)", () => {
    expect(computeOldRegimeTax(2_50_00_000)).toBe(0); // ₹2,50,000
  });

  it("computes 5% tax on ₹2,50,001 to ₹5,00,000", () => {
    expect(computeOldRegimeTax(5_00_00_000)).toBe(12_50_000); // ₹2,50,000 × 5% = ₹12,500
  });

  it("computes 20% tax on ₹5,00,001 to ₹10,00,000", () => {
    // ₹2,50,000 × 5% + ₹5,00,000 × 20% = ₹12,500 + ₹1,00,000 = ₹1,12,500
    expect(computeOldRegimeTax(10_00_00_000)).toBe(1_12_50_000);
  });

  it("computes 30% tax on income above ₹10,00,000", () => {
    // ₹2,50,000 × 5% + ₹5,00,000 × 20% + ₹5,00,000 × 30% = ₹12,500 + ₹1,00,000 + ₹1,50,000 = ₹2,62,500
    expect(computeOldRegimeTax(15_00_00_000)).toBe(2_62_50_000);
  });

  it("computes tax for senior citizens (60-80 years)", () => {
    // Senior citizen: nil up to ₹3,00,000, 5% on ₹3,00,001-₹5,00,000, 20% on ₹5,00,001-₹10,00,000, 30% above
    // ₹5,00,000: nil on ₹3,00,000 + 5% on ₹2,00,000 = ₹10,000
    expect(computeOldRegimeTax(5_00_00_000, 65)).toBe(10_00_000);
  });

  it("computes tax for super senior citizens (80+ years)", () => {
    // Super senior: nil up to ₹5,00,000, 20% on ₹5,00,001-₹10,00,000, 30% above
    // ₹10,00,000: nil on ₹5,00,000 + 20% on ₹5,00,000 = ₹1,00,000
    expect(computeOldRegimeTax(10_00_00_000, 82)).toBe(1_00_00_000);
  });
});

describe("quarterDateRange", () => {
  it("returns correct date ranges for all quarters", () => {
    expect(quarterDateRange("Q1", "2025-26")).toEqual({ from: "2025-04-01", to: "2025-06-30" });
    expect(quarterDateRange("Q2", "2025-26")).toEqual({ from: "2025-07-01", to: "2025-09-30" });
    expect(quarterDateRange("Q3", "2025-26")).toEqual({ from: "2025-10-01", to: "2026-03-31" });
  });
});

describe("generateForm16PartA", () => {
  it("aggregates salary and TDS by quarter", () => {
    const entries = [
      {
        id: "e1",
        quarter: "Q1",
        fy: "2025-26",
        dateOfPayment: "2025-04-30",
        grossAmount: 5_00_00_000,
        tdsAmount: 50_00_000, // 10% of 5,00,000
        challanRef: "0004329/001",
        bsrCode: "0004329",
        challanSerial: "001",
        dateOfDeposit: "2025-05-07",
        challanAmount: 50_00_000,
        status: "deposited",
      },
      {
        id: "e2",
        quarter: "Q1",
        fy: "2025-26",
        dateOfPayment: "2025-05-31",
        grossAmount: 5_00_00_000,
        tdsAmount: 50_00_000,
        challanRef: "0004329/002",
        bsrCode: "0004329",
        challanSerial: "002",
        dateOfDeposit: "2025-06-07",
        challanAmount: 50_00_000,
        status: "deposited",
      },
      {
        id: "e3",
        quarter: "Q2",
        fy: "2025-26",
        dateOfPayment: "2025-07-31",
        grossAmount: 5_00_00_000,
        tdsAmount: 50_00_000,
        challanRef: "0004329/003",
        bsrCode: "0004329",
        challanSerial: "003",
        dateOfDeposit: "2025-08-07",
        challanAmount: 50_00_000,
        status: "deposited",
      },
    ];

    const partA = generateForm16PartA(entries, "Acme Ltd", "MUMA12345B", "2025-26");

    expect(partA.quarters.length).toBe(2);
    expect(partA.totalSalaryPaid).toBe(15_00_00_000); // ₹15,00,000
    expect(partA.totalTdsDeducted).toBe(1_50_00_000); // ₹1,50,000
    expect(partA.totalTdsDeposited).toBe(1_50_00_000);

    const q1 = partA.quarters.find((q) => q.quarter === "Q1");
    expect(q1?.totalSalaryPaid).toBe(10_00_00_000);
    expect(q1?.totalTdsDeducted).toBe(1_00_00_000);
    expect(q1?.totalTdsDeposited).toBe(1_00_00_000);
  });

  it("includes deposit details from challans", () => {
    const entries = [
      {
        id: "e1",
        quarter: "Q1",
        fy: "2025-26",
        dateOfPayment: "2025-04-30",
        grossAmount: 5_00_00_000,
        tdsAmount: 50_00_000,
        challanRef: "0004329/001",
        bsrCode: "0004329",
        challanSerial: "001",
        dateOfDeposit: "2025-05-07",
        challanAmount: 50_00_000,
        status: "deposited",
      },
    ];

    const partA = generateForm16PartA(entries, "Acme Ltd", "MUMA12345B", "2025-26");

    expect(partA.depositDetails.length).toBe(1);
    expect(partA.depositDetails[0]!.bsrCode).toBe("0004329");
    expect(partA.depositDetails[0]!.challanSerial).toBe("001");
    expect(partA.depositDetails[0]!.amount).toBe(50_00_000);
  });

  it("excludes undeposited entries from deposit totals", () => {
    const entries = [
      {
        id: "e1",
        quarter: "Q1",
        fy: "2025-26",
        dateOfPayment: "2025-04-30",
        grossAmount: 5_00_00_000,
        tdsAmount: 50_00_000,
        challanRef: null,
        bsrCode: null,
        challanSerial: null,
        dateOfDeposit: null,
        challanAmount: null,
        status: "deducted", // Not deposited
      },
    ];

    const partA = generateForm16PartA(entries, "Acme Ltd", "MUMA12345B", "2025-26");

    expect(partA.totalTdsDeposited).toBe(0);
    expect(partA.depositDetails.length).toBe(0);
  });
});

describe("generateForm16PartB", () => {
  it("computes tax on total income with Chapter VI-A deductions", () => {
    const salaryData = {
      basicSalary: 6_00_00_000,
      dearnessAllowance: 1_00_00_000,
      houseRentAllowance: 2_00_00_000,
      conveyanceAllowance: 50_00_000,
      leaveTravelAllowance: 0,
      medicalAllowance: 0,
      specialAllowance: 1_00_00_000,
      otherAllowances: 0,
      bonus: 1_00_00_000,
      commission: 0,
      arrears: 0,
      leaveEncashment: 0,
      gratuity: 0,
      pension: 0,
      otherIncomeFromEmployer: 0,
      totalSalary: 11_50_00_000,
      standardDeduction: 50_00_000,
      taxableSalary: 11_00_00_000,
    };

    const chapterVIAData = {
      section80C: 1_50_00_000,
      section80CCC: 0,
      section80CCD_1: 50_00_000,
      section80CCD_2: 0,
      section80CCD_1B: 0,
      section80D: 25_00_000,
      section80E: 0,
      section80EE: 0,
      section80G: 0,
      section80GG: 0,
      section80TTA: 0,
      section80TTB: 0,
      section80U: 0,
      otherChapterVIA: 0,
      totalChapterVIA: 2_25_00_000,
    };

    const otherIncome: { source: string; amount: number; tdsDeducted: boolean; remarks?: string | null }[] = [];

    const partB = generateForm16PartB(salaryData, chapterVIAData, otherIncome, 1_00_00_000);

    // Total income = taxable salary (11,50,000 - 50,000 = 11,00,000) + other income (0) - Chapter VI-A (2,25,000) = 8,75,000
    // Tax on ₹8,75,000: nil on 2,50,000 + 5% on 2,50,000 (12,500) + 20% on 3,75,000 (75,000) = 87,500
    expect(partB.taxComputation.totalIncome).toBe(8_75_00_000);
    expect(partB.taxComputation.taxOnTotalIncome).toBe(87_50_000);
    expect(partB.taxComputation.rebate87A).toBe(0); // Income > 5,00,000, no rebate
    expect(partB.taxComputation.netTaxLiability).toBeGreaterThan(0);
    expect(partB.taxComputation.taxRefundable).toBeGreaterThan(0); // TDS 1,00,000 > tax liability
  });

  it("applies 87A rebate when total income ≤ ₹5,00,000", () => {
    const salaryData = {
      basicSalary: 3_00_00_000,
      dearnessAllowance: 0,
      houseRentAllowance: 0,
      conveyanceAllowance: 0,
      leaveTravelAllowance: 0,
      medicalAllowance: 0,
      specialAllowance: 0,
      otherAllowances: 0,
      bonus: 0,
      commission: 0,
      arrears: 0,
      leaveEncashment: 0,
      gratuity: 0,
      pension: 0,
      otherIncomeFromEmployer: 0,
      totalSalary: 3_00_00_000,
      standardDeduction: 50_00_000,
      taxableSalary: 2_50_00_000,
    };

    const chapterVIAData = {
      section80C: 0,
      section80CCC: 0,
      section80CCD_1: 0,
      section80CCD_2: 0,
      section80CCD_1B: 0,
      section80D: 0,
      section80E: 0,
      section80EE: 0,
      section80G: 0,
      section80GG: 0,
      section80TTA: 0,
      section80TTB: 0,
      section80U: 0,
      otherChapterVIA: 0,
      totalChapterVIA: 0,
    };

    const partB = generateForm16PartB(salaryData, chapterVIAData, [], 0);

    // Total income = 2,50,000 - 0 = 2,50,000
    // Tax = nil (below 2,50,000)
    // Rebate 87A = min(12,500, tax) = 0 (since tax is 0)
    expect(partB.taxComputation.totalIncome).toBe(2_50_00_000);
    expect(partB.taxComputation.rebate87A).toBe(0); // No tax, no rebate needed
  });
});

describe("generateForm16A", () => {
  it("aggregates non-salary TDS by section", () => {
    const entries = [
      {
        id: "e1",
        section: "194C",
        natureOfPayment: "Contractor payment",
        grossAmount: 5_00_00_000,
        tdsAmount: 10_00_000,
        challanRef: "0004329/001",
        bsrCode: "0004329",
        challanSerial: "001",
        dateOfDeposit: "2025-05-07",
        challanAmount: 10_00_000,
        status: "deposited",
      },
      {
        id: "e2",
        section: "194J",
        natureOfPayment: "Professional services",
        grossAmount: 2_00_00_000,
        tdsAmount: 20_00_000,
        challanRef: "0004329/002",
        bsrCode: "0004329",
        challanSerial: "002",
        dateOfDeposit: "2025-06-07",
        challanAmount: 20_00_000,
        status: "deposited",
      },
    ];

    const form16A = generateForm16A(entries, "Acme Ltd", "MUMA12345B", "AAAAA0000A", "Test Payee", "2025-26");

    expect(form16A.sections.length).toBe(2);
    expect(form16A.sections[0]!.section).toBe("194C");
    expect(form16A.sections[1]!.section).toBe("194J");
    expect(form16A.totalAmount).toBe(7_00_00_000);
    expect(form16A.totalTdsDeducted).toBe(30_00_000);
    expect(form16A.totalTdsDeposited).toBe(30_00_000);
    expect(form16A.panValidated).toBe(true);
  });
});

describe("validateForm16Certificate", () => {
  it("validates a correct Form 16 certificate", () => {
    const cert: TdsCertificate = {
      id: "cert-1",
      certificateType: "16",
      deductorTan: "MUMA12345B",
      deductorName: "Acme Ltd",
      deductorPan: "AAAAA0000A",
      deductorAddress: "123, Main Street, Mumbai",
      deductorContact: "contact@acme.com",
      deducteePan: "BBBBB1111B",
      deducteeName: "Test Employee",
      deducteeAddress: "456, Cross Road, Delhi",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      generatedAt: "2026-06-01T00:00:00Z",
      status: "issued",
      partA: {
        certificateNumber: "CERT-001",
        quarters: [
          {
            quarter: "Q1",
            fromDate: "2025-04-01",
            toDate: "2025-06-30",
            totalSalaryPaid: 15_00_00_000,
            totalTdsDeducted: 1_50_00_000,
            totalTdsDeposited: 1_50_00_000,
            challanRefs: ["0004329/001"],
            depositDates: ["2025-05-07"],
          },
        ],
        totalSalaryPaid: 15_00_00_000,
        totalTdsDeducted: 1_50_00_000,
        totalTdsDeposited: 1_50_00_000,
        depositDetails: [],
      },
      partB: {
        salaryAnnexure: {
          basicSalary: 6_00_00_000,
          dearnessAllowance: 1_00_00_000,
          houseRentAllowance: 2_00_00_000,
          conveyanceAllowance: 50_00_000,
          leaveTravelAllowance: 0,
          medicalAllowance: 0,
          specialAllowance: 1_00_00_000,
          otherAllowances: 0,
          bonus: 1_00_00_000,
          commission: 0,
          arrears: 0,
          leaveEncashment: 0,
          gratuity: 0,
          pension: 0,
          otherIncomeFromEmployer: 0,
          totalSalary: 11_50_00_000,
          standardDeduction: 50_00_000,
          taxableSalary: 11_00_00_000,
        },
        chapterVIAAnnexure: {
          section80C: 1_50_00_000,
          section80CCC: 0,
          section80CCD_1: 50_00_000,
          section80CCD_2: 0,
          section80CCD_1B: 0,
          section80D: 25_00_000,
          section80E: 0,
          section80EE: 0,
          section80G: 0,
          section80GG: 0,
          section80TTA: 0,
          section80TTB: 0,
          section80U: 0,
          otherChapterVIA: 0,
          totalChapterVIA: 2_25_00_000,
        },
        otherIncome: [],
        taxComputation: {
          totalIncome: 8_75_00_000,
          taxOnTotalIncome: 87_50_000,
          rebate87A: 0,
          surcharge: 0,
          cess: 3_50_000,
          totalTaxLiability: 91_00_000,
          tdsDeducted: 1_50_00_000,
          relief89: 0,
          relief90_91: 0,
          otherRelief: 0,
          totalRelief: 0,
          netTaxLiability: 91_00_000,
          taxPayable: 0,
          taxRefundable: 59_00_000,
        },
        investmentsDeclared: true,
        investmentsDeclaredAtJoining: false,
        remarks: null,
      },
      form16AData: null,
      issuedToDeductee: true,
      issuedToDeducteeAt: "2026-06-15T00:00:00Z",
      issuanceMethod: "digital",
      udin: null,
      remarks: "Generated for FY 2025-26",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-15T00:00:00Z",
    };

    const result = validateForm16Certificate(cert);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("flags missing TAN", () => {
    const cert: TdsCertificate = {
      id: "cert-1",
      certificateType: "16",
      deductorTan: "",
      deductorName: "Acme Ltd",
      deducteePan: "BBBBB1111B",
      deducteeName: "Test Employee",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      generatedAt: "2026-06-01T00:00:00Z",
      status: "draft",
      partA: null,
      partB: null,
      form16AData: null,
      issuedToDeductee: false,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    };

    const result = validateForm16Certificate(cert);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("TAN"))).toBe(true);
  });

  it("flags missing Part A and Part B for Form 16", () => {
    const cert: TdsCertificate = {
      id: "cert-1",
      certificateType: "16",
      deductorTan: "MUMA12345B",
      deductorName: "Acme Ltd",
      deducteePan: "BBBBB1111B",
      deducteeName: "Test Employee",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      generatedAt: "2026-06-01T00:00:00Z",
      status: "draft",
      partA: null,
      partB: null,
      form16AData: null,
      issuedToDeductee: false,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    };

    const result = validateForm16Certificate(cert);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("Part A"))).toBe(true);
  });
});

describe("certificateSummaryForDeductee", () => {
  it("summarizes certificates for a deductee", () => {
    const certificates: TdsCertificate[] = [
      {
        id: "c1",
        certificateType: "16",
        deductorTan: "MUMA12345B",
        deductorName: "Acme Ltd",
        deducteePan: "BBBBB1111B",
        deducteeName: "Test Employee",
        financialYear: "2025-26",
        assessmentYear: "2026-27",
        generatedAt: "2026-06-01T00:00:00Z",
        status: "issued",
        partA: null,
        partB: null,
        form16AData: null,
        issuedToDeductee: true,
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-01T00:00:00Z",
      },
      {
        id: "c2",
        certificateType: "16A",
        deductorTan: "MUMA12345B",
        deductorName: "Acme Ltd",
        deducteePan: "BBBBB1111B",
        deducteeName: "Test Employee",
        financialYear: "2025-26",
        assessmentYear: "2026-27",
        generatedAt: "2026-06-01T00:00:00Z",
        status: "issued",
        partA: null,
        partB: null,
        form16AData: {
          sections: [],
          totalAmount: 10_00_00_000,
          totalTdsDeducted: 10_00_000,
          totalTdsDeposited: 10_00_000,
          panValidated: true,
        },
        issuedToDeductee: false,
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-01T00:00:00Z",
      },
    ];

    const summary = certificateSummaryForDeductee(certificates, "BBBBB1111B");

    expect(summary.totalCertificates).toBe(2);
    expect(summary.form16Count).toBe(1);
    expect(summary.form16ACount).toBe(1);
    expect(summary.issuedCount).toBe(1);
    expect(summary.fontIssuedCount).toBe(1);
    expect(summary.financialYears).toContain("2025-26");
  });
});
