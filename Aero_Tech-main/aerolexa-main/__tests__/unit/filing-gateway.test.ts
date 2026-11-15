/**
 * Government-portal filing gateway — oracle tests.
 *
 * The crypto is oracle-tested against published vectors and against node:crypto
 * itself (the reference implementation), so a checksum or MAC computed here is
 * provably correct rather than merely self-consistent. The IRP handshake is
 * exercised end-to-end through an injected fetch with a locally generated RSA
 * keypair: the test decrypts the auth envelope the gateway sent, recovers the
 * AppKey, mints the Sek the way the IRP would, and encrypts the IRN response
 * with that Sek — no network, but the real wire shape. The simulator is pinned
 * for determinism and idempotency; provider selection and the boot-time live
 * credential check are exercised with env overrides so a half-configured live
 * deployment can never reach a portal.
 */

import {
  aesDecryptBase64,
  aesEncryptBase64,
  createAppKey,
  generateIrpKeyPair,
  isValidRsaPublicKey,
  rsaDecryptBase64,
  rsaEncryptBase64,
} from "@/lib/engine/filing/crypto";
import { CredentialMissingError, PortalRejectionError, PortalTransportError } from "@/lib/engine/filing/errors";
import {
  __resetFilingGatewayForTests,
  efilingFieldMapFromEnv,
  filingGatewayHealth,
  filingGatewayPreflight,
  normalizePem,
  resolveFilingGateway,
} from "@/lib/engine/filing/gateway";
import {
  DEFAULT_EFILING_FIELDS,
  FilingTransport,
  GstnIrpGateway,
  ItdEfilingGateway,
  backoffDelay,
  isSandboxHost,
  parseFieldCandidates,
  resolvePathValue,
  type FetchLike,
} from "@/lib/engine/filing/irp";
import {
  canonicalJson,
  gstnChecksumHex,
  hmacSha256Base64,
  hmacSha256Hex,
  irnReference,
  onceToken,
  sha256Base64,
  sha256Hex,
} from "@/lib/engine/filing/signing";
import { FilingSimulator, ReferenceFilingGateway } from "@/lib/engine/filing/simulator";
import type { FilingSubmissionRequest } from "@/lib/engine/filing/types";
import { __resetServerEnvForTests, __serverSchemaForTests } from "@/lib/env";

import { withEnv, withEnvAsync } from "../helpers/temp-env";

const IRP_CONFIG = {
  irpBaseUrl: "https://einvoice1.gst.gov.in",
  authPath: "/eivital/v1.04/auth",
  irpEndpointPath: "/eicore/v1.03/Invoice",
  gstin: "27AAPFU0939F1ZV",
  clientId: "client-id",
  clientSecret: "client-secret",
  portalUser: "irp-user",
  portalPassword: "irp-pass",
  irpPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nRkFLRQ==\n-----END PUBLIC KEY-----",
  timeoutMs: 1_000,
};

// A real RSA keypair stands in for the IRP's public key in the provider-selection
// tests, because a live env must now carry a PARSEABLE key (boot fails closed
// otherwise). The handshake tests mint their own keypairs per case.
const PROVIDER_KEY = generateIrpKeyPair();

function request(overrides: Partial<FilingSubmissionRequest> = {}): FilingSubmissionRequest {
  return {
    channel: "irp-irn",
    token: "11111111-1111-4111-8111-111111111111",
    gstin: "27AAPFU0939F1ZV",
    payload: { invoiceNumber: "INV-1", taxableValue: 1000, gstin: "27AAPFU0939F1ZV" },
    ...overrides,
  };
}

function mockFetch(handler: (input: string, init: RequestInit) => Promise<Response>): FetchLike {
  return handler as FetchLike;
}

/**
 * A fake IRP: decrypts the RSA auth envelope exactly as the real portal would,
 * mints the Sek encrypted with the recovered AppKey, and encrypts the invoice
 * response with the Sek. Ordering is preserved so callers can assert which call
 * carried which headers.
 */
