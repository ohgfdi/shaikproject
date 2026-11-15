/**
 * Roadmap A2 — LLM-written narratives attached to ALREADY-COMPUTED insights.
 *
 * The narration-only rule (docs/copilot-roadmap.md A2): the model may
 * reorder, phrase and explain — it may NOT introduce a number. Enforcement
 * is mechanical, not aspirational:
 *
 *  1. Every number already present in the insight's own computed evidence
 *     (title, observedChange, evidence lines) is collected as "citable".
 *  2. After generation, `verifySummary` from the numeric grounding guard
 *     (lib/copilot/guard.ts) checks every numeric token in the narrative
 *     against that citable set. Rounding is NOT equality: "1.2M" for
 *     "1,234,567" is rejected.
 *  3. Any unverified number ⇒ the narrative is discarded WHOLESALE and the
 *     deterministic `possibleCause` text ships instead. The insight row keeps
 *     a factual note that the narrative was withheld, so the omission is
 *     visible rather than silent.
 *
 * A failed or absent model is a no-op: the deterministic insight text is
 * already complete, so narration is pure enhancement, never a dependency.
 */

import { verifySummary } from "@/lib/copilot/guard";
import type { LLMProvider } from "@/lib/llm/providers";
import type { InsightInput } from "@/lib/types";

/** Every number-bearing string the insight itself computed — the citable set. */
export function citableFactsForInsight(insight: InsightInput): string[] {
  const facts = [insight.title, insight.observedChange ?? "", ...insight.evidence];
  if (insight.metric) facts.push(insight.metric);
  return facts.filter((f) => f.length > 0);
}

/** Build the narration request. The engine's numbers are passed back verbatim so the model can reference them. */
export function narrativePrompt(insight: InsightInput): { system: string; user: string } {
  return {
    system:
      "You write short business narratives for pre-computed analytics insights. " +
      "You may ONLY use numbers that appear in the provided facts — every number you write is mechanically verified against them, " +
      "and the whole narrative is discarded if you introduce any other number (including rounded forms like 1.2M). " +
      "Write one or two plain sentences, no markdown, no headings.",
    user: [
      "Facts (the ONLY numbers you may use, verbatim):",
      ...citableFactsForInsight(insight).map((f) => ` - ${f}`),
      "",
      `Insight title: ${insight.title}`,
      `Severity: ${insight.severity}`,
      "",
      "Write a one-or-two-sentence narrative explaining what happened and what it means for the business. " +
        "Do not invent causes; phrase drivers as possibilities.",
    ].join("\n"),
  };
}

export interface NarrativeResult {
  /** The guard-verified narrative, or null when withheld/unavailable. */
  narrative: string | null;
  /** True when a model produced text but the guard rejected it. */
  withheld: boolean;
  reason: string | null;
}

/** Generate the narrative with the given provider, or null if generation failed. */
export async function generateNarrative(provider: LLMProvider, insight: InsightInput): Promise<string | null> {
  const { system, user } = narrativePrompt(insight);
  try {
    const res = await provider.generate({
      systemPrompt: system,
      userPrompt: user,
      maxTokens: 160,
      temperature: 0.3,
      timeout: 15000,
    });
    const text = res.content.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Full narration step for one insight: generate → verify → return. Never
 * throws. When `provider` is null the insight ships unchanged.
 */
export async function narrateInsight(provider: LLMProvider | null, insight: InsightInput): Promise<NarrativeResult> {
  if (!provider) return { narrative: null, withheld: false, reason: null };
  const narrative = await generateNarrative(provider, insight);
  if (!narrative) return { narrative: null, withheld: false, reason: null };

  const verdict = verifySummary(narrative, citableFactsForInsight(insight));
  if (verdict.ok) return { narrative, withheld: false, reason: null };
  return {
    narrative: null,
    withheld: true,
    reason: `Narrative withheld: it cited numbers that were not computed (${verdict.violations.join(", ")}).`,
  };
}

/**
 * Narrate a batch of insights. Independent per insight: one withheld
 * narrative never blocks the others.
 */
export async function narrateInsights(
  provider: LLMProvider | null,
  insights: InsightInput[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!provider) return out;
  for (let i = 0; i < insights.length; i++) {
    const result = await narrateInsight(provider, insights[i]!);
    if (result.narrative) out.set(i, result.narrative);
  }
  return out;
}
