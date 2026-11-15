/**
 * CA portal submission engines — oracle tests.
 *
 * Tests the auth / sign / submit / acknowledgement flow for GST, Income Tax,
 * ROC and TDS portal filing. The tests exercise the real crypto (jose + Node
 * crypto), the real signing bundle, the real submission orchestration and the
 * real filing-window logic, with an injected (simulated) portal API so the
 * whole workflow is verified end-to-end without hitting government servers.
 *
 * The DSC certificates are fixed, pre-generated X.509 PEMs (2020–2045 for the
 * valid/no-PAN fixtures, 2010–2015 for the expired fixture) so certificate
 * parsing, PAN extraction and expiry handling are deterministic. The RSA
 * signing key is generated in-memory per run; the bundle signs a real SHA-256
 * hash and the portal API assertion checks the signature/certificate are
 * forwarded.
 */

import { createHash, generateKeyPairSync } from "node:crypto";

import {
  submitGstReturn,
  submitItReturn,
  submitRocForm,
  submitTdsStatement,
  submitToPortal,
  gstFilingWindow,
  itFilingWindow,
  rocFilingWindow,
  isTransientPortalError,
  formDisplayName,
  TokenBucket,
} from "@/lib/engine/connectors/ca-portals";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import {
  preparePortalSigning,
  validateDscCertificate,
  parseDscCertificate,
  signWithDsc,
  createDscSigningBundle,
  prepareEvcVerification,
  prepareEtMSigning,
} from "@/lib/engine/connectors/portal-auth";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** PAN-carrying, currently-valid self-signed DSC certificate (2020–2045). */
const VALID_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUdlxtMhmgzPZUTc2rk4VSHcGHsvMwDQYJKoZIhvcNAQEL
BQAwJzEYMBYGA1UECgwPUEFOOiBBQkNERTEyMzRGMQswCQYDVQQGEwJJTjAeFw0y
MDAxMDEwMDAwMDBaFw00NTAxMDEwMDAwMDBaMCcxGDAWBgNVBAoMD1BBTjogQUJD
REUxMjM0RjELMAkGA1UEBhMCSU4wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQCntOxIEpEyprElZUz+M6tMhT6jI21c6OC/nRP3uaZ3gZV5vfBAC2HfCAV/
/CSZkC96eGA+5ojlo0muE/WM8cISaLkhX42XwPfBOk8rOrhA9d8Hcspm/eAAgHJF
Kx/JgbbhO6eCrVcVQR3WiPdUzqeod7rzlzEiFWLlAPZVEo6mVU0enb9muo6vpFHy
qVi4ncEl4BwFx2wTFR1S1Ii6CAr3zbOlloZJFZHD9KLeQj8f6oEJQIiSHbEmgJTS
TeFePls29vjeTYNKn5YTras0mkNBIJCmEJHSbv/BSBtiCAwCs6wbZF+8idrXpIht
irPJPbPNhWgUV9cSeR266bmLYrJVAgMBAAGjUzBRMB0GA1UdDgQWBBRoC1X//73t
xK7qTlwLGC58NSPwwjAfBgNVHSMEGDAWgBRoC1X//73txK7qTlwLGC58NSPwwjAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBcypKsEFup4/IMAWn4
JZE/9nBLBAD0KupNwnH2ucFFT3khYczpoo6rbJTeV5iUfYEsExfjFYDJ6Wizwolw
AS/9tJm0yRBNsr9Y3PBrmUltWb+QTh/JXnb/XxCUpk2oeVh+P/GdYadzEtx7Y7OF
pjoZCJU9q3cX516dgCdrdCMuw2UssYFVLO0/r7HpHso4spIAjuBJoTKhS+uww5pE
ZyzSCkwR/+eV1esIUhr+3GRrMC8pmjmqoOKJgwleEN1I1TuGINPEj7NNsATDSXO7
vsXCnv13DH9YvJwG4Bh97GbA714kGWjajTTwtiZhGV81xTK+72tNXxjMFanaco2S
1i1r
-----END CERTIFICATE-----
`;

/** PAN-carrying DSC certificate that expired in 2015. */
const EXPIRED_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUQEGx8vIyHzAA4ISYFYkofeOsFOcwDQYJKoZIhvcNAQEL
BQAwJzEYMBYGA1UECgwPUEFOOiBBQkNERTEyMzRGMQswCQYDVQQGEwJJTjAeFw0x
MDAxMDEwMDAwMDBaFw0xNTAxMDEwMDAwMDBaMCcxGDAWBgNVBAoMD1BBTjogQUJD
REUxMjM0RjELMAkGA1UEBhMCSU4wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQDZzQWLWvP7j5/LA+bzoIuZEzDeveZ7U7f/C7jHn7bVmpmhWxgvr4+fpmci
WuU4qDDXQ61zVVsGu7tSO8x5DCC7z70+mJi5rxN687iPPWObKdCxj3M+zHse6jQh
cFgxsoo3MbH+cJHpO/lrih0K4CSLgpMzDQ6Eut3NppM9MHNLbkRYaYErR6NeKcPE
dYoiesOE+eSsJNU++uMn3SSX+8bng9Xi/MyN5kK/F/+gfuI3dzKZe+zpta4NGQxd
jasK8YLOwQArmDdO6c4mvrkT2xQ2T3ryBTZvFkN9YkTvcv1NZca0mBBSbBCq9ier
IPJqwMbtusk26kn1ukmo16cuDnipAgMBAAGjUzBRMB0GA1UdDgQWBBSnbrJE9YY4
SsqQMOMo+yjfvuOEDDAfBgNVHSMEGDAWgBSnbrJE9YY4SsqQMOMo+yjfvuOEDDAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCH4GMEO0ZRZQWXZ/q0
M1ynq4tI5S+jCQRm7WL3DxMEpAKT9KZO/KFBrIM+Jp9Ag+gKUVqJuJtsK1OT7PSL
An/l3AvmyHKJmqYuUmoNWlaBXSLdEMjH0Xg/fd76CvA6588DgfZW6CG1wet5YEh7
61vGNlbvhS0WtMh90K9nw2i8D9xX2RlHmTkBRuJ5lpGmtG0IB1p09V9enRV6UjOl
rFJb+wp1ZGbLhpHa1NO/IuThg9mycoOjYB2GBI9MvdMeqs4+D67cWCjYue6FPDud
wP6wRhi/cqrWe2gAo/li4zMuTBLM9lls0bUM3VqSfb4v5QOIYrsJ8L7jRNmlPpK2
lqxh
-----END CERTIFICATE-----
`;

