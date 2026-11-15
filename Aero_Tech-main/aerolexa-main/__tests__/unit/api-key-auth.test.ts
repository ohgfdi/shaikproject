/**
 * API key auth tests (SEC-1) — the public API's front door.
 *
 * Pins:
 * 1. generate → extract round-trip consistency (the stored `keyPrefix` is
 *    ALWAYS the prefix extractPrefix() resolves from the full key);
 * 2. RFC 6750 case-insensitive `Bearer` scheme handling (the defect that made
 *    SDK clients sending `bearer` unauthenticatable);
 * 3. whitespace/newline normalization (copy-paste artifacts must not produce
 *    phantom lookups);
 * 4. malformed keys fail closed.
 *
 * Source-gated assertions pin the auth flow's wiring without a live DB
 * (validateApiKey's DB path runs in the API integration suite).
 */
import { readFileSync } from "node:fs";

import {
  extractPrefix,
  generateApiKey,
  normalizeApiKey,
  validateApiKeyFormat,
  validateApiKeyPrefix,
} from "@/lib/server/api-keys";

const AUTH_SRC = readFileSync(`${process.cwd()}/lib/server/api-key-auth.ts`, "utf8");

describe("api keys — generate/extract round trip", () => {
  it("extractPrefix always returns exactly the stored prefix (5000 samples)", () => {
    for (let i = 0; i < 5000; i++) {
      const { key, prefix } = generateApiKey();
      expect(extractPrefix(key)).toBe(prefix);
      expect(validateApiKeyFormat(key)).toBe(true);
      expect(validateApiKeyPrefix(prefix)).toBe(true);
    }
  });

  it("secrets containing base64url `_`/`-` never confuse the parser", () => {
    // base64url of 32 random bytes often contains both characters.
    const adversarial = "ak_live_AbCd1234_a-b_c-d_e-f_g-h_i-j_k-l_m-n_o-p_q";
    expect(validateApiKeyFormat(adversarial)).toBe(true);
    expect(extractPrefix(adversarial)).toBe("ak_live_AbCd1234");
  });

  it("normalization trims the credential so lookups match the stored prefix", () => {
    const { key, prefix } = generateApiKey();
    const polluted = ` ${key}\n`;
    expect(normalizeApiKey(polluted)).toBe(key);
    expect(extractPrefix(normalizeApiKey(polluted))).toBe(prefix);
  });

  it("malformed keys fail closed", () => {
    expect(extractPrefix("")).toBeNull();
    expect(extractPrefix("ak_live_AbCd1234")).toBeNull(); // prefix only, no secret
    expect(extractPrefix("ak_live_AbCd1234_")).toBeNull(); // empty secret
    expect(extractPrefix("ak_live_AbCd12345_AAAAabcdefghijklmnop")).toBeNull(); // 9-char id
    expect(extractPrefix("sk_live_AbCd1234_AAAAabcdefghijklmnop")).toBeNull(); // wrong family
  });
});

describe("api key auth — Authorization header contract", () => {
  it("accepts the scheme case-insensitively (RFC 6750 §2.1)", () => {
    // The defect: startsWith("Bearer ") rejected "bearer ..." so compliant
    // SDK clients got 401 on every request.
    expect(AUTH_SRC).toContain('scheme.toLowerCase() !== "bearer "');
    expect(AUTH_SRC).not.toContain('authHeader?.startsWith("Bearer ")');
  });

  it("normalizes the credential before lookup and bcrypt compare", () => {
    expect(AUTH_SRC).toContain("normalizeApiKey(authHeader.slice(7))");
  });

  it("still verifies the full key against the hash (prefix only locates the row)", () => {
    expect(AUTH_SRC).toContain("verifyApiKey(apiKey, keyRecord.keyHash)");
  });

  it("checks expiry and revocation before any scope is honored", () => {
    expect(AUTH_SRC).toContain("keyRecord.revokedAt");
    expect(AUTH_SRC).toContain("keyRecord.expiresAt && keyRecord.expiresAt < new Date()");
  });
});
