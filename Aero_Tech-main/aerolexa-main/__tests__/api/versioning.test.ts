/**
 * Phase 1.5 API acceptance — full request pipeline against the real dev
 * server (booted by __tests__/api/global-setup.cjs) and a fresh scratch DB.
 *
 * Covers, end to end:
 *  - upload creates DatasetVersion v1; re-upload (replace) appends v2 with a
 *    change log, and both versions are listed (prior data not deleted);
 *  - every analysis run + re-run records an immutable AnalysisVersion, and the
 *    diff endpoint reports which metrics moved;
 *  - Export runnable code: analysis + model Python scripts download as
 *    text/x-python, notebooks download as valid nbformat-4 .ipynb JSON;
 *  - pinning an analysis / notebook to a dataset version;
 *  - cross-workspace isolation on every new data path.
 */
import request from "supertest";

const BASE = "http://127.0.0.1:3210";
// Unique X-Forwarded-For per agent — see app.test.ts for the rationale.
const agent = () => {
  const a = request.agent(BASE);
  a.set("X-Forwarded-For", `10.7.2.${++agentSeq}`);
  return a;
};
let agentSeq = 0;

const validSignup = (email: string) => ({
  name: "Versioning Tester",
  email,
  password: "Testpass123",
});

// `orders` is the numeric feature column the model trainer needs; `revenue`
// is the regression target.
const CSV_V1 = [
  "region,orders,revenue",
  "East,10,1200",
  "East,8,980",
  "West,12,1350",
  "West,6,760",
  "East,14,1500",
  "West,16,1620",
].join("\n");

const CSV_V2 = [
  "region,orders,revenue",
  "East,10,1200",
  "East,8,980",
  "West,12,1350",
  "West,6,760",
  "East,14,1500",
  "West,16,1620",
  "North,20,2100",
  "South,9,880",
].join("\n");

let userA: ReturnType<typeof agent>;
let userB: ReturnType<typeof agent>;

beforeAll(async () => {
  userA = agent();
  userB = agent();
});

