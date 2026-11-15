/**
 * SSRF guard + connector typing tests.
 *
 * The url-guard tests never touch the network for literal-IP cases (pure
 * validation), and mock node:dns/promises for hostname cases so every
 * resolution outcome (public, private, unresolvable, empty) is deterministic
 * and hermetic. The postgres tests cover the OID → type mapping that replaced
 * the string-everything column typing.
 */
import { lookup } from "node:dns/promises";

import { pgTypeToColType, oidToTypeName } from "@/lib/engine/connectors/postgres";
import { UrlGuardError, assertSafeExternalUrl, isPrivateIp } from "@/lib/server/url-guard";

jest.mock("node:dns/promises", () => ({
  lookup: jest.fn(),
}));

const mockLookup = lookup as unknown as jest.Mock;

async function expectBlocked(url: string, pattern?: RegExp): Promise<void> {
  let error: unknown;
  try {
    await assertSafeExternalUrl(url);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(UrlGuardError);
  if (pattern) expect((error as UrlGuardError).message).toMatch(pattern);
}

async function expectAllowed(url: string): Promise<void> {
  await expect(assertSafeExternalUrl(url)).resolves.toBeInstanceOf(URL);
}

describe("isPrivateIp — literal address classification", () => {
  it("blocks loopback, link-local and cloud-metadata addresses", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true); // AWS/GCP metadata
    expect(isPrivateIp("169.254.0.1")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true); // IPv6 link-local
  });

  it("blocks RFC1918, CGNAT and multicast/reserved ranges", () => {
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("100.64.0.1")).toBe(true); // CGNAT
    expect(isPrivateIp("224.0.0.1")).toBe(true); // multicast
    expect(isPrivateIp("255.255.255.255")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 that embeds a private address", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.5")).toBe(true);
    expect(isPrivateIp("::ffff:192.168.0.9")).toBe(true);
  });

  it("allows genuinely public addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false); // just outside RFC1918
    expect(isPrivateIp("100.128.0.1")).toBe(false); // just outside CGNAT
    expect(isPrivateIp("2606:4700::1111")).toBe(false);
  });

  it("fails closed on unparseable input", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });
});

describe("assertSafeExternalUrl — literal URL validation", () => {
  it("rejects non-http(s) protocols without any DNS work", async () => {
    await expectBlocked("file:///etc/passwd");
    await expectBlocked("ftp://example.com/data.csv");
    await expectBlocked("gopher://example.com");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects URLs with embedded credentials", async () => {
    await expectBlocked("https://user:pass@example.com/data.csv");
    await expectBlocked("https://x@8.8.8.8/");
  });

  it("rejects internal hostnames before DNS", async () => {
    await expectBlocked("http://localhost:3000/api", /internal/i);
    await expectBlocked("http://api.localhost/data", /internal/i);
    await expectBlocked("http://db.internal/data", /internal/i);
    await expectBlocked("http://svc.orders.svc/rows", /internal/i);
    await expectBlocked("http://my.svc.cluster.local/api", /internal/i);
    await expectBlocked("http://printer.local/data", /internal/i);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects literal private IPs outright", async () => {
    await expectBlocked("http://127.0.0.1:8080/admin", /private|loopback/i);
    await expectBlocked("http://169.254.169.254/latest/meta-data/", /private|loopback/i);
    await expectBlocked("http://10.0.0.1/internal", /private|loopback/i);
    await expectBlocked("http://[::1]:5432/", /private|loopback/i);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("allows public literal IPs and URLs", async () => {
    await expectAllowed("https://8.8.8.8/data.csv");
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expectAllowed("https://example.com/data.csv");
  });
});

describe("assertSafeExternalUrl — DNS resolution (fail closed)", () => {
  it("blocks a hostname that resolves to a private address", async () => {
    mockLookup.mockResolvedValue([{ address: "192.168.1.10", family: 4 }]);
    await expectBlocked("https://rebind.example.com/data", /private address/i);
    expect(mockLookup).toHaveBeenCalledWith("rebind.example.com", { all: true, verbatim: true });
  });

  it("blocks when ANY resolved address is private (multi-record DNS)", async () => {
    mockLookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.9", family: 4 },
    ]);
    await expectBlocked("https://mixed.example.com/data");
  });

  it("blocks unresolvable hostnames with a 502-style unreachable error", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    let error: unknown;
    try {
      await assertSafeExternalUrl("https://no-such-host.example.invalid/data");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(UrlGuardError);
    const guardError = error as UrlGuardError;
    expect(guardError.code).toBe("CONNECTOR_UNREACHABLE");
    expect(guardError.status).toBe(502);
  });

  it("blocks an empty resolution set", async () => {
    mockLookup.mockResolvedValue([]);
    await expectBlocked("https://empty.example.com/data");
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    await expectAllowed("https://public.example.com/data.csv");
  });
});

describe("postgres OID → type mapping", () => {
  it("maps core OIDs to honest type names", () => {
    expect(oidToTypeName(16)).toBe("boolean");
    expect(oidToTypeName(20)).toBe("bigint");
    expect(oidToTypeName(23)).toBe("integer");
    expect(oidToTypeName(25)).toBe("text");
    expect(oidToTypeName(700)).toBe("real");
    expect(oidToTypeName(701)).toBe("double precision");
    expect(oidToTypeName(1082)).toBe("date");
    expect(oidToTypeName(1114)).toBe("timestamp without time zone");
    expect(oidToTypeName(1184)).toBe("timestamp with time zone");
    expect(oidToTypeName(1700)).toBe("numeric");
    expect(oidToTypeName(3802)).toBe("jsonb");
  });

  it("falls back to text for unknown OIDs (never crashes)", () => {
    expect(oidToTypeName(99999)).toBe("text");
  });

  it("produces Ledgerly ColTypes suitable for the profiler", () => {
    // An expression like SELECT count(*) yields OID 20 (bigint) → number.
    expect(pgTypeToColType(oidToTypeName(20))).toBe("number");
    // NOW() yields timestamptz (1184) → date.
    expect(pgTypeToColType(oidToTypeName(1184))).toBe("date");
    // CASE yielding text (25) → string.
    expect(pgTypeToColType(oidToTypeName(25))).toBe("string");
  });
});
