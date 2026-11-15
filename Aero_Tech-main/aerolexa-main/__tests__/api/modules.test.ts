/**
 * API integration tests for the extended modules (notebooks, SQL lab, model
 * training, what-if, prompts, scheduled reports, collaboration, comments).
 *
 * Runs against the scratch Next.js server on :3210 (see global-setup.cjs)
 * with a fresh SQLite database per jest invocation.
 */
import request from "supertest";

const BASE = "http://127.0.0.1:3210";
// Unique X-Forwarded-For per agent — see app.test.ts for the rationale.
const agent = () => {
  const a = request.agent(BASE);
  a.set("X-Forwarded-For", `10.7.1.${++agentSeq}`);
  return a;
};
let agentSeq = 0;

const validSignup = (email: string) => ({ name: "Tester Two", email, password: "Testpass123" });

const CSV = [
  "date,region,channel,revenue,cost",
  "2024-01-05,East,Online,1200,700",
  "2024-01-12,East,Retail,980,600",
  "2024-02-02,West,Online,1350,800",
  "2024-02-09,West,Partner,760,500",
  "2024-03-01,East,Online,1500,900",
  "2024-03-08,East,Retail,1100,650",
  "2024-04-05,West,Online,1620,950",
  "2024-04-12,West,Partner,900,550",
  "2024-05-03,East,Online,1780,1000",
  "2024-05-10,East,Retail,1240,720",
  "2024-06-07,West,Online,1900,1100",
  "2024-06-14,West,Partner,1010,640",
].join("\n");

const sumEast = 1200 + 980 + 1500 + 1100 + 1780 + 1240;
const sumWest = 1350 + 760 + 1620 + 900 + 1900 + 1010;

let userA: ReturnType<typeof agent>;

beforeAll(async () => {
  userA = agent();
});

