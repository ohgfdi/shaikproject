/**
 * Advanced reconciliation engine for matching transactions across systems
 */

/** A transaction row whose columns are only known at runtime. */
export type ReconciliationRow = Record<string, unknown>;

export interface ReconciliationMatch {
  id: string;
  leftId: string;
  rightId: string;
  confidence: number;
  matchType: "exact" | "fuzzy" | "date-amount" | "reference";
  reasons: string[];
}

export interface ReconciliationResult {
  matches: ReconciliationMatch[];
  unmatchedLeft: ReconciliationRow[];
  unmatchedRight: ReconciliationRow[];
  totalMatched: number;
  matchRate: number;
}

/** Amounts are read the way `parseFloat(value || 0)` reads them — NaN included. */
function toAmount(value: unknown): number {
  return parseFloat(value ? String(value) : "0");
}

/** A date cell, or null when it carries nothing parsable. */
function toDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

export class ReconciliationEngine {
  static matchTransactions(
    left: ReconciliationRow[],
    right: ReconciliationRow[],
    rules: {
      amountTolerance?: number;
      dateToleranceDays?: number;
      referenceFields?: string[];
      amountFields?: { left: string; right: string };
      dateFields?: { left: string; right: string };
    } = {},
  ): ReconciliationResult {
    const matches: ReconciliationMatch[] = [];
    const matchedLeft = new Set<number>();
    const matchedRight = new Set<number>();

    const amountTolerance = rules.amountTolerance ?? 0;
    const dateToleranceDays = rules.dateToleranceDays ?? 1;
    const amountLeft = rules.amountFields?.left ?? "amount";
    const amountRight = rules.amountFields?.right ?? "amount";
    const dateLeft = rules.dateFields?.left ?? "date";
    const dateRight = rules.dateFields?.right ?? "date";

    // Try exact matches first (amount + reference)
    for (let i = 0; i < left.length; i++) {
      if (matchedLeft.has(i)) continue;
      for (let j = 0; j < right.length; j++) {
        if (matchedRight.has(j)) continue;

        const leftAmount = Math.abs(toAmount(left[i]![amountLeft]));
        const rightAmount = Math.abs(toAmount(right[j]![amountRight]));
        const amtMatch = Math.abs(leftAmount - rightAmount) <= amountTolerance;

        if (amtMatch) {
          // Check references if available
          const hasRefMatch = (rules.referenceFields || []).some((field) => {
            const lref = left[i]![field];
            const rref = right[j]![field];
            return Boolean(lref && rref) && String(lref) === String(rref);
          });

          if (hasRefMatch && (rules.referenceFields || []).length > 0) {
            matches.push({
              id: `${i}-${j}`,
              leftId: String(left[i]!.id || i),
              rightId: String(right[j]!.id || j),
              confidence: 0.99,
              matchType: "reference",
              reasons: ["Exact reference and amount match"],
            });
            matchedLeft.add(i);
            matchedRight.add(j);
            break;
          } else {
            // Date tolerance match
            const leftDate = toDate(left[i]![dateLeft]);
            const rightDate = toDate(right[j]![dateRight]);
            if (leftDate && rightDate) {
              const diffDays = Math.abs((leftDate.getTime() - rightDate.getTime()) / (1000 * 60 * 60 * 24));
              if (diffDays <= dateToleranceDays) {
                matches.push({
                  id: `${i}-${j}`,
                  leftId: String(left[i]!.id || i),
                  rightId: String(right[j]!.id || j),
                  confidence: 0.95,
                  matchType: "date-amount",
                  reasons: [`Amount match (diff 0), date diff ${diffDays.toFixed(1)} days`],
                });
                matchedLeft.add(i);
                matchedRight.add(j);
                break;
              }
            }
          }
        }
      }
    }

    const unmatchedLeft = left.filter((_, i) => !matchedLeft.has(i));
    const unmatchedRight = right.filter((_, i) => !matchedRight.has(i));

    return {
      matches,
      unmatchedLeft,
      unmatchedRight,
      totalMatched: matches.length,
      matchRate: left.length > 0 ? (matches.length / left.length) * 100 : 0,
    };
  }
}
