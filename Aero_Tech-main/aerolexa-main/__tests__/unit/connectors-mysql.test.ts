/**
 * mySQL connector engine — real integration tests.
 *
 * Requires a real mySQL reachable at TEST_MYSQL_URL (e.g.
 * mysql://test:test@127.0.0.1:55433/test). The suite creates and drops its own
 * scratch tables inside the target database, so it never touches user data.
 * Skips cleanly when TEST_MYSQL_URL is unset (CI without mySQL still runs the
 * rest). Run for real with: npm run test:mysql
 */
import mysql from "mysql2/promise";

import type { MySqlConfig } from "@/lib/engine/connectors/config";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import {
  fetchMySqlTableRows,
  listMySqlTables,
  mysqlTypeToColType,
  mySqlToCell,
  quoteMySqlIdent,
  testMySqlConnection,
  withMySqlClient,
} from "@/lib/engine/connectors/mysql";

const TEST_MYSQL = process.env.TEST_MYSQL_URL ?? "";

function configFromUrl(url: string): MySqlConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl: false,
  };
}

const SCHEMA = "test";

async function setupSource(): Promise<void> {
  const parsed = new URL(TEST_MYSQL);
  const conn = await mysql.createConnection({
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  });
  await conn.query(`DROP TABLE IF EXISTS ${quoteMySqlIdent(SCHEMA)}.${quoteMySqlIdent("order items")}`);
  await conn.query(`DROP TABLE IF EXISTS ${quoteMySqlIdent(SCHEMA)}.aerolexa_customers`);
  await conn.query(
    `CREATE TABLE ${quoteMySqlIdent(SCHEMA)}.aerolexa_customers (
       id INT PRIMARY KEY,
       name VARCHAR(100) NOT NULL,
       balance DECIMAL(10,2),
       active TINYINT(1),
       signed_up DATE
     )`,
  );
  await conn.query(
    `INSERT INTO ${quoteMySqlIdent(SCHEMA)}.aerolexa_customers (id, name, balance, active, signed_up) VALUES
       (1, 'Ada Lovelace', 1250.50, 1, '2023-01-15'),
       (2, 'Grace Hopper', 88.25,   0, '2023-02-20'),
       (3, 'Katherine Johnson', 4310.00, 1, '2023-03-01')`,
  );
  // Identifier-quoting safety: table name with spaces + a reserved-word column.
  await conn.query(
    `CREATE TABLE ${quoteMySqlIdent(SCHEMA)}.${quoteMySqlIdent("order items")} (id INT, \`select\` TEXT)`,
  );
  await conn.query(
    `INSERT INTO ${quoteMySqlIdent(SCHEMA)}.${quoteMySqlIdent("order items")} VALUES (1, 'widget'), (2, 'gadget')`,
  );
  await conn.end();
}

const maybe = TEST_MYSQL ? describe : describe.skip;

