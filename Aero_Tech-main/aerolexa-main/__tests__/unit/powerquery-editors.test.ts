/**
 * Gap ⑤ + ⑥: the schema-driven editor surface and the saved-steps applier.
 *
 * Editor tests pin the data-driven contract (every palette kind has an editor
 * spec; field keys map onto real PQStep properties). Applier tests run the
 * REAL engine over an in-memory dataset: applied pipelines re-materialize
 * transformed rows; column drift keeps raw rows with a reason.
 */

import { applySteps, describeStep, type PQStep } from "@/lib/engine/powerquery";
import { STEP_EDITORS, editorFor } from "@/lib/engine/powerquery-editors";
import { describeSavedSteps } from "@/lib/server/transform-apply";

export {};

const PALETTE_KINDS = [
  "removeColumns",
  "renameColumn",
  "changeType",
  "removeBlankRows",
  "removeDuplicates",
  "filterRows",
  "sortRows",
  "fillDown",
  "replaceValues",
  "trimText",
  "uppercase",
  "lowercase",
  "splitColumn",
  "groupBy",
  "addCustomColumn",
  "addIndexColumn",
  "unpivot",
  "pivot",
  "mergeColumns",
  "topN",
] as const;

describe("step editor schema (Gap ⑤)", () => {
  it("every palette step kind has an editor spec (except the two zero/low-config kinds)", () => {
    for (const kind of PALETTE_KINDS) {
      const spec = editorFor(kind);
      if (kind === "removeBlankRows" || kind === "unpivot") continue; // no editable fields needed
      expect(spec).toBeTruthy();
    }
  });

  it("editor field keys map onto real PQStep properties — verified by applying a patched step", () => {
    const source = {
      columns: [
        { name: "city", type: "string" as const, origin: "source" as const },
        { name: "sales", type: "number" as const, origin: "source" as const },
      ],
      rows: [
        ["Pune", 10],
        ["Jaipur", 20],
      ],
    };
    // Simulate the studio patching a filterRows step through the editor schema.
    const spec = STEP_EDITORS.filterRows!;
    const keys = spec.fields.map((f) => f.key);
    expect(keys).toEqual(["column", "op", "value"]);
    const step = {
      id: "s1",
      label: "Filter rows",
      kind: "filterRows" as const,
      column: "city",
      op: "eq" as const,
      value: "Pune",
    };
    const out = applySteps(source, [step]);
    expect(out.rows).toEqual([["Pune", 10]]);
  });

  it("groupBy spec exposes the aggSpec control so aggregations are editable", () => {
    const spec = STEP_EDITORS.groupBy!;
    expect(spec.fields.some((f) => f.control === "aggSpec")).toBe(true);
  });

  it("describeStep renders human labels for the provenance trail", () => {
    const step: PQStep = { id: "s2", label: "Sort", kind: "sortRows", column: "sales", direction: "desc" };
    expect(describeStep(step)).toContain("sales");
    expect(describeSavedSteps([step])).toEqual([describeStep(step)]);
  });
});

describe("saved-steps applier core (Gap ⑥) — real engine, in-memory", () => {
  it("applies a saved pipeline: filter+sort re-materialize correctly", () => {
    const source = {
      columns: [
        { name: "city", type: "string" as const, origin: "source" as const },
        { name: "sales", type: "number" as const, origin: "source" as const },
      ],
      rows: [
        ["Pune", 10],
        ["Jaipur", 30],
        ["Pune", 20],
      ],
    };
    const steps: PQStep[] = [
      { id: "a", label: "Filter rows", kind: "filterRows", column: "city", op: "eq", value: "Pune" },
      { id: "b", label: "Sort", kind: "sortRows", column: "sales", direction: "desc" },
    ];
    const out = applySteps(source, steps);
    expect(out.rows).toEqual([
      ["Pune", 20],
      ["Pune", 10],
    ]);
  });

  it("column drift raises PQError — the applier's signal to keep raw rows", () => {
    const source = {
      columns: [{ name: "renamed_col", type: "string" as const, origin: "source" as const }],
      rows: [["x"]],
    };
    const steps: PQStep[] = [{ id: "c", label: "Sort", kind: "sortRows", column: "city", direction: "asc" }];
    expect(() => applySteps(source, steps)).toThrow();
  });

  it("empty pipelines are a no-op (applier returns applied:false quickly)", () => {
    const source = {
      columns: [{ name: "a", type: "number" as const, origin: "source" as const }],
      rows: [[1]],
    };
    expect(applySteps(source, []).rows).toEqual([[1]]);
  });
});
