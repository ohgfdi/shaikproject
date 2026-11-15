/**
 * Postgres connector engine — real integration tests.
 *
 * Requires a real PostgreSQL reachable at TEST_POSTGRES_URL (e.g.
 * postgres://user:pass@127.0.0.1:55432/db). The suite creates and drops its
 * own scratch schema, so it never touches user data. Skips cleanly when
 * TEST_POSTGRES_URL is unset (CI without Postgres still runs the rest).
 */
import { Client } from "pg";

import type { PostgresConfig } from "@/lib/engine/connectors/config";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import {
  fetchPostgresTableRows,
  listPostgresTables,
  pgTypeToColType,
  samplePostgresRows,
  testPostgresConnection,
  withPgClient,
} from "@/lib/engine/connectors/postgres";

const TEST_PG = process.env.TEST_POSTGRES_URL ?? "";

function configFromUrl(url: string): PostgresConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl: false,
  };
}

const SCHEMA = "aerolexa_test_engine";

async function setupSource(): Promise<void> {
  const client = new Client({ connectionString: TEST_PG });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(
    `CREATE TABLE ${SCHEMA}.customers (
       id integer PRIMARY KEY,
       name text NOT NULL,
       balance numeric(10,2),
       active boolean,
       signed_up date
     )`,
  );
  await client.query(
    `INSERT INTO ${SCHEMA}.customers (id, name, balance, active, signed_up) VALUES
       (1, 'Ada Lovelace', 1250.50, true,  '2023-01-15'),
       (2, 'Grace Hopper', 88.25,   false, '2023-02-20'),
       (3, 'Katherine Johnson', 4310.00, true, '2023-03-01')`,
  );
  // Identifier-quoting safety: table name with spaces + a reserved word column.
  await client.query(`CREATE TABLE ${SCHEMA}."order items" (id integer, "select" text)`);
  await client.query(`INSERT INTO ${SCHEMA}."order items" VALUES (1, 'widget'), (2, 'gadget')`);
  await client.end();
}

const maybe = TEST_PG ? describe : describe.skip;

maybe("real Postgres connector engine", () => {
  beforeAll(async () => {
    if (TEST_PG) await setupSource();
  });

  it("connects and reports a real server version", async () => {
    const meta = await testPostgresConnection(configFromUrl(TEST_PG));
    expect(meta.serverVersion).toMatch(/^\d+(\.\d+)+/);
    expect(meta.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("introspects real tables and columns via information_schema", async () => {
    const tables = await withPgClient(configFromUrl(TEST_PG), (client) => listPostgresTables(client));
    const customers = tables.find((table) => table.schema === SCHEMA && table.name === "customers");
    expect(customers).toBeDefined();
    expect(customers!.columns.map((column) => column.name)).toEqual(["id", "name", "balance", "active", "signed_up"]);
    expect(customers!.columns.find((column) => column.name === "active")!.dataType).toBe("boolean");
    // Quoted identifiers: a table with spaces shows up too.
    expect(tables.some((table) => table.schema === SCHEMA && table.name === "order items")).toBe(true);
  });

  it("pulls sample rows that match the source exactly", async () => {
    const sample = await withPgClient(configFromUrl(TEST_PG), (client) =>
      samplePostgresRows(client, SCHEMA, "customers", 10),
    );
    expect(sample.rowCount).toBe(3);
    expect(sample.rows).toHaveLength(3);
    // numeric comes back from node-postgres as a string — preserved verbatim.
    expect(sample.rows[0]).toEqual([1, "Ada Lovelace", "1250.50", true, "2023-01-15T00:00:00.000Z"]);
    // A specific sample value must match the source exactly (acceptance test).
    expect(sample.rows[1]![1]).toBe("Grace Hopper");
    expect(sample.rows[2]![2]).toBe("4310.00");
  });

  it("fetches typed rows for import with Ledgerly column types", async () => {
    const pulled = await withPgClient(configFromUrl(TEST_PG), (client) =>
      fetchPostgresTableRows(client, SCHEMA, "customers", 100),
    );
    expect(pulled.totalRows).toBe(3);
    expect(pulled.columns.map((column) => column.name)).toEqual(["id", "name", "balance", "active", "signed_up"]);
    expect(pulled.columns.find((column) => column.name === "id")!.type).toBe("number");
    expect(pulled.columns.find((column) => column.name === "name")!.type).toBe("string");
    expect(pulled.columns.find((column) => column.name === "balance")!.type).toBe("number");
    expect(pulled.columns.find((column) => column.name === "active")!.type).toBe("boolean");
    expect(pulled.columns.find((column) => column.name === "signed_up")!.type).toBe("date");
  });

  it("caps the import at the requested row limit", async () => {
    const pulled = await withPgClient(configFromUrl(TEST_PG), (client) =>
      fetchPostgresTableRows(client, SCHEMA, "customers", 2),
    );
    expect(pulled.rows).toHaveLength(2);
    expect(pulled.truncated).toBe(true);
    expect(pulled.totalRows).toBe(3);
  });

  it("rejects invalid credentials with a clean, non-leaking error", async () => {
    const bad = { ...configFromUrl(TEST_PG), password: "definitely-wrong-password-xyz" };
    let error: ConnectorError | undefined;
    try {
      await testPostgresConnection(bad);
    } catch (err) {
      error = err as ConnectorError;
    }
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error!.status).toBe(401);
    expect(error!.code).toBe("CONNECTOR_AUTH");
    expect(error!.message).toMatch(/What happened/i);
    expect(error!.message).toMatch(/How to fix/i);
    // The attempted credential must never surface in the error.
    expect(error!.message).not.toContain("definitely-wrong-password-xyz");
    expect(error!.message).not.toContain("hunter2");
  });

  it("reports a friendly error for an unreachable host", async () => {
    const unreachable = { ...configFromUrl(TEST_PG), host: "127.0.0.1", port: 55999, password: "x" };
    let error: ConnectorError | undefined;
    try {
      await testPostgresConnection(unreachable);
    } catch (err) {
      error = err as ConnectorError;
    }
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error!.status).toBe(502);
    expect(error!.code).toBe("CONNECTOR_UNREACHABLE");
    expect(error!.message).toMatch(/How to fix/i);
  });

  it("maps PostgreSQL data types to Ledgerly ColType", () => {
    expect(pgTypeToColType("integer")).toBe("number");
    expect(pgTypeToColType("numeric")).toBe("number");
    expect(pgTypeToColType("double precision")).toBe("number");
    expect(pgTypeToColType("boolean")).toBe("boolean");
    expect(pgTypeToColType("timestamp with time zone")).toBe("date");
    expect(pgTypeToColType("date")).toBe("date");
    expect(pgTypeToColType("character varying")).toBe("string");
    expect(pgTypeToColType("jsonb")).toBe("string");
    expect(pgTypeToColType("uuid")).toBe("string");
  });
});
