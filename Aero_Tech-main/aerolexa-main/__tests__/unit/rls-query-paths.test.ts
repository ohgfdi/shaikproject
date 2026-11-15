/**
 * RLS on every query path (P21 / E19) — source-gated contract test.
 *
 * Every user-facing read must pass the shared dataset chokepoint before an
 * engine sees rows. This test pins the wiring that a refactor could quietly
 * drop: the SQL Lab route runs through `runQueryOnDatasets`, that helper calls
 * `applyRowSecurity` per source dataset, and the direct read surfaces (rows,
 * values, notebook cell runs) filter before computing.
 */
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");

describe("RLS query-path wiring", () => {
  it("SQL Lab runs through the shared dataset-query helper", () => {
    const route = read("app/api/datasets/[id]/query/route.ts");
    expect(route).toContain("runQueryOnDatasets(");
    // No direct loadParsedDataset escape hatch in the SQL route.
    expect(route).not.toContain("loadParsedDataset(");
  });

  it("dataset-query applies row security to every source before the query", () => {
    const helper = read("lib/server/dataset-query.ts");
    expect(helper).toContain("applyRowSecurity(ctx, source");
    // The filtered rows are the ones handed to the engine.
    expect(helper).toContain("rows: rls.rows");
    expect(helper).toContain("rls.note");
  });

  it("direct row/value reads filter before returning data", () => {
    for (const path of ["app/api/datasets/[id]/rows/route.ts", "app/api/datasets/[id]/values/route.ts"]) {
      const route = read(path);
      expect(route).toContain("applyRowSecurity(ctx, dataset");
      expect(route).toContain("rls.rows");
    }
  });

  it("notebook cell runs compute over RLS-filtered rows", () => {
    const route = read("app/api/notebooks/[id]/run/route.ts");
    expect(route).toContain("applyRowSecurity(ctx, dataset");
    // The dataset context handed to every cell runner uses the filtered rows.
    expect(route).toMatch(/rows:\s*rls\.rows/);
  });

  it("the RLS wiring flag matches reality and enforcement fails closed", () => {
    const status = read("lib/server/rls-status.ts");
    // The query layer is NOT wrapped yet (npm run tenancy:audit still reports
    // unwrapped tenant files), so the flag must stay false: enabling RLS against
    // unset GUCs hides every row. A future refactor flips this constant, the
    // audit and the docs together — and this test moves with them.
    expect(status).toContain("RLS_QUERY_LAYER_WIRED = false");
    const tenancy = read("lib/server/tenancy.ts");
    expect(tenancy).toContain("setTenantContext");
    // Requesting RLS while the layer is unwired must produce a readable config
    // error rather than a silent, row-hiding "success".
    expect(tenancy).toContain("rlsConfigError");
    expect(tenancy).toContain("would hide every row");
  });
});
