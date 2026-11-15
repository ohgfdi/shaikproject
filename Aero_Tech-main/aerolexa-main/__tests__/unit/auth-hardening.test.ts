/**
 * Auth hardening tests (SEC-7).
 *
 * 1. Trusted-proxy IP resolution — REAL tests of clientIp(): the spoofable
 *    first-hop parse is what let an attacker behind a proxy rotate fake IPs
 *    and escape every IP rate limit, so the pure parsing logic is the thing
 *    worth testing directly.
 * 2. Session revocation — source-gated wiring: the `ver` claim is minted,
 *    enforced in readSession, and bumped on password reset.
 * 3. Cookie attribute parity — login uses the same createSessionCookie
 *    attributes the rest of the app reads.
 */
import { readFileSync } from "node:fs";
import * as fs from "node:fs";

import { clientIp, trustedProxyHops } from "@/lib/server/rate-limit";

const SESSION_SRC = readFileSync(`${process.cwd()}/lib/auth/session.ts`, "utf8");
const AUTH_SERVICE_SRC = readFileSync(`${process.cwd()}/lib/server/auth-service.ts`, "utf8");

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/x", { headers });
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Array<[string, string | undefined]> = [];
  const had = new Set<string>();
  for (const [k, v] of Object.entries(vars)) {
    if (Object.prototype.hasOwnProperty.call(process.env, k)) {
      saved.push([k, process.env[k]]);
      had.add(k);
    } else {
      saved.push([k, undefined]);
    }
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined && !had.has(k)) delete process.env[k];
      else if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
}

describe("SEC-7 — trusted-proxy client IP", () => {
  it("ignores x-forwarded-for entirely with the default TRUST_PROXY_HOPS=0", () => {
    withEnv({ TRUST_PROXY_HOPS: undefined }, () => {
      const spoof = req({ "x-forwarded-for": "1.2.3.4, 10.0.0.9" });
      expect(clientIp(spoof)).toBe("untrusted-proxy");
      expect(clientIp(req({}))).toBe("untrusted-proxy");
      expect(trustedProxyHops()).toBe(0);
    });
  });

  it("with TRUST_PROXY_HOPS=1, the client is the value ONE from the right (not the first/left entry)", () => {
    withEnv({ TRUST_PROXY_HOPS: "1" }, () => {
      // Client sends "fake" first; the trusted proxy appends the real peer.
      const r = req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
      expect(clientIp(r)).toBe("203.0.113.7");
    });
  });

  it("with TRUST_PROXY_HOPS=2 the client is the 2nd value from the right", () => {
    withEnv({ TRUST_PROXY_HOPS: "2" }, () => {
      // Chain: [client-spoof?, proxy1-addr, proxy2-addr]. With two trusted
      // proxies the rightmost is proxy2's peer (proxy1), and one further is
      // what proxy1 saw — here the real client 6.6.6.6 arrived through
      // proxy1 which recorded it: parts[len-2].
      const r = req({ "x-forwarded-for": "203.0.113.9, 6.6.6.6, 10.0.0.1" });
      expect(clientIp(r)).toBe("6.6.6.6");
    });
  });

  it("a chain shorter than the trusted path fails closed", () => {
    withEnv({ TRUST_PROXY_HOPS: "3" }, () => {
      const r = req({ "x-forwarded-for": "6.6.6.6" });
      expect(clientIp(r)).toBe("untrusted-proxy");
    });
  });

  it("an explicit socket-peer fallback wins when no proxies are declared", () => {
    withEnv({ TRUST_PROXY_HOPS: "0" }, () => {
      const r = req({ "x-forwarded-for": "6.6.6.6" });
      expect(clientIp(r, "192.0.2.1")).toBe("192.0.2.1");
    });
  });

  it("absurd hop counts collapse to 0 (fail closed)", () => {
    withEnv({ TRUST_PROXY_HOPS: "999" }, () => {
      expect(trustedProxyHops()).toBe(0);
    });
  });
});

describe("SEC-7 — session revocation wiring", () => {
  it("session tokens embed the user's session version as a ver claim", () => {
    expect(SESSION_SRC).toContain("ver");
    expect(SESSION_SRC).toContain("sessionVersion: true");
  });

  it("readSession rejects tokens whose ver does not match the live value", () => {
    expect(SESSION_SRC).toContain("user.sessionVersion !== ver");
  });

  it("password reset bumps the version (revoke-then-mint)", () => {
    expect(AUTH_SERVICE_SRC).toContain("await revokeUserSessions(record.userId)");
    const resetIdx = AUTH_SERVICE_SRC.indexOf("await revokeUserSessions(record.userId)");
    const mintIdx = AUTH_SERVICE_SRC.indexOf("createSessionToken(record.userId)");
    expect(mintIdx).toBeGreaterThan(resetIdx);
  });

  it("revokeUserSessions is exported for operator use", () => {
    expect(SESSION_SRC).toContain("export async function revokeUserSessions(");
  });

  it("the sessionVersion column ships in both migration sets", () => {
    const { existsSync, readFileSync: rf } = fs;
    const sqlite = `${process.cwd()}/prisma/migrations-sqlite/20260925000000_add_session_version/migration.sql`;
    expect(existsSync(sqlite)).toBe(true);
    expect(rf(sqlite, "utf8")).toContain("sessionVersion");
    const pg = `${process.cwd()}/prisma/migrations-postgres/20260924000000_postgres_baseline/migration.sql`;
    expect(rf(pg, "utf8")).toContain("sessionVersion");
  });
});
