/**
 * Self-hosted error tracking (Phase 5.2).
 *
 * The whole justification for not shipping Sentry is that this path never
 * persists personal data — so the redaction is the security-critical code, and
 * it is tested against the specific shapes this app actually produces:
 * emails, bearer tokens, share tokens in query strings, cuids and UUIDs.
 */
import { fingerprint, redact, toReport } from "@/lib/server/error-tracking";

describe("error redaction", () => {
  it("removes email addresses", () => {
    expect(redact("failed for ca.firm@example.com")).toBe("failed for [email]");
  });

  it("removes bearer credentials but keeps the scheme readable", () => {
    expect(redact("Authorization: Bearer ak_live_abc123xyz789")).toContain("Bearer [redacted]");
  });

  it("removes secrets from query strings", () => {
    const out = redact("GET /api/public/v1/datasets/1/rows?api_key=SUPERSECRET&limit=10");
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[redacted]");
  });

  it("removes the app's own cuid ids", () => {
    expect(redact("row cuidclq1234567890abcdefgh not found")).toContain("[id]");
  });

  it("removes UUIDs", () => {
    expect(redact("user 550e8400-e29b-41d4-a716-446655440000 gone")).toContain("[id]");
  });

  it("removes any other long opaque token", () => {
    expect(redact("signed with ZmFrZXRoaXNsZWNyZXR2YWx1ZWtleTEyMzQ1Njc4")).toContain("[token]");
  });
});

describe("error fingerprinting", () => {
  it("groups the same error from different users into one fingerprint", () => {
    // The grouping key must NOT include the message: two users hitting the same
    // bug with different ids in the message must produce ONE row, or the error
    // table fragments by cardinality instead of frequency.
    const a = new Error("Cannot read properties of undefined (reading 'map')");
    const b = new Error("Cannot read properties of undefined (reading 'rows')");
    expect(fingerprint(a.name, a.stack ?? "")).toBe(fingerprint(b.name, b.stack ?? ""));
  });

  it("distinguishes genuinely different error types", () => {
    const a = new TypeError("x");
    const b = new RangeError("x");
    expect(fingerprint(a.name, a.stack ?? "")).not.toBe(fingerprint(b.name, b.stack ?? ""));
  });

  it("is stable across calls", () => {
    const e = new Error("boom");
    expect(fingerprint(e.name, e.stack ?? "")).toBe(fingerprint(e.name, e.stack ?? ""));
  });
});

describe("toReport", () => {
  it("strips the query string from the path (a share token lives in the path/query)", () => {
    const report = toReport(new Error("boom"), { path: "/apps/abc123?token=SUPERSECRET" });
    expect(report.path).toBe("/apps/abc123");
    expect(report.path).not.toContain("SUPERSECRET");
  });

  it("redacts the message and the stack", () => {
    const err = new Error("login failed for ca@example.com");
    err.stack = "Error: login failed for ca@example.com\n    at x (/app/routes/login.ts:1:1)";
    const report = toReport(err, { path: "/login" });
    expect(report.message).not.toContain("example.com");
    expect(report.stack).not.toContain("example.com");
  });

  it("handles a thrown non-Error", () => {
    // Throwing a string or an object is common and must not crash the reporter.
    const report = toReport("just a string", { path: "/x" });
    expect(report.name).toBe("NonError");
    expect(report.message).toContain("just a string");
    expect(report.fingerprint).toHaveLength(32);
  });

  it("caps the stack size so one pathological error cannot bloat the row", () => {
    const err = new Error("big");
    err.stack = `Error: big\n${"    at f(/a.ts:1:1)\n".repeat(5_000)}`;
    expect(toReport(err).stack.length).toBeLessThanOrEqual(8_000);
  });

  it("omits optional context rather than storing empty strings", () => {
    const report = toReport(new Error("x"));
    expect(report.requestId).toBeUndefined();
    expect(report.userId).toBeUndefined();
    expect(report.workspaceId).toBeUndefined();
  });
});
