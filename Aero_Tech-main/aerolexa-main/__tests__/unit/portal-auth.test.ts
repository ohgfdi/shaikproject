/**
 * Portal identity helpers. The session and database paths need a request
 * context; these pin the parts that decide whether an email can become an
 * account and whether a one-time link is still usable.
 */

import {
  hashPortalLoginToken,
  isValidPortalEmail,
  newPortalLoginToken,
  normalizePortalEmail,
  portalLoginTokenState,
} from "@/lib/server/portal-auth";

describe("portal email", () => {
  it("normalises case and surrounding whitespace", () => {
    expect(normalizePortalEmail("  CFO@Client.Example ")).toBe("cfo@client.example");
  });

  it("rejects addresses that cannot be delivered to", () => {
    expect(isValidPortalEmail("cfo@client.example")).toBe(true);
    expect(isValidPortalEmail("cfo@localhost")).toBe(false);
    expect(isValidPortalEmail("two words@client.example")).toBe(false);
    expect(isValidPortalEmail("")).toBe(false);
  });
});

describe("portal login token", () => {
  it("mints a long random secret and stores only its hash", () => {
    const first = newPortalLoginToken();
    const second = newPortalLoginToken();
    expect(first.raw.startsWith("lpl_login_")).toBe(true);
    expect(first.raw).not.toBe(second.raw);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.hash).toBe(hashPortalLoginToken(first.raw));
    expect(first.hash).not.toContain(first.raw);
  });

  it("is active until used or expired", () => {
    const now = new Date("2026-11-13T10:00:00Z");
    expect(
      portalLoginTokenState({ usedAt: null, expiresAt: new Date("2026-11-13T10:15:00Z") }, now),
    ).toBe("active");
    expect(
      portalLoginTokenState({ usedAt: new Date("2026-11-13T09:00:00Z"), expiresAt: new Date("2026-11-13T10:15:00Z") }, now),
    ).toBe("used");
    expect(
      portalLoginTokenState({ usedAt: null, expiresAt: new Date("2026-11-13T09:59:00Z") }, now),
    ).toBe("expired");
  });
});
