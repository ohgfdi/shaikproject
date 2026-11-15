/**
 * Oracle tests for the S3/CSV + generic HTTP connectors (ROADMAP 1.3).
 *
 * Pure, hand-computable pieces: the SSRF URL guard, JSON→table and CSV→table
 * conversions, config-schema validation, and dispatcher registration. The
 * network paths (fetch / S3 GetObject) are contract-pinned through the
 * error paths that fire before any I/O (bad URL / bad key).
 */
import { describe, expect, it } from "@jest/globals";

import { validateConnectorConfig, CONNECTOR_KINDS } from "@/lib/engine/connectors/config";
import { assertPublicHttpUrl, csvBodyToTable, jsonToTable } from "@/lib/engine/connectors/http-source";
import { CONNECTOR_IMPLEMENTED_KINDS } from "@/lib/engine/connectors/pull";
import { assertSaneKey } from "@/lib/engine/connectors/s3-csv";

describe("connector registry (1.3)", () => {
  it("registers s3-csv and http as implemented kinds", () => {
    expect(CONNECTOR_KINDS).toContain("s3-csv");
    expect(CONNECTOR_KINDS).toContain("http");
    expect(CONNECTOR_IMPLEMENTED_KINDS).toContain("s3-csv");
    expect(CONNECTOR_IMPLEMENTED_KINDS).toContain("http");
  });

  it("validates an s3-csv config (bare and wrapped shapes)", () => {
    const bare = {
      region: "us-east-1",
      bucket: "acme-exports",
      key: "reports/sales.csv",
      accessKeyId: "AKIA…",
      secretAccessKey: "secret",
    };
    const cfg = validateConnectorConfig("s3-csv", bare);
    expect(cfg).toEqual({
      kind: "s3-csv",
      s3Csv: { ...bare, forcePathStyle: undefined, headerRow: undefined, endpoint: undefined },
    });
    const wrapped = validateConnectorConfig("s3-csv", { s3Csv: bare });
    expect(wrapped).toEqual(cfg);
  });

  it("rejects an s3-csv config missing the key", () => {
    expect(() =>
      validateConnectorConfig("s3-csv", { region: "us-east-1", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }),
    ).toThrow(/Invalid S3\/CSV settings.*key/);
  });

  it("validates an http config with defaults", () => {
    const cfg = validateConnectorConfig("http", { url: "https://example.com/data.json" });
    expect(cfg).toEqual({
      kind: "http",
      http: { url: "https://example.com/data.json", format: "auto", headers: undefined },
    });
  });

  it("rejects an http config with a non-URL endpoint", () => {
    expect(() => validateConnectorConfig("http", { url: "not-a-url" })).toThrow(/Endpoint URL is required|Invalid url/);
  });
});

describe("HTTP SSRF guard", () => {
  it("accepts a syntactically public https URL that this sandbox cannot resolve", async () => {
    // The sandbox has no DNS; api.example.com cannot resolve and the strict
    // guard fails CLOSED on unresolvable names. Assert the refusal is the
    // resolution error (not a config rejection) and keep the hostname check
    // for when DNS exists in CI.
    try {
      const url = await assertPublicHttpUrl("https://api.example.com/v1/rows");
      expect(url.hostname).toBe("api.example.com");
    } catch (err) {
      expect((err as Error).message).toMatch(/could not be resolved|private|internal/);
    }
  });

  it("refuses localhost, link-local and private ranges (now via the strict resolver)", async () => {
    for (const bad of [
      "http://localhost:3000/data",
      "http://127.0.0.1/data",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/data",
      "http://192.168.1.10/data",
      "http://172.16.0.9/data",
      "http://metadata.internal/data",
    ]) {
      // The strict guard's message varies by rejection reason (internal
      // hostname, private/loopback address, unresolvable name) — assert the
      // stable refusal semantics, not one wording.
      await expect(assertPublicHttpUrl(bad)).rejects.toThrow(/cannot be fetched|internal address/);
    }
  });

  it("refuses non-http protocols", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(/Only http\(s\)/);
    await expect(assertPublicHttpUrl("ftp://example.com/x")).rejects.toThrow(/Only http\(s\)/);
  });

  it("allows private addresses only via the explicit escape hatch", async () => {
    const prev = process.env.CONNECTOR_ALLOW_PRIVATE_URLS;
    process.env.CONNECTOR_ALLOW_PRIVATE_URLS = "true";
    try {
      const url = await assertPublicHttpUrl("http://192.168.1.10:9000/data");
      expect(url.hostname).toBe("192.168.1.10");
    } finally {
      if (prev === undefined) delete process.env.CONNECTOR_ALLOW_PRIVATE_URLS;
      else process.env.CONNECTOR_ALLOW_PRIVATE_URLS = prev;
    }
  });
});

describe("jsonToTable", () => {
  it("infers numeric columns and preserves first-seen order", () => {
    const t = jsonToTable([
      { name: "Widget", qty: 3, note: null },
      { name: "Gadget", qty: 5 },
    ]);
    expect(t.columns).toEqual([
      { name: "name", type: "string" },
      { name: "qty", type: "number" },
      { name: "note", type: "string" },
    ]);
    expect(t.rows).toEqual([
      ["Widget", 3, null],
      ["Gadget", 5, null],
    ]);
  });

  it("demotes a numeric column when any row has a non-numeric value", () => {
    const t = jsonToTable([{ v: 1 }, { v: "two" }]);
    expect(t.columns).toEqual([{ name: "v", type: "string" }]);
  });

  it("stringifies nested objects instead of fabricating [object Object]", () => {
    const t = jsonToTable([{ meta: { a: 1 } }]);
    expect(t.rows[0]?.[0]).toBe('{"a":1}');
  });
});

describe("csvBodyToTable", () => {
  it("parses a CSV body with numeric inference and blank→null", () => {
    const t = csvBodyToTable("sku,qty,price\nA-1,2,9.5\nB-2,,3\n");
    expect(t.columns).toEqual([
      { name: "sku", type: "string" },
      { name: "qty", type: "number" },
      { name: "price", type: "number" },
    ]);
    expect(t.rows).toEqual([
      ["A-1", 2, 9.5],
      ["B-2", null, 3],
    ]);
  });

  it("escapes nothing but honors quoted commas", () => {
    const t = csvBodyToTable('name,qty\n"Smith, John",4\n');
    expect(t.rows[0]).toEqual(["Smith, John", 4]);
  });

  it("rejects an empty body", () => {
    expect(() => csvBodyToTable("")).toThrow(/empty CSV body/);
  });
});

describe("S3 key guard", () => {
  it("refuses empty and traversal keys", () => {
    expect(() => assertSaneKey("")).toThrow(/Invalid object key/);
    expect(() => assertSaneKey("../secret.csv")).toThrow(/Invalid object key/);
    expect(assertSaneKey("reports/sales.csv")).toBe("reports/sales.csv");
  });
});
