/**
 * Tool-boundary redaction and Indian money/FY formatting.
 *
 * These are the two representations the model is allowed to see: masked
 * identifiers and integer-paise money with an Indian-grouped display string.
 */

import { assertFy, formatInr, fyRange, money } from "@/lib/ai/format";
import { maskAccount, maskGstin, maskPan, scrubForLog, scrubText } from "@/lib/ai/redact";

describe("redaction at the tool boundary", () => {
  it("masks PAN, GSTIN and bank account numbers, keeping only the suffix", () => {
    expect(maskPan("ABCDE1234F")).toBe("PAN •••• 234F");
    expect(maskGstin("27ABCDE1234F1Z5")).toBe("GSTIN •••• F1Z5");
    expect(maskAccount("123456789012")).toBe("•••• 9012");
  });

  it("never returns the full identifier it was given", () => {
    const full = "ABCDE1234F";
    expect(maskPan(full)).not.toContain(full);
    expect(maskGstin("27ABCDE1234F1Z5")).not.toContain("27ABCDE1234F1Z5");
    expect(maskAccount("123456789012")).not.toContain("123456789012");
  });

  it("scrubs identifiers and phone numbers out of free text", () => {
    const scrubbed = scrubText("PAN ABCDE1234F, call 9876543210");
    expect(scrubbed).not.toContain("ABCDE1234F");
    expect(scrubbed).not.toContain("9876543210");
    expect(scrubbed).toContain("3210");
  });

  it("scrubs nested log payloads without changing their shape", () => {
    const scrubbed = scrubForLog({
      pan: "ABCDE1234F",
      rows: [{ phone: "9876543210" }],
      count: 2,
    }) as Record<string, unknown>;

    expect(JSON.stringify(scrubbed)).not.toContain("ABCDE1234F");
    expect(JSON.stringify(scrubbed)).not.toContain("9876543210");
    expect(scrubbed.count).toBe(2);
  });

  it("is idempotent for empty values", () => {
    expect(maskPan(null)).toBeNull();
    expect(maskGstin(undefined)).toBeNull();
    expect(scrubText(null)).toBeNull();
  });
});

describe("Indian money and financial-year formatting", () => {
  it("formats integer paise with Indian digit grouping", () => {
    expect(formatInr(12_345_678)).toContain("1,23,456.78");
    expect(money(12_345_678).paise).toBe(12_345_678);
    expect(money(12_345_678).inr).toBe(formatInr(12_345_678));
  });

  it("never converts paise into a float amount in the machine value", () => {
    expect(Number.isInteger(money(99_999).paise)).toBe(true);
    expect(money(0).paise).toBe(0);
  });

  it("uses the April–March Indian financial year", () => {
    expect(fyRange("2025-26")).toEqual({ from: "2025-04-01", to: "2026-03-31" });
  });

  it("rejects a non-consecutive or malformed FY label", () => {
    expect(() => assertFy("2025-27")).toThrow(/consecutive years/);
    expect(() => assertFy("2025")).toThrow(/look like/);
  });
});
