/**
 * Numeric grounding guard.
 *
 * The agent's prose is the one place a hallucinated number could slip through,
 * because the model — not the engine — writes it. This module closes that hole:
 * before any model-authored `summary` is shown, every number in it is checked
 * against the numbers the tools actually produced. If even one cannot be
 * traced back to real tool output, the summary is rejected wholesale.
 *
 * Rejection is deliberately blunt. A partial answer with a good sentence next
 * to an invented figure is exactly the failure mode we refuse to ship, so the
 * caller withholds the whole sentence and tells the user why.
 *
 * Matching is on the numeric value, not its formatting: "$1,234.56" and
 * "1234.56" are the same number. Rounding is NOT treated as equal — "$1.2M" for
 * "$1,234,567" is a different, unverified value and is rejected.
 */

/** Numbers as they appear in text: optional sign, digit groups, optional decimal. */
const NUMBER_PATTERN = /-?\d[\d,]*(?:\.\d+)?/g;

/** Normalize a matched numeric string to a canonical value token. */
function canonicalNumber(token: string): string {
  return token.replace(/,/g, "").replace(/\.$/, "").replace(/^\+/, "");
}

/** Every distinct number appearing in a body of text. */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  for (const match of text.match(NUMBER_PATTERN) ?? []) {
    const c = canonicalNumber(match);
    if (c) out.push(c);
  }
  return out;
}

/** The set of numbers a summary is permitted to cite. */
export function allowedNumbers(citable: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const text of citable) {
    for (const n of extractNumbers(text)) allowed.add(n);
  }
  return allowed;
}

export interface GroundingVerdict {
  ok: boolean;
  /** Numbers present in the summary that no tool produced. */
  violations: string[];
  /** How many numbers were checked (0 is valid — a qualitative summary). */
  checked: number;
}

/**
 * Verify a model-authored summary against the facts the tools produced.
 *
 * @param summary the model's prose
 * @param citable every real number string the runtime trusts: tool facts, the
 *        schema summary, and the user's own request text
 */
export function verifySummary(summary: string, citable: string[]): GroundingVerdict {
  const allowed = allowedNumbers(citable);
  const violations: string[] = [];
  const seen = new Set<string>();
  let checked = 0;

  for (const n of extractNumbers(summary)) {
    checked++;
    if (!allowed.has(n) && !seen.has(n)) {
      violations.push(n);
      seen.add(n);
    }
  }

  return { ok: violations.length === 0, violations, checked };
}
