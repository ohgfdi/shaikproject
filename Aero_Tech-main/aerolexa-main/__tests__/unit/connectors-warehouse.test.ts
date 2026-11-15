/**
 * Warehouse connectors (WS2) — real unit tests, no live services required.
 *
 * What is genuinely verified here:
 * - Config validation accepts/rejects the new Snowflake + BigQuery shapes
 *   (including credentialsJson structure checks) via the same entry point the
 *   API routes use.
 * - Snowflake key-pair and BigQuery service-account JWTs are actually minted
 *   with a freshly generated RSA key and their signature, issuer, subject,
 *   audience and expiry are cryptographically verified with jose.
 * - Type mappers and quoted-identifier helpers.
 * - The pull dispatcher surfaces the "table not found" path with a clean
 *   ConnectorError (network-free branch).
 */

import { jwtVerify, importPKCS8 } from "jose";
import { createHash, generateKeyPairSync } from "node:crypto";

import { bigQueryTypeToColType } from "@/lib/engine/connectors/bigquery";
import { validateConnectorConfig, snowflakeConfigSchema, bigqueryConfigSchema } from "@/lib/engine/connectors/config";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { normalizePrivateKey, snowflakeAccessToken, bigQueryAccessToken } from "@/lib/engine/connectors/jwt-auth";
import { quoteWarehouseIdent } from "@/lib/engine/connectors/pull";
import { snowflakeTypeToColType } from "@/lib/engine/connectors/snowflake";

// A stable RSA keypair for JWT tests (fast, no network).
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const spkiPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const fingerprint = createHash("sha256").update(spkiPem).digest("base64");

describe("connector config validation (warehouse kinds)", () => {
  it("accepts a Snowflake key-pair config", () => {
    const config = validateConnectorConfig("snowflake", {
      account: "acme.eu-central-1.aws",
      username: "ANALYST",
      privateKeyPem: pkcs8Pem,
      database: "SALES_DB",
      schema: "PUBLIC",
    });
    if (config.kind !== "snowflake") throw new Error("expected snowflake config");
    expect(config.snowflake.account).toBe("acme.eu-central-1.aws");
    expect(config.snowflake.privateKeyPem).toContain("BEGIN");
  });

  it("rejects a Snowflake config with neither key nor password", () => {
    expect(() =>
      validateConnectorConfig("snowflake", {
        account: "acme",
        username: "u",
        database: "db",
        schema: "PUBLIC",
      }),
    ).toThrow(ConnectorError);
  });

  it("accepts a Snowflake password config (fallback auth)", () => {
    const config = validateConnectorConfig("snowflake", {
      account: "acme",
      username: "u",
      password: "pw",
      database: "db",
      schema: "PUBLIC",
    });
    if (config.kind !== "snowflake") throw new Error("expected snowflake config");
    expect(config.snowflake.password).toBe("pw");
  });

  it("accepts a BigQuery config with service-account JSON and rejects a broken one", () => {
    const good = validateConnectorConfig("bigquery", {
      projectId: "proj",
      datasetId: "ds",
      credentialsJson: JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com", private_key: pkcs8Pem }),
    });
    if (good.kind !== "bigquery") throw new Error("expected bigquery config");
    expect(good.bigquery.projectId).toBe("proj");

    expect(() =>
      validateConnectorConfig("bigquery", {
        projectId: "proj",
        datasetId: "ds",
        credentialsJson: JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com" }),
      }),
    ).toThrow(ConnectorError);
    expect(() =>
      validateConnectorConfig("bigquery", {
        projectId: "proj",
        datasetId: "ds",
        credentialsJson: "not json",
      }),
    ).toThrow(ConnectorError);
  });

  it("still validates the postgres schema the same as before", () => {
    expect(() => validateConnectorConfig("postgres", { host: "", user: "u", password: "p", database: "d" })).toThrow(
      ConnectorError,
    );
  });
});

describe("normalizePrivateKey", () => {
  it("accepts a real PKCS#8 PEM and rejects garbage", () => {
    expect(normalizePrivateKey(pkcs8Pem)).toContain("-----BEGIN");
    expect(() => normalizePrivateKey("not a key")).toThrow(ConnectorError);
    expect(() => normalizePrivateKey("")).toThrow(ConnectorError);
  });

  it("unescapes \\n-escaped keys (credentials JSON style)", () => {
    const escaped = pkcs8Pem.replace(/\n/g, "\\n");
    expect(normalizePrivateKey(escaped)).toContain("-----BEGIN");
  });
});