describe("dataset versioning: upload → replace → diff-able history", () => {
  const email = `ver-${Date.now()}@test.dev`;
  let projectId: string;
  let datasetId: string;

  it("signs up, completes onboarding and uploads a CSV (v1)", async () => {
    const signup = await userA.post("/api/auth/signup").send(validSignup(email));
    expect(signup.status).toBe(200);
    const onboard = await userA
      .post("/api/onboarding")
      .send({ profileRole: "Data Analyst", goals: ["analyze"], organization: "Acme GmbH" });
    expect(onboard.status).toBe(200);
    projectId = onboard.body.data.projectId;

    const upload = await userA
      .post("/api/upload")
      .field("projectId", projectId)
      .attach("file", Buffer.from(CSV_V1, "utf8"), "revenue-v1.csv");
    expect(upload.status).toBe(200);
    datasetId = upload.body.data.datasetId;
  });

  it("records the initial upload as dataset version 1", async () => {
    const res = await userA.get(`/api/datasets/${datasetId}/versions`);
    expect(res.status).toBe(200);
    expect(res.body.data.currentVersion.version).toBe(1);
    expect(res.body.data.versions).toHaveLength(1);
    expect(res.body.data.versions[0].source).toBe("upload");
    expect(res.body.data.versions[0].rowCount).toBe(6);
  });

  it("re-uploading appends version 2 with a change log — no overwrite", async () => {
    const res = await userA
      .post(`/api/datasets/${datasetId}/replace`)
      .attach("file", Buffer.from(CSV_V2, "utf8"), "revenue-v2.csv");
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.changeLog.rowsAdded).toBe(2);
    expect(res.body.data.changeLog.rowsRemoved).toBe(0);

    const versions = await userA.get(`/api/datasets/${datasetId}/versions`);
    expect(versions.body.data.versions).toHaveLength(2);
    const v2 = versions.body.data.versions.find((v: { version: number }) => v.version === 2);
    expect(v2.source).toBe("re-upload");
    expect(v2.changeLog.rowsAdded).toBe(2);
    expect(v2.previousVersionId).toBe(versions.body.data.versions.find((v: { version: number }) => v.version === 1).id);
    expect(versions.body.data.currentVersion.version).toBe(2);
  });

  it("serves a pinned dataset version's rows through the rows endpoint", async () => {
    const versions = await userA.get(`/api/datasets/${datasetId}/versions`);
    const v1 = versions.body.data.versions.find((v: { version: number }) => v.version === 1);

    const pinned = await userA.get(`/api/datasets/${datasetId}/rows?version=${v1.id}`);
    expect(pinned.status).toBe(200);
    expect(pinned.body.data.versionId).toBe(v1.id);
    expect(pinned.body.data.totalRows).toBe(6); // v1 row count, not the live 8

    const live = await userA.get(`/api/datasets/${datasetId}/rows`);
    expect(live.body.data.totalRows).toBe(8);

    // A version from another dataset must 404.
    const other = await userA
      .post("/api/upload")
      .field("projectId", projectId)
      .attach("file", Buffer.from("a,b\n1,2\n", "utf8"), "other.csv");
    const otherVersions = await userA.get(`/api/datasets/${other.body.data.datasetId}/versions`);
    const foreign = await userA.get(
      `/api/datasets/${datasetId}/rows?version=${otherVersions.body.data.versions[0].id}`,
    );
    expect(foreign.status).toBe(404);
  });

  it("versions analyses on every run and re-run, and diffs them", async () => {
    const first = await userA.post(`/api/datasets/${datasetId}/analyses`).send({ kind: "eda", config: {} });
    expect(first.status).toBe(200);
    const analysisId = first.body.data.analysis.id;
    expect(first.body.data.version).toBe(1);

    const second = await userA
      .post(`/api/datasets/${datasetId}/analyses`)
      .send({ kind: "eda", config: {}, analysisId });
    expect(second.status).toBe(200);
    expect(second.body.data.version).toBe(2);

    const versions = await userA.get(`/api/analyses/${analysisId}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.data.versions).toHaveLength(2);
    expect(versions.body.data.versions[0].version).toBe(2);

    const [v2, v1] = versions.body.data.versions;
    const diff = await userA.get(`/api/analyses/${analysisId}/diff?from=${v1.id}&to=${v2.id}`);
    expect(diff.status).toBe(200);
    expect(diff.body.data.from.version).toBe(1);
    expect(diff.body.data.to.version).toBe(2);
    expect(Array.isArray(diff.body.data.changed)).toBe(true);
    for (const row of diff.body.data.changed) {
      expect(typeof row.metric).toBe("string");
      expect(typeof row.delta).toBe("number");
      expect("deltaPct" in row).toBe(true);
    }
  });

  it("downloads runnable Python for an analysis version", async () => {
    const first = await userA
      .post(`/api/datasets/${datasetId}/analyses`)
      .send({ kind: "kpi", config: { metric: "revenue" } });
    const analysisId = first.body.data.analysis.id;

    const res = await userA.get(`/api/analyses/${analysisId}/export-python`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/x-python");
    expect(res.text).toContain("Ledgerly analysis export");
    expect(res.text).toContain("RESULT:");
  });

  it("pins an analysis to a specific dataset version", async () => {
    const versions = await userA.get(`/api/datasets/${datasetId}/versions`);
    const v1 = versions.body.data.versions.find((v: { version: number }) => v.version === 1);

    const res = await userA
      .post(`/api/datasets/${datasetId}/analyses`)
      .send({ kind: "eda", config: {}, datasetVersionId: v1.id });
    expect(res.status).toBe(200);

    const list = await userA.get(`/api/analyses/${res.body.data.analysis.id}/versions`);
    expect(list.body.data.versions[0].datasetVersion.version).toBe(1);

    // A version belonging to another dataset must be rejected.
    const bad = await userA
      .post(`/api/datasets/${datasetId}/analyses`)
      .send({ kind: "eda", config: {}, datasetVersionId: "does-not-exist" });
    // A malformed/foreign version pin is a client error (400 VERSION_MISMATCH
    // with a what-happened/how-to-fix message) — surfaced loudly, never silent.
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VERSION_MISMATCH");
  });

  it("downloads runnable Python for a trained model", async () => {
    // The trainer requires a minimum sample size — use a dedicated, larger
    // dataset for the model path.
    const bigCsv = [
      "region,orders,revenue",
      ...Array.from({ length: 40 }, (_, i) => `R${i % 4},${5 + (i % 9)},${1000 + i * 37}`),
    ].join("\n");
    const upload = await userA
      .post("/api/upload")
      .field("projectId", projectId)
      .attach("file", Buffer.from(bigCsv, "utf8"), "big.csv");
    expect(upload.status).toBe(200);
    const trainDatasetId = upload.body.data.datasetId;

    const train = await userA.post("/api/training").send({
      datasetId: trainDatasetId,
      projectId,
      task: "regression",
      name: "revenue-reg",
      targetColumn: "revenue",
      algorithm: "linear-regression",
      testRatio: 0.2,
      cvFolds: 0,
    });
    if (train.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("TRAIN FAILED:", JSON.stringify(train.body));
    }
    expect(train.status).toBe(200);
    const modelId = train.body.data.model.id;

    const res = await userA.get(`/api/models/${modelId}/export-python`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/x-python");
    expect(res.text).toContain("Ledgerly model export");
    expect(res.text).toContain("RESULT:");
  });

  it("exports notebooks as valid nbformat-4 .ipynb and supports pinning", async () => {
    const created = await userA.post(`/api/projects/${projectId}/notebooks`).send({ datasetId });
    expect(created.status).toBe(200);
    const notebookId = created.body.data.notebook.id;

    const exported = await userA.get(`/api/notebooks/${notebookId}/export.ipynb`);
    expect(exported.status).toBe(200);
    expect(exported.headers["content-type"]).toContain("json");
    const doc = JSON.parse(exported.text);
    expect(doc.nbformat).toBe(4);
    expect(Array.isArray(doc.cells)).toBe(true);

    // Pin the notebook to dataset version 1.
    const versions = await userA.get(`/api/datasets/${datasetId}/versions`);
    const v1 = versions.body.data.versions.find((v: { version: number }) => v.version === 1);
    const pinned = await userA.patch(`/api/notebooks/${notebookId}`).send({ datasetVersionId: v1.id, cells: [] });
    expect(pinned.status).toBe(200);

    const doc2 = await userA.get(`/api/notebooks/${notebookId}`);
    expect(doc2.body.data.notebook.datasetVersionId).toBe(v1.id);
  });
});

describe("cross-workspace isolation on versioning/export paths", () => {
  it("blocks another workspace from reading versions, rows, diffs or exports", async () => {
    const emailB = `ver-b-${Date.now()}@test.dev`;
    await userB.post("/api/auth/signup").send(validSignup(emailB));
    const onboard = await userB.post("/api/onboarding").send({ profileRole: "Founder", goals: ["decisions"] });
    expect(onboard.status).toBe(200);

    // Workspace A: fresh owner (userA already onboarded in the earlier suite),
    // its own project + dataset + analysis.
    const owner = agent();
    await owner.post("/api/auth/signup").send(validSignup(`ver-owner-${Date.now()}@test.dev`));
    const projectA = await owner
      .post("/api/onboarding")
      .send({ profileRole: "Data Analyst", goals: ["analyze"], organization: "Acme" });
    const projectIdA = projectA.body.data.projectId;
    const uploadA = await owner
      .post("/api/upload")
      .field("projectId", projectIdA)
      .attach("file", Buffer.from(CSV_V1, "utf8"), "a.csv");
    const datasetIdA = uploadA.body.data.datasetId;
    const analysisA = await owner.post(`/api/datasets/${datasetIdA}/analyses`).send({ kind: "eda", config: {} });
    const analysisIdA = analysisA.body.data.analysis.id;

    // User B (different workspace) must be denied on every new data path.
    expect((await userB.get(`/api/datasets/${datasetIdA}/versions`)).status).toBe(403);
    expect((await userB.get(`/api/datasets/${datasetIdA}/rows?version=x`)).status).toBe(403);
    expect((await userB.get(`/api/analyses/${analysisIdA}/versions`)).status).toBe(403);
    expect((await userB.get(`/api/analyses/${analysisIdA}/diff?from=a&to=b`)).status).toBe(403);
    expect((await userB.get(`/api/analyses/${analysisIdA}/export-python`)).status).toBe(403);

    // And a foreign dataset version cannot be pinned onto an analysis.
    const otherDs = await owner
      .post("/api/upload")
      .field("projectId", projectIdA)
      .attach("file", Buffer.from("a,b\n1,2\n", "utf8"), "other.csv");
    const otherVersions = await owner.get(`/api/datasets/${otherDs.body.data.datasetId}/versions`);
    const otherVersionId = otherVersions.body.data.versions[0].id;
    const badPin = await owner
      .post(`/api/datasets/${datasetIdA}/analyses`)
      .send({ kind: "eda", config: {}, datasetVersionId: otherVersionId });
    // A version from another dataset must be refused as a client error —
    // rejected loudly, never silently ignored.
    expect(badPin.status).toBe(400);
    expect(badPin.body.error.code).toBe("VERSION_MISMATCH");
  });
});
