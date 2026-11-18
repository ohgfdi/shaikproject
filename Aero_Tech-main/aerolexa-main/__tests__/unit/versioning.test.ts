/**
 * Phase 1.5 versioning — dataset snapshot integration test against a real
 * scratch SQLite database.
 *
 * Proves the acceptance criterion for re-uploads: every dataset create/replace
 * appends an immutable DatasetVersion linked to the prior one, and the PRIOR
 * version's rows stay retrievable after the live file is overwritten.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { parseMetricNumber } from "@/lib/engine/versioning";

const SCRATCH_DB =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
const SCRATCH_DIR = "data/versioning-test";

describe("dataset versioning", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let createDatasetVersion: (typeof import("@/lib/server/versioning"))["createDatasetVersion"];
  let datasetRowsAtVersion: (typeof import("@/lib/server/versioning"))["datasetRowsAtVersion"];

  beforeAll(async () => {
    process.env.DATABASE_URL = SCRATCH_DB;
    process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "versioning-test-secret-0123456789abcdefghijklmnopqrstuv";
    process.env.DATA_DIR = SCRATCH_DIR;

    await fs.rm(path.join(process.cwd(), SCRATCH_DIR), { recursive: true, force: true });
    // Skip dropping/recreating DB file for Postgres; use existing DB instead
    // await fs.rm(path.join(process.cwd(), "data", "versioning-test"), { force: true });
    // For Postgres, just ensure the DB exists; prisma migrate will use the connection
    const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
    if (migrate.status !== 0) {
      throw new Error(`prisma migrate deploy failed: ${String(migrate.stderr).slice(-2000)}`);
    }

    ({ prisma } = await import("@/lib/db"));
    ({ createDatasetVersion, datasetRowsAtVersion } = await import("@/lib/server/versioning"));
  });

  afterAll(async () => {
    await fs.rm(path.join(process.cwd(), SCRATCH_DIR), { recursive: true, force: true });
    await fs.rm(path.join(process.cwd(), "data", "versioning-test"), { force: true });
  });

  it("appends immutable dataset versions and keeps prior rows retrievable after replace", async () => {
    const user = await prisma.user.create({
      data: { email: `ver-${Date.now()}@test.dev`, name: "Versioning Tester", passwordHash: "x" },
    });
    const workspace = await prisma.workspace.create({
      data: { name: "Versioning Workspace", user: { connect: { id: user.id } } },
    });
    const project = await prisma.project.create({
      data: { workspaceId: workspace.id, ownerId: user.id, name: "Versioning Project" },
    });
    const dataset = await prisma.dataset.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        name: "events",
        originalName: "events.csv",
        mimeType: "text/csv",
        sizeBytes: 100,
        rowCount: 2,
        columnCount: 2,
        status: "READY",
        ndjsonPath: "events.ndjson",
        profile: "{}",
        columns: JSON.stringify([
          { name: "id", type: "number" },
          { name: "name", type: "string" },
        ]),
        preview: "[]",
        qualityWarnings: "[]",
        createdById: user.id,
      },
    });

    // v1: original live file.
    const parsedDir = path.join(process.cwd(), SCRATCH_DIR, "parsed");
    await fs.mkdir(parsedDir, { recursive: true });
    await fs.writeFile(
      path.join(parsedDir, `${dataset.id}.ndjson`),
      `${JSON.stringify([1, "alpha"])}\n${JSON.stringify([2, "beta"])}\n`,
      "utf8",
    );
    const v1 = await createDatasetVersion({
      workspaceId: workspace.id,
      datasetId: dataset.id,
      label: "Initial upload",
      source: "upload",
      createdById: user.id,
    });
    expect(v1).not.toBeNull();
    expect(v1!.version).toBe(1);

    // Overwrite the live file with new contents (what a replace does).
    await fs.writeFile(
      path.join(parsedDir, `${dataset.id}.ndjson`),
      `${JSON.stringify([3, "gamma"])}\n${JSON.stringify([4, "delta"])}\n${JSON.stringify([5, "epsilon"])}\n`,
      "utf8",
    );
    const v2 = await createDatasetVersion({
      workspaceId: workspace.id,
      datasetId: dataset.id,
      label: "Re-upload · events-v2.csv",
      source: "re-upload",
      createdById: user.id,
    });
    expect(v2).not.toBeNull();
    expect(v2!.version).toBe(2);

    const chain = await prisma.datasetVersion.findMany({
      where: { datasetId: dataset.id },
      orderBy: { version: "asc" },
    });
    expect(chain).toHaveLength(2);
    expect(chain[1]!.previousVersionId).toBe(chain[0]!.id);
    expect(chain[0]!.source).toBe("upload");
    expect(chain[1]!.source).toBe("re-upload");

    // Acceptance: the prior version's data is still retrievable (not deleted),
    // while the latest version serves the new rows.
    const v1rows = await datasetRowsAtVersion(dataset.id, chain[0]!.id);
    expect(v1rows.totalRows).toBe(2);
    expect(v1rows.rows).toEqual([
      [1, "alpha"],
      [2, "beta"],
    ]);

    const v2rows = await datasetRowsAtVersion(dataset.id, chain[1]!.id);
    expect(v2rows.totalRows).toBe(3);
    expect(v2rows.rows).toEqual([
      [3, "gamma"],
      [4, "delta"],
      [5, "epsilon"],
    ]);
  });
});

describe("parseMetricNumber", () => {
  it("parses formatted metric values back to numbers", () => {
    expect(parseMetricNumber("1,234.56")).toBe(1234.56);
    expect(parseMetricNumber("$99")).toBe(99);
    expect(parseMetricNumber("12.3%")).toBe(12.3);
    expect(parseMetricNumber("1.2M")).toBe(1_200_000);
    expect(parseMetricNumber("450K")).toBe(450_000);
    expect(parseMetricNumber("-5")).toBe(-5);
    expect(parseMetricNumber("—")).toBeNull();
    expect(parseMetricNumber("n/a")).toBeNull();
    expect(parseMetricNumber("null")).toBeNull();
    expect(parseMetricNumber("")).toBeNull();
    expect(parseMetricNumber("abc")).toBeNull();
    expect(parseMetricNumber(null)).toBeNull();
    expect(parseMetricNumber(undefined)).toBeNull();
  });
});
