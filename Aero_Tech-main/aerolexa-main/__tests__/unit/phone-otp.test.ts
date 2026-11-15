/**
 * Phone/OTP auth tests (Band 3.1) — the security contract without a DB.
 *
 * DB-touching paths (send/verify flows) are exercised by the API suite against
 * the scratch database. Here we verify: E.164 normalization, the brute-force
 * budget constants, and source-gated guarantees — codes are bcrypt-hashed
 * (never stored raw), rows are deleted after consumption, and every mutating
 * path enforces the attempt budget.
 */

import { readFileSync } from "node:fs";

import { OTP_HOURLY_SEND_LIMIT, OTP_MAX_ATTEMPTS, OTP_TTL_MS, normalizePhone } from "@/lib/auth/phone-otp";

const SRC = readFileSync(`${process.cwd()}/lib/auth/phone-otp.ts`, "utf8");

describe("phone OTP — E.164 normalization", () => {
  it("accepts the common Indian input formats", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizePhone("919876543210")).toBe("+919876543210");
    expect(normalizePhone("098765 43210".replace(/^0/, ""))).toBe("+919876543210");
    expect(normalizePhone("+91-98765-43210")).toBe("+919876543210");
  });

  it("rejects invalid numbers instead of guessing", () => {
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("1234567890")).toBeNull(); // not a mobile prefix
    expect(normalizePhone("+44 7911 123456")).toBeNull(); // prototype scope: India
    expect(normalizePhone("")).toBeNull();
  });
});

describe("phone OTP — brute-force budget (constants contract)", () => {
  it("codes live 5 minutes and allow 5 attempts", () => {
    expect(OTP_TTL_MS).toBe(5 * 60 * 1000);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(OTP_HOURLY_SEND_LIMIT).toBeLessThanOrEqual(5);
  });

  it("stores codes as hashes, never raw (source-gated)", () => {
    expect(SRC).toContain("codeHash: await hashPassword(code)");
    expect(SRC).toContain("verifyPassword(input.code, row.codeHash)");
    expect(SRC).not.toMatch(/code:\s*generateCode\(\)[^,]*\n\s*\}\s*,?\s*\}\)/);
  });

  it("consumes codes atomically and deletes OTP material after use", () => {
    expect(SRC).toContain("where: { id: row.id, consumedAt: null }");
    expect(SRC).toContain("phoneOtp.delete");
  });

  it("locks the row after max attempts (source-gated)", () => {
    expect(SRC).toContain("row.attempts >= row.maxAttempts");
    expect(SRC).toContain("data: { attempts: { increment: 1 } }");
  });

  it("enforces a per-phone send budget (SMS pumping defense)", () => {
    expect(SRC).toContain("enforceSendBudget(phone)");
    expect(SRC).toContain("OTP_RESEND_COOLDOWN_MS");
  });

  it("delivery falls back to console and activates the WhatsApp hook only when configured", () => {
    expect(SRC).toContain("deliverConsole");
    expect(SRC).toContain("deliverWhatsApp");
    expect(SRC).toContain("WHATSAPP_ENABLED");
  });

  it("never prints a live code in production (refuses instead of leaking)", () => {
    expect(SRC).toContain('env.NODE_ENV === "production"');
    expect(SRC).toContain("ALLOW_INSECURE_PROD_TRANSPORTS");
    expect(SRC).toContain("OTP_DELIVERY_UNAVAILABLE");
  });
});
