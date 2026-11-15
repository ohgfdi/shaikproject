import { allowedNumbers, extractNumbers, verifySummary } from "@/lib/copilot/guard";

/**
 * The numeric guard is the ONLY thing standing between a model's prose and the
 * user. These tests pin the contract: a summary may cite numbers the tools
 * produced (formatting-insensitively) and nothing else — not rounded, not
 * converted, not invented.
 */

describe("copilot guard — extractNumbers", () => {
  it("finds plain, signed, comma-grouped and decimal numbers", () => {
    expect(extractNumbers("Total $1,234.56 and -8 and 42%")).toEqual(["1234.56", "-8", "42"]);
  });

  it("ignores a sentence-ending period after a number", () => {
    expect(extractNumbers("Revenue was 120. It grew.")).toEqual(["120"]);
  });

  it("returns nothing for purely qualitative prose", () => {
    expect(extractNumbers("Revenue rose across every region.")).toEqual([]);
  });
});

describe("copilot guard — allowedNumbers", () => {
  it("normalizes formatting so the same value matches regardless of style", () => {
    const allowed = allowedNumbers(["Total Revenue: $1,234.56 (Σ revenue)"]);
    expect(allowed.has("1234.56")).toBe(true);
  });
});

describe("copilot guard — verifySummary", () => {
  const facts = ["Total Revenue: $1,234.56 (formula Σ revenue; 4 of 4 rows, 100% coverage)", "4 of 4 rows analysed"];

  it("passes a summary that copies real tool numbers verbatim", () => {
    const v = verifySummary("Total revenue was $1,234.56 across 100% of rows.", facts);
    expect(v.ok).toBe(true);
    expect(v.violations).toEqual([]);
    expect(v.checked).toBeGreaterThan(0);
  });

  it("passes a qualitative summary that cites no numbers", () => {
    const v = verifySummary("Revenue is concentrated in a few regions.", facts);
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(0);
  });

  it("flags an invented number and reports it", () => {
    const v = verifySummary("Total revenue was $9,999.99.", facts);
    expect(v.ok).toBe(false);
    expect(v.violations).toContain("9999.99");
  });

  it("rejects rounding — a derived value is not a computed value", () => {
    const v = verifySummary("Roughly $1.2M in revenue.", ["Total Revenue: $1,234,567.00"]);
    expect(v.ok).toBe(false);
    expect(v.violations).toContain("1.2");
  });

  it("treats the user's own requested number as citable", () => {
    const v = verifySummary("Here are the top 5 regions by revenue.", [...facts, "show the top 5 regions"]);
    expect(v.ok).toBe(true);
  });

  it("reports a violation once even when repeated", () => {
    const v = verifySummary("It was 777, then 777 again.", []);
    expect(v.violations).toEqual(["777"]);
  });
});
