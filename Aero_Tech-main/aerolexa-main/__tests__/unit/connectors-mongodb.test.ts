/**
 * MongoDB connector engine — real integration tests.
 *
 * Requires a real MongoDB reachable at TEST_MONGODB_URL (e.g.
 * mongodb://127.0.0.1:55434/test). The suite creates and drops its own scratch
 * collections in the target database, so it never touches user data. Skips
 * cleanly when TEST_MONGODB_URL is unset. Run for real with:
 * npm run test:mongodb
 */
import { MongoClient, ObjectId } from "mongodb";
import os from "node:os";

import type { MongoDbConfig } from "@/lib/engine/connectors/config";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import {
  fetchMongoCollectionRows,
  friendlyMongoError,
  listMongoCollections,
  mongoValueToCell,
  testMongoDbConnection,
  withMongoClient,
} from "@/lib/engine/connectors/mongodb";

const TEST_MONGO = process.env.TEST_MONGODB_URL ?? "";

function configFromUrl(url: string): MongoDbConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 27017),
    database: parsed.pathname.replace(/^\//, ""),
    user: "",
    password: "",
    ssl: false,
  };
}

async function setupSource(): Promise<void> {
  const client = new MongoClient(TEST_MONGO, { serverSelectionTimeoutMS: 5000, runtimeAdapters: { os } });
  await client.connect();
  const db = client.db(configFromUrl(TEST_MONGO).database);
  await db
    .collection("aerolexa_customers")
    .drop()
    .catch(() => undefined);
  await db
    .collection("order items")
    .drop()
    .catch(() => undefined);
  const customers = db.collection("aerolexa_customers");
  await customers.insertMany([
    {
      name: "Ada Lovelace",
      balance: 1250.5,
      active: true,
      signed_up: new Date("2023-01-15T00:00:00.000Z"),
      profile: { title: "Analyst", tags: ["math", "code"] },
    },
    { name: "Grace Hopper", balance: 88.25, active: false, signed_up: new Date("2023-02-20T00:00:00.000Z") },
    { name: "Katherine Johnson", balance: 4310, active: true, signed_up: new Date("2023-03-01T00:00:00.000Z") },
  ]);
  await db.collection("order items").insertMany([
    { id: 1, select: "widget" },
    { id: 2, select: "gadget" },
  ]);
  await client.close();
}

const maybe = TEST_MONGO ? describe : describe.skip;

maybe("real MongoDB connector engine", () => {
  beforeAll(async () => {
    if (TEST_MONGO) await setupSource();
  });

  it("connects and reports a real server version", async () => {
    const meta = await testMongoDbConnection(configFromUrl(TEST_MONGO));
    expect(meta.serverVersion).toMatch(/^\d+(\.\d+)+/);
    expect(meta.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("lists collections as tables with sampled field columns", async () => {
    const collections = await withMongoClient(configFromUrl(TEST_MONGO), (db) => listMongoCollections(db));
    const customers = collections.find((c) => c.name === "aerolexa_customers");
    expect(customers).toBeDefined();
    expect(customers!.schema).toBe(configFromUrl(TEST_MONGO).database);
    for (const column of ["_id", "name", "balance", "active", "signed_up", "profile"]) {
      expect(customers!.columns.some((c) => c.name === column)).toBe(true);
    }
    // A collection with a space lists too.
    expect(collections.some((c) => c.name === "order items")).toBe(true);
  });

  it("fetches rows with inferred Ledgerly column types", async () => {
    const pulled = await withMongoClient(configFromUrl(TEST_MONGO), (db) =>
      fetchMongoCollectionRows(db, "aerolexa_customers", 100),
    );
    expect(pulled.totalRows).toBe(3);
    expect(pulled.rows).toHaveLength(3);
    const typeOf = (name: string) => pulled.columns.find((c) => c.name === name)?.type ?? "missing";
    expect(typeOf("_id")).toBe("string");
    expect(typeOf("name")).toBe("string");
    expect(typeOf("balance")).toBe("number");
    expect(typeOf("active")).toBe("boolean");
    expect(typeOf("signed_up")).toBe("date");
    // _id surfaces as its hex string; objects are flattened to JSON.
    const first = pulled.rows[0]!;
    const firstDoc = new Map(pulled.columns.map((c, i) => [c.name, first[i]]));
    expect(ObjectId.isValid(String(firstDoc.get("_id")))).toBe(true);
    expect(JSON.parse(String(firstDoc.get("profile")))).toEqual({ title: "Analyst", tags: ["math", "code"] });
  });

  it("caps the import at the requested row limit", async () => {
    const pulled = await withMongoClient(configFromUrl(TEST_MONGO), (db) =>
      fetchMongoCollectionRows(db, "aerolexa_customers", 2),
    );
    expect(pulled.rows).toHaveLength(2);
    expect(pulled.truncated).toBe(true);
    expect(pulled.totalRows).toBe(3);
  });

  it("maps an unreachable server to a clean ConnectorError", async () => {
    const unreachable = { ...configFromUrl(TEST_MONGO), port: 1 };
    let error: ConnectorError | undefined;
    try {
      await testMongoDbConnection(unreachable);
    } catch (err) {
      error = err as ConnectorError;
    }
    expect(error).toBeInstanceOf(ConnectorError);
    expect(["CONNECTOR_UNREACHABLE", "CONNECTOR_TIMEOUT"]).toContain(error!.code);
    expect(error!.message).toContain("How to fix");
  });
});

describe("MongoDB connector helpers", () => {
  it("converts BSON values to serializable SqlValue", () => {
    expect(mongoValueToCell(null)).toBeNull();
    expect(mongoValueToCell(undefined)).toBeNull();
    expect(mongoValueToCell(42)).toBe(42);
    expect(mongoValueToCell(true)).toBe(true);
    expect(mongoValueToCell(new Date("2023-01-15T00:00:00.000Z"))).toBe("2023-01-15T00:00:00.000Z");
    expect(mongoValueToCell(new ObjectId("65d1f2a3b4c5d6e7f8a9b0c1"))).toBe("65d1f2a3b4c5d6e7f8a9b0c1");
    expect(mongoValueToCell(Buffer.from("hi"))).toBe("aGk=");
    expect(JSON.parse(mongoValueToCell({ a: 1, b: [true, null] }) as string)).toEqual({ a: 1, b: [true, null] });
    // Big integer values stay exact when they exceed Number.MAX_SAFE_INTEGER.
    expect(mongoValueToCell(123456789012345678901234567890n)).toBe("123456789012345678901234567890");
  });

  it("maps driver errors away from leaking credentials", () => {
    const err = new Error("bad auth Authentication failed.");
    const mapped = friendlyMongoError(err);
    expect(mapped.code).toBe("CONNECTOR_AUTH");
    expect(mapped.message).toContain("How to fix");
  });
});