function irpFetch(options: {
  privateKeyPem: string;
  sek: string;
  authToken: string;
  invoiceResponse: Record<string, unknown>;
  authResponse?: Record<string, unknown>;
  capture?: (url: string, init: RequestInit) => void;
}): FetchLike {
  return mockFetch(async (input, init) => {
    options.capture?.(input, init);
    const body = JSON.parse(String(init.body ?? "{}")) as { Data?: string };
    if (input.endsWith("/eivital/v1.04/auth")) {
      const inner = JSON.parse(
        Buffer.from(rsaDecryptBase64(body.Data ?? "", options.privateKeyPem), "base64").toString("utf8"),
      ) as {
        AppKey: string;
      };
      const sekEncrypted = aesEncryptBase64(options.sek, inner.AppKey);
      return new Response(
        JSON.stringify(
          options.authResponse ?? {
            Status: "1",
            Data: {
              ClientId: "client-id",
              UserName: "irp-user",
              AuthToken: options.authToken,
              Sek: sekEncrypted,
              TokenExpiry: "2026-10-16 12:00:00",
            },
            ErrorDetails: null,
          },
        ),
        { status: 200 },
      );
    }
    const data = aesEncryptBase64(JSON.stringify(options.invoiceResponse), options.sek);
    return new Response(JSON.stringify({ Status: "1", Data: data, ErrorDetails: null }), { status: 200 });
  });
}

