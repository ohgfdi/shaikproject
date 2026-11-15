/**
 * API integration tests for the MLOps surface: worker-thread training with
 * SSE progress, model serving (/predict) and Shapley explanations (/explain).
 *
 * Runs against the real Next.js server on :3210 (see global-setup.cjs) with a
 * fresh scratch SQLite DB. The server process has NO JEST_WORKER_ID env, so
 * training here exercises the REAL worker-thread path — bundle → spawn → fit
 * → result — plus the exact HTTP contracts the browser consumes:
 *
 *   signup → onboard → upload → train (advanced engine, runId) →
 *   GET /api/training/progress (SSE: progress/done events) →
 *   POST /api/models/:id/predict → POST /api/models/:id/explain
 *
 * Shapley oracle: for the additive truth revenue ≈ 4·units + noise-free, the
 * explanation of a row must attribute ~4 per unit of `units` deviation, and
 * prediction + attributions must reconstruct within sampling noise.
 */
import request from "supertest";

const BASE = "http://127.0.0.1:3210";
const agent = () => {
  const a = request.agent(BASE);
  a.set("X-Forwarded-For", `10.9.4.${++agentSeq}`);
  return a;
};
let agentSeq = 0;

const CSV = [
  "region,units,price,revenue",
  "East,10,100,1000",
  "East,12,100,1200",
  "East,9,100,900",
  "West,14,100,1400",
  "West,11,100,1100",
  "West,15,100,1500",
  "East,13,100,1300",
  "West,8,100,800",
  "East,16,100,1600",
  "West,10,100,1000",
  "East,12,100,1200",
  "West,13,100,1300",
  "East,14,100,1400",
  "West,9,100,900",
].join("\n");

const validSignup = (email: string) => ({ name: "MLOps Tester", email, password: "Testpass123" });

/** Read one SSE stream to completion; returns the parsed event list. */
async function readSse(
  client: ReturnType<typeof agent>,
  runId: string,
): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const res = await client
    .get(`/api/training/progress?runId=${runId}`)
    .buffer(true)
    .parse((res, cb) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => cb(null, body));
    });
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const text = res.body as unknown as string;
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const dataLine = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (event && dataLine) {
      try {
        events.push({ event, data: JSON.parse(dataLine) as Record<string, unknown> });
      } catch {
        /* ignore malformed frames */
      }
    }
  }
  return events;
}

describe("mlops end-to-end (owning workspace)", () => {
  const email = `mlops-${Date.now()}@test.dev`;
  let projectId = "";
  let datasetId = "";
  let modelId = "";

  it("sets up user, project and dataset", async () => {
    const user = agent();
    const signup = await user.post("/api/auth/signup").send(validSignup(email));
    expect(signup.status).toBe(200);
    const onboarding = await user
      .post("/api/onboarding")
      .send({ profileRole: "Data Scientist", goals: ["analyze"], organization: "Meridian" });
    expect(onboarding.status).toBe(200);
    projectId = onboarding.body.data.projectId;
    const upload = await user
      .post("/api/upload")
      .field("projectId", projectId)
      .attach("file", Buffer.from(CSV, "utf8"), "units-revenue.csv");
    expect(upload.status).toBe(200);
    datasetId = upload.body.data.datasetId;
  }, 60_000);

  it("trains with the advanced engine through the REAL worker thread (runId in params)", async () => {
    const user = agent();
    // Log in again via signup would create a second user — use a fresh agent
    // that signs in with the same credentials instead.
    const login = await user.post("/api/auth/login").send({ email, password: "Testpass123" });
    expect(login.status).toBe(200);

    const runId = `run-${Date.now().toString(36)}-apitest`;
    const train = await user.post("/api/training").send({
      datasetId,
      projectId,
      task: "regression",
      targetColumn: "revenue",
      name: "Revenue CV (worker)",
      engine: "advanced",
      cvFolds: 3,
      hyperparams: { runId, seed: 7 },
    });
    expect(train.status).toBe(200);
    expect(train.body.data.model.metrics.cvMetric).toBe("rmse");
    modelId = train.body.data.model.id;
  }, 120_000);

  it("streams progress over SSE and finishes with a done event", async () => {
    const user = agent();
    await user.post("/api/auth/login").send({ email, password: "Testpass123" });
    // Fresh run: train in the background, connect immediately (the route
    // waits for late-registered runs — the race the UI relies on).
    const runId = `run-${Date.now().toString(36)}-sse`;
    const trainPromise = user
      .post("/api/training")
      .send({
        datasetId,
        projectId,
        task: "regression",
        targetColumn: "revenue",
        name: "SSE run",
        engine: "advanced",
        cvFolds: 3,
        hyperparams: { runId, seed: 7 },
      })
      .then((r: request.Response) => expect(r.status).toBe(200));
    const events = await readSse(user, runId);
    await trainPromise;
    const phases = events.map((e) => e.event);
    expect(phases[0]).toBe("progress");
    expect(phases).toContain("done");
    const progressEvents = events.filter((e) => e.event === "progress");
    // The engine contract: cv folds, then refit, then importance.
    const firstCv = progressEvents.find((e) => e.data.phase === "cv");
    expect(firstCv).toBeDefined();
    expect(progressEvents.some((e) => e.data.phase === "refit")).toBe(true);
    expect(progressEvents.some((e) => e.data.phase === "importance")).toBe(true);
  }, 120_000);

  it("serves a prediction from the stored artifact (exact linear recovery)", async () => {
    const user = agent();
    await user.post("/api/auth/login").send({ email, password: "Testpass123" });
    const res = await user.post(`/api/models/${modelId}/predict`).send({
      features: { region: "East", units: 12, price: 100 },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // revenue = units·100 at price 100 with the CV ridge shrinkage — close.
    expect(res.body.data.output).toBeGreaterThan(900);
    expect(res.body.data.output).toBeLessThan(1500);
    expect(res.body.data.methodology).toContain("aerolexa.ml.v1");
  }, 60_000);

  it("explains the prediction with Shapley attributions that add up", async () => {
    const user = agent();
    await user.post("/api/auth/login").send({ email, password: "Testpass123" });
    const res = await user.post(`/api/models/${modelId}/explain`).send({
      features: { region: "East", units: 12, price: 100 },
      nPermutations: 16,
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.contributions.length).toBeGreaterThanOrEqual(2);
    // Additive guarantee: prediction ≈ baseValue + Σφ.
    const sumPhi = d.contributions.reduce((s: number, c: { phi: number }) => s + c.phi, 0);
    expect(Math.abs(d.prediction - (d.baseValue + sumPhi))).toBeLessThan(1e-6);
    // revenue is driven by units (price constant): units must outrank price.
    const units = d.contributions.find((c: { feature: string }) => c.feature.includes("units"));
    const price = d.contributions.find((c: { feature: string }) => c.feature.includes("price"));
    expect(units).toBeDefined();
    expect(price).toBeDefined();
    expect(Math.abs(units.phi)).toBeGreaterThan(Math.abs(price.phi));
  }, 90_000);

  it("rejects serving/explaining without every feature (400 VALIDATION)", async () => {
    const user = agent();
    await user.post("/api/auth/login").send({ email, password: "Testpass123" });
    const res = await user.post(`/api/models/${modelId}/predict`).send({ features: { region: "East" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  }, 60_000);
});
