/**
 * TDS Lower Deduction Certificate (LDC) & Form 15G/15H — tests.
 */

import {
  type LdcCertificate,
  type Form15Declaration,
  isLdcCertificateValid,
  ldcCoversSection,
  findActiveLdc,
  isForm15Valid,
  validateForm15Type,
  validateForm15Declaration,
  getTdsExemptionCover,
} from "@/lib/engine/tds-ldc-form15g";

// The fixtures below pin the FY 2025-26 validity window. Freeze the clock so
// the suite is deterministic beyond 31 March 2026 instead of going stale as
// time passes and every "active" certificate silently becomes expired.
beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-06-15T00:00:00Z"));
});

afterAll(() => {
  jest.useRealTimers();
});

describe("LDC Certificate validity", () => {
  it("returns valid for active certificate within validity period", () => {
    const cert: LdcCertificate = {
      id: "ldc-1",
      applicationId: "app-1",
      certificateNumber: "LDC-2025-001",
      deducteePan: "AAAAA0000A",
      deducteeName: "Test Deductee",
      status: "active",
      sections: ["194C", "194J"],
      natureOfIncome: "Contract and professional services",
      lowerRate: 5,
      lowerAmountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      validityPeriod: "1 April 2025 to 31 March 2026",
      conditions: null,
      remarks: null,
      issuedAt: "2025-04-01",
      issuedBy: "AO, Ward A",
      createdAt: "2025-04-01T00:00:00Z",
    };

    expect(isLdcCertificateValid(cert)).toBe(true);
  });

  it("returns invalid for expired certificate", () => {
    const cert: LdcCertificate = {
      id: "ldc-2",
      applicationId: "app-2",
      certificateNumber: "LDC-2024-001",
      deducteePan: "BBBBB1111B",
      deducteeName: "Expired Deductee",
      status: "active",
      sections: ["194C"],
      natureOfIncome: "Contract payments",
      lowerRate: 3,
      lowerAmountLimit: null,
      validFrom: "2024-04-01",
      validUntil: "2025-03-31",
      validityPeriod: "1 April 2024 to 31 March 2025",
      conditions: null,
      remarks: null,
      issuedAt: "2024-04-01",
      issuedBy: "AO, Ward B",
      createdAt: "2024-04-01T00:00:00Z",
    };

    expect(isLdcCertificateValid(cert)).toBe(false);
  });

  it("returns invalid for non-active status", () => {
    const cert: LdcCertificate = {
      id: "ldc-3",
      applicationId: "app-3",
      certificateNumber: "LDC-2025-003",
      deducteePan: "CCCCC2222C",
      deducteeName: "Cancelled Deductee",
      status: "cancelled",
      sections: ["194J"],
      natureOfIncome: "Professional services",
      lowerRate: 7,
      lowerAmountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      validityPeriod: "1 April 2025 to 31 March 2026",
      conditions: null,
      remarks: null,
      issuedAt: "2025-04-01",
      issuedBy: "AO, Ward C",
      createdAt: "2025-04-01T00:00:00Z",
    };

    expect(isLdcCertificateValid(cert)).toBe(false);
  });
});

describe("ldcCoversSection", () => {
  it("returns true when certificate covers the section", () => {
    const cert: LdcCertificate = {
      id: "ldc-4",
      applicationId: "app-4",
      certificateNumber: "LDC-2025-004",
      deducteePan: "AAAAA0000A",
      deducteeName: "Test Deductee",
      status: "active",
      sections: ["194C", "194J"],
      natureOfIncome: "Contract and professional services",
      lowerRate: 5,
      lowerAmountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      validityPeriod: "1 April 2025 to 31 March 2026",
      conditions: null,
      remarks: null,
      issuedAt: "2025-04-01",
      issuedBy: "AO, Ward A",
      createdAt: "2025-04-01T00:00:00Z",
    };

    expect(ldcCoversSection(cert, "194C")).toBe(true);
    expect(ldcCoversSection(cert, "194J")).toBe(true);
    expect(ldcCoversSection(cert, "194A")).toBe(false);
  });

  it("is case-insensitive", () => {
    const cert: LdcCertificate = {
      id: "ldc-5",
      applicationId: "app-5",
      certificateNumber: "LDC-2025-005",
      deducteePan: "AAAAA0000A",
      deducteeName: "Test Deductee",
      status: "active",
      sections: ["194C"],
      natureOfIncome: "Contract payments",
      lowerRate: 3,
      lowerAmountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      validityPeriod: "1 April 2025 to 31 March 2026",
      conditions: null,
      remarks: null,
      issuedAt: "2025-04-01",
      issuedBy: "AO, Ward A",
      createdAt: "2025-04-01T00:00:00Z",
    };

    expect(ldcCoversSection(cert, "194c")).toBe(true);
    expect(ldcCoversSection(cert, "194C")).toBe(true);
  });
});