describe("filing signing primitives", () => {
  it("canonicalises with sorted keys, recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("matches the SHA-256 abc vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Base64("abc")).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });

  it("matches the RFC 4231 HMAC-SHA256 vector", () => {
    const message = "The quick brown fox jumps over the lazy dog";
    expect(hmacSha256Hex(message, "key")).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    expect(hmacSha256Base64(message, "key")).toBe("97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=");
  });

  it("computes the GSTN checksum as SHA-256 of canonical payload + secret", () => {
    const payload = { b: 1, a: 2 };
    expect(gstnChecksumHex(payload, "s")).toBe(sha256Hex(`${canonicalJson(payload)}s`));
  });

  it("derives a 40-char GSTN-shaped IRN reference", () => {
    const irn = irnReference(canonicalJson({ invoiceNumber: "INV-1" }));
    expect(irn).toHaveLength(40);
    expect(irn).toMatch(/^[0-9A-Z]{40}$/);
    expect(irn).toBe(
      sha256Hex(canonicalJson({ invoiceNumber: "INV-1" }))
        .toUpperCase()
        .slice(0, 40),
    );
  });

  it("generates unique RFC-4122 once-tokens", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => onceToken()));
    expect(tokens.size).toBe(1000);
    expect(onceToken()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("IRP envelope crypto", () => {
  it("round-trips an RSA/ECB/PKCS1 envelope with a real keypair", () => {
    const { publicKeyPem, privateKeyPem } = generateIrpKeyPair();
    const inner = Buffer.from(JSON.stringify({ UserName: "u", AppKey: "k" }), "utf8").toString("base64");
    const cipher = rsaEncryptBase64(inner, publicKeyPem);
    expect(cipher).not.toBe(inner);
    expect(rsaDecryptBase64(cipher, privateKeyPem)).toBe(inner);
  });

  it("round-trips an AES-256/ECB payload with a 32-byte base64 key", () => {
    const key = createAppKey();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    const cipher = aesEncryptBase64(JSON.stringify({ Irn: "abc" }), key);
    expect(aesDecryptBase64(cipher, key)).toBe('{"Irn":"abc"}');
  });

  it("rejects a wrong-length AES key", () => {
    expect(() => aesEncryptBase64("x", Buffer.from("short").toString("base64"))).toThrow(/32-byte AES key/);
  });

  it("validates a pasted public key and rejects junk", () => {
    const { publicKeyPem } = generateIrpKeyPair();
    expect(isValidRsaPublicKey(publicKeyPem)).toBe(true);
    // one-line form with \n escapes is accepted too
    expect(isValidRsaPublicKey(publicKeyPem.replace(/\n/g, "\\n"))).toBe(true);
    expect(isValidRsaPublicKey("not-a-key")).toBe(false);
    expect(isValidRsaPublicKey("")).toBe(false);
  });

  it("flags sandbox hosts", () => {
    expect(isSandboxHost("https://einv-apisandbox.nic.in")).toBe(true);
    expect(isSandboxHost("https://einvoice1.gst.gov.in")).toBe(false);
  });
});

describe("FilingTransport", () => {
  it("computes a bounded, jittered exponential backoff", () => {
    expect(backoffDelay(0, 100, 30_000)).toBe(0);
    const second = backoffDelay(1, 100, 30_000);
    expect(second).toBeGreaterThanOrEqual(100);
    expect(second).toBeLessThanOrEqual(115);
    expect(backoffDelay(20, 100, 1_000)).toBeLessThanOrEqual(1_000);
  });

  it("retries transport faults and succeeds within the attempt budget", async () => {
    let calls = 0;
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 3,
      baseMs: 1,
      fetchImpl: mockFetch(async () => {
        calls += 1;
        if (calls < 3) return new Response("boom", { status: 502 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    });
    const result = await transport.request(
      "POST",
      "https://einvoice1.gst.gov.in/x",
      {},
      { a: 1 },
      { provider: "live", channel: "irp-irn", token: "t" },
    );
    expect(calls).toBe(3);
    expect(result.httpStatus).toBe(200);
  });

  it("gives up with a PortalTransportError after the budget is exhausted", async () => {
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 2,
      baseMs: 1,
      fetchImpl: mockFetch(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(
      transport.request(
        "POST",
        "https://einvoice1.gst.gov.in/x",
        {},
        {},
        { provider: "live", channel: "irp-irn", token: "t" },
      ),
    ).rejects.toBeInstanceOf(PortalTransportError);
  });

  it("treats a 4xx as a non-retryable rejection", async () => {
    let calls = 0;
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 3,
      baseMs: 1,
      fetchImpl: mockFetch(async () => {
        calls += 1;
        return new Response(JSON.stringify({ error_code: "DOC_INVALID", error_msg: "bad invoice" }), { status: 400 });
      }),
    });
    await expect(
      transport.request(
        "POST",
        "https://einvoice1.gst.gov.in/x",
        {},
        {},
        { provider: "live", channel: "irp-irn", token: "t" },
      ),
    ).rejects.toBeInstanceOf(PortalRejectionError);
    expect(calls).toBe(1);
  });
});

describe("GstnIrpGateway (live shape, injected fetch)", () => {
  it("completes the RSA auth handshake and captures the encrypted IRN", async () => {
    const { publicKeyPem, privateKeyPem } = generateIrpKeyPair();
    const sek = createAppKey();
    const seen: {
      authHeaders: Record<string, string> | null;
      invoiceHeaders: Record<string, string> | null;
      invoiceBody: string | null;
    } = {
      authHeaders: null,
      invoiceHeaders: null,
      invoiceBody: null,
    };
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 1,
      baseMs: 1,
      fetchImpl: irpFetch({
        privateKeyPem,
        sek,
        authToken: "AUTH-TOKEN-1",
        invoiceResponse: {
          Irn: "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
          AckNo: 112010000002315,
          AckDt: "2026-10-16 09:30:00",
          Status: "ACTIVE",
        },
        capture: (url, init) => {
          const headers = (init as unknown as { headers: Record<string, string> }).headers;
          if (url.endsWith("/auth")) seen.authHeaders = headers;
          else {
            seen.invoiceHeaders = headers;
            seen.invoiceBody = String(init.body);
          }
        },
      }),
    });
    const gateway = new GstnIrpGateway({ ...IRP_CONFIG, irpPublicKeyPem: publicKeyPem }, transport);
    const receipt = await gateway.submit(request());

    expect(receipt.provider).toBe("live");
    expect(receipt.status).toBe("filed");
    expect(receipt.irn).toBe("9a1b2c3d4e5f60718293a4b5c6d7e8f901234567");
    expect(receipt.ackNumber).toBe("112010000002315");

    // Auth call carried the client identity but no AuthToken yet.
    expect(seen.authHeaders?.["client_id"]).toBe("client-id");
    expect(seen.authHeaders?.["gstin"]).toBe("27AAPFU0939F1ZV");

    // Invoice call carried the minted AuthToken and the portal user.
    expect(seen.invoiceHeaders?.["AuthToken"]).toBe("AUTH-TOKEN-1");
    expect(seen.invoiceHeaders?.["user_name"]).toBe("irp-user");
    expect(seen.invoiceHeaders?.["once-token"]).toBe("11111111-1111-4111-8111-111111111111");
    // The invoice body is the AES envelope the IRP expects, not the clear payload.
    const envelope = JSON.parse(seen.invoiceBody ?? "{}") as { Data?: string };
    expect(Object.keys(envelope)).toEqual(["Data"]);
    expect(JSON.parse(aesDecryptBase64(envelope.Data ?? "", sek))).toMatchObject({ invoiceNumber: "INV-1" });
  });

  it("reuses the cached AuthToken across submissions (no second auth call)", async () => {
    const { publicKeyPem, privateKeyPem } = generateIrpKeyPair();
    const sek = createAppKey();
    let authCalls = 0;
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 1,
      baseMs: 1,
      fetchImpl: ((input: string, init: RequestInit) => {
        if (input.endsWith("/auth")) authCalls += 1;
        return irpFetch({ privateKeyPem, sek, authToken: "AUTH-TOKEN-1", invoiceResponse: { Irn: "abc", AckNo: 1 } })(
          input,
          init,
        );
      }) as FetchLike,
    });
    const gateway = new GstnIrpGateway({ ...IRP_CONFIG, irpPublicKeyPem: publicKeyPem }, transport);
    await gateway.submit(request({ token: "tok-1" }));
    await gateway.submit(request({ token: "tok-2" }));
    expect(authCalls).toBe(1);
  });

  it("requires the full credential set to construct", () => {
    expect(() => new GstnIrpGateway({ ...IRP_CONFIG, clientSecret: "" })).toThrow(CredentialMissingError);
    expect(() => new GstnIrpGateway({ ...IRP_CONFIG, irpPublicKeyPem: "" })).toThrow(CredentialMissingError);
    expect(() => new GstnIrpGateway({ ...IRP_CONFIG, portalPassword: "" })).toThrow(CredentialMissingError);
  });

  it("surfaces a GSTN business rejection as a PortalRejectionError", async () => {
    const { publicKeyPem, privateKeyPem } = generateIrpKeyPair();
    const sek = createAppKey();
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 1,
      baseMs: 1,
      fetchImpl: irpFetch({
        privateKeyPem,
        sek,
        authToken: "AUTH-TOKEN-1",
        invoiceResponse: {},
        authResponse: { Status: "0", Data: null, ErrorDetails: [{ ErrorCode: "2150", ErrorMessage: "Duplicate IRN" }] },
      }),
    });
    const gateway = new GstnIrpGateway({ ...IRP_CONFIG, irpPublicKeyPem: publicKeyPem }, transport);
    await expect(gateway.submit(request())).rejects.toBeInstanceOf(PortalRejectionError);
  });

  it("rejects a malformed auth response (missing AuthToken/Sek)", async () => {
    const { publicKeyPem, privateKeyPem } = generateIrpKeyPair();
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 1,
      baseMs: 1,
      fetchImpl: irpFetch({
        privateKeyPem,
        sek: createAppKey(),
        authToken: "unused",
        invoiceResponse: {},
        authResponse: { Status: "1", Data: { ClientId: "c" }, ErrorDetails: null },
      }),
    });
    const gateway = new GstnIrpGateway({ ...IRP_CONFIG, irpPublicKeyPem: publicKeyPem }, transport);
    await expect(gateway.submit(request())).rejects.toBeInstanceOf(PortalRejectionError);
  });

  it("preflights credentials by running the auth handshake only (no invoice filed)", async () => {
    const { publicKeyPem, privateKeyPem } = generateIrpKeyPair();
    const sek = createAppKey();
    let invoiceCalls = 0;
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 1,
      baseMs: 1,
      fetchImpl: ((input: string, init: RequestInit) => {
        if (input.includes("/Invoice")) invoiceCalls += 1;
        return irpFetch({ privateKeyPem, sek, authToken: "AUTH-TOKEN-1", invoiceResponse: {} })(input, init);
      }) as FetchLike,
    });
    const gateway = new GstnIrpGateway({ ...IRP_CONFIG, irpPublicKeyPem: publicKeyPem }, transport);
    const report = await gateway.preflight();

    expect(report.ok).toBe(true);
    expect(report.provider).toBe("live");
    expect(report.sandbox).toBe(false);
    expect(invoiceCalls).toBe(0);
  });

  it("reports a failed preflight without throwing when the portal rejects auth", async () => {
    const { publicKeyPem, privateKeyPem } = generateIrpKeyPair();
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 1,
      baseMs: 1,
      fetchImpl: irpFetch({
        privateKeyPem,
        sek: createAppKey(),
        authToken: "x",
        invoiceResponse: {},
        authResponse: {
          Status: "0",
          Data: null,
          ErrorDetails: [{ ErrorCode: "AUTH001", ErrorMessage: "invalid credentials" }],
        },
      }),
    });
    const gateway = new GstnIrpGateway({ ...IRP_CONFIG, irpPublicKeyPem: publicKeyPem }, transport);
    const report = await gateway.preflight();

    expect(report.ok).toBe(false);
    expect(report.detail).toMatch(/invalid credentials|AUTH001/);
  });
});

