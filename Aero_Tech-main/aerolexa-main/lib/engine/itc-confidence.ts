/**
 * Match confidence for an ITC reconciliation.
 *
 * The reconciliation engine already decides each invoice's verdict. What a
 * reviewer needs next is ordering: which of 400 lines should they open first,
 * and how much of the period is safe to avail. This module turns verdicts into
 * a deterministic confidence score and an exception worklist. It never changes
 * the verdict or the Table 4 figures.
 */

import type { ItcReconciliation, ReconciledInvoice } from "./gstr-2b-itc";

export type ConfidenceBand = "high" | "medium" | "low";

const SCORE: Record<ReconciledInvoice["verdict"], number> = {
  "matched-eligible": 98,
  "matched-eligible-rcm": 90,
  "matched-blocked": 85,
  "matched-expired-s16": 80,
  "matched-rule37": 72,
  "in-2b-only": 65,
  "amount-mismatch": 55,
  "in-books-only": 45,
};

export interface ConfidenceItem {
  key: string;
  invoiceNumber: string;
  gstin: string;
  verdict: ReconciledInvoice["verdict"];
  score: number;
  band: ConfidenceBand;
  action: string;
}

export interface ItcConfidence {
  /** Weighted mean score across every line, rounded to one decimal. */
  score: number;
  band: ConfidenceBand;
  counts: Record<ConfidenceBand, number>;
  /** Lines that need a human before credit is availed, lowest score first. */
  worklist: ConfidenceItem[];
  summary: string;
}

function bandOf(score: number): ConfidenceBand {
  return score >= 90 ? "high" : score >= 70 ? "medium" : "low";
}

function actionFor(invoice: ReconciledInvoice): string {
  switch (invoice.verdict) {
    case "matched-eligible":
      return "No action: matched and eligible.";
    case "matched-eligible-rcm":
      return "Pay the reverse-charge liability before availing; claim in 4(A)(3).";
    case "matched-blocked":
      return "Do not avail: blocked or flagged unavailable in 2B.";
    case "matched-expired-s16":
      return "Do not avail: the s16(4) time limit has expired.";
    case "matched-rule37":
      return "Avail provisionally only; the supplier has not filed GSTR-1.";
    case "in-2b-only":
      return "Credit is in 2B but not the books — record the purchase or confirm it is not yours.";
    case "amount-mismatch":
      return "Correct the tax heads/amounts before availing.";
    case "in-books-only":
      return "Do not avail: s16(2)(aa) requires the invoice in GSTR-2B.";
  }
}

export function summarizeItcConfidence(reconciliation: ItcReconciliation): ItcConfidence {
  const items: ConfidenceItem[] = reconciliation.invoices.map((invoice) => {
    const score = SCORE[invoice.verdict];
    return {
      key: invoice.key,
      invoiceNumber: invoice.invoiceNumber,
      gstin: invoice.gstin,
      verdict: invoice.verdict,
      score,
      band: bandOf(score),
      action: actionFor(invoice),
    };
  });

  const counts: Record<ConfidenceBand, number> = { high: 0, medium: 0, low: 0 };
  for (const item of items) counts[item.band] += 1;

  const score =
    items.length === 0
      ? 0
      : Math.round((items.reduce((sum, item) => sum + item.score, 0) / items.length) * 10) / 10;

  const worklist = items
    .filter((item) => item.verdict !== "matched-eligible")
    .sort((a, b) => a.score - b.score || a.invoiceNumber.localeCompare(b.invoiceNumber));

  const summary =
    items.length === 0
      ? "No invoices were compared, so no confidence can be claimed."
      : `${worklist.length} of ${items.length} line${items.length === 1 ? "" : "s"} need attention before availing; ${counts.high} are high-confidence.`;

  return { score, band: bandOf(score), counts, worklist, summary };
}