describe("findActiveLdc", () => {
  it("finds active LDC for a deductee and section", () => {
    const certificates: LdcCertificate[] = [
      {
        id: "ldc-6",
        applicationId: "app-6",
        certificateNumber: "LDC-2025-006",
        deducteePan: "AAAAA0000A",
        deducteeName: "Test Deductee",
        status: "active",
        sections: ["194C"],
        natureOfIncome: "Contract payments",
        lowerRate: 3,
        lowerAmountLimit: null,
        validFrom: "2025-04-01",
        validUntil: "2026-03-31",
        validityPeriod: "1 April 2025 to 31 March 2026",
        conditions: null,
        remarks: null,
        issuedAt: "2025-04-01",
        issuedBy: "AO, Ward A",
        createdAt: "2025-04-01T00:00:00Z",
      },
      {
        id: "ldc-7",
        applicationId: "app-7",
        certificateNumber: "LDC-2025-007",
        deducteePan: "AAAAA0000A",
        deducteeName: "Test Deductee",
        status: "active",
        sections: ["194J"],
        natureOfIncome: "Professional services",
        lowerRate: 7,
        lowerAmountLimit: null,
        validFrom: "2025-04-01",
        validUntil: "2026-03-31",
        validityPeriod: "1 April 2025 to 31 March 2026",
        conditions: null,
        remarks: null,
        issuedAt: "2025-04-01",
        issuedBy: "AO, Ward A",
        createdAt: "2025-04-01T00:00:00Z",
      },
    ];

    const ldcFor194C = findActiveLdc(certificates, "AAAAA0000A", "194C");
    expect(ldcFor194C).toBeTruthy();
    expect(ldcFor194C?.certificateNumber).toBe("LDC-2025-006");

    const ldcFor194J = findActiveLdc(certificates, "AAAAA0000A", "194J");
    expect(ldcFor194J).toBeTruthy();
    expect(ldcFor194J?.certificateNumber).toBe("LDC-2025-007");

    const ldcFor194A = findActiveLdc(certificates, "AAAAA0000A", "194A");
    expect(ldcFor194A).toBeUndefined();
  });

  it("does not return expired LDC", () => {
    const certificates: LdcCertificate[] = [
      {
        id: "ldc-8",
        applicationId: "app-8",
        certificateNumber: "LDC-2024-008",
        deducteePan: "AAAAA0000A",
        deducteeName: "Expired Deductee",
        status: "active",
        sections: ["194C"],
        natureOfIncome: "Contract payments",
        lowerRate: 3,
        lowerAmountLimit: null,
        validFrom: "2024-04-01",
        validUntil: "2025-03-31",
        validityPeriod: "1 April 2024 to 31 March 2025",
        conditions: null,
        remarks: null,
        issuedAt: "2024-04-01",
        issuedBy: "AO, Ward A",
        createdAt: "2024-04-01T00:00:00Z",
      },
    ];

    const ldc = findActiveLdc(certificates, "AAAAA0000A", "194C");
    expect(ldc).toBeUndefined();
  });
});

