/**
 * Xero OAuth contracts that must hold without live credentials or network:
 * state generation, refresh-token rotation (Xero invalidates the old token on
 * every exchange) and the portal approval rule.
 */

import type { ConnectorConfig } from "@/lib/engine/connectors/config";
import { canClientApprove } from "@/lib/server/client-portal";
import { newXeroState, rotateXeroConfig } from "@/lib/server/xero-oauth";

function xeroPart(config: ConnectorConfig) {
  if (config.kind !== "xero") throw new Error(`expected a xero config, got ${config.kind}`);
  return config.xero;
}

describe("xero oauth state", () => {
  it("mints 48 hex characters from 24 random bytes", () => {
    const state = newXeroState();
    expect(state).toMatch(/^[0-9a-f]{48}$/);
  });

  it("never repeats a state value", () => {
    const states = new Set(Array.from({ length: 50 }, () => newXeroState()));
    expect(states.size).toBe(50);
  });
});

describe("xero refresh-token rotation", () => {
  const stored = {
    kind: "xero",
    xero: {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "old-token",
      tenantId: "tenant-1",
    },
  };

  it("replaces only the refresh token and keeps every other credential", () => {
    const rotated = rotateXeroConfig(stored, "new-token");
    expect(rotated.kind).toBe("xero");
    expect(xeroPart(rotated)).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "new-token",
      tenantId: "tenant-1",
    });
  });

  it("accepts an unwrapped config (legacy rows)", () => {
    const rotated = rotateXeroConfig(stored.xero, "newer-token");
    expect(xeroPart(rotated).refreshToken).toBe("newer-token");
    expect(xeroPart(rotated).tenantId).toBe("tenant-1");
  });

  it("refuses to write an empty rotation (Xero never returns one)", () => {
    expect(() => rotateXeroConfig(stored, "")).toThrow();
  });

  it("refuses a config with no tenant, so a broken row cannot be silently kept", () => {
    expect(() => rotateXeroConfig({ ...stored.xero, tenantId: "" }, "token")).toThrow();
  });
});

describe("client portal approval rule", () => {
  it("approves only a reviewed filing", () => {
    expect(canClientApprove("reviewed")).toBe(true);
    expect(canClientApprove("computed")).toBe(false);
    expect(canClientApprove("prepared")).toBe(false);
    expect(canClientApprove("client-approved")).toBe(false);
    expect(canClientApprove("filed")).toBe(false);
    expect(canClientApprove("acknowledged")).toBe(false);
  });
});
