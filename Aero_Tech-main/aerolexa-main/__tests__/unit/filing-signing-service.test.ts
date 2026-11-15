/**
 * Remote DSC signing oracle tests.
 *
 * The app must never hold a DSC private key, so the live path is an HTTP
 * adapter. These tests pin the request shape, the response validation and the
 * detached envelope the e-filing gateway transmits — no network involved.
 */
import { describe, expect, it } from "@jest/globals";

import { FilingTransport, ItdEfilingGateway } from "@/lib/engine/filing/irp";
import { canonicalJson, HttpSigningService, sha256Hex, signFilingPayload } from "@/lib/engine/filing/signing";
import { resolveFilingSigner, resolveSigningAccount } from "@/lib/engine/filing/signing-service";
import { __resetServerEnvForTests } from "@/lib/env";

import { withEnv } from "../helpers/temp-env";

const ACCOUNT = { user: "partner-1", certificateSerial: "1A2B3C" };
const DIGEST = sha256Hex("abc");

describe("HttpSigningService", () => {
  it("posts the digest and account, and returns the signature", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const signer = new HttpSigningService({
      url: "https://sign.example/sign",
      token: "svc-token",
      timeoutMs: 500,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            signatureBase64: Buffer.from("signature-bytes").toString("base64"),
            certificateSerial: "1A2B3C",
            signedAt: "2026-11-10T12:00:00.000Z",
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    const result = await signer.sign(DIGEST, ACCOUNT);
    expect(result.signatureBase64).toBe(Buffer.from("signature-bytes").toString("base64"));
    expect(result.certificateSerial).toBe("1A2B3C");
    expect(result.signedAt).toBe("2026-11-10T12:00:00.000Z");

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      digest: string;
      algorithm: string;
      account: { user: string; certificateSerial: string };
    };
    expect(calls[0]?.url).toBe("https://sign.example/sign");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer svc-token");
    expect(body).toEqual({
      digest: DIGEST,
      algorithm: "SHA256withRSA",
      account: { user: "partner-1", certificateSerial: "1A2B3C" },
    });
  });

  it("refuses a non-hex digest instead of signing the wrong input", async () => {
    const signer = new HttpSigningService({
      url: "https://sign.example/sign",
      token: "t",
      timeoutMs: 500,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });
    await expect(signer.sign("not-a-digest", ACCOUNT)).rejects.toThrow(/SHA-256 hex digest/);
  });

  it("surfaces a signing-service rejection readably", async () => {
    const signer = new HttpSigningService({
      url: "https://sign.example/sign",
      token: "t",
      timeoutMs: 500,
      fetchImpl: (async () => new Response("certificate expired", { status: 422 })) as typeof fetch,
    });
    await expect(signer.sign(DIGEST, ACCOUNT)).rejects.toThrow(/HTTP 422\): certificate expired/);
  });

  it("rejects a response with no signature", async () => {
    const signer = new HttpSigningService({
      url: "https://sign.example/sign",
      token: "t",
      timeoutMs: 500,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
    });
    await expect(signer.sign(DIGEST, ACCOUNT)).rejects.toThrow(/no signatureBase64/);
  });
});

describe("signFilingPayload", () => {
  it("signs the canonical payload digest, not raw JSON key order", async () => {
    let seenDigest = "";
    const signer = new HttpSigningService({
      url: "https://sign.example/sign",
      token: "t",
      timeoutMs: 500,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seenDigest = (JSON.parse(String(init.body)) as { digest: string }).digest;
        return new Response(JSON.stringify({ signatureBase64: "c2ln" }), { status: 200 });
      }) as typeof fetch,
    });
    const payload = { b: 2, a: 1 };
    const envelope = await signFilingPayload(signer, ACCOUNT, payload);
    expect(seenDigest).toBe(sha256Hex(canonicalJson(payload)));
    expect(envelope.digest).toBe(seenDigest);
    expect(envelope.algorithm).toBe("SHA256withRSA");
    expect(envelope.signerId).toBe("http-signing-service");
  });
});

describe("signing configuration", () => {
  afterEach(() => __resetServerEnvForTests());

  it("returns null when no signing service is configured", () => {
    withEnv({ FILING_SIGNING_URL: "", FILING_SIGNING_TOKEN: "" }, () => {
      __resetServerEnvForTests();
      expect(resolveFilingSigner()).toBeNull();
      expect(resolveSigningAccount()).toBeNull();
    });
  });

  it("refuses a URL without a token (never falls back to unsigned)", () => {
    withEnv({ FILING_SIGNING_URL: "https://sign.example", FILING_SIGNING_TOKEN: "" }, () => {
      __resetServerEnvForTests();
      expect(() => resolveFilingSigner()).toThrow(/both FILING_SIGNING_URL and FILING_SIGNING_TOKEN/);
    });
  });

  it("builds the account only when both fields are present", () => {
    withEnv({ FILING_SIGNING_USER: "partner-1", FILING_SIGNING_CERT_SERIAL: "" }, () => {
      __resetServerEnvForTests();
      expect(() => resolveSigningAccount()).toThrow(/both FILING_SIGNING_USER and FILING_SIGNING_CERT_SERIAL/);
    });
    withEnv({ FILING_SIGNING_USER: "partner-1", FILING_SIGNING_CERT_SERIAL: "1A2B3C" }, () => {
      __resetServerEnvForTests();
      expect(resolveSigningAccount()).toEqual(ACCOUNT);
    });
  });
});

describe("ItdEfilingGateway DSC envelope", () => {
  it("carries the detached signature in the body and headers", async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 1,
      baseMs: 1,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url,
          body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
          headers: (init.headers as Record<string, string>) ?? {},
        });
        return new Response(
          JSON.stringify(url.endsWith("/token") ? { access_token: "TOK" } : { ackNo: "ACK-1" }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const gateway = new ItdEfilingGateway(
      {
        tokenUrl: "https://eportal.example/token",
        submitUrl: "https://eportal.example/submit",
        clientId: "cid",
        clientSecret: "sec",
        timeoutMs: 500,
      },
      transport,
    );
    const signature = {
      algorithm: "SHA256withRSA" as const,
      digest: DIGEST,
      signatureBase64: "c2ln",
      certificateSerial: "1A2B3C",
      signedAt: "2026-11-10T12:00:00.000Z",
      signerId: "http-signing-service",
    };
    const receipt = await gateway.submit({
      channel: "efiling-audit",
      token: "t-audit",
      payload: { ITR: 1 },
      signature,
    });
    expect(receipt.status).toBe("filed");
    const submit = calls.find((call) => call.url.endsWith("/submit"));
    expect(submit?.body.dsc).toEqual(signature);
    expect(submit?.headers["x-dsc-signature"]).toBe("c2ln");
    expect(submit?.headers["x-dsc-certificate-serial"]).toBe("1A2B3C");
    expect(submit?.headers["x-dsc-digest"]).toBe(DIGEST);
  });
});
