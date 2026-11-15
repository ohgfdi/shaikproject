/**
 * Template catalog — catalog-validity gates.
 *
 * These tests are the reason the catalog can never rot: every template's SQL
 * must pass the read-only contract, every slot must be declared AND used,
 * placeholders must round-trip through the fill operation, and every pack
 * must contain at least one template (a vanished wedge = a silent SEO loss).
 */

import {
  ANALYSIS_TEMPLATES,
  templatePlaceholders,
  templateSqlProblems,
  templatesByPack,
  undeclaredPlaceholders,
  unusedSlots,
  type AnalysisTemplate,
} from "@/lib/engine/template-catalog";

/** The UI's fill operation: replace every declared slot placeholder. */
function fillTemplate(t: AnalysisTemplate, values: Record<string, string>): string[] {
  return t.steps.map((step) => {
    let out = step.content;
    for (const slot of t.slots) {
      out = out.split(slot.placeholder).join(values[slot.key] ?? "");
    }
    return out;
  });
}

describe("template catalog — validity gates", () => {
  it("ships templates for every pack (no vanished wedge)", () => {
    for (const pack of ["gst", "tally", "bank", "audit", "core"] as const) {
      expect(templatesByPack(pack).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("every template has SEO metadata (title, description, keywords)", () => {
    for (const t of ANALYSIS_TEMPLATES) {
      expect(t.title.length).toBeGreaterThan(8);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.keywords.length).toBeGreaterThanOrEqual(2);
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("every SQL step passes the read-only contract", () => {
    for (const t of ANALYSIS_TEMPLATES) {
      for (const step of t.steps.filter((s) => s.surface === "sql")) {
        const problems = templateSqlProblems(step.content);
        expect(problems).toEqual([]);
      }
    }
  });

  it("rejects DDL/DML and multi-statement SQL (guard contract)", () => {
    expect(templateSqlProblems("DELETE FROM dataset")).not.toEqual([]);
    expect(templateSqlProblems("SELECT 1; DROP TABLE dataset")).not.toEqual([]);
    expect(templateSqlProblems("CREATE TABLE x AS SELECT 1")).not.toEqual([]);
    expect(templateSqlProblems("SELECT 'delete' AS word")).toEqual([]); // string literal is safe
  });

  it("every slot is used AND every placeholder is declared", () => {
    for (const t of ANALYSIS_TEMPLATES) {
      expect(unusedSlots(t)).toEqual([]);
      expect(undeclaredPlaceholders(t)).toEqual([]);
    }
  });

  it("placeholders round-trip: a fully-filled template has no [Slots] left in SQL steps", () => {
    for (const t of ANALYSIS_TEMPLATES) {
      const values: Record<string, string> = {};
      for (const slot of t.slots) values[slot.key] = slot.key; // plain identifier, no brackets
      const filled = fillTemplate(t, values);
      filled.forEach((sql, i) => {
        if (t.steps[i]?.surface !== "sql") return;
        // Every original [Placeholder] must be replaced by the plain identifier.
        for (const slot of t.slots) {
          expect(sql).not.toContain(slot.placeholder);
        }
        expect(sql).toContain("FROM dataset"); // still a query against the dataset
      });
    }
  });

  it("known-answer: the placeholders list for the KPI template is exact", () => {
    const t = ANALYSIS_TEMPLATES.find((x) => x.id === "core-monthly-kpi");
    expect(t).toBeDefined();
    expect(templatePlaceholders(t!).sort()).toEqual(["[Cost]", "[OrderDate]", "[Revenue]"]);
  });

  it("every template declares its artifact", () => {
    for (const t of ANALYSIS_TEMPLATES) {
      expect(["dashboard", "report", "presentation"]).toContain(t.artifact.kind);
      expect(t.artifact.note.length).toBeGreaterThan(10);
    }
  });
});
