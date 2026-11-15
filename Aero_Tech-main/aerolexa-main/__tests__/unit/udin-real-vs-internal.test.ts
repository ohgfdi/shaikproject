import {
  generateInternalUdinId,
  generateUdin,
  INTERNAL_UDIN_TAG,
  isValidUdin,
  isValidUdinFormat,
  recordUdinIssuance,
} from "@/lib/engine/udin";

/**
 * A real ICAI UDIN and an app-internal document id are both 21 characters, but
 * they are not interchangeable: ICAI never issues a value with our internal
 * checksum, and our internal id must never be printed as a UDIN. These tests pin
 * that boundary so a future change cannot quietly re-conflate them.
 */
describe("real ICAI UDIN vs internal document reference", () => {
  it("accepts a 21-character uppercase alphanumeric ICAI UDIN format", () => {
    expect(isValidUdinFormat("ABCDEFGHIJKLMNOPQRSTU")).toBe(true);
    expect(isValidUdinFormat("23456789ABCDEFGHIJKLM")).toBe(true);
  });

  it("rejects lowercase, wrong-length and non-alphanumeric values", () => {
    expect(isValidUdinFormat("abcdefghijklmnopqrstu")).toBe(false);
    expect(isValidUdinFormat("ABCDEFGHIJKLMNOPQRST")).toBe(false);
    expect(isValidUdinFormat("ABCDEFGHIJKLMNOPQRST!")).toBe(false);
    expect(isValidUdinFormat("")).toBe(false);
  });

  it("does not treat an internal checksum id as a real-format UDIN validator", () => {
    const internal = generateUdin("user_1", "version_1", new Date("2026-06-01T00:00:00Z"));
    expect(isValidUdin(internal)).toBe(true);
    // A real-format value has no internal checksum, so the internal validator
    // must reject it.
    expect(isValidUdin("ABCDEFGHIJKLMNOPQRSTU")).toBe(false);
  });

  it("marks internal ids as INTERNAL-UDIN, never as filing UDINs", () => {
    const id = generateInternalUdinId("user_1", "version_1");
    expect(id.kind).toBe(INTERNAL_UDIN_TAG);
    expect(id.value).toMatch(/^[A-Z0-9]{21}$/);
  });

  it("captures a real-format UDIN even though it has no internal checksum", () => {
    const real = "ABCDEFGHIJKLMNOPQRSTU";
    const record = recordUdinIssuance({
      udin: real,
      memberId: "123456",
      documentDescription: "Audit report FY 2025-26",
      documentType: "audit-report",
      issuedAt: "2026-09-30T00:00:00.000Z",
      source: "icai-udin-portal",
      status: "verified",
    });
    expect(record.udin).toBe(real);
    expect(record.source).toBe("icai-udin-portal");
    expect(record.status).toBe("verified");
  });

  it("rejects a malformed UDIN string", () => {
    expect(() =>
      recordUdinIssuance({
        udin: "not-a-valid-udin-value",
        memberId: "123456",
        documentDescription: "x",
        documentType: "audit-report",
        issuedAt: new Date().toISOString(),
        source: "captured-manually",
      }),
    ).toThrow(/Invalid UDIN format/);
  });
});