describe("Form 15G/15H validity", () => {
  it("returns valid for active declaration within validity period", () => {
    const decl: Form15Declaration = {
      id: "form15-1",
      formType: "15G",
      deducteePan: "AAAAA0000A",
      deducteeName: "Test Deductee",
      deducteeType: "individual",
      age: 35,
      isNonResident: false,
      declarationDate: "2025-04-01",
      status: "active",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      estimatedTotalIncome: 4_00_00_00,
      estimatedTotalTax: 0,
      sections: ["194A", "194C", "194J"],
      natureOfIncome: "Interest, contract, and professional income",
      scope: "all",
      specificSections: null,
      amountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      declarationReference: "FORM15G-2025-001",
      verified: true,
      documents: ["PAN card", "Aadhaar card"],
      notes: null,
      createdAt: "2025-04-01T00:00:00Z",
      updatedAt: "2025-04-01T00:00:00Z",
    };

    expect(isForm15Valid(decl)).toBe(true);
  });

  it("returns invalid for expired declaration", () => {
    const decl: Form15Declaration = {
      id: "form15-2",
      formType: "15G",
      deducteePan: "BBBBB1111B",
      deducteeName: "Expired Deductee",
      deducteeType: "individual",
      age: 40,
      isNonResident: false,
      declarationDate: "2024-04-01",
      status: "active",
      financialYear: "2024-25",
      assessmentYear: "2025-26",
      estimatedTotalIncome: 3_00_00_00,
      estimatedTotalTax: 0,
      sections: ["194A"],
      natureOfIncome: "Interest income",
      scope: "all",
      specificSections: null,
      amountLimit: null,
      validFrom: "2024-04-01",
      validUntil: "2025-03-31",
      declarationReference: "FORM15G-2024-001",
      verified: true,
      documents: [],
      notes: null,
      createdAt: "2024-04-01T00:00:00Z",
      updatedAt: "2024-04-01T00:00:00Z",
    };

    expect(isForm15Valid(decl)).toBe(false);
  });

  it("returns invalid for cancelled declaration", () => {
    const decl: Form15Declaration = {
      id: "form15-3",
      formType: "15G",
      deducteePan: "CCCCC2222C",
      deducteeName: "Cancelled Deductee",
      deducteeType: "individual",
      age: 30,
      isNonResident: false,
      declarationDate: "2025-04-01",
      status: "cancelled",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      estimatedTotalIncome: 2_00_00_00,
      estimatedTotalTax: 0,
      sections: ["194A"],
      natureOfIncome: "Interest income",
      scope: "all",
      specificSections: null,
      amountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      declarationReference: "FORM15G-2025-003",
      verified: false,
      documents: [],
      notes: null,
      createdAt: "2025-04-01T00:00:00Z",
      updatedAt: "2025-05-01T00:00:00Z",
    };

    expect(isForm15Valid(decl)).toBe(false);
  });
});

describe("validateForm15Type", () => {
  it("returns null for correct form type (15G for <60)", () => {
    const decl: Form15Declaration = {
      id: "form15-4",
      formType: "15G",
      deducteePan: "AAAAA0000A",
      deducteeName: "Test Deductee",
      deducteeType: "individual",
      age: 35,
      isNonResident: false,
      declarationDate: "2025-04-01",
      status: "active",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      estimatedTotalIncome: 3_00_00_00,
      estimatedTotalTax: 0,
      sections: ["194A"],
      natureOfIncome: "Interest income",
      scope: "all",
      specificSections: null,
      amountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      declarationReference: "FORM15G-2025-004",
      verified: true,
      documents: [],
      notes: null,
      createdAt: "2025-04-01T00:00:00Z",
      updatedAt: "2025-04-01T00:00:00Z",
    };

    expect(validateForm15Type(decl)).toBeNull();
  });

  it("flags 15G for senior citizen (should be 15H)", () => {
    const decl: Form15Declaration = {
      id: "form15-5",
      formType: "15G",
      deducteePan: "AAAAA0000A",
      deducteeName: "Senior Citizen",
      deducteeType: "individual",
      age: 65,
      isNonResident: false,
      declarationDate: "2025-04-01",
      status: "active",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      estimatedTotalIncome: 3_00_00_00,
      estimatedTotalTax: 0,
      sections: ["194A"],
      natureOfIncome: "Interest income",
      scope: "all",
      specificSections: null,
      amountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      declarationReference: "FORM15G-2025-005",
      verified: true,
      documents: [],
      notes: null,
      createdAt: "2025-04-01T00:00:00Z",
      updatedAt: "2025-04-01T00:00:00Z",
    };

    expect(validateForm15Type(decl)).toContain("Form 15H should be used instead");
  });

  it("flags 15H for non-senior citizen", () => {
    const decl: Form15Declaration = {
      id: "form15-6",
      formType: "15H",
      deducteePan: "AAAAA0000A",
      deducteeName: "Young Person",
      deducteeType: "individual",
      age: 25,
      isNonResident: false,
      declarationDate: "2025-04-01",
      status: "active",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      estimatedTotalIncome: 2_00_00_00,
      estimatedTotalTax: 0,
      sections: ["194A"],
      natureOfIncome: "Interest income",
      scope: "all",
      specificSections: null,
      amountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      declarationReference: "FORM15H-2025-001",
      verified: true,
      documents: [],
      notes: null,
      createdAt: "2025-04-01T00:00:00Z",
      updatedAt: "2025-04-01T00:00:00Z",
    };

    expect(validateForm15Type(decl)).toContain("Form 15H is only for senior citizens (60+)");
  });
});