maybe("real mySQL connector engine", () => {
  beforeAll(async () => {
    if (TEST_MYSQL) await setupSource();
  });

  it("connects and reports a real server version", async () => {
    const meta = await testMySqlConnection(configFromUrl(TEST_MYSQL));
    expect(meta.serverVersion).toMatch(/^\d+(\.\d+)+/);
    expect(meta.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("introspects real tables and columns via information_schema", async () => {
    const tables = await withMySqlClient(configFromUrl(TEST_MYSQL), (client) =>
      listMySqlTables(client, configFromUrl(TEST_MYSQL).database),
    );
    const customers = tables.find((table) => table.schema === SCHEMA && table.name === "aerolexa_customers");
    expect(customers).toBeDefined();
    expect(customers!.columns.map((column) => column.name)).toEqual(["id", "name", "balance", "active", "signed_up"]);
    expect(customers!.columns.find((column) => column.name === "active")!.dataType).toBe("tinyint(1)");
    // Quoted identifiers: a table with spaces shows up too.
    expect(tables.some((table) => table.schema === SCHEMA && table.name === "order items")).toBe(true);
  });

  it("pulls sample rows that match the source exactly", async () => {
    const pulled = await withMySqlClient(configFromUrl(TEST_MYSQL), (client) =>
      fetchMySqlTableRows(client, SCHEMA, "aerolexa_customers", 10),
    );
    expect(pulled.totalRows).toBe(3);
    expect(pulled.rows).toHaveLength(3);
    // DECIMAL comes back as a number (decimalNumbers), DATE as an ISO string.
    expect(pulled.rows[0]).toEqual([1, "Ada Lovelace", 1250.5, true, "2023-01-15T00:00:00.000Z"]);
    // A specific sample value must match the source exactly (acceptance test).
    expect(pulled.rows[1]![1]).toBe("Grace Hopper");
    expect(pulled.rows[2]![2]).toBe(4310);
  });

  it("fetches typed rows with Ledgerly column types", async () => {
    const pulled = await withMySqlClient(configFromUrl(TEST_MYSQL), (client) =>
      fetchMySqlTableRows(client, SCHEMA, "aerolexa_customers", 100),
    );
    expect(pulled.columns.map((column) => column.name)).toEqual(["id", "name", "balance", "active", "signed_up"]);
    expect(pulled.columns.find((column) => column.name === "id")!.type).toBe("number");
    expect(pulled.columns.find((column) => column.name === "name")!.type).toBe("string");
    expect(pulled.columns.find((column) => column.name === "balance")!.type).toBe("number");
    expect(pulled.columns.find((column) => column.name === "active")!.type).toBe("boolean");
    expect(pulled.columns.find((column) => column.name === "signed_up")!.type).toBe("date");
  });

  it("coerces tinyint(1) values to real booleans", async () => {
    const pulled = await withMySqlClient(configFromUrl(TEST_MYSQL), (client) =>
      fetchMySqlTableRows(client, SCHEMA, "aerolexa_customers", 100),
    );
    expect(pulled.rows[0]![3]).toBe(true);
    expect(pulled.rows[1]![3]).toBe(false);
  });

  it("caps the import at the requested row limit", async () => {
    const pulled = await withMySqlClient(configFromUrl(TEST_MYSQL), (client) =>
      fetchMySqlTableRows(client, SCHEMA, "aerolexa_customers", 2),
    );
    expect(pulled.rows).toHaveLength(2);
    expect(pulled.truncated).toBe(true);
    expect(pulled.totalRows).toBe(3);
  });

  it("rejects invalid credentials with a clean, non-leaking error", async () => {
    const bad = { ...configFromUrl(TEST_MYSQL), password: "definitely-wrong-password-xyz" };
    let error: ConnectorError | undefined;
    try {
      await testMySqlConnection(bad);
    } catch (err) {
      error = err as ConnectorError;
    }
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error!.code).toBe("CONNECTOR_AUTH");
    expect(error!.message).toContain("How to fix");
    expect(error!.message).not.toContain("definitely-wrong-password-xyz");
  });

  it("maps an inaccessible database to a clean ConnectorError", async () => {
    // mySQL reports this either as 1049 (unknown database) or, for a user
    // without grants on the target, as 1044 (access denied) — both are honest
    // "this source is not readable" signals with a clean message.
    const missing = { ...configFromUrl(TEST_MYSQL), database: "aerolexa_does_not_exist_xyz" };
    let error: ConnectorError | undefined;
    try {
      await testMySqlConnection(missing);
    } catch (err) {
      error = err as ConnectorError;
    }
    expect(error).toBeInstanceOf(ConnectorError);
    expect(["CONNECTOR_NOT_FOUND", "CONNECTOR_PERMISSION", "CONNECTOR_ERROR"]).toContain(error!.code);
  });
});

describe("mySQL connector helpers", () => {
  it("quotes identifiers with backticks and escapes embedded backticks", () => {
    expect(quoteMySqlIdent("weird`name")).toBe("`weird``name`");
    expect(quoteMySqlIdent("order items")).toBe("`order items`");
  });

  it("maps declared types to Ledgerly ColType", () => {
    expect(mysqlTypeToColType("tinyint(1)")).toBe("boolean");
    expect(mysqlTypeToColType("int")).toBe("number");
    expect(mysqlTypeToColType("decimal")).toBe("number");
    expect(mysqlTypeToColType("double")).toBe("number");
    expect(mysqlTypeToColType("date")).toBe("date");
    expect(mysqlTypeToColType("timestamp")).toBe("date");
    expect(mysqlTypeToColType("varchar")).toBe("string");
    expect(mysqlTypeToColType("text")).toBe("string");
    expect(mysqlTypeToColType("json")).toBe("string");
  });

  it("converts cells to serializable SqlValue", () => {
    expect(mySqlToCell(null)).toBeNull();
    expect(mySqlToCell(42)).toBe(42);
    expect(mySqlToCell(true)).toBe(true);
    expect(mySqlToCell(new Date("2023-01-15T00:00:00.000Z"))).toBe("2023-01-15T00:00:00.000Z");
    expect(mySqlToCell(Buffer.from("hi"))).toBe("aGk=");
    // Big integer values stay exact as strings when they exceed Number.MAX_SAFE_INTEGER.
    expect(mySqlToCell("9007199254740993")).toBe("9007199254740993");
    expect(mySqlToCell("42")).toBe(42);
  });
});
