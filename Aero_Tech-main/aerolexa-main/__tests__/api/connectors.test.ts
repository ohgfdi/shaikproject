/**
 * Connector API integration tests — the full request pipeline (auth → route →
 * real Postgres → Dataset materialization), no mocks.
 *
 * Requires TEST_POSTGRES_URL (a real Postgres reachable from the dev server);
 * skips cleanly when unset. The suite creates its own scratch schema and
 * drops it afterwards.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import request from "supertest";

const BASE = "http://127.0.0.1:3210";
const TEST_PG = process.env.TEST_POSTGRES_URL ?? "";
const SCHEMA = "aerolexa_test_api";
// The REAL credential — used both to connect and as the leak sentinel: if it
// ever appears in a client response, the test fails. Computed lazily so the
// module still loads cleanly when TEST_POSTGRES_URL is unset (the suite then
// skips wholesale).
function getPgPassword() {
  return decodeURIComponent(new URL(TEST_PG).password);
}

/** Every string value in a JSON response (keys excluded). */
function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) jsonStrings(item, out);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) jsonStrings(item, out);
  }
  return out;
}

const maybe = TEST_PG ? describe : describe.skip;

function pgConfig() {
  const url = new URL(TEST_PG);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: false,
  };
}

maybe("connector API (real Postgres)", () => {
  // Unique X-Forwarded-For per agent — see app.test.ts for the rationale.
  const agent = () => {
    const a = request.agent(BASE);
    a.set("X-Forwarded-For", `10.7.3.${++agentSeq}`);
    return a;
  };
  let agentSeq = 0;
  let userA: ReturnType<typeof agent>;
  let userB: ReturnType<typeof agent>;
  let connectorId = "";
  let badConnectorId = "";
  let datasetId = "";

  beforeAll(async () => {
    if (!TEST_PG) return;
    // Seed the source schema directly (the app only ever reads from it).
    const client = new Client({ connectionString: TEST_PG });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(
      `CREATE TABLE ${SCHEMA}.customers (id integer PRIMARY KEY, name text, balance numeric(10,2), active boolean)`,
    );
    await client.query(
      `INSERT INTO ${SCHEMA}.customers VALUES (1, 'Ada Lovelace', 1250.50, true), (2, 'Grace Hopper', 88.25, false), (3, 'Katherine Johnson', 4310.00, true)`,
    );
    await client.end();
  });

  beforeAll(async () => {
    userA = agent();
    userB = agent();
  });

  it("sets up two isolated workspaces", async () => {
    await userA
      .post("/api/auth/signup")
      .send({ name: "Connector A", email: `ca-${Date.now()}@test.dev`, password: "Testpass123" });
    const onboardingA = await userA.post("/api/onboarding").send({ profileRole: "Data Analyst", goals: ["analyze"] });
    expect(onboardingA.status).toBe(200);

    await userB
      .post("/api/auth/signup")
      .send({ name: "Connector B", email: `cb-${Date.now()}@test.dev`, password: "Testpass123" });
    const onboardingB = await userB.post("/api/onboarding").send({ profileRole: "Founder", goals: ["decisions"] });
    expect(onboardingB.status).toBe(200);
  });

  it("creates a per-workspace connector and runs a real connection test", async () => {
    const res = await userA.post("/api/connectors").send({
      kind: "postgres",
      name: "Warehouse (test)",
      config: pgConfig(),
    });
    expect(res.status).toBe(200);
    connectorId = res.body.data.connector.id;
    expect(connectorId).toBeTruthy();
    // Live test happened on create → status ok with a real server version recorded.
    expect(res.body.data.connector.status).toBe("ok");
    expect(res.body.data.connector.lastTestedAt).toBeTruthy();
  });

  it("never returns credentials or the config blob from any endpoint", async () => {
    const endpoints = [
      ["get", "/api/connectors"],
      ["get", `/api/connectors/${connectorId}`],
      ["post", `/api/connectors/${connectorId}/test`],
      ["get", `/api/connectors/${connectorId}/tables`],
      ["get", `/api/connectors/${connectorId}/sample?schema=${SCHEMA}&table=customers&limit=10`],
    ] as const;
    for (const [method, url] of endpoints) {
      const res = await userA[method](url as never).send({});
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      // Compare password values exactly: a real deployment can have a password
      // that is a substring of legitimate metadata (the "test" database, the
      // "Warehouse (test)" name), which a blanket substring check flags.
      expect(jsonStrings(res.body)).not.toContain(getPgPassword());
      expect(body).not.toContain(`:${getPgPassword()}@`);
      expect(body).not.toContain("encrypted");
      expect(body).not.toContain("hunter2");
      expect(body).not.toContain("config");
    }
  });

  it("validates config with a friendly Zod-style message", async () => {
    const res = await userA
      .post("/api/connectors")
      .send({ kind: "postgres", name: "Broken", config: { host: "", database: "x", user: "y", password: "z" } });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).toMatch(/How to fix/i);
  });

  it("rejects connector kinds that are not implemented", async () => {
    const res = await userA.post("/api/connectors").send({ kind: "salesforce", name: "Salesforce", config: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not implemented/i);
  });

  it("introspects the real schema (tables + columns)", async () => {
    const res = await userA.get(`/api/connectors/${connectorId}/tables`);
    expect(res.status).toBe(200);
    const table = res.body.data.tables.find(
      (t: { schema: string; name: string }) => t.schema === SCHEMA && t.name === "customers",
    );
    expect(table).toBeDefined();
    expect(table.columns.map((c: { name: string }) => c.name)).toEqual(["id", "name", "balance", "active"]);
    expect(res.body.data.source.database).toBe(pgConfig().database);
  });

  it("pulls a real sample the user can confirm before importing", async () => {
    const res = await userA.get(`/api/connectors/${connectorId}/sample?schema=${SCHEMA}&table=customers&limit=100`);
    expect(res.status).toBe(200);
    expect(res.body.data.rowCount).toBe(3);
    expect(res.body.data.rows).toHaveLength(3);
    // Sample values match the source database exactly (numeric stays a string).
    expect(res.body.data.rows[0]).toEqual([1, "Ada Lovelace", "1250.50", true]);
    expect(res.body.data.rows[1]![1]).toBe("Grace Hopper");
  });

  it("imports the table as a Dataset with exact row count and values", async () => {
    const res = await userA.post(`/api/connectors/${connectorId}/import`).send({
      schema: SCHEMA,
      table: "customers",
      name: "Customers import",
    });
    expect(res.status).toBe(200);
    datasetId = res.body.data.datasetId;
    expect(res.body.data.rowCount).toBe(3);
    expect(res.body.data.columnCount).toBe(4);

    // The Dataset flows through the normal pipeline — read it back and verify
    // row count + a sample value match the source exactly.
    const rows = await userA.get(`/api/datasets/${datasetId}/rows`);
    expect(rows.status).toBe(200);
    expect(rows.body.data.totalRows).toBe(3);
    expect(rows.body.data.rows[0]).toContain("Ada Lovelace");
    expect(rows.body.data.columns.map((c: { name: string }) => c.name)).toEqual(["id", "name", "balance", "active"]);
  });

  it("records the import as versioned sync run #1 with a change log", async () => {
    const res = await userA.get(`/api/connectors/${connectorId}/syncs`);
    expect(res.status).toBe(200);
    const runs = res.body.data.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("SUCCESS");
    expect(runs[0].rowCount).toBe(3);
    expect(runs[0].changeLog.rowsAdded).toBe(3);
    expect(runs[0].changeLog.previousRowCount).toBe(0);
  });

  it("re-syncs after the source changes: new version + diff-able change log", async () => {
    const client = new Client({ connectionString: TEST_PG });
    await client.connect();
    await client.query(`INSERT INTO ${SCHEMA}.customers VALUES (4, 'Radia Perlman', 99.99, false)`);
    await client.end();

    const sync = await userA.post(`/api/connectors/${connectorId}/sync`).send({});
    expect(sync.status).toBe(200);
    expect(sync.body.data.synced).toBe(1);
    expect(sync.body.data.failed).toBe(0);
    const outcome = sync.body.data.outcomes[0];
    expect(outcome.status).toBe("SUCCESS");
    expect(outcome.rowCount).toBe(4);
    expect(outcome.changeLog.previousRowCount).toBe(3);
    expect(outcome.changeLog.newRowCount).toBe(4);
    expect(outcome.changeLog.rowsAdded).toBe(1);
    expect(outcome.changeLog.rowsRemoved).toBe(0);

    const runs = await userA.get(`/api/connectors/${connectorId}/syncs`);
    expect(runs.body.data.runs).toHaveLength(2); // import + this sync

    const rows = await userA.get(`/api/datasets/${datasetId}/rows`);
    expect(rows.body.data.totalRows).toBe(4);
    expect(JSON.stringify(rows.body.data.rows)).toContain("Radia Perlman");
  });

  it("produces a snapshot file for the new version (prior data retrievable)", async () => {
    const runs = await userA.get(`/api/connectors/${connectorId}/syncs`);
    const latest = runs.body.data.runs[0];
    const snapshot = path.join(process.cwd(), "data", "api-test", "connector-syncs", `${latest.id}.ndjson`);
    const content = await fs.readFile(snapshot, "utf8");
    expect(content.trim().split("\n")).toHaveLength(4);
  });

  it("fails invalid credentials with a clean, non-leaking error", async () => {
    const create = await userA.post("/api/connectors").send({
      kind: "postgres",
      name: "Wrong password",
      config: { ...pgConfig(), password: "wrong-password-xyz" },
      test: false,
    });
    expect(create.status).toBe(200);
    badConnectorId = create.body.data.connector.id;
    expect(create.body.data.connector.status).toBe("untested");

    const test = await userA.post(`/api/connectors/${badConnectorId}/test`).send({});
    expect(test.status).toBe(401);
    expect(test.body.ok).toBe(false);
    expect(test.body.error.code).toBe("CONNECTOR_AUTH");
    expect(test.body.error.message).toMatch(/What happened/i);
    expect(test.body.error.message).toMatch(/How to fix/i);
    expect(test.body.error.message).not.toContain("wrong-password-xyz");

    // The failed test is recorded on the connector.
    const single = await userA.get(`/api/connectors/${badConnectorId}`);
    expect(single.body.data.connector.status).toBe("error");
    expect(single.body.data.connector.lastError).toMatch(/How to fix/i);
  });

  it("enforces workspace isolation on every connector route", async () => {
    const attempts = [
      ["get", `/api/connectors/${connectorId}`],
      ["post", `/api/connectors/${connectorId}/test`],
      ["get", `/api/connectors/${connectorId}/tables`],
      ["post", `/api/connectors/${connectorId}/import`],
      ["post", `/api/connectors/${connectorId}/sync`],
      ["delete", `/api/connectors/${connectorId}`],
    ] as const;
    for (const [method, url] of attempts) {
      const res = await userB[method](url as never).send({
        schema: SCHEMA,
        table: "customers",
        name: "stolen",
        datasetId,
      });
      expect([403, 404]).toContain(res.status);
      expect(res.body.ok).toBe(false);
    }
  });

  it("only allows deleting a connector with no imported datasets", async () => {
    // badConnectorId has no datasets → deletable.
    const deleteBad = await userA.delete(`/api/connectors/${badConnectorId}`);
    expect(deleteBad.status).toBe(200);
    expect(deleteBad.body.data.deleted).toBe(true);

    // connectorId has an imported dataset → refused with guidance.
    const deleteUsed = await userA.delete(`/api/connectors/${connectorId}`);
    expect(deleteUsed.status).toBe(400);
    expect(deleteUsed.body.error.message).toMatch(/imported datasets/i);
  });

  afterAll(async () => {
    if (!TEST_PG) return;
    try {
      const client = new Client({ connectionString: TEST_PG });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await client.end();
    } catch {
      // best-effort cleanup
    }
  });
});
