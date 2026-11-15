/**
 * Connector credential encryption: AES-256-GCM round-trip, tamper detection,
 * and the guarantee that ciphertext never contains the plaintext password.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "unit-test-secret-0123456789abcdefghijklmnopqrstuv";

import { decryptJson, encryptJson } from "@/lib/engine/connectors/crypto";
import { ConnectorError } from "@/lib/engine/connectors/errors";

const SECRET_CONFIG = {
  kind: "postgres",
  postgres: {
    host: "db.internal",
    port: 5432,
    database: "warehouse",
    user: "analyst",
    password: "hunter2-super-secret",
    ssl: false,
  },
};

describe("connector credential encryption", () => {
  it("round-trips a config through encrypt/decrypt", () => {
    const blob = encryptJson(SECRET_CONFIG);
    expect(decryptJson<typeof SECRET_CONFIG>(blob)).toEqual(SECRET_CONFIG);
  });

  it("never stores the password in plaintext", () => {
    const blob = encryptJson(SECRET_CONFIG);
    expect(blob).not.toContain("hunter2-super-secret");
    expect(blob).not.toContain("db.internal");
  });

  it("detects tampering and throws a friendly ConnectorError", () => {
    const blob = encryptJson(SECRET_CONFIG);
    const parts = blob.split(":");
    const flipped = Buffer.from(parts[3]!, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString("base64");
    expect(() => decryptJson(parts.join(":"))).toThrow(ConnectorError);
    expect(() => decryptJson(parts.join(":"))).toThrow(/could not be decrypted/i);
  });

  it("rejects malformed blobs", () => {
    expect(() => decryptJson("garbage")).toThrow(ConnectorError);
    expect(() => decryptJson("v9:aaaa:bbbb:cccc")).toThrow(ConnectorError);
  });
});