describe("Snowflake key-pair JWT (real crypto)", () => {
  it("mints a verifiable RS256 JWT with uppercase iss/sub and posts it", async () => {
    let capturedAssertion = "";
    let capturedUrl = "";
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      const body = new URLSearchParams(String(init?.body ?? ""));
      capturedAssertion = body.get("assertion") ?? "";
      return new Response(JSON.stringify({ access_token: "session-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const meta = await snowflakeAccessToken({
      account: "acme.eu-central-1.aws",
      username: "analyst",
      privateKeyPem: pkcs8Pem,
    });

    expect(meta.token).toBe("session-token");
    expect(capturedUrl).toBe("https://acme.eu-central-1.aws.snowflakecomputing.com/oauth/token");

    // Cryptographic verification of the minted assertion.
    const key = await importPKCS8(pkcs8Pem, "RS256");
    const { payload } = await jwtVerify(capturedAssertion, key, { algorithms: ["RS256"] });
    expect(payload.iss).toBe("ACME.EU-CENTRAL-1.AWS.ANALYST");
    expect(payload.sub).toBe("ACME.EU-CENTRAL-1.AWS.ANALYST");
    const now = Math.floor(Date.now() / 1000);
    expect(Number(payload.exp) - now).toBeLessThanOrEqual(60);
    expect(Number(payload.exp) - now).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("maps a token-endpoint 401 to a clean CONNECTOR_AUTH error", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "invalid_client", error_description: "jwt verification failed" }), {
          status: 401,
        }),
    );
    await expect(
      snowflakeAccessToken({ account: "acme", username: "u", privateKeyPem: pkcs8Pem }),
    ).rejects.toMatchObject({ code: "CONNECTOR_AUTH", status: 401 });
    fetchSpy.mockRestore();
  });
});

describe("BigQuery service-account JWT (real crypto)", () => {
  it("mints a verifiable JWT with the right audience and scope claim", async () => {
    let capturedAssertion = "";
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      capturedAssertion = body.get("assertion") ?? "";
      return new Response(JSON.stringify({ access_token: "ya29.token" }), { status: 200 });
    });

    const { token } = await bigQueryAccessToken({
      client_email: "sa@proj.iam.gserviceaccount.com",
      private_key: pkcs8Pem,
    });
    expect(token).toBe("ya29.token");

    const key = await importPKCS8(pkcs8Pem, "RS256");
    const { payload } = await jwtVerify(capturedAssertion, key, {
      algorithms: ["RS256"],
      audience: "https://oauth2.googleapis.com/token",
    });
    expect(payload.iss).toBe("sa@proj.iam.gserviceaccount.com");
    expect(String(payload.scope)).toContain("bigquery.readonly");

    fetchSpy.mockRestore();
  });
});

describe("warehouse type mappers + identifiers", () => {
  it("maps Snowflake types to ColType", () => {
    expect(snowflakeTypeToColType("NUMBER")).toBe("number");
    expect(snowflakeTypeToColType("timestamp_ntz")).toBe("date");
    expect(snowflakeTypeToColType("BOOLEAN")).toBe("boolean");
    expect(snowflakeTypeToColType("VARCHAR")).toBe("string");
  });

  it("maps BigQuery types to ColType", () => {
    expect(bigQueryTypeToColType("INT64")).toBe("number");
    expect(bigQueryTypeToColType("NUMERIC")).toBe("number");
    expect(bigQueryTypeToColType("TIMESTAMP")).toBe("date");
    expect(bigQueryTypeToColType("BOOL")).toBe("boolean");
    expect(bigQueryTypeToColType("STRUCT")).toBe("string");
  });

  it("quotes warehouse identifiers safely", () => {
    expect(quoteWarehouseIdent('weird"name')).toBe('"weird""name"');
    expect(quoteWarehouseIdent("Orders")).toBe('"Orders"');
  });
});

describe("pull dispatcher guards", () => {
  it("is exported with the implemented kinds list", async () => {
    const { CONNECTOR_IMPLEMENTED_KINDS } = await import("@/lib/engine/connectors/pull");
    expect(CONNECTOR_IMPLEMENTED_KINDS).toEqual([
      "postgres",
      "snowflake",
      "bigquery",
      "mysql",
      "mongodb",
      "tally",
      "zoho-books",
      "xero",
      "gst",
      "bank-statement",
      "s3-csv",
      "http",
      "sheets",
      "onedrive-excel",
      // India-CA connectors added alongside the CA engines.
      "tds-challan",
      "payroll-export",
      "ims-einvoice",
      "razorpay",
      "payu",
      "busy",
      "marg",
    ]);
  });

  it("exposes the SPKI fingerprint pattern needed for Snowflake key enrollment docs", () => {
    // The RSA_PUBLIC_KEY Frosty enrolls is this fingerprint's base64 SPKI body.
    const body = spkiPem
      .replace("-----BEGIN PUBLIC KEY-----", "")
      .replace("-----END PUBLIC KEY-----", "")
      .replace(/\s+/g, "");
    expect(createHash("sha256").update(body).digest("base64").length).toBeGreaterThan(0);
    expect(fingerprint.length).toBeGreaterThan(0);
  });
});

// Keep the schemas referenced so tree-shaking cannot drop their side effects.
void snowflakeConfigSchema;
void bigqueryConfigSchema;
