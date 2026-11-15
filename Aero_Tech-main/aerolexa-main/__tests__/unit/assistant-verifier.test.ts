/**
 * Grounding verifier — oracle tests.
 *
 * The verifier is the last line of defence: a plausible but fabricated number
 * must not survive, while the exact Indian-formatted strings produced by the
 * tool layer (and their whole-rupee rounded forms) must pass. These tests use
 * hand-built envelopes so they are deterministic and DB-free.
 */

import { money } from "@/lib/ai/format";
import type { ToolEnvelope } from "@/lib/ai/tools/types";
import { verifyAnswer } from "@/lib/ai/verifier";

const RESULT_ID = "tr_abc12345";

function envelope(data: Record<string, unknown>): ToolEnvelope {
  return {
    ok: true,
    resultId: RESULT_ID,
    tool: "financial_statements",
    tier: "READ",
    data,
    meta: {
      rowCount: 1,
      total: 1,
      truncated: false,
      provenance: "test",
      generatedAt: "2026-10-22T00:00:00.000Z",
    },
  };
}

function results(data: Record<string, unknown>): Map<string, ToolEnvelope> {
  return new Map([[RESULT_ID, envelope(data)]]);
}

describe("verifyAnswer", () => {
  const revenue = money(12_345_678); // ₹1,23,456.78

  it("accepts a claim whose figure appears verbatim in the cited result", () => {
    const outcome = verifyAnswer({
      answer: `Revenue was ${revenue.inr}.`,
      claims: [{ text: `Revenue was ${revenue.inr}.`, result_ids: [RESULT_ID] }],
      results: results({ revenue }),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.failures).toEqual([]);
    expect(outcome.citedResultIds).toEqual([RESULT_ID]);
  });

  it("accepts a whole-rupee rounding of a stored paise value", () => {
    const outcome = verifyAnswer({
      answer: "Revenue was ₹1,23,457.",
      claims: [{ text: "Revenue was ₹1,23,457.", result_ids: [RESULT_ID] }],
      results: results({ revenue }),
    });

    expect(outcome.ok).toBe(true);
  });

  it("blocks a fabricated total even when the claim cites a real result", () => {
    const outcome = verifyAnswer({
      answer: "Revenue was ₹9,99,999.",
      claims: [{ text: "Revenue was ₹9,99,999.", result_ids: [RESULT_ID] }],
      results: results({ revenue }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures.some((failure) => failure.kind === "number")).toBe(true);
  });

  it("blocks a figure in a claim that cites no result", () => {
    const outcome = verifyAnswer({
      answer: "Revenue was ₹1,23,456.78.",
      claims: [{ text: "Revenue was ₹1,23,456.78.", result_ids: [] }],
      results: results({ revenue }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures.some((failure) => failure.kind === "citation")).toBe(true);
  });

  it("blocks a cited resultId that was never produced in this run", () => {
    const outcome = verifyAnswer({
      answer: `Revenue was ${revenue.inr}.`,
      claims: [{ text: `Revenue was ${revenue.inr}.`, result_ids: ["tr_missing99"] }],
      results: results({ revenue }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures.some((failure) => failure.kind === "citation")).toBe(true);
  });

  it("blocks an invented invoice number", () => {
    const outcome = verifyAnswer({
      answer: "Invoice INV/2025/0099 is overdue.",
      claims: [{ text: "Invoice INV/2025/0099 is overdue.", result_ids: [RESULT_ID] }],
      results: results({ revenue }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures.some((failure) => failure.kind === "identifier")).toBe(true);
  });

  it("accepts an honest qualitative answer with no figures and no claims", () => {
    const outcome = verifyAnswer({
      answer: "I cannot determine that with the tools I have.",
      claims: [],
      results: new Map(),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.failures).toEqual([]);
  });

  it("rejects a malformed claims shape", () => {
    const outcome = verifyAnswer({
      answer: "Revenue was ₹1,23,456.78.",
      claims: [{ text: "Revenue was ₹1,23,456.78." }],
      results: results({ revenue }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures.some((failure) => failure.kind === "shape")).toBe(true);
  });

  it("rejects a non-string answer", () => {
    const outcome = verifyAnswer({ answer: 42, claims: [], results: new Map() });
    expect(outcome.ok).toBe(false);
    expect(outcome.failures[0]?.kind).toBe("shape");
  });
});
