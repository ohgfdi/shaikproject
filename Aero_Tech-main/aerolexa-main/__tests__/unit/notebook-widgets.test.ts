/**
 * Unit tests for notebook widget variable substitution (lib/engine/notebook-widgets.ts).
 */

import { describe, expect, it } from "@jest/globals";

import {
  downstreamOf,
  referencesWidgetVariable,
  substituteWidgetVariables,
  widgetLiteral,
  widgetRaw,
  widgetValuesFromCells,
} from "@/lib/engine/notebook-widgets";
import type { NotebookCell } from "@/lib/types";

describe("notebook-widgets", () => {
  describe("widgetRaw", () => {
    it("returns the raw value for DSL cells", () => {
      expect(widgetRaw("revenue")).toBe("revenue");
      expect(widgetRaw(25)).toBe("25");
      expect(widgetRaw({ min: "2023-01-01", max: "2023-02-01" })).toBe("2023-01-01..2023-02-01");
      expect(widgetRaw(null)).toBe("");
    });
  });

  describe("widgetLiteral", () => {
    it("renders Python/JS literals for code cells", () => {
      expect(widgetLiteral("East")).toBe('"East"');
      expect(widgetLiteral(5)).toBe("5");
      expect(widgetLiteral({ min: "2023-01-01", max: "2023-02-01" })).toBe('{"min":"2023-01-01","max":"2023-02-01"}');
      expect(widgetLiteral(null)).toBe("None");
    });
  });

  describe("substituteWidgetVariables", () => {
    const values = { region: "East", threshold: 50, period: { min: "2023-01-01", max: "2023-02-01" } };

    it("substitutes raw values in DSL commands", () => {
      expect(substituteWidgetVariables("%kpi {{region}}", values, "dsl")).toBe("%kpi East");
      expect(substituteWidgetVariables("%rows {{threshold}}", values, "dsl")).toBe("%rows 50");
    });

    it("substitutes literals in Python cells", () => {
      expect(substituteWidgetVariables("region = {{region}}", values, "literal")).toBe('region = "East"');
      expect(substituteWidgetVariables("threshold = {{threshold}}", values, "literal")).toBe("threshold = 50");
      expect(substituteWidgetVariables("period = {{period}}", values, "literal")).toBe(
        'period = {"min":"2023-01-01","max":"2023-02-01"}',
      );
    });

    it("auto-detects DSL mode from leading %", () => {
      expect(substituteWidgetVariables("%kpi {{region}}", values)).toBe("%kpi East");
      expect(substituteWidgetVariables("x = {{region}}", values)).toBe('x = "East"');
    });

    it("substitutes SQL literals in SQL cells (quotes escaped, numbers bare)", () => {
      expect(substituteWidgetVariables("SELECT * FROM t WHERE region = {{region}}", values, "sql")).toBe(
        "SELECT * FROM t WHERE region = 'East'",
      );
      expect(substituteWidgetVariables("SELECT * FROM t WHERE n > {{threshold}}", values, "sql")).toBe(
        "SELECT * FROM t WHERE n > 50",
      );
    });

    it("escapes single quotes in SQL string values", () => {
      expect(substituteWidgetVariables("WHERE name = {{name}}", { name: "O'Brien Ltd" }, "sql")).toBe(
        "WHERE name = 'O''Brien Ltd'",
      );
    });

    it("leaves unresolved tokens untouched", () => {
      expect(substituteWidgetVariables("%kpi {{missing}}", values, "dsl")).toBe("%kpi {{missing}}");
    });
  });

  describe("widgetValuesFromCells", () => {
    it("collects values from widget cells by variable name", () => {
      const cells: NotebookCell[] = [
        { id: "w1", kind: "widget", content: "", widget: { kind: "dropdown", variable: "region", value: "West" } },
        { id: "c1", kind: "code", content: "%kpi {{region}}" },
      ];
      expect(widgetValuesFromCells(cells)).toEqual({ region: "West" });
    });

    it("returns empty map when no widget cells exist", () => {
      expect(widgetValuesFromCells([{ id: "c1", kind: "code", content: "%help" }])).toEqual({});
    });
  });

  describe("referencesWidgetVariable", () => {
    it("detects {{variable}} tokens", () => {
      expect(referencesWidgetVariable("%kpi {{region}}")).toBe(true);
      expect(referencesWidgetVariable("%help")).toBe(false);
    });
  });

  describe("downstreamOf — reactive re-run set (ROADMAP 4.3)", () => {
    const widgetCell: NotebookCell = {
      id: "w1",
      kind: "widget",
      content: "",
      widget: { kind: "dropdown", variable: "region", value: "East" },
    };

    it("finds direct readers of the widget variable", () => {
      const cells: NotebookCell[] = [
        widgetCell,
        { id: "c1", kind: "code", content: "x = {{region}}" },
        { id: "c2", kind: "code", content: "y = 1" },
      ];
      const ids = downstreamOf(cells, "w1", { changedVariable: "region" }).map((c) => c.id);
      expect(ids).toEqual(["c1"]);
    });

    it("walks TRANSITIVE chains: widget → code → sql via outputVariable", () => {
      const cells: NotebookCell[] = [
        widgetCell,
        { id: "c1", kind: "code", content: "df = load({{region}})", outputVariable: "df" },
        { id: "s1", kind: "sql", content: "", sqlConfig: { query: "SELECT * FROM $df" } },
        { id: "c2", kind: "code", content: "unrelated" },
      ];
      const ids = downstreamOf(cells, "w1", { changedVariable: "region" }).map((c) => c.id);
      expect(ids).toEqual(["c1", "s1"]); // document order
    });

    it("follows explicit dependencies[] edges", () => {
      const cells: NotebookCell[] = [
        { id: "c1", kind: "code", content: "a = 1", outputVariable: "a" },
        { id: "c2", kind: "code", content: "b = a", dependencies: [{ dependsOn: "c1", variable: "a" }] },
      ];
      const ids = downstreamOf(cells, "c1").map((c) => c.id);
      expect(ids).toEqual(["c2"]);
    });

    it("returns document-ordered results and never includes the source", () => {
      const cells: NotebookCell[] = [
        // s1 is listed BEFORE the cells it depends on — document order must hold.
        { id: "s1", kind: "sql", content: "", sqlConfig: { query: "SELECT * FROM $df" } },
        { id: "c1", kind: "code", content: "df = f({{n}})", outputVariable: "df" },
        { id: "w1", kind: "widget", content: "", widget: { kind: "number", variable: "n", value: 1 } },
      ];
      const ids = downstreamOf(cells, "w1", { changedVariable: "n" }).map((c) => c.id);
      expect(ids).toEqual(["s1", "c1"]); // document order, not discovery order
      expect(ids).not.toContain("w1");
    });

    it("ignores markdown cells and non-matching cells", () => {
      const cells: NotebookCell[] = [
        widgetCell,
        { id: "m1", kind: "markdown", content: "see {{region}}" },
        { id: "c1", kind: "code", content: "x = {{other}}" },
      ];
      expect(downstreamOf(cells, "w1", { changedVariable: "region" })).toEqual([]);
    });
  });
});
