/**
 * readJsonBody — request-size hardening.
 *
 * JSON bodies carry config/parameters, never uploads, so an unbounded body must
 * not be buffered into memory. These tests pin both the declared-length guard
 * (Content-Length) and the streaming guard (a chunked body with no header).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "read-json-test-secret-0123456789abc";

import { __resetServerEnvForTests } from "@/lib/env";
import { readJsonBody } from "@/lib/server/api";

import { withEnvAsync } from "../helpers/temp-env";

const BASE = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable",
  AUTH_SECRET: "read-json-test-secret-0123456789abc",
};

function requestWith(body: BodyInit | null, stream = false) {
  const init: RequestInit = { method: "POST" };
  if (body !== null) {
    init.body = body;
    if (stream) (init as { duplex?: string }).duplex = "half";
  }
  return new Request("http://localhost/api/test", init);
}

describe("readJsonBody", () => {
  it("parses a normal JSON body", async () => {
    await expect(readJsonBody(requestWith(JSON.stringify({ a: 1 })))).resolves.toEqual({ a: 1 });
  });

  it("returns an empty object for an empty body", async () => {
    await expect(readJsonBody(requestWith(null))).resolves.toEqual({});
  });

  it("rejects invalid JSON with BAD_JSON (400)", async () => {
    await expect(readJsonBody(requestWith("{ not json"))).rejects.toMatchObject({
      status: 400,
      code: "BAD_JSON",
    });
  });

  it("rejects an oversized declared body with PAYLOAD_TOO_LARGE (413)", async () => {
    await withEnvAsync({ ...BASE, MAX_JSON_BODY_BYTES: "1024" }, async () => {
      __resetServerEnvForTests();
      const body = JSON.stringify({ big: "x".repeat(5000) });
      await expect(readJsonBody(requestWith(body))).rejects.toMatchObject({
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
      });
    });
  });

  it("rejects an oversized streamed body with no Content-Length (413)", async () => {
    await withEnvAsync({ ...BASE, MAX_JSON_BODY_BYTES: "1024" }, async () => {
      __resetServerEnvForTests();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ big: "x".repeat(5000) })));
          controller.close();
        },
      });
      const req = requestWith(stream, true);
      expect(req.headers.get("content-length")).toBeNull();
      await expect(readJsonBody(req)).rejects.toMatchObject({
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
      });
    });
  });
});