describe("validateForm15Declaration", () => {
  it("validates a correct declaration", () => {
    const decl: Form15Declaration = {
      id: "form15-7",
      formType: "15G",
      deducteePan: "AAAAA0000A",
      deducteeName: "Test Deductee",
      deducteeType: "individual",
      age: 35,
      isNonResident: false,
      declarationDate: "2025-04-01",
      status: "active",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      estimatedTotalIncome: 3_00_00_00,
      estimatedTotalTax: 0,
      sections: ["194A", "194C"],
      natureOfIncome: "Interest and contract income",
      scope: "specific",
      specificSections: ["194A", "194C"],
      amountLimit: 1_00_00_00,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      declarationReference: "FORM15G-2025-007",
      verified: true,
      documents: ["PAN", "Aadhaar"],
      notes: "Income below taxable limit",
      createdAt: "2025-04-01T00:00:00Z",
      updatedAt: "2025-04-01T00:00:00Z",
    };

    const result = validateForm15Declaration(decl);
    expect(result.valid).toBe(true);
    expect(result.issues.length).toBeGreaterThanOrEqual(0);
  });

  it("flags declaration with invalid date format", () => {
    const decl: Form15Declaration = {
      id: "form15-8",
      formType: "15G",
      deducteePan: "AAAAA0000A",
      deducteeName: "Test Deductee",
      deducteeType: "individual",
      age: 35,
      isNonResident: false,
      declarationDate: "01-04-2025", // Wrong format
      status: "active",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      estimatedTotalIncome: 3_00_00_00,
      estimatedTotalTax: 0,
      sections: ["194A"],
      natureOfIncome: "Interest income",
      scope: "all",
      specificSections: null,
      amountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      declarationReference: "FORM15G-2025-008",
      verified: true,
      documents: [],
      notes: null,
      createdAt: "2025-04-01T00:00:00Z",
      updatedAt: "2025-04-01T00:00:00Z",
    };

    const result = validateForm15Declaration(decl);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("not in yyyy-mm-dd format"))).toBe(true);
  });

  it("flags declaration for non-resident", () => {
    const decl: Form15Declaration = {
      id: "form15-9",
      formType: "15G",
      deducteePan: "AAAAA0000A",
      deducteeName: "Non-Resident",
      deducteeType: "individual",
      age: 35,
      isNonResident: true,
      declarationDate: "2025-04-01",
      status: "active",
      financialYear: "2025-26",
      assessmentYear: "2026-27",
      estimatedTotalIncome: 3_00_00_00,
      estimatedTotalTax: 0,
      sections: ["194A"],
      natureOfIncome: "Interest income",
      scope: "all",
      specificSections: null,
      amountLimit: null,
      validFrom: "2025-04-01",
      validUntil: "2026-03-31",
      declarationReference: "FORM15G-2025-009",
      verified: false,
      documents: [],
      notes: null,
      createdAt: "2025-04-01T00:00:00Z",
      updatedAt: "2025-04-01T00:00:00Z",
    };

    const result = validateForm15Declaration(decl);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("non-resident"))).toBe(true);
  });
});

