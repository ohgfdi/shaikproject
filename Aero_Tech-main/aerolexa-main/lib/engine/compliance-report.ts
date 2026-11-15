/**
 * Monthly client compliance report — the artefact a CA firm forwards to its
 * client: what was due this month, what was filed on time, what was late, and
 * what the late-filing exposure is.
 *
 * Pure by construction. The server module supplies the obligations; this file
 * decides what the month means, so the wording and the totals are oracle-tested
 * without a database.
 *
 * Honesty rules:
 *  - a waived obligation is counted and costs nothing;
 *  - an open obligation past its due date is `overdue`, not "late", because it
 *    still has not been filed;
 *  - exposure is summed only from rows where a figure is computable, and the
 *    number of rows that could not be estimated is reported alongside it — a
 *    partial total is never presented as the whole bill.
 */

import {
  lateFilingExposure,
  regimeForTaskCode,
  type ExposureBasis,
  type LateFilingExposure,
} from "@/lib/engine/late-filing-exposure";

export interface ReportObligation {
  taskId: string;
  /** Stable calendar code (GSTR-3B, TDS-26Q, ITR, …). */
  code: string;
  title: string;
  authority: string;
  dueDate: string;
  /** Date the return was filed, when it was. */
  filedDate: string | null;
  /** filed | pending | in-progress | waived */
  status: string;
  /** ARN / SRN, when recorded. */
  reference: string | null;
  /** SHA-256 of the filing proof bundle, when a portal attempt exists. */
  proofDigest: string | null;
  /** When the client approved through the portal, if they did. */
  clientApprovedAt: string | null;
  /** GST state code or name, used to price professional tax. */
  state?: string | null;
  /** Tax paid late, in paise, when the firm recorded it. */
  taxMinor?: number | null;
  nilReturn?: boolean;
}

export interface ReportRow extends ReportObligation {
  /** filed-on-time | filed-late | overdue | pending | waived */
  outcome: "filed-on-time" | "filed-late" | "overdue" | "pending" | "waived";
  daysLate: number;
  exposure: LateFilingExposure;
}

export interface MonthlyComplianceReport {
  month: string;
  asOf: string;
  engagement: { id: string; name: string };
  rows: ReportRow[];
  totals: {
    due: number;
    filed: number;
    onTime: number;
    late: number;
    pending: number;
    overdue: number;
    waived: number;
    /**
     * Sum of the computable exposure figures, in paise. Read it with
     * `exposureIncomplete`: this is not necessarily the full bill.
     */
    exposureMinor: number;
    /** Rows with a computable exposure figure. */
    exposureRows: number;
    /** Rows that are late/overdue but could not be priced from recorded facts. */
    exposureIncomplete: number;
    /** Rows whose figure is an uncapped maximum (`upper-bound`). */
    exposureUpperBound: number;
  };
  /** Deterministic plain-English summary, one sentence per line. */
  narrative: string[];
}

