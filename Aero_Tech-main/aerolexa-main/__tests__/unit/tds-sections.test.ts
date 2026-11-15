/**
 * TDS Section Applicability Matrix — tests.
 */

import {
  TDS_SECTIONS,
  lookupSection,
  sectionsForForm,
  tcsSections,
  tdsSections,
  sectionsAllowingForm15G_15H,
  sectionsAllowingLdc,
  crossBorderSections,
} from "@/lib/engine/tds-sections";

describe("TDS_SECTIONS — matrix integrity", () => {
  it("has entries for all common sections", () => {
    const sectionCodes = TDS_SECTIONS.map((s) => s.section);
    expect(sectionCodes).toContain("192");
    expect(sectionCodes).toContain("194A");
    expect(sectionCodes).toContain("194C");
    expect(sectionCodes).toContain("194H");
    expect(sectionCodes).toContain("194I");
    expect(sectionCodes).toContain("194J");
    expect(sectionCodes).toContain("194Q");
    expect(sectionCodes).toContain("194R");
    expect(sectionCodes).toContain("194S");
    expect(sectionCodes).toContain("194-IA");
    expect(sectionCodes).toContain("194-IB");
    expect(sectionCodes).toContain("194-IR");
    expect(sectionCodes).toContain("195");
    expect(sectionCodes).toContain("206C");
    expect(sectionCodes).toContain("206C(1H)");
    expect(sectionCodes).toContain("206C(1G)");
    expect(sectionCodes).toContain("206C(1F)");
  });

  it("each entry has all required fields", () => {
    for (const section of TDS_SECTIONS) {
      expect(section.section).toBeTruthy();
      expect(section.label).toBeTruthy();
      expect(section.natureOfPayment).toBeTruthy();
      expect(typeof section.defaultRatePct).toBe("number");
      expect(typeof section.thresholdMinor).toBe("number");
      expect(typeof section.isTcs).toBe("boolean");
      expect(["24Q", "26Q", "27Q", "NIL"]).toContain(section.form);
      expect(["Q1", "Q2", "Q3", "Q4", "annual"]).toContain(section.typicalQuarter);
      expect(Array.isArray(section.relatedSections)).toBe(true);
      expect(Array.isArray(section.notes)).toBe(true);
      expect(typeof section.allowsForm15G_15H).toBe("boolean");
      expect(typeof section.allowsLowerDeductionCertificate).toBe("boolean");
      expect(typeof section.crossBorderApplicable).toBe("boolean");
      expect(typeof section.treatyReliefPossible).toBe("boolean");
    }
  });
});

describe("lookupSection", () => {
  it("finds a section by code (case-insensitive)", () => {
    expect(lookupSection("194C")).toBeTruthy();
    expect(lookupSection("194c")).toBeTruthy();
    expect(lookupSection("194C")?.section).toBe("194C");
  });

  it("returns undefined for an unknown section", () => {
    expect(lookupSection("9999")).toBeUndefined();
  });

  it("finds 194-IA correctly", () => {
    const ia = lookupSection("194-IA");
    expect(ia).toBeTruthy();
    expect(ia?.section).toBe("194-IA");
    expect(ia?.defaultRatePct).toBe(1);
    // ₹50,00,000 in paise. Written as 5000000 * 100 so the rupee figure and the
    // minor unit are both readable — the fixture previously pinned the buggy
    // 50_00_00_00 (₹5,00,000), which certified a 10x-wrong threshold.
    expect(ia?.thresholdMinor).toBe(5000000 * 100);
  });

  it("finds 194-IB correctly", () => {
    const ib = lookupSection("194-IB");
    expect(ib).toBeTruthy();
    expect(ib?.section).toBe("194-IB");
    expect(ib?.thresholdMinor).toBe(50000 * 100); // ₹50,000 per month
  });
});

describe("sectionsForForm", () => {
  it("returns 24Q sections (salary only)", () => {
    const q24 = sectionsForForm("24Q");
    expect(q24.length).toBeGreaterThan(0);
    expect(q24.every((s) => s.form === "24Q")).toBe(true);
    expect(q24.some((s) => s.section === "192")).toBe(true);
  });

  it("returns 26Q sections (non-salary)", () => {
    const q26 = sectionsForForm("26Q");
    expect(q26.length).toBeGreaterThan(0);
    expect(q26.every((s) => s.form === "26Q")).toBe(true);
    expect(q26.some((s) => s.section === "194C")).toBe(true);
  });

  it("returns 27Q sections (non-resident)", () => {
    const q27 = sectionsForForm("27Q");
    expect(q27.length).toBeGreaterThan(0);
    expect(q27.every((s) => s.form === "27Q")).toBe(true);
    expect(q27.some((s) => s.section === "195")).toBe(true);
  });

  it("returns NIL sections", () => {
    const nil = sectionsForForm("NIL");
    expect(nil.length).toBeGreaterThanOrEqual(0);
  });
});

describe("tcsSections / tdsSections", () => {
  it("identifies TCS sections", () => {
    const tcs = tcsSections();
    expect(tcs.length).toBeGreaterThan(0);
    expect(tcs.every((s) => s.isTcs)).toBe(true);
    expect(tcs.some((s) => s.section === "206C(1H)")).toBe(true);
    expect(tcs.some((s) => s.section === "206C(1G)")).toBe(true);
  });

  it("identifies TDS sections", () => {
    const tds = tdsSections();
    expect(tds.length).toBeGreaterThan(0);
    expect(tds.every((s) => !s.isTcs)).toBe(true);
    expect(tds.some((s) => s.section === "194C")).toBe(true);
  });
});

describe("sectionsAllowingForm15G_15H", () => {
  it("returns sections that allow Form 15G/15H", () => {
    const sections = sectionsAllowingForm15G_15H();
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.allowsForm15G_15H)).toBe(true);
    expect(sections.some((s) => s.section === "194A")).toBe(true);
    expect(sections.some((s) => s.section === "194C")).toBe(true);
    expect(sections.some((s) => s.section === "194J")).toBe(true);
  });

  it("does not return 194B/194BB (no Form 15G/15H for lottery)", () => {
    const sections = sectionsAllowingForm15G_15H();
    expect(sections.some((s) => s.section === "194B")).toBe(false);
    expect(sections.some((s) => s.section === "194BB")).toBe(false);
  });
});

describe("sectionsAllowingLdc", () => {
  it("returns sections that allow lower deduction certificate", () => {
    const sections = sectionsAllowingLdc();
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.allowsLowerDeductionCertificate)).toBe(true);
    expect(sections.some((s) => s.section === "194C")).toBe(true);
    expect(sections.some((s) => s.section === "194J")).toBe(true);
  });

  it("does not return 194B (no LDC for lottery)", () => {
    const sections = sectionsAllowingLdc();
    expect(sections.some((s) => s.section === "194B")).toBe(false);
  });
});

describe("crossBorderSections", () => {
  it("returns sections applicable to non-residents", () => {
    const sections = crossBorderSections();
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.crossBorderApplicable)).toBe(true);
    expect(sections.some((s) => s.section === "195")).toBe(true);
    expect(sections.some((s) => s.section === "194J")).toBe(true);
  });

  it("marks 195 as cross-border", () => {
    const s195 = lookupSection("195");
    expect(s195?.crossBorderApplicable).toBe(true);
    expect(s195?.treatyReliefPossible).toBe(true);
  });
});