describe("getTdsExemptionCover", () => {
  it("returns Form 15G/15H cover when active declaration exists", () => {
    const declarations: Form15Declaration[] = [
      {
        id: "form15-10",
        formType: "15G",
        deducteePan: "AAAAA0000A",
        deducteeName: "Test Deductee",
        deducteeType: "individual",
        age: 35,
        isNonResident: false,
        declarationDate: "2025-04-01",
        status: "active",
        financialYear: "2025-26",
        assessmentYear: "2026-27",
        estimatedTotalIncome: 3_00_00_00,
        estimatedTotalTax: 0,
        sections: ["194A"],
        natureOfIncome: "Interest income",
        scope: "all",
        specificSections: null,
        amountLimit: null,
        validFrom: "2025-04-01",
        validUntil: "2026-03-31",
        declarationReference: "FORM15G-2025-010",
        verified: true,
        documents: [],
        notes: null,
        createdAt: "2025-04-01T00:00:00Z",
        updatedAt: "2025-04-01T00:00:00Z",
      },
    ];

    const ldcCertificates: LdcCertificate[] = [];

    const result = getTdsExemptionCover(
      { deducteePan: "AAAAA0000A", section: "194A", amount: 5_00_00, dateOfPaymentOrCredit: "2025-05-15" },
      declarations,
      ldcCertificates,
    );

    expect(result.covered).toBe(true);
    expect(result.byForm15).toBeTruthy();
    expect(result.byForm15?.formType).toBe("15G");
  });

  it("returns LDC cover when active LDC exists", () => {
    const declarations: Form15Declaration[] = [];
    const ldcCertificates: LdcCertificate[] = [
      {
        id: "ldc-10",
        applicationId: "app-10",
        certificateNumber: "LDC-2025-010",
        deducteePan: "AAAAA0000A",
        deducteeName: "Test Deductee",
        status: "active",
        sections: ["194C"],
        natureOfIncome: "Contract payments",
        lowerRate: 3,
        lowerAmountLimit: null,
        validFrom: "2025-04-01",
        validUntil: "2026-03-31",
        validityPeriod: "1 April 2025 to 31 March 2026",
        conditions: null,
        remarks: null,
        issuedAt: "2025-04-01",
        issuedBy: "AO, Ward A",
        createdAt: "2025-04-01T00:00:00Z",
      },
    ];

    const result = getTdsExemptionCover(
      { deducteePan: "AAAAA0000A", section: "194C", amount: 5_00_00_00, dateOfPaymentOrCredit: "2025-05-15" },
      declarations,
      ldcCertificates,
    );

    expect(result.covered).toBe(true);
    expect(result.byLdc).toBeTruthy();
    expect(result.byLdc?.lowerRate).toBe(3);
  });

  it("returns no cover when neither Form 15G/15H nor LDC exists", () => {
    const declarations: Form15Declaration[] = [];
    const ldcCertificates: LdcCertificate[] = [];

    const result = getTdsExemptionCover(
      { deducteePan: "AAAAA0000A", section: "194C", amount: 5_00_00_00, dateOfPaymentOrCredit: "2025-05-15" },
      declarations,
      ldcCertificates,
    );

    expect(result.covered).toBe(false);
    expect(result.byForm15).toBeNull();
    expect(result.byLdc).toBeNull();
  });

  it("returns no cover when payment exceeds Form 15G/15H amount limit", () => {
    const declarations: Form15Declaration[] = [
      {
        id: "form15-11",
        formType: "15G",
        deducteePan: "AAAAA0000A",
        deducteeName: "Test Deductee",
        deducteeType: "individual",
        age: 35,
        isNonResident: false,
        declarationDate: "2025-04-01",
        status: "active",
        financialYear: "2025-26",
        assessmentYear: "2026-27",
        estimatedTotalIncome: 3_00_00_00,
        estimatedTotalTax: 0,
        sections: ["194A"],
        natureOfIncome: "Interest income",
        scope: "all",
        specificSections: null,
        amountLimit: 50_00_00, // ₹50,000 limit
        validFrom: "2025-04-01",
        validUntil: "2026-03-31",
        declarationReference: "FORM15G-2025-011",
        verified: true,
        documents: [],
        notes: null,
        createdAt: "2025-04-01T00:00:00Z",
        updatedAt: "2025-04-01T00:00:00Z",
      },
    ];

    const ldcCertificates: LdcCertificate[] = [];

    const result = getTdsExemptionCover(
      { deducteePan: "AAAAA0000A", section: "194A", amount: 1_00_00_00, dateOfPaymentOrCredit: "2025-05-15" }, // ₹1,00,000 > ₹50,000 limit
      declarations,
      ldcCertificates,
    );

    expect(result.covered).toBe(false);
    expect(result.reason).toContain("amount limit");
  });
});