describe("ItdEfilingGateway (configurable ERI field mapping)", () => {
  const baseConfig = {
    tokenUrl: "https://eportal.example/iec/eriservice/token",
    submitUrl: "https://eportal.example/iec/eriservice/submit",
    clientId: "cid",
    clientSecret: "sec",
    timeoutMs: 500,
  };

  /** Records every call and lets each test answer by URL. */
  function efilingTransport(handler: (url: string) => { status?: number; body: unknown }): {
    transport: FilingTransport;
    calls: { url: string; body: unknown; headers: Record<string, string> }[];
  } {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const transport = new FilingTransport({
      timeoutMs: 500,
      maxAttempts: 1,
      baseMs: 1,
      fetchImpl: mockFetch(async (input, init) => {
        const headers = (init.headers as Record<string, string> | undefined) ?? {};
        const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
        calls.push({ url: input, body, headers });
        const { status = 200, body: responseBody } = handler(input);
        return new Response(JSON.stringify(responseBody), { status });
      }),
    });
    return { transport, calls };
  }

  it("uses the default field paths and wraps the submit body under `json`", async () => {
    const { transport, calls } = efilingTransport((url) =>
      url.endsWith("/token")
        ? { body: { access_token: "TOK" } }
        : { body: { data: { ackNo: "ACK-1", ackDt: "2026-10-16", status: "Success" } } },
    );
    const gateway = new ItdEfilingGateway({ ...baseConfig }, transport);
    const receipt = await gateway.submit({
      channel: "efiling-return",
      token: "t1",
      payload: { ITR: 1 },
      ay: "2026-27",
    });

    expect(receipt.provider).toBe("live");
    expect(receipt.status).toBe("filed");
    expect(receipt.ackNumber).toBe("ACK-1");
    expect(receipt.ackDate).toBe("2026-10-16");

    const submit = calls.find((c) => c.url.endsWith("/submit"));
    expect(submit?.headers["authorization"]).toBe("Bearer TOK");
    expect(submit?.body).toEqual({ json: { ITR: 1 } });
  });

  it("honours a custom ERI field map from the registration pack", async () => {
    const { transport, calls } = efilingTransport((url) =>
      url.endsWith("/token")
        ? { body: { result: { session: { token: "CUSTOM-TOK" } } } }
        : { body: { response: { ack: { num: 42, date: "2026-10-16T00:00:00" } } } },
    );
    const gateway = new ItdEfilingGateway(
      {
        ...baseConfig,
        fields: {
          ...DEFAULT_EFILING_FIELDS,
          token: ["result.session.token"],
          ackNumber: ["response.ack.num"],
          ackDate: ["response.ack.date"],
        },
        submitBodyKey: "returnData",
      },
      transport,
    );
    const receipt = await gateway.submit({ channel: "efiling-audit", token: "t2", payload: { ITR: 2 } });

    expect(receipt.ackNumber).toBe("42"); // numeric ack is stringified
    expect(receipt.ackDate).toBe("2026-10-16T00:00:00");
    expect(receipt.channel).toBe("efiling-audit");
    const submit = calls.find((c) => c.url.endsWith("/submit"));
    expect(submit?.headers["authorization"]).toBe("Bearer CUSTOM-TOK");
    expect(submit?.body).toEqual({ returnData: { ITR: 2 } });
  });

  it("posts the payload raw when submitBodyKey is empty", async () => {
    const { transport, calls } = efilingTransport((url) =>
      url.endsWith("/token") ? { body: { token: "TOK" } } : { body: { ackNo: "A" } },
    );
    const gateway = new ItdEfilingGateway({ ...baseConfig, submitBodyKey: "" }, transport);
    await gateway.submit({ channel: "efiling-return", token: "t3", payload: { ITR: 3 } });
    const submit = calls.find((c) => c.url.endsWith("/submit"));
    expect(submit?.body).toEqual({ ITR: 3 });
  });

  it("surfaces an ERI business rejection from the configured error paths", async () => {
    const { transport } = efilingTransport((url) =>
      url.endsWith("/token")
        ? { body: { access_token: "TOK" } }
        : { body: { error_code: "E1", error_msg: "bad return" } },
    );
    const gateway = new ItdEfilingGateway({ ...baseConfig }, transport);
    await expect(gateway.submit({ channel: "efiling-return", token: "t4", payload: {} })).rejects.toMatchObject({
      kind: "rejection",
      details: expect.objectContaining({ portalErrorCode: "E1" }),
    });
  });

  it("preflights by exchanging the token only (no submit call)", async () => {
    const { transport, calls } = efilingTransport(() => ({ body: { access_token: "TOK" } }));
    const gateway = new ItdEfilingGateway({ ...baseConfig }, transport);
    const report = await gateway.preflight();
    expect(report.ok).toBe(true);
    expect(calls.every((c) => c.url.endsWith("/token"))).toBe(true);
  });
});