/** Currently-valid DSC certificate whose subject carries no PAN. */
const NO_PAN_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDRzCCAi+gAwIBAgIUFhGGy6t4LSbXwPaj2smrmyCzCiQwDQYJKoZIhvcNAQEL
BQAwMzESMBAGA1UECgwJQWNtZSBDb3JwMRAwDgYDVQQLDAdTaWduaW5nMQswCQYD
VQQGEwJJTjAeFw0yMDAxMDEwMDAwMDBaFw00NTAxMDEwMDAwMDBaMDMxEjAQBgNV
BAoMCUFjbWUgQ29ycDEQMA4GA1UECwwHU2lnbmluZzELMAkGA1UEBhMCSU4wggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7QEF58Drwn8lL9bnP/13rbqdI
mqwnU5eSsB6bNujaFHeWPSPIzU6WjFDvZzmyOm7k3qxQ6sxLwFvigwy32ZMjuiP/
h4RrB/6kZzP8O95q7wSt/LJtjl26I9DUpOZwrDC42TzZn9wf3hha5Xw0jDFDto+Y
ZAc6NHbnBSea5IP2DA4UKd4uffgnqHc093k+fq9Q1dYZbaWo9jyKV82DdpvEXPCS
F8pb+8jd7VOzAyTfhFIhxHYMKjAzETmDm/fMJqEDeuVEJl99iJ4L+dSAR1weMLC5
S9BqXUNi7YmTmr2znWv+lYVn1fsOsLXk0coPmlv9EPqo5ANFvuH5y6YMyZMtAgMB
AAGjUzBRMB0GA1UdDgQWBBTKpfdv7BRR7vXl/QhmL6TKqqu7CjAfBgNVHSMEGDAW
gBTKpfdv7BRR7vXl/QhmL6TKqqu7CjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQB43kmQ2FOL9q00rquvB37QmRS3nH5kfkaIQTq6FkwEaNxi4rFo
qmhVAXiA0i6VXbV33mq10FZ/ZH8Yn30lp77rZXC1Xv7wqOzRoaDl4ZJz7sOugMLa
V2Wn++mKB1Zk2Raij5GYRYNRMa6O7WTbDe2XpN8Rlr288axyo1DaGpq8Y17S3+s2
85JW/eWuMBV0ccEItSHKT+T9KZFg2x2xhIS2mWOdRySfwjSGH0JeC3krJe/jVDto
AKF+KKwzKQ3yYrug62A8+Iqvcse+JwHHeVvXRsO5ySHYFSB5oCjZyNj4OwkKfz4H
/wbMYaW+3XN0Ji7HcSfBEdIC0PDrPyL5YQrN
-----END CERTIFICATE-----
`;

const PAN = "ABCDE1234F";

function makeDscKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

const dscKeys = makeDscKeyPair();

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A rate limiter that always lets a request through immediately. */
function immediateLimiter() {
  return { allow: () => true, wait: async () => {} };
}

const NO_RETRY = { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 };

/** The submission bundle handed to the injected portal API. */
interface PortalApiSubmission {
  portal: string;
  formType: string;
  taxpayerId: string;
  payload: string;
  signingMethod: string;
  signature?: string;
  certificate?: string;
}

/** Await a promise expected to reject and return the ConnectorError. */
async function captureConnectorError(promise: Promise<unknown>): Promise<ConnectorError> {
  let caught: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (err) {
    caught = err;
    rejected = true;
  }
  expect(rejected).toBe(true);
  expect(caught).toBeInstanceOf(ConnectorError);
  return caught as ConnectorError;
}

// ---------------------------------------------------------------------------
// DSC certificate parsing
// ---------------------------------------------------------------------------

describe("parseDscCertificate", () => {
  it("extracts certificate metadata including thumbprint and PAN", () => {
    const info = parseDscCertificate(VALID_CERT_PEM);
    expect(info.subjectName).toBeTruthy();
    expect(info.serial).toBeTruthy();
    expect(info.thumbprint).toMatch(/^[0-9A-F]{64}$/);
    expect(info.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(info.validTo).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(info.isExpired).toBe(false);
    expect(info.pan).toBe(PAN);
  });

  it("detects expired certificates", () => {
    expect(parseDscCertificate(EXPIRED_CERT_PEM).isExpired).toBe(true);
  });

  it("returns undefined PAN when the subject has no PAN", () => {
    const info = parseDscCertificate(NO_PAN_CERT_PEM);
    expect(info.isExpired).toBe(false);
    expect(info.pan).toBeUndefined();
  });
});

describe("validateDscCertificate", () => {
  it("accepts a valid certificate and returns its metadata", () => {
    const info = validateDscCertificate(VALID_CERT_PEM);
    expect(info.pan).toBe(PAN);
    expect(info.isExpired).toBe(false);
    expect(info.serial).toBeTruthy();
  });

  it("rejects an expired certificate with DSC_CERTIFICATE_EXPIRED", async () => {
    const err = await captureConnectorError(Promise.resolve().then(() => validateDscCertificate(EXPIRED_CERT_PEM)));
    expect(err.code).toBe("DSC_CERTIFICATE_EXPIRED");
    expect(err.message).toMatch(/expired/i);
  });

  it("rejects a certificate without PAN with DSC_CERTIFICATE_NO_PAN", async () => {
    const err = await captureConnectorError(Promise.resolve().then(() => validateDscCertificate(NO_PAN_CERT_PEM)));
    expect(err.code).toBe("DSC_CERTIFICATE_NO_PAN");
    expect(err.message).toMatch(/PAN/i);
  });
});

// ---------------------------------------------------------------------------
// signWithDsc / createDscSigningBundle
// ---------------------------------------------------------------------------

describe("signWithDsc", () => {
  it("returns a base64 signature with SHA256withRSA", async () => {
    const result = await signWithDsc("{}", dscKeys.privateKey);
    expect(result.signature).toBeTruthy();
    expect(result.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(result.algorithm).toBe("SHA256withRSA");
    expect(result.hashAlgorithm).toBe("SHA-256");
  });

  it("rejects a value with no PEM header", async () => {
    const err = await captureConnectorError(signWithDsc("{}", "not a pem key"));
    expect(err.code).toBe("DSC_KEY_INVALID");
    expect(err.message).toMatch(/PEM/i);
  });

  it("accepts a real node:crypto PKCS#8 PEM (real newlines, not \\n escapes)", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const bundle = await createDscSigningBundle({
      payload: "{}",
      privateKeyPem: privateKey,
      certificatePem: VALID_CERT_PEM,
    });
    expect(bundle.certificateSerial).toBeTruthy();
    expect(bundle.payloadHash).toBe(sha256Hex("{}"));
  });

  it("rejects a PEM-shaped but malformed key with DSC_KEY_INVALID", async () => {
    const malformed = "-----BEGIN PRIVATE KEY-----\nnot-real-base64!!\n-----END PRIVATE KEY-----";
    const err = await captureConnectorError(signWithDsc("{}", malformed));
    expect(err.code).toBe("DSC_KEY_INVALID");
  });
});

describe("createDscSigningBundle", () => {
  it("returns the full signing bundle portals expect", async () => {
    const payload = JSON.stringify({ gstin: "22AAAAA0000A1Z0", period: "2025-06" });
    const bundle = await createDscSigningBundle({
      payload,
      privateKeyPem: dscKeys.privateKey,
      certificatePem: VALID_CERT_PEM,
    });

    expect(bundle.signature).toBeTruthy();
    expect(bundle.algorithm).toBe("SHA256withRSA");
    expect(bundle.hashAlgorithm).toBe("SHA-256");
    expect(bundle.certificateThumbprint).toMatch(/^[0-9A-F]{64}$/);
    expect(bundle.certificateSerial).toBeTruthy();
    expect(bundle.payloadHash).toBe(sha256Hex(payload));
    expect(bundle.signedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(bundle.portalSubmission).toEqual({
      payload,
      signature: bundle.signature,
      certificate: VALID_CERT_PEM,
      signingMethod: "dsc",
    });
  });

  it("fails fast on an expired certificate", async () => {
    const err = await captureConnectorError(
      createDscSigningBundle({
        payload: "{}",
        privateKeyPem: dscKeys.privateKey,
        certificatePem: EXPIRED_CERT_PEM,
      }),
    );
    expect(err.code).toBe("DSC_CERTIFICATE_EXPIRED");
  });

  it("fails fast on a certificate with no PAN", async () => {
    const err = await captureConnectorError(
      createDscSigningBundle({
        payload: "{}",
        privateKeyPem: dscKeys.privateKey,
        certificatePem: NO_PAN_CERT_PEM,
      }),
    );
    expect(err.code).toBe("DSC_CERTIFICATE_NO_PAN");
  });
});

// ---------------------------------------------------------------------------
// preparePortalSigning — dsc / evc / etm
// ---------------------------------------------------------------------------

describe("preparePortalSigning", () => {
  it("builds a DSC bundle and hashes the payload", async () => {
    const payload = JSON.stringify({ form: "itr-1" });
    const bundle = await preparePortalSigning({
      formType: "itr-1",
      taxpayerId: PAN,
      payload,
      signingMethod: "dsc",
      dscPrivateKey: dscKeys.privateKey,
      dscCertificate: VALID_CERT_PEM,
    });

    expect(bundle.signingMethod).toBe("dsc");
    expect(bundle.dscBundle).toBeTruthy();
    expect(bundle.evcPreparation).toBeUndefined();
    expect(bundle.etmPreparation).toBeUndefined();
    expect(bundle.payload).toBe(payload);
    expect(bundle.payloadHash).toBe(sha256Hex(payload));
    expect(bundle.preparedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(bundle.formType).toBe("itr-1");
    expect(bundle.taxpayerId).toBe(PAN);
  });

  it("rejects DSC signing when the private key is missing", async () => {
    const err = await captureConnectorError(
      preparePortalSigning({
        formType: "itr-1",
        taxpayerId: PAN,
        payload: "{}",
        signingMethod: "dsc",
        dscCertificate: VALID_CERT_PEM,
      }),
    );
    expect(err.code).toBe("DSC_CREDENTIALS_MISSING");
  });

  it("rejects DSC signing when the certificate is missing", async () => {
    const err = await captureConnectorError(
      preparePortalSigning({
        formType: "itr-1",
        taxpayerId: PAN,
        payload: "{}",
        signingMethod: "dsc",
        dscPrivateKey: dscKeys.privateKey,
      }),
    );
    expect(err.code).toBe("DSC_CREDENTIALS_MISSING");
  });

  it("builds an EVC bundle with the requested channel", async () => {
    const payload = JSON.stringify({ form: "itr-1" });
    const bundle = await preparePortalSigning({
      formType: "itr-1",
      taxpayerId: PAN,
      payload,
      signingMethod: "evc",
      evcChannel: "bank",
      evcBankAccount: "12345678901234",
    });

    expect(bundle.signingMethod).toBe("evc");
    expect(bundle.evcPreparation?.channel).toBe("bank");
    expect(bundle.evcPreparation?.verificationMethod).toContain("1234");
    expect(bundle.dscBundle).toBeUndefined();
    expect(bundle.payloadHash).toBe(sha256Hex(payload));
  });

  it("defaults the EVC channel to bank when omitted", async () => {
    const bundle = await preparePortalSigning({
      formType: "itr-1",
      taxpayerId: PAN,
      payload: "{}",
      signingMethod: "evc",
    });
    expect(bundle.evcPreparation?.channel).toBe("bank");
  });

  it("builds an ETM bundle", async () => {
    const payload = JSON.stringify({ form: "itr-1" });
    const bundle = await preparePortalSigning({
      formType: "itr-1",
      taxpayerId: PAN,
      payload,
      signingMethod: "etm",
      etmIdentifier: "ETM-DEVICE-12345",
    });

    expect(bundle.signingMethod).toBe("etm");
    expect(bundle.etmPreparation?.method).toBe("etm");
    expect(bundle.etmPreparation?.challengeRequired).toBe(true);
    expect(bundle.payloadHash).toBe(sha256Hex(payload));
  });
});

// ---------------------------------------------------------------------------
// prepareEvcVerification / prepareEtMSigning
// ---------------------------------------------------------------------------

describe("prepareEvcVerification", () => {
  it("masks the bank account to its last four digits", () => {
    const evc = prepareEvcVerification({
      channel: "bank",
      bankAccount: "9876543210",
    });
    expect(evc.channel).toBe("bank");
    expect(evc.verificationMethod).toContain("(last 4: 3210)");
    expect(evc.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(evc.note).toMatch(/EVC/);
  });

  it("uses the registered mobile for the mobile channel", () => {
    const evc = prepareEvcVerification({
      channel: "mobile",
      mobile: "9876543210",
    });
    expect(evc.channel).toBe("mobile");
    expect(evc.verificationMethod).toContain("9876543210");
  });

  it("uses the Aadhaar last four for the aadhaar channel", () => {
    const evc = prepareEvcVerification({
      channel: "aadhaar",
      aadhaarLast4: "1234",
    });
    expect(evc.channel).toBe("aadhaar");
    expect(evc.verificationMethod).toContain("ending: 1234");
    expect(evc.note).toMatch(/Aadhaar/i);
  });
});

describe("prepareEtMSigning", () => {
  it("masks the ETM identifier and requires a challenge", () => {
    const etm = prepareEtMSigning({
      method: "etm",
      identifier: "ETM-DEVICE-12345",
    });
    expect(etm.method).toBe("etm");
    expect(etm.identifierMasked).toHaveLength("ETM-DEVICE-12345".length);
    expect(etm.identifierMasked.endsWith("2345")).toBe(true);
    expect(etm.identifierMasked.startsWith("*")).toBe(true);
    expect(etm.challengeRequired).toBe(true);
    expect(etm.note).toMatch(/ETM/);
  });

  it("masks the Aadhaar identifier for Aadhaar eSign", () => {
    const etm = prepareEtMSigning({
      method: "aadhaar-esign",
      identifier: "9876543210",
    });
    expect(etm.method).toBe("aadhaar-esign");
    expect(etm.identifierMasked).toBe("******3210");
    expect(etm.challengeRequired).toBe(true);
    expect(etm.note.toLowerCase()).toContain("otp");
  });
});

// ---------------------------------------------------------------------------
// isTransientPortalError
// ---------------------------------------------------------------------------

describe("isTransientPortalError", () => {
  it("treats portal outage / rate-limit codes as transient", () => {
    for (const code of [
      "PORTAL_UNREACHABLE",
      "PORTAL_TIMEOUT",
      "PORTAL_RATE_LIMITED",
      "PORTAL_SERVER_ERROR",
      "DSC_KEY_INVALID",
      "DSC_CERTIFICATE_EXPIRED",
    ]) {
      expect(isTransientPortalError(new ConnectorError("x", { code }))).toBe(true);
    }
  });

  it("never retries permanent (config / auth / schema) failures", () => {
    for (const code of [
      "CONNECTOR_NOT_FOUND",
      "CONNECTOR_AUTH",
      "CONNECTOR_CONFIG",
      "DSC_CERTIFICATE_NO_PAN",
      "DSC_CREDENTIALS_MISSING",
      "ROC_DSC_REQUIRED",
      "PORTAL_SIGNING_FAILED",
    ]) {
      expect(isTransientPortalError(new ConnectorError("x", { code }))).toBe(false);
    }
  });

  it("classifies plain errors by their message", () => {
    expect(isTransientPortalError(new Error("fetch failed"))).toBe(true);
    expect(isTransientPortalError(new Error("socket Timeout"))).toBe(true);
    expect(isTransientPortalError(new Error("network unreachable"))).toBe(true);
    expect(isTransientPortalError(new Error("invalid payload"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    for (const value of [null, undefined, "boom", 0, 42, {}, []]) {
      expect(isTransientPortalError(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TokenBucket (rate limiter) — deterministic via fake timers
// ---------------------------------------------------------------------------

describe("TokenBucket", () => {
  const FIXED_NOW = new Date("2026-01-15T12:00:00.000Z");

  beforeEach(() => {
    jest.useFakeTimers({ now: FIXED_NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("allows up to `capacity` requests, then blocks", () => {
    const bucket = new TokenBucket(3, 1);
    expect(bucket.allow()).toBe(true);
    expect(bucket.allow()).toBe(true);
    expect(bucket.allow()).toBe(true);
    expect(bucket.allow()).toBe(false);
  });

  it("refills tokens over time and never exceeds capacity", () => {
    const bucket = new TokenBucket(2, 1);
    expect(bucket.allow()).toBe(true);
    expect(bucket.allow()).toBe(true);
    expect(bucket.allow()).toBe(false);

    // +1 second → exactly one token available.
    jest.setSystemTime(new Date(FIXED_NOW.getTime() + 1_000));
    expect(bucket.allow()).toBe(true);
    expect(bucket.allow()).toBe(false);

    // +100 seconds → refill is capped at capacity (2), not 100.
    jest.setSystemTime(new Date(FIXED_NOW.getTime() + 100_000));
    expect(bucket.allow()).toBe(true);
    expect(bucket.allow()).toBe(true);
    expect(bucket.allow()).toBe(false);
  });

  it("wait() resolves once a token refills", async () => {
    const bucket = new TokenBucket(1, 1);
    expect(bucket.allow()).toBe(true);
    expect(bucket.allow()).toBe(false);

    const pending = bucket.wait();
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Filing windows
// ---------------------------------------------------------------------------

describe("gstFilingWindow", () => {
  const FIXED_NOW = new Date("2026-01-15T12:00:00.000Z");

  beforeEach(() => {
    jest.useFakeTimers({ now: FIXED_NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("opens on the 1st and closes on the 20th of the window month", () => {
    const window = gstFilingWindow("22AAAAA0000A1Z0", "2026-01");
    expect(window.opens).toBe("2026-03-01");
    expect(window.closes).toBe("2026-03-20");
    expect(window.isWithinWindow).toBe(false);
    expect(window.note).toContain("2026-01");
    expect(window.note).toContain("2026-03-01");
    expect(window.note).toContain("2026-03-20");
    expect(window.note).toMatch(/outside filing window/i);
  });

  it("reports a period whose window contains the current date", () => {
    const window = gstFilingWindow("22AAAAA0000A1Z0", "2025-11");
    expect(window.opens).toBe("2026-01-01");
    expect(window.closes).toBe("2026-01-20");
    expect(window.isWithinWindow).toBe(true);
    expect(window.note).toMatch(/within filing window/i);
  });
});

describe("itFilingWindow", () => {
  const FIXED_NOW = new Date("2026-01-15T12:00:00.000Z");

  beforeEach(() => {
    jest.useFakeTimers({ now: FIXED_NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("runs from April 1 to July 31 of the assessment start year", () => {
    const window = itFilingWindow(PAN, "2026-27");
    expect(window.opens).toBe("2026-04-01");
    expect(window.closes).toBe("2026-07-31");
    expect(window.isWithinWindow).toBe(false);
    expect(window.note).toContain("2026-27");
    expect(window.note).toContain("2026-04-01");
    expect(window.note).toContain("2026-07-31");
  });
});

describe("rocFilingWindow", () => {
  const FIXED_NOW = new Date("2026-01-15T12:00:00.000Z");
  const CIN = "U12345MH2020PTC123456";

  beforeEach(() => {
    jest.useFakeTimers({ now: FIXED_NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("makes AOC-4 due 30 days after the financial year end", () => {
    const window = rocFilingWindow(CIN, "aoc-4", "2026");
    expect(window.dueDate).toBe("2026-04-30");
    expect(window.lateFeePerDay).toBe(100);
    expect(window.isOverdue).toBe(false);
    expect(window.note).toContain("aoc-4");
    expect(window.note).toContain(CIN);
    expect(window.note).toContain("2026-04-30");
    expect(window.note).toMatch(/within deadline/i);
  });

  it("makes MGT-7 due 60 days after the financial year end", () => {
    expect(rocFilingWindow(CIN, "mgt-7", "2026").dueDate).toBe("2026-05-30");
  });

  it("makes DIR-3 KYC due April 30 of the following year", () => {
    expect(rocFilingWindow(CIN, "dir-3-kyc", "2026").dueDate).toBe("2027-04-30");
  });

  it("flags overdue filings with the late-fee note", () => {
    const window = rocFilingWindow(CIN, "aoc-4", "2025");
    expect(window.dueDate).toBe("2025-04-30");
    expect(window.isOverdue).toBe(true);
    expect(window.note).toMatch(/overdue by/i);
  });
});

// ---------------------------------------------------------------------------
// submitToPortal — orchestration
// ---------------------------------------------------------------------------

describe("submitToPortal", () => {
  const payload = JSON.stringify({ gstin: "22AAAAA0000A1Z0", period: "2025-06" });

  function baseInput(overrides: Record<string, unknown>) {
    return {
      portal: "gst" as const,
      formType: "gst",
      taxpayerId: "22AAAAA0000A1Z0",
      payload,
      signingMethod: "evc" as const,
      evcChannel: "bank" as const,
      evcBankAccount: "12345678901234",
      rateLimiter: immediateLimiter(),
      retryConfig: NO_RETRY,
      submitToPortalApi: async () => ({ success: true, ackNumber: "ACK-1" }),
      ...overrides,
    };
  }

  it("captures an acknowledgement and returns the completed workflow", async () => {
    const result = await submitToPortal(
      baseInput({
        submitToPortalApi: async () => ({
          success: true,
          ackNumber: "AA220626000001",
          transactionId: "TXN-1",
          status: "Accepted",
          dueDate: "2026-02-20",
        }),
      }),
    );

    expect(result.accepted).toBe(true);
    expect(result.formType).toBe("gst");
    expect(result.taxpayerId).toBe("22AAAAA0000A1Z0");
    expect(result.signingMethod).toBe("evc");
    expect(result.error).toBeUndefined();
    expect(result.acknowledgement).toMatchObject({
      ackNumber: "AA220626000001",
      status: "Accepted",
      transactionId: "TXN-1",
      dueDate: "2026-02-20",
    });
    expect(result.acknowledgement?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.signingBundle?.method).toBe("evc");
    expect(result.signingBundle?.evcChannel).toBe("bank");
    expect(result.signingBundle?.payloadHash).toBe(sha256Hex(payload));
    expect(result.metadata.portal).toBe("gst");
    expect(result.metadata.formDisplayName).toBe("GST return");
    expect(result.metadata.filingWindow.isWithinWindow).toBe(true);
    expect(result.metadata.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults the acknowledgement status to Accepted", async () => {
    const result = await submitToPortal(
      baseInput({ submitToPortalApi: async () => ({ success: true, ackNumber: "ACK-2" }) }),
    );
    expect(result.acknowledgement?.status).toBe("Accepted");
  });

  it("waits on the rate limiter before submitting", async () => {
    const wait = jest.fn(async () => {});
    await submitToPortal(baseInput({ rateLimiter: { allow: () => true, wait } }));
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("signs a DSC submission and forwards signature + certificate", async () => {
    let seen: PortalApiSubmission | undefined;

    const result = await submitToPortal(
      baseInput({
        portal: "it-return" as const,
        formType: "itr-1",
        taxpayerId: PAN,
        signingMethod: "dsc" as const,
        dscPrivateKey: dscKeys.privateKey,
        dscCertificate: VALID_CERT_PEM,
        submitToPortalApi: async (submission: PortalApiSubmission) => {
          seen = submission;
          return { success: true, ackNumber: "ITR-ACK-1" };
        },
      }),
    );

    expect(seen).toBeDefined();
    expect(seen?.portal).toBe("it-return");
    expect(seen?.signingMethod).toBe("dsc");
    expect(seen?.payload).toBe(payload);
    expect(seen?.signature).toBeTruthy();
    expect(seen?.certificate).toContain("BEGIN CERTIFICATE");
    expect(result.signingBundle?.method).toBe("dsc");
    expect(result.signingBundle?.certificateThumbprint).toMatch(/^[0-9A-F]{64}$/);
    expect(result.signingBundle?.certificateSerial).toBeTruthy();
    expect(result.signingBundle?.evcChannel).toBeUndefined();
    expect(result.metadata.formDisplayName).toBe("ITR-1 (SAHAJ)");
  });

  it("returns the portal's error details when a submission is rejected", async () => {
    const result = await submitToPortal(
      baseInput({
        submitToPortalApi: async () => ({
          success: false,
          error: {
            code: "GSTN-1001",
            message: "invalid return period",
            resubmitAllowed: true,
            correction: "correct the return period",
          },
        }),
      }),
    );

    expect(result.accepted).toBe(false);
    expect(result.acknowledgement).toBeUndefined();
    expect(result.error).toMatchObject({
      code: "GSTN-1001",
      message: "invalid return period",
      resubmitAllowed: true,
      correction: "correct the return period",
    });
    expect(result.retries?.attempts).toBe(1);
    expect(result.retries?.lastError).toBe("invalid return period");
    expect(result.signingBundle?.method).toBe("evc");
  });

  it("falls back to a PORTAL_REJECTED error when the portal gives none", async () => {
    const result = await submitToPortal(baseInput({ submitToPortalApi: async () => ({ success: false }) }));
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("PORTAL_REJECTED");
    expect(result.error?.resubmitAllowed).toBe(true);
    expect(result.error?.correction).toBeTruthy();
  });

  it("throws PORTAL_SIGNING_FAILED when DSC signing has no key material", async () => {
    const err = await captureConnectorError(
      submitToPortal(baseInput({ signingMethod: "dsc" as const, dscPrivateKey: undefined })),
    );
    expect(err.code).toBe("PORTAL_SIGNING_FAILED");
    expect(err.message).toMatch(/signing preparation failed/i);
  });

  it("retries transient failures and succeeds within the budget", async () => {
    let calls = 0;
    const result = await submitToPortal(
      baseInput({
        retryConfig: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
        submitToPortalApi: async () => {
          calls += 1;
          if (calls < 3) {
            throw new ConnectorError("portal busy", { code: "PORTAL_SERVER_ERROR" });
          }
          return { success: true, ackNumber: "ACK-RETRY" };
        },
      }),
    );

    expect(calls).toBe(3);
    expect(result.accepted).toBe(true);
    expect(result.acknowledgement?.ackNumber).toBe("ACK-RETRY");
  });

  it("records the attempt count when a retried submission is rejected", async () => {
    let calls = 0;
    const result = await submitToPortal(
      baseInput({
        retryConfig: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
        submitToPortalApi: async () => {
          calls += 1;
          if (calls < 2) {
            throw new ConnectorError("rate limited", { code: "PORTAL_RATE_LIMITED" });
          }
          return {
            success: false,
            error: { code: "GSTN-1002", message: "bad period", resubmitAllowed: false },
          };
        },
      }),
    );

    expect(calls).toBe(2);
    expect(result.accepted).toBe(false);
    expect(result.retries?.attempts).toBe(2);
    expect(result.retries?.lastError).toBe("bad period");
  });

  it("rethrows after the retry budget is exhausted", async () => {
    let calls = 0;
    const err = await captureConnectorError(
      submitToPortal(
        baseInput({
          retryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
          submitToPortalApi: async () => {
            calls += 1;
            throw new ConnectorError("timeout", { code: "PORTAL_TIMEOUT" });
          },
        }),
      ),
    );
    expect(calls).toBe(2);
    expect(err.code).toBe("PORTAL_TIMEOUT");
  });

  it("fails fast (no retry) on a permanent error", async () => {
    let calls = 0;
    const err = await captureConnectorError(
      submitToPortal(
        baseInput({
          retryConfig: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
          submitToPortalApi: async () => {
            calls += 1;
            throw new ConnectorError("auth failed", { code: "CONNECTOR_AUTH" });
          },
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(err.code).toBe("CONNECTOR_AUTH");
  });

  it("files ROC forms with a DSC-signed submission", async () => {
    const result = await submitToPortal(
      baseInput({
        portal: "roc" as const,
        formType: "aoc-4",
        taxpayerId: "U12345MH2020PTC123456",
        signingMethod: "dsc" as const,
        dscPrivateKey: dscKeys.privateKey,
        dscCertificate: VALID_CERT_PEM,
        submitToPortalApi: async () => ({ success: true, ackNumber: "MCA-ACK-1" }),
      }),
    );

    expect(result.accepted).toBe(true);
    expect(result.metadata.portal).toBe("roc");
    expect(result.metadata.formDisplayName).toBe("AOC-4 (Annual Accounts)");
    expect(result.metadata.filingWindow.opens).toBe("N/A (simulated)");
    expect(result.metadata.filingWindow.closes).toBe("N/A (simulated)");
  });
});

// ---------------------------------------------------------------------------
// Per-portal submission helpers
// ---------------------------------------------------------------------------

describe("submitGstReturn", () => {
  it("files a GST return via EVC and returns the acknowledgement", async () => {
    const result = await submitGstReturn({
      config: {
        gstin: "22AAAAA0000A1Z0",
        period: "2025-06",
        filingTypes: ["gstr-1"],
        signingMethod: "evc",
        dsc: null,
        evcBankAccount: "12345678901234",
        timeoutSeconds: 30,
        maxRetries: 0,
      },
      gstPayload: { gstin: "22AAAAA0000A1Z0", period: "2025-06", invoices: [] },
      submitToPortalApi: async () => ({ success: true, ackNumber: "GST-ACK-1" }),
    });

    expect(result.accepted).toBe(true);
    expect(result.formType).toBe("gst");
    expect(result.taxpayerId).toBe("22AAAAA0000A1Z0");
    expect(result.signingMethod).toBe("evc");
    expect(result.acknowledgement?.ackNumber).toBe("GST-ACK-1");
    expect(result.metadata.portal).toBe("gst");
    expect(result.metadata.formDisplayName).toBe("GST return");
  });

  it("fails DSC signing because no key material is stored", async () => {
    const err = await captureConnectorError(
      submitGstReturn({
        config: {
          gstin: "22AAAAA0000A1Z0",
          period: "2025-06",
          filingTypes: ["gstr-3b"],
          signingMethod: "dsc",
          dsc: { certificateSerial: "AB12CD34", thumbprint: "A".repeat(64) },
          timeoutSeconds: 30,
          maxRetries: 0,
        },
        gstPayload: {},
        submitToPortalApi: async () => ({ success: true, ackNumber: "x" }),
      }),
    );
    expect(err.code).toBe("PORTAL_SIGNING_FAILED");
  });
});

describe("submitItReturn", () => {
  it("routes an ITR form to the it-return portal", async () => {
    const result = await submitItReturn({
      config: {
        pan: PAN,
        assessmentYear: "2026-27",
        formType: "itr-1",
        signingMethod: "evc",
        dsc: null,
        evcBankAccount: "12345678901234",
        timeoutSeconds: 45,
        maxRetries: 0,
      },
      itrPayload: { pan: PAN, assessmentYear: "2026-27" },
      submitToPortalApi: async () => ({ success: true, ackNumber: "ITR-ACK" }),
    });

    expect(result.accepted).toBe(true);
    expect(result.taxpayerId).toBe(PAN);
    expect(result.metadata.portal).toBe("it-return");
    expect(result.metadata.formDisplayName).toBe("ITR-1 (SAHAJ)");
  });

  it("routes an audit report to the it-audit portal", async () => {
    const result = await submitItReturn({
      config: {
        pan: PAN,
        assessmentYear: "2026-27",
        formType: "audit-report",
        signingMethod: "evc",
        dsc: null,
        evcBankAccount: "12345678901234",
        timeoutSeconds: 45,
        maxRetries: 0,
      },
      itrPayload: {},
      submitToPortalApi: async () => ({ success: true, ackNumber: "ATR-ACK" }),
    });

    expect(result.metadata.portal).toBe("it-audit");
    expect(result.metadata.formDisplayName).toBe("Audit report");
  });
});

describe("submitTdsStatement", () => {
  it("files a TDS statement and uses the statement type as the form type", async () => {
    const result = await submitTdsStatement({
      config: {
        tan: "ABCD123456E",
        assessmentYear: "2026-27",
        statementType: "24q",
        deductorName: "Acme Pvt Ltd",
        signingMethod: "evc",
        dsc: null,
        evcBankAccount: "12345678901234",
        timeoutSeconds: 45,
        maxRetries: 0,
      },
      tdsPayload: { tan: "ABCD123456E", form: "24Q" },
      submitToPortalApi: async () => ({ success: true, ackNumber: "TDS-ACK" }),
    });

    expect(result.accepted).toBe(true);
    expect(result.formType).toBe("24q");
    expect(result.taxpayerId).toBe("ABCD123456E");
    expect(result.metadata.portal).toBe("tds");
    expect(result.metadata.formDisplayName).toBe("Form 24Q (Salary TDS)");
  });
});

describe("submitRocForm", () => {
  const cin = "U12345MH2020PTC123456";

  it("requires a DSC certificate serial", async () => {
    const err = await captureConnectorError(
      submitRocForm({
        config: {
          cin,
          formType: "aoc-4",
          dsc: { certificateSerial: "", thumbprint: "", pan: PAN },
          dscPan: PAN,
          timeoutSeconds: 60,
          maxRetries: 0,
          environment: "prod",
        },
        rocPayload: {},
        submitToPortalApi: async () => ({ success: true, ackNumber: "x" }),
      }),
    );
    expect(err.code).toBe("ROC_DSC_REQUIRED");
    expect(err.message).toMatch(/DSC/i);
  });

  it("fails DSC signing because no private key is stored", async () => {
    const err = await captureConnectorError(
      submitRocForm({
        config: {
          cin,
          formType: "mgt-7",
          dsc: { certificateSerial: "AB12CD34", thumbprint: "A".repeat(64), pan: PAN },
          dscPan: PAN,
          timeoutSeconds: 60,
          maxRetries: 0,
          environment: "evo",
        },
        rocPayload: {},
        submitToPortalApi: async () => ({ success: true, ackNumber: "x" }),
      }),
    );
    expect(err.code).toBe("PORTAL_SIGNING_FAILED");
  });
});

// ---------------------------------------------------------------------------
// formDisplayName
// ---------------------------------------------------------------------------

describe("formDisplayName", () => {
  it("maps known form types to their display names", () => {
    const cases: Record<string, string> = {
      itr: "Income-tax return",
      "itr-1": "ITR-1 (SAHAJ)",
      "itr-4": "ITR-4 (SUGAM)",
      "itr-7": "ITR-7",
      "audit-report": "Audit report",
      gst: "GST return",
      "gstr-1": "GSTR-1",
      "gstr-3b": "GSTR-3B",
      "gstr-9": "GSTR-9 (Annual Return)",
      "gstr-9c": "GSTR-9C (Reconciliation)",
      "tds-statement": "TDS statement",
      "24q": "Form 24Q (Salary TDS)",
      "26q": "Form 26Q (Non-salary TDS)",
      "27q": "Form 27Q (Non-resident TDS)",
      "27eq": "Form 27EQ (TCS)",
      "dir-3-kyc": "DIR-3 KYC",
      "aoc-4": "AOC-4 (Annual Accounts)",
      "mgt-7": "MGT-7 (Annual Return)",
      "mgt-7a": "MGT-7A (Listed Company)",
      "chg-4": "CHG-4 (Charge Registration)",
      "roc-form": "ROC form",
    };
    for (const [formType, displayName] of Object.entries(cases)) {
      expect(formDisplayName(formType)).toBe(displayName);
    }
  });

  it("returns the input unchanged for unknown form types", () => {
    expect(formDisplayName("something-custom")).toBe("something-custom");
  });
});