describe("extended modules journey (owning workspace)", () => {
  const email = `modules-${Date.now()}@test.dev`;
  let projectId = "";
  let datasetId = "";
  let notebookId = "";
  let analysisId = "";
  let reportId = "";

  it("sets up the owning user, project and dataset", async () => {
    const signup = await userA.post("/api/auth/signup").send(validSignup(email));
    expect(signup.status).toBe(200);
    const onboarding = await userA
      .post("/api/onboarding")
      .send({ profileRole: "Data Scientist", goals: ["forecast"], organization: "Meridian Analytics" });
    expect(onboarding.status).toBe(200);
    projectId = onboarding.body.data.projectId;

    const upload = await userA
      .post("/api/upload")
      .field("projectId", projectId)
      .attach("file", Buffer.from(CSV, "utf8"), "revenue-2024.csv");
    expect(upload.status).toBe(200);
    datasetId = upload.body.data.datasetId;
    expect(upload.body.data.rowCount).toBe(12);
  });

  it("creates a notebook and runs a DSL cell against the dataset", async () => {
    const create = await userA.post(`/api/projects/${projectId}/notebooks`).send({ title: "Exploration", datasetId });
    expect(create.status).toBe(200);
    notebookId = create.body.data.notebook.id;

    const run = await userA.post(`/api/notebooks/${notebookId}/run`).send({ code: "%kpi revenue", cellId: notebookId }); // cell not in doc → run without persistence
    expect(run.status).toBe(200);
    expect(run.body.data.output.type).toBe("stats");
    expect(run.body.data.dataset.name).toBe("revenue-2024");

    const pyNote = await userA.post(`/api/notebooks/${notebookId}/run`).send({ code: "import pandas as pd" });
    expect(pyNote.status).toBe(200);
    expect(pyNote.body.data.output.type).toBe("note");
  });

  it("runs the read-only SQL engine with aggregation", async () => {
    const res = await userA
      .post(`/api/datasets/${datasetId}/query`)
      .send({ sql: "SELECT region, SUM(revenue) AS total FROM sales GROUP BY region ORDER BY total DESC" });
    // eslint-disable-next-line no-console
    console.error("SQL DEBUG:", JSON.stringify(res.body));
    expect(res.status).toBe(200);
    expect(res.body.data.result.rows).toEqual([
      ["East", sumEast],
      ["West", sumWest],
    ]);
    // DuckDB when the engine initializes, prototype parser as fallback.
    expect(["duckdb", "prototype-sql"]).toContain(res.body.data.result.engine);
  });

  it("rejects non-SELECT statements and unknown columns", async () => {
    const drop = await userA.post(`/api/datasets/${datasetId}/query`).send({ sql: "DROP TABLE sales" });
    expect(drop.status).toBe(400);
    expect(drop.body.ok).toBe(false);

    const unknown = await userA.post(`/api/datasets/${datasetId}/query`).send({ sql: "SELECT nope FROM sales" });
    expect(unknown.status).toBe(400);
  });

  it("materializes a query result as a new dataset", async () => {
    const res = await userA
      .post(`/api/datasets/${datasetId}/materialize`)
      .send({ sql: "SELECT region, COUNT(*) AS orders FROM sales GROUP BY region", name: "Region summary" });
    expect(res.status).toBe(200);
    expect(res.body.data.rowCount).toBe(2);
    expect(res.body.data.columnCount).toBe(2);
  });

  it("runs a what-if simulation on a numeric driver", async () => {
    const res = await userA
      .post(`/api/datasets/${datasetId}/whatif`)
      .send({ driverColumn: "cost", outcomeColumn: "revenue", pctChange: 10 });
    expect(res.status).toBe(200);
    expect(res.body.data.result.driverColumn).toBe("cost");
    expect(res.body.data.result.afterValue).toBeGreaterThan(0);
    // Either path is honest: real OLS when the fit is strong, explicit
    // hypothetical fallback when it is not. Never a generic prototype label.
    expect(res.body.data.result.confidenceNote).toMatch(/least squares|Hypothetical fallback/i);

    const invalid = await userA
      .post(`/api/datasets/${datasetId}/whatif`)
      .send({ driverColumn: "cost", outcomeColumn: "revenue" });
    expect(invalid.status).toBe(400);
  });

  it("trains models with the real engines (clustering + regression)", async () => {
    const cluster = await userA
      .post("/api/training")
      .send({ datasetId, projectId, task: "clustering", name: "Channel clusters", hyperparams: { k: 2 } });
    expect(cluster.status).toBe(200);
    expect(cluster.body.data.model.task).toBe("clustering");
    expect(cluster.body.data.model.demoNote).toMatch(/k-means/i);
    expect(cluster.body.data.model.demoNote).toMatch(/uploaded rows/i);
    expect(cluster.body.data.model.version).toBe(1);

    // Regression on revenue with cost as the feature — must fit and report R².
    const regression = await userA
      .post("/api/training")
      .send({ datasetId, projectId, task: "regression", targetColumn: "revenue", name: "Revenue driver" });
    expect(regression.status).toBe(200);
    expect(regression.body.data.model.metrics.r2).toBeGreaterThan(0.5);

    // Unknown target column → friendly 400 TRAINING_INPUT.
    const badRegression = await userA
      .post("/api/training")
      .send({ datasetId, projectId, task: "regression", targetColumn: "does-not-exist" });
    expect(badRegression.status).toBe(400);
    expect(badRegression.body.error.code).toBe("TRAINING_INPUT");
  });

  it("adds a threaded comment to an analysis", async () => {
    const analysis = await userA.post(`/api/datasets/${datasetId}/analyses`).send({ kind: "eda", config: {} });
    expect(analysis.status).toBe(200);
    analysisId = analysis.body.data.analysis.id;

    const post = await userA
      .post("/api/comments")
      .send({ targetType: "analysis", targetId: analysisId, body: "Should we look at Q2 separately?" });
    expect(post.status).toBe(200);
    const commentId = post.body.data.comment.id;

    const reply = await userA
      .post("/api/comments")
      .send({ targetType: "analysis", targetId: analysisId, body: "Yes — flagging it.", parentId: commentId });
    expect(reply.status).toBe(200);

    const list = await userA.get(`/api/comments?targetType=analysis&targetId=${analysisId}`);
    expect(list.status).toBe(200);
    expect(list.body.data.comments).toHaveLength(2);
    expect(list.body.data.comments[1]!.parentId).toBe(commentId);
  });

  it("creates prompts with detected {{variables}}", async () => {
    const res = await userA.post("/api/prompts").send({
      name: "Margin review",
      template: "Analyze {{dataset}} over {{timeframe}} and focus on {{metric}}.",
      isAdvisorTemplate: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.prompt.variables.sort()).toEqual(["dataset", "metric", "timeframe"]);
    expect(res.body.data.prompt.isAdvisorTemplate).toBe(true);

    const list = await userA.get("/api/prompts");
    expect(list.body.data.prompts.some((p: { name: string }) => p.name === "Margin review")).toBe(true);
  });

  it("schedules a report run and generates a local export", async () => {
    const report = await userA.post("/api/reports").send({ projectId, title: "Q2 board summary" });
    expect(report.status).toBe(201);
    reportId = report.body.data.report.id;

    const schedule = await userA.post("/api/scheduled-reports").send({
      name: "Monday morning brief",
      cron: "0 9 * * 1",
      reportId,
      recipients: ["exec@example.com"],
    });
    // eslint-disable-next-line no-console
    console.error("SCHEDULE DEBUG:", JSON.stringify(schedule.body));
    expect(schedule.status).toBe(200);
    expect(schedule.body.data.schedule.nextRunAt).toBeTruthy();
    const scheduleId = schedule.body.data.schedule.id;

    const run = await userA.post(`/api/scheduled-reports/${scheduleId}/run`).send({});
    expect(run.status).toBe(200);
    expect(run.body.data.status).toBe("ok");
    expect(run.body.data.outputUrl).toContain("/artifact");

    const artifact = await userA.get(`/api/scheduled-reports/${scheduleId}/artifact`);
    expect(artifact.status).toBe(200);
    expect(artifact.headers["content-type"]).toContain("text/html");
  });
});

describe("collaboration — cross-workspace role enforcement", () => {
  const emailA = `collab-a-${Date.now()}@test.dev`;
  const emailB = `collab-b-${Date.now()}@test.dev`;
  let projA = "";
  let dataA = "";
  let memberUserId = "";
  const a = agent();
  const b = agent();

  it("owner adds the second user as VIEWER", async () => {
    await a.post("/api/auth/signup").send(validSignup(emailA));
    const onboardingA = await a.post("/api/onboarding").send({ profileRole: "Data Analyst", goals: ["analyze"] });
    expect(onboardingA.status).toBe(200);
    projA = onboardingA.body.data.projectId;
    await b.post("/api/auth/signup").send(validSignup(emailB));
    await b.post("/api/onboarding").send({ profileRole: "Consultant", goals: ["decisions"] });
    const upload = await a
      .post("/api/upload")
      .field("projectId", projA)
      .attach("file", Buffer.from(CSV, "utf8"), "revenue.csv");
    dataA = upload.body.data.datasetId;

    // userB is refused before being added.
    const before = await b.get(`/api/projects/${projA}/members`);
    expect(before.status).toBe(403);

    const add = await a.post(`/api/projects/${projA}/members`).send({ email: emailB, role: "VIEWER" });
    expect(add.status).toBe(200);
    expect(add.body.data.member.role).toBe("VIEWER");
    memberUserId = add.body.data.member.userId;
  });

  it("viewer can read + comment but cannot write", async () => {
    const list = await b.get(`/api/projects/${projA}/members`);
    expect(list.status).toBe(200);
    expect(list.body.data.myRole).toBe("VIEWER");

    // own email visible, others' emails masked for non-owners
    const mine = list.body.data.members.find((m: { userId: string }) => m.userId === memberUserId);
    expect(mine.email).toBe(emailB);
    const ownerRow = list.body.data.members.find((m: { isOwner: boolean }) => m.isOwner);
    expect(ownerRow.email).toBeNull();

    const comment = await b
      .post("/api/comments")
      .send({ targetType: "dataset", targetId: dataA, body: "Noted from the viewer side." });
    expect(comment.status).toBe(200);

    // materializing a SQL result requires EDITOR
    const write = await b
      .post(`/api/datasets/${dataA}/materialize`)
      .send({ sql: "SELECT * FROM sales", name: "Viewer copy" });
    expect(write.status).toBe(403);

    // running an analysis requires EDITOR as well
    const analysis = await b.post(`/api/datasets/${dataA}/analyses`).send({ kind: "eda", config: {} });
    expect(analysis.status).toBe(403);
  });

  it("owner removes the member again", async () => {
    const remove = await a.delete(`/api/projects/${projA}/members/${memberUserId}`);
    expect(remove.status).toBe(200);
    const after = await b.get(`/api/projects/${projA}/members`);
    expect(after.status).toBe(403);
  });
});