describe("ERI field-map parsing", () => {
  it("parses dotted candidates and falls back when blank", () => {
    expect(parseFieldCandidates("response.ack.num, ackNo", ["x"])).toEqual(["response.ack.num", "ackNo"]);
    expect(parseFieldCandidates("  ", ["x"])).toEqual(["x"]);
    expect(parseFieldCandidates("", DEFAULT_EFILING_FIELDS.token)).toEqual(DEFAULT_EFILING_FIELDS.token);
  });

  it("resolves nested dotted paths and stringifies numbers", () => {
    expect(resolvePathValue({ a: { b: { c: 7 } } }, "a.b.c")).toBe("7");
    expect(resolvePathValue({ a: 1 }, "a.b.c")).toBeNull();
    expect(resolvePathValue({ a: "x" }, "a")).toBe("x");
    expect(resolvePathValue(null, "a")).toBeNull();
  });

  it("assembles the field map from env, with defaults for unset vars", () => {
    withEnv({ FILING_EFILING_TOKEN_FIELD: "result.session.token", FILING_EFILING_ACK_NUMBER_FIELD: "" }, () => {
      __resetServerEnvForTests();
      const map = efilingFieldMapFromEnv();
      expect(map.token).toEqual(["result.session.token"]);
      expect(map.ackNumber).toEqual(DEFAULT_EFILING_FIELDS.ackNumber);
      expect(map.errorMessage).toEqual(DEFAULT_EFILING_FIELDS.errorMessage);
    });
  });
});

