/**
 * Starter questions for the Business Advisor.
 *
 * Kept in its own module with zero server imports so the client panel can use
 * it without pulling the analysis engine (which streams files with node:fs)
 * into the browser bundle.
 */

export const ADVISOR_SUGGESTIONS: { q: string; intent: string }[] = [
  { q: "How is our business performing overall?", intent: "performance" },
  { q: "What is driving our results this period?", intent: "drivers" },
  { q: "Which segments are genuinely different, not just noise?", intent: "segments" },
  { q: "What should we expect next quarter?", intent: "forecast" },
  { q: "Are there data quality issues I should fix first?", intent: "quality" },
];
