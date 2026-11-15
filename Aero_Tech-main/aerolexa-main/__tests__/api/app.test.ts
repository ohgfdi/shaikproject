/**
 * API integration tests — full request pipeline, no mocks.
 *
 * These run against a real Next.js dev server booted by __tests__/api/
 * global-setup.cjs on port 3210 with a fresh scratch SQLite database.
 */
import request from "supertest";

const BASE = "http://127.0.0.1:3210";
const agent = () => {
  // Unique X-Forwarded-For per agent: the rate limiter keys by client IP, and
  // the full journey exceeds the per-IP signup budget (10/hour) from one
  // address. Distinct IPs model distinct clients and keep limits deterministic.
  const a = request.agent(BASE);
  a.set("X-Forwarded-For", `10.7.0.${++agentSeq}`);
  return a;
};
let agentSeq = 0;

const validSignup = (email: string) => ({
  name: "Tester One",
  email,
  password: "Testpass123",
});

const CSV = [
  "date,region,channel,revenue",
  "2024-01-05,East,Online,1200",
  "2024-01-12,East,Retail,980",
  "2024-02-02,West,Online,1350",
  "2024-02-09,West,Partner,760",
  "2024-03-01,East,Online,1500",
  "2024-03-08,East,Retail,1100",
  "2024-04-05,West,Online,1620",
  "2024-04-12,West,Partner,900",
  "2024-05-03,East,Online,1780",
  "2024-05-10,East,Retail,1240",
  "2024-06-07,West,Online,1900",
  "2024-06-14,West,Partner,1010",
].join("\n");

let userA: ReturnType<typeof agent>;
let userB: ReturnType<typeof agent>;

beforeAll(async () => {
  userA = agent();
  userB = agent();
});

describe("auth", () => {
  it("rejects a weak password with 400", async () => {
    const res = await userA
      .post("/api/auth/signup")
      .send({ name: "X", email: `weak-${Date.now()}@test.dev`, password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBeDefined();
  });

  it("rejects duplicate signups", async () => {
    const email = `dup-${Date.now()}@test.dev`;
    const first = await userA.post("/api/auth/signup").send(validSignup(email));
    expect(first.status).toBe(200);
    const second = await userA.post("/api/auth/signup").send(validSignup(email));
    expect(second.status).toBe(409);
    expect(second.body.ok).toBe(false);
  });

  it("returns 401 for protected endpoints when anonymous", async () => {
    const res = await request(BASE).patch("/api/workspace").send({ name: "nope" });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

describe("full journey: signup → upload → analysis", () => {
  const email = `journey-${Date.now()}@test.dev`;
  let projectId: string;
  let datasetId: string;
  let analysisId: string;

  it("signs up and lands with a session cookie", async () => {
    const res = await userA.post("/api/auth/signup").send(validSignup(email));
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(email);
    const cookies = (res.headers["set-cookie"] ?? []) as string[];
    // Signup WRITES the current brand key (lib/auth/session.ts → brandKey);
    // the pre-rename key is read-only fallback, never written (see lib/brand.ts).
    expect(cookies.some((c) => c.includes("ledgerly.session"))).toBe(true);
  });

  it("completes onboarding and receives a project", async () => {
    const res = await userA
      .post("/api/onboarding")
      .send({ profileRole: "Data Analyst", goals: ["analyze", "reports"], organization: "Northwind GmbH" });
    expect(res.status).toBe(200);
    expect(res.body.data.projectId).toBeTruthy();
    projectId = res.body.data.projectId;
  });

  it("uploads a CSV dataset with profile data", async () => {
    const res = await userA
      .post("/api/upload")
      .field("projectId", projectId)
      .attach("file", Buffer.from(CSV, "utf8"), "revenue-2024.csv");
    expect(res.status).toBe(200);
    expect(res.body.data.datasetId).toBeTruthy();
    expect(res.body.data.rowCount).toBe(12);
    datasetId = res.body.data.datasetId;
  });

  it("rejects an unsupported file type", async () => {
    const res = await userA
      .post("/api/upload")
      .field("projectId", projectId)
      .attach("file", Buffer.from("not a csv", "utf8"), "notes.txt");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FILE_INVALID");
  });

  it("runs an EDA analysis and the result renders on the detail page", async () => {
    const startPost = Date.now();
    const res = await userA.post(`/api/datasets/${datasetId}/analyses`).send({ kind: "eda", config: {} });
    console.log(`POST /api/datasets/${datasetId}/analyses took ${Date.now() - startPost}ms`);
    expect(res.status).toBe(200);
    expect(res.body.data.analysis.id).toBeTruthy();
    analysisId = res.body.data.analysis.id;

    // Detail views are server-rendered (no GET JSON API) — assert the SSR page
    // renders the computed result for the owning workspace.
    const startGet = Date.now();
    const detail = await userA.get(`/analyses/${analysisId}`);
    console.log(`GET /analyses/${analysisId} took ${Date.now() - startGet}ms`);
    if (detail.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("analysis detail status", detail.status, detail.text.slice(0, 1500));
    }
    expect(detail.status).toBe(200);
    expect(detail.text).toContain("Exploratory data analysis");
    expect(detail.text).toContain("revenue-2024");
  }, 60_000);

  it("blocks cross-workspace access (RLS equivalent)", async () => {
    const secondEmail = `other-${Date.now()}@test.dev`;
    await userB.post("/api/auth/signup").send(validSignup(secondEmail));
    await userB.post("/api/onboarding").send({ profileRole: "Founder", goals: ["decisions"] });

    // Running an analysis on another workspace's dataset must not be possible.
    const stolen = await userB.post(`/api/datasets/${datasetId}/analyses`).send({ kind: "eda", config: {} });
    expect(stolen.status).toBe(403); // exists but belongs to another workspace
    expect(stolen.body.ok).toBe(false);

    // Nor may they view the analysis page. The server component calls
    // notFound() on a foreign workspace and renders the not-found page, so the
    // analysis result must never leak. NOTE: under `next dev` (this harness)
    // Next.js streams the app-shell segment with status 200 before the page's
    // notFound() resolves (known next 14 dev-mode bug; vercel/next.js#49343);
    // a production build returns a true 404. Assert the security invariant
    // that holds in both modes: no analysis data reaches the foreign user.
    const stolenAnalysis = await userB.get(`/analyses/${analysisId}`);
    expect(stolenAnalysis.text).not.toContain("Exploratory data analysis");
    expect(stolenAnalysis.text).not.toContain("revenue-2024");
    expect(stolenAnalysis.text).toMatch(/Page not found|does not exist/i);
  });

  it("updates workspace settings for the owner only path", async () => {
    const res = await userA
      .patch("/api/workspace")
      .send({ settings: { numberFormat: "dot", timezone: "Europe/Berlin" } });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(true);
  });
});
