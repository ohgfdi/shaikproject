/**
 * Unit tests for the notebook NL→DSL assistant (lib/engine/nl-to-code.ts).
 */

import { describe, expect, it } from "@jest/globals";

import { buildLlmPrompt, isSafeDslCommand, translateToDsl } from "@/lib/engine/nl-to-code";
import type { ColumnDef } from "@/lib/types";

const COLUMNS: ColumnDef[] = [
  { name: "date", type: "date" },
  { name: "region", type: "string" },
  { name: "revenue", type: "number" },
  { name: "costs", type: "number" },
];

describe("nl-to-code", () => {
  describe("translateToDsl", () => {
    it("maps help requests", () => {
      const result = translateToDsl("what can you do?", COLUMNS);
      expect(result.matched).toBe(true);
      expect(result.code).toBe("%help");
    });

    it("maps schema requests", () => {
      const result = translateToDsl("show me the columns", COLUMNS);
      expect(result.code).toBe("%columns");
    });

    it("maps profile requests", () => {
      const result = translateToDsl("data quality overview", COLUMNS);
      expect(result.code).toBe("%profile");
    });

    it("maps row previews with a number", () => {
      const result = translateToDsl("show the first 10 rows", COLUMNS);
      expect(result.code).toBe("%rows 10");
    });

    it("maps averages to %describe", () => {
      const result = translateToDsl("average revenue", COLUMNS);
      expect(result.code).toBe("%describe revenue");
    });

    it("maps sums/totals to %kpi", () => {
      const result = translateToDsl("total revenue please", COLUMNS);
      expect(result.code).toBe("%kpi revenue");
    });

    it("maps trends using the date column", () => {
      const result = translateToDsl("trend of revenue over time", COLUMNS);
      expect(result.code).toBe("%trend revenue by date");
    });

    it("maps correlations between two columns", () => {
      const result = translateToDsl("correlation between revenue and costs", COLUMNS);
      expect(result.code).toBe("%corr revenue costs");
    });

    it("maps histograms", () => {
      const result = translateToDsl("histogram of revenue", COLUMNS);
      expect(result.code).toBe("%histogram revenue");
    });

    it("fails honestly on unrecognized requests", () => {
      const result = translateToDsl("teleport me to the moon", COLUMNS);
      expect(result.matched).toBe(false);
      expect(result.help).toContain("%kpi");
    });

    it("handles empty requests", () => {
      const result = translateToDsl("  ", COLUMNS);
      expect(result.matched).toBe(false);
    });
  });

  describe("isSafeDslCommand", () => {
    it("accepts known commands with arguments", () => {
      expect(isSafeDslCommand("%kpi revenue")).toBe(true);
      expect(isSafeDslCommand("%corr revenue costs")).toBe(true);
      expect(isSafeDslCommand("%rows 25")).toBe(true);
      expect(isSafeDslCommand("%help")).toBe(true);
    });

    it("rejects unknown or malformed commands", () => {
      expect(isSafeDslCommand("rm -rf /")).toBe(false);
      expect(isSafeDslCommand("%delete revenue")).toBe(false);
      expect(isSafeDslCommand("%kpi revenue\n%help")).toBe(false);
      expect(isSafeDslCommand("%kpi revenue; drop table users")).toBe(false);
      expect(isSafeDslCommand("%kpi")).toBe(false); // missing argument
      expect(isSafeDslCommand("%corr revenue")).toBe(false); // needs two columns
    });
  });

  describe("buildLlmPrompt", () => {
    it("includes the dataset schema and command list", () => {
      const prompt = buildLlmPrompt("average revenue", COLUMNS, "sales");
      expect(prompt).toContain("sales");
      expect(prompt).toContain("revenue (number)");
      expect(prompt).toContain("%describe");
      expect(prompt).toContain("average revenue");
    });
  });
});