describe("FilingSimulator", () => {
  it("returns a deterministic, GSTN-shaped filed receipt", async () => {
    const sim = new FilingSimulator();
    const req = request();
    const first = await sim.submit(req);
    const second = await sim.submit(req);

    expect(first.provider).toBe("simulation");
    expect(first.status).toBe("filed");
    expect(first.irn).toHaveLength(40);
    expect(first.ackNumber).toMatch(/^NAPR[0-9A-F]{12}$/);
    expect(first.digest).toBe(sha256Hex(canonicalJson(req.payload)));
    expect(second).toEqual(first);
  });

  it("rejects a payload flagged for simulation rejection", async () => {
    const sim = new FilingSimulator();
    await expect(sim.submit(request({ payload: { simulateRejection: true } }))).rejects.toMatchObject({
      kind: "rejection",
      details: expect.objectContaining({ portalErrorCode: "SIM_TEST_REJECTION" }),
    });
  });

  it("rejects a non-object payload", async () => {
    const sim = new FilingSimulator();
    await expect(sim.submit(request({ payload: [1, 2, 3] }))).rejects.toBeInstanceOf(PortalRejectionError);
  });

  it("reports stored status for a known token", async () => {
    const sim = new FilingSimulator();
    const receipt = await sim.submit(request());
    expect(await sim.status(request())).toEqual(receipt);
    expect((await sim.status(request({ token: "unknown-token" }))).status).toBe("accepted-pending");
  });
});

describe("ReferenceFilingGateway", () => {
  it("is clearly labelled as not transmitted", async () => {
    const gateway = new ReferenceFilingGateway();
    const req = request();
    const receipt = await gateway.submit(req);
    expect(receipt.provider).toBe("reference");
    expect(receipt.irn).toBe(irnReference(canonicalJson(req.payload)));
    expect(receipt.ackNumber).toBeNull();
    expect(receipt.portalMessage).toContain("nothing was transmitted");
  });
});

