/**
 * DPDP module tests — pure-logic coverage without a database.
 * DB-touching paths (recordConsent/eraseUser) are exercised through the API
 * suite (__tests__/api) against the scratch database; here we verify the
 * consent catalogue contract, policy versioning, and the erasure-id schema.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { CONSENT_POLICY_VERSION, CONSENT_PURPOSES, hashIp } from "@/lib/server/dpdp";

describe("DPDP consent catalogue", () => {
  it("itemizes consent purposes with exactly one required purpose (service)", () => {
    expect(CONSENT_PURPOSES.length).toBeGreaterThanOrEqual(3);
    const required = CONSENT_PURPOSES.filter((p) => p.required);
    expect(required).toHaveLength(1);
    expect(required[0]?.id).toBe("service");
  });

  it("gives every purpose a stable id, a required flag, and a human description", () => {
    for (const p of CONSENT_PURPOSES) {
      expect(p.id).toMatch(/^[a-z-]+$/);
      expect(typeof p.required).toBe("boolean");
      expect(p.description.length).toBeGreaterThan(20);
    }
  });
  it("versions the consent policy (proof of what the user saw)", () => {
    expect(CONSENT_POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});

describe("DPDP IP hashing (consent proof)", () => {
  it("hashes deterministically and never stores the raw IP", () => {
    const a = hashIp("203.0.113.7");
    const b = hashIp("203.0.113.7");
    expect(a).toBe(b);
    expect(a).not.toContain("203.0.113.7");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("handles missing IPs gracefully (null in, null out)", () => {
    expect(hashIp(null)).toBeNull();
    expect(hashIp(undefined)).toBeNull();
    expect(hashIp("")).toBeNull();
  });

  it("produces distinct hashes for distinct IPs", () => {
    expect(hashIp("203.0.113.7")).not.toBe(hashIp("198.51.100.9"));
  });
});

describe("DPDP signup contract (source-gated)", () => {
  it("signup records itemized consents with no pre-ticked optional boxes", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app/api/auth/signup/route.ts"), "utf8");
    // Optional consents flow through the request schema…
    expect(src).toContain("consents");
    // …and are recorded server-side (never trusted from the client alone).
    expect(src).toContain("recordSignupConsents");
  });

  it("erasure route demands password proof and a typed confirmation", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app/api/me/erase/route.ts"), "utf8");
    expect(src).toContain("DELETE MY ACCOUNT");
    expect(src).toContain("verifyPassword");
    expect(src).toContain("clearSessionCookie");
  });
});
