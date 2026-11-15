/**
 * MFA oracle tests.
 *
 * TOTP is only trustworthy if it reproduces the RFC vectors exactly. The
 * RFC 6238 SHA-1 vectors below are the published ones (8 digits), so this is a
 * real interoperability check with authenticator apps, not a self-consistency
 * test. Sealing and recovery-code consumption are tested for the properties
 * the service relies on: tamper detection and single use.
 */
import { describe, expect, it } from "@jest/globals";

import {
  base32Decode,
  base32Encode,
  findRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCodes,
  hotp,
  normalizeRecoveryCode,
  openTotpSecret,
  otpauthUrl,
  recoveryCodesRemaining,
  sealTotpSecret,
  totp,
  totpStep,
  verifyTotp,
} from "@/lib/auth/totp";

// RFC 6238 Appendix B: ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("base32", () => {
  it("matches the RFC 4648 vector and round-trips", () => {
    expect(base32Encode(Buffer.from("foo", "utf8"))).toBe("MZXW6");
    expect(base32Decode("MZXW6").toString("utf8")).toBe("foo");
    expect(base32Decode(RFC_SECRET).toString("ascii")).toBe("12345678901234567890");
  });

  it("rejects a non-base32 secret", () => {
    expect(() => base32Decode("not*base32")).toThrow(/invalid base32/);
  });
});

describe("TOTP (RFC 6238)", () => {
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(vectors)("matches the published 8-digit value at %i", (seconds, expected) => {
    expect(totp(RFC_SECRET, seconds * 1000, 8)).toBe(expected);
  });

  it("computes the RFC 4226 HOTP counter vector", () => {
    expect(hotp(RFC_SECRET, 0)).toBe("755224");
    expect(hotp(RFC_SECRET, 1)).toBe("287082");
  });

  it("uses a 30-second step", () => {
    expect(totpStep(59_999)).toBe(1);
    expect(totpStep(60_000)).toBe(2);
  });

  it("accepts one step of skew and rejects a replay", () => {
    const now = 1_700_000_000_000;
    const code = totp(RFC_SECRET, now);
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, code, { at: now }).valid).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, { at: now, lastUsedStep: step }).valid).toBe(false);
    expect(verifyTotp(RFC_SECRET, code, { at: now, lastUsedStep: step - 1 }).valid).toBe(true);
  });

  it("rejects malformed and non-numeric codes", () => {
    expect(verifyTotp(RFC_SECRET, "12345").valid).toBe(false);
    expect(verifyTotp(RFC_SECRET, "abcdef").valid).toBe(false);
    expect(verifyTotp(RFC_SECRET, "000000", { at: 59_000 }).valid).toBe(false);
  });

  it("generates a fresh 160-bit base32 seed", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(a).not.toBe(b);
  });

  it("builds a scannable otpauth URI", () => {
    const url = otpauthUrl({ secret: RFC_SECRET, account: "partner@firm.test", issuer: "Ledgerly" });
    expect(url).toContain("otpauth://totp/");
    expect(url).toContain(encodeURIComponent("Ledgerly:partner@firm.test"));
    expect(url).toContain(`secret=${RFC_SECRET}`);
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
  });
});

describe("sealed TOTP seeds", () => {
  it("round-trips and hides the secret at rest", () => {
    const sealed = sealTotpSecret(RFC_SECRET);
    expect(sealed).not.toContain(RFC_SECRET);
    expect(sealed).toMatch(/^v1\./);
    expect(openTotpSecret(sealed)).toBe(RFC_SECRET);
  });

  it("detects tampering", () => {
    const sealed = sealTotpSecret(RFC_SECRET);
    const parts = sealed.split(".");
    parts[3] = `${parts[3]!.slice(0, -2)}AA`;
    expect(() => openTotpSecret(parts.join("."))).toThrow();
  });
});

describe("recovery codes", () => {
  it("generates human-friendly, unique codes", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/);
  });

  it("hashes and finds exactly one code, then never reuses it", async () => {
    const codes = ["abcd-efgh", "jkmn-pqrs"];
    const hashes = await hashRecoveryCodes(codes);
    expect(await findRecoveryCode("ABCD-EFGH", hashes)).toBe(0);
    expect(await findRecoveryCode("jkmn pqrs", hashes)).toBe(1);
    expect(await findRecoveryCode("zzzz-zzzz", hashes)).toBe(-1);
    const remaining = hashes.filter((_, index) => index !== 0);
    expect(await findRecoveryCode(codes[0]!, remaining)).toBe(-1);
    expect(normalizeRecoveryCode(" AB-CD ")).toBe("abcd");
  });

  it("counts remaining codes and tolerates junk", () => {
    expect(recoveryCodesRemaining(JSON.stringify(["a", "b"]))).toBe(2);
    expect(recoveryCodesRemaining("not-json")).toBe(0);
    expect(recoveryCodesRemaining(null)).toBe(0);
  });
});