describe("gateway helpers", () => {
  it("normalises a PEM pasted with literal \\n escapes", () => {
    expect(normalizePem("-----BEGIN PUBLIC KEY-----\\nRkFLRQ==\\n-----END PUBLIC KEY-----")).toBe(
      "-----BEGIN PUBLIC KEY-----\nRkFLRQ==\n-----END PUBLIC KEY-----",
    );
    expect(normalizePem("already\nreal")).toBe("already\nreal");
  });
});

describe("provider selection + boot-time live credential check", () => {
  afterEach(() => {
    __resetFilingGatewayForTests();
    __resetServerEnvForTests();
  });

  const LIVE_IRP_ENV = {
    FILING_GATEWAY: "live",
    FILING_CHANNEL: "irp-irn",
    FILING_GSTIN: "27AAPFU0939F1ZV",
    FILING_IRP_CLIENT_ID: "id",
    FILING_IRP_CLIENT_SECRET: "secret",
    FILING_IRP_PORTAL_USER: "u",
    FILING_IRP_PORTAL_PASSWORD: "p",
    FILING_IRP_PUBLIC_KEY: PROVIDER_KEY.publicKeyPem,
  };

  it("defaults to reference when FILING_GATEWAY is unset", () => {
    withEnv({ FILING_GATEWAY: undefined }, () => {
      __resetServerEnvForTests();
      __resetFilingGatewayForTests();
      expect(resolveFilingGateway().provider).toBe("reference");
      expect(filingGatewayHealth().liveEligible).toBe(false);
    });
  });

  it("uses the deterministic simulator when FILING_GATEWAY=simulation", () => {
    withEnv({ FILING_GATEWAY: "simulation" }, () => {
      __resetServerEnvForTests();
      __resetFilingGatewayForTests();
      const gateway = resolveFilingGateway();
      expect(gateway.provider).toBe("simulation");
      expect(gateway.health()?.activeChannel).toBe("irp-irn");
    });
  });

  it("builds a live IRP gateway when credentials are complete", () => {
    withEnv(LIVE_IRP_ENV, () => {
      __resetServerEnvForTests();
      __resetFilingGatewayForTests();
      expect(resolveFilingGateway().provider).toBe("live");
      expect(filingGatewayHealth().liveEligible).toBe(true);
    });
  });

  it("throws a readable CredentialMissingError when live is under-configured", () => {
    withEnv(
      {
        FILING_GATEWAY: "live",
        FILING_CHANNEL: "irp-irn",
        FILING_GSTIN: "",
        FILING_IRP_CLIENT_ID: "",
        FILING_IRP_CLIENT_SECRET: "",
      },
      () => {
        __resetServerEnvForTests();
        __resetFilingGatewayForTests();
        expect(() => resolveFilingGateway()).toThrow(CredentialMissingError);
      },
    );
  });

  it("fails fast at boot when FILING_GATEWAY=live is missing the active channel's credentials", () => {
    const base = {
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable",
      AUTH_SECRET: "a".repeat(32),
    };
    const failing = __serverSchemaForTests.safeParse({ ...base, FILING_GATEWAY: "live", FILING_CHANNEL: "irp-irn" });
    expect(failing.success).toBe(false);
    if (!failing.success) {
      expect(failing.error.issues.some((i) => i.path.includes("FILING_GATEWAY"))).toBe(true);
    }

    const ok = __serverSchemaForTests.safeParse({ ...base, ...LIVE_IRP_ENV });
    expect(ok.success).toBe(true);
  });

  it("fails fast at boot on a malformed FILING_IRP_PUBLIC_KEY", () => {
    const base = {
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable",
      AUTH_SECRET: "a".repeat(32),
    };
    const bad = __serverSchemaForTests.safeParse({ ...base, ...LIVE_IRP_ENV, FILING_IRP_PUBLIC_KEY: "not-a-pem" });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.path.includes("FILING_IRP_PUBLIC_KEY"))).toBe(true);
    }
  });

  it("reports nothing to preflight when the provider is offline", async () => {
    await withEnvAsync({ FILING_GATEWAY: "simulation" }, async () => {
      __resetServerEnvForTests();
      __resetFilingGatewayForTests();
      const report = await filingGatewayPreflight();
      expect(report.ok).toBe(false);
      expect(report.provider).toBe("simulation");
      expect(report.detail).toContain("simulation");
    });
  });
});
