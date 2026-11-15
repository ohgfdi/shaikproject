import { fmtNumber, fmtInteger, fmtPct, fmtSignedPct, fmtCurrency, fmtDate, timeAgo, fmtAxis } from "@/lib/format";

describe("number formatting", () => {
  it("formats with locale grouping per style", () => {
    expect(fmtNumber(1234567.891)).toBe("1,234,567.89");
    expect(fmtNumber(1234567.891, { style: "dot" })).toBe("1.234.567,89");
    expect(fmtNumber(1234567.891, { style: "plain" })).toBe("1234567.89");
  });

  it("returns an em dash for null / non-finite", () => {
    expect(fmtNumber(null)).toBe("—");
    expect(fmtNumber(undefined)).toBe("—");
    expect(fmtNumber(Number.NaN)).toBe("—");
    expect(fmtNumber(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("supports compact and fixed-digit variants", () => {
    expect(fmtNumber(2500000, { compact: true })).toMatch(/2\.5\s?M/);
    expect(fmtNumber(3.14159, { maximumFractionDigits: 3 })).toBe("3.142");
  });

  it("formats integers without decimals", () => {
    expect(fmtInteger(42.9)).toBe("43");
  });

  it("formats percentages with sign control", () => {
    expect(fmtPct(12.345)).toBe("12.3%");
    expect(fmtPct(12.345, 2)).toBe("12.35%");
    expect(fmtSignedPct(4.2)).toBe("+4.2%");
    expect(fmtSignedPct(-1.5)).toBe("-1.5%");
    expect(fmtPct(null)).toBe("—");
  });

  it("formats currency with compact whole numbers", () => {
    expect(fmtCurrency(1250, "USD")).toBe("$1,250");
    expect(fmtCurrency(12.5, "EUR")).toBe("€12.50");
  });

  it("formats dates and time-ago labels", () => {
    expect(fmtDate("2024-01-05")).toContain("2024");
    const now = new Date();
    const fiveSecondsAgo = new Date(now.getTime() - 5000);
    expect(timeAgo(fiveSecondsAgo, now)).toMatch(/seconds? ago/);
    const aDayAgo = new Date(now.getTime() - 26 * 3600 * 1000);
    expect(timeAgo(aDayAgo, now)).toMatch(/day/i);
  });

  it("scales axis labels", () => {
    expect(fmtAxis(1234)).toBe("1,234");
    expect(fmtAxis(5_000_000)).toContain("M");
    expect(fmtAxis(42.567)).toBe("42.57");
  });
});