export function isReportMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function money(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function outcomeOf(obligation: ReportObligation, daysLate: number): ReportRow["outcome"] {
  if (obligation.status === "waived") return "waived";
  if (obligation.filedDate) return daysLate > 0 ? "filed-late" : "filed-on-time";
  return daysLate > 0 ? "overdue" : "pending";
}

/**
 * Build the report for one engagement and month. Only obligations whose due
 * date falls in `month` are included: the report answers "what was this month",
 * not "everything that ever happened".
 */
export function buildMonthlyComplianceReport(input: {
  month: string;
  asOf: string;
  engagement: { id: string; name: string };
  obligations: ReportObligation[];
}): MonthlyComplianceReport {
  if (!isReportMonth(input.month)) {
    throw new Error(`Expected a month as yyyy-mm, got “${input.month}”.`);
  }

  const rows: ReportRow[] = input.obligations
    .filter((obligation) => obligation.dueDate.startsWith(input.month))
    .map((obligation) => {
      const exposure = lateFilingExposure({
        regime: regimeForTaskCode(obligation.code),
        code: obligation.code,
        state: obligation.state ?? null,
        dueDate: obligation.dueDate,
        filedDate: obligation.filedDate,
        asOf: input.asOf,
        taxMinor: obligation.taxMinor ?? null,
        nilReturn: obligation.nilReturn ?? false,
      });
      const outcome = outcomeOf(obligation, exposure.daysLate);
      return { ...obligation, outcome, daysLate: exposure.daysLate, exposure };
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));

  const totals = {
    due: rows.length,
    filed: rows.filter((row) => row.outcome === "filed-on-time" || row.outcome === "filed-late").length,
    onTime: rows.filter((row) => row.outcome === "filed-on-time").length,
    late: rows.filter((row) => row.outcome === "filed-late").length,
    pending: rows.filter((row) => row.outcome === "pending").length,
    overdue: rows.filter((row) => row.outcome === "overdue").length,
    waived: rows.filter((row) => row.outcome === "waived").length,
    exposureMinor: 0,
    exposureRows: 0,
    exposureIncomplete: 0,
    exposureUpperBound: 0,
  };

  for (const row of rows) {
    // Only a late or overdue obligation carries exposure. An on-time or
    // not-yet-due row prices at zero, so counting it would inflate "across N
    // obligations" with entries that cost nothing.
    if (row.outcome !== "filed-late" && row.outcome !== "overdue") continue;
    const basis: ExposureBasis = row.exposure.basis;
    if (row.exposure.totalMinor !== null && basis !== "unknown") {
      totals.exposureMinor += row.exposure.totalMinor;
      totals.exposureRows += 1;
      if (basis === "upper-bound") totals.exposureUpperBound += 1;
    } else {
      totals.exposureIncomplete += 1;
    }
  }

  const narrative: string[] = [];
  if (rows.length === 0) {
    narrative.push(`No statutory obligation for ${input.engagement.name} fell due in ${input.month}.`);
  } else {
    narrative.push(`${rows.length} obligation${rows.length === 1 ? "" : "s"} fell due in ${input.month}.`);
    const parts: string[] = [];
    if (totals.onTime > 0) parts.push(`${totals.onTime} filed on time`);
    if (totals.late > 0) parts.push(`${totals.late} filed late`);
    if (totals.pending > 0) parts.push(`${totals.pending} not yet due at the report date`);
    if (totals.overdue > 0) parts.push(`${totals.overdue} still open past the due date`);
    if (totals.waived > 0) parts.push(`${totals.waived} waived`);
    if (parts.length > 0) narrative.push(`${parts.join("; ")}.`);
  }

  if (totals.exposureRows > 0) {
    narrative.push(
      `Estimated late-filing exposure: ${money(totals.exposureMinor)} across ${totals.exposureRows} obligation${
        totals.exposureRows === 1 ? "" : "s"
      }${totals.exposureUpperBound > 0 ? `, of which ${totals.exposureUpperBound} is an uncapped maximum` : ""}.`,
    );
  }
  if (totals.exposureIncomplete > 0) {
    narrative.push(
      `${totals.exposureIncomplete} late or overdue obligation${
        totals.exposureIncomplete === 1 ? "" : "s"
      } could not be priced because the tax amount or the fee schedule is not recorded.`,
    );
  }
  if (totals.filed > 0) {
    const withProof = rows.filter(
      (row) => (row.outcome === "filed-on-time" || row.outcome === "filed-late") && row.proofDigest,
    ).length;
    narrative.push(
      `${withProof} of ${totals.filed} filed return${totals.filed === 1 ? "" : "s"} carries a portal proof digest.`,
    );
  }
  narrative.push(
    "Exposure figures are arithmetic estimates on the stated statutory rates, not a legal opinion or a demand.",
  );

  return {
    month: input.month,
    asOf: input.asOf,
    engagement: input.engagement,
    rows,
    totals,
    narrative,
  };
}
