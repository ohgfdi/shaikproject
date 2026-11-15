/** Form 3CD tax audit report generation for Indian tax audits */

export class Form3CdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Form3CdError";
  }
}

import { formatInr } from "./india-tax";

export type AuditType = "44AB" | "44ADA" | "44AD";

export interface PartAGeneralInfo {
  pan: string;
  name: string;
  address: string;
  assessmentYear: string;
  returnFilingStatus: string;
  dateOfAudit: string;
  placeOfAudit: string;
  earlierAudit?: { date: string; auditorName: string; auditReportNumber: string } | null;
  auditType: AuditType;
  turnoverOrReceipts: number;
  auditedTurnoverReceipts?: number | null;
}

export function generatePartA(info: PartAGeneralInfo): string {
  const lines: string[] = [];
  lines.push("FORM 3CD - TAX AUDIT REPORT");
  lines.push("PART A - GENERAL INFORMATION");
  lines.push("=========================================================");
  lines.push("");
  lines.push(`1.  PAN: ${info.pan}`);
  lines.push(`2.  Name of the Assessee: ${info.name}`);
  lines.push(`3.  Address: ${info.address}`);
  lines.push(`4.  Assessment Year: ${info.assessmentYear}`);
  lines.push(`5.  Return Filing Status: ${info.returnFilingStatus}`);
  lines.push("");
  lines.push("AUDIT PARTICULARS");
  lines.push(`6.  Date of Audit: ${info.dateOfAudit}`);
  lines.push(`7.  Place of Audit: ${info.placeOfAudit}`);
  lines.push("");
  lines.push(
    `8.  Audit Type: ${info.auditType === "44AB" ? "Tax Audit u/s 44AB (Business)" : info.auditType === "44ADA" ? "Tax Audit u/s 44ADA (Profession)" : "Tax Audit u/s 44AD (Presumptive)"}`,
  );
  lines.push(`9.  Turnover/Receipts as per books: ${formatInr(info.turnoverOrReceipts)}`);
  if (info.auditedTurnoverReceipts !== null && info.auditedTurnoverReceipts !== undefined) {
    lines.push(`    Audited Turnover/Receipts: ${formatInr(info.auditedTurnoverReceipts)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export interface AuditObservation {
  clauseNumber: string;
  clauseTitle: string;
  finding: "satisfied" | "qualified" | "not-applicable";
  comment: string;
  qualify?: string;
}

export interface Form3CdAuditData {
  generalInfo: PartAGeneralInfo;
  observations: AuditObservation[];
  additionalNotes?: string[];
}

export function generateForm3CD(data: Form3CdAuditData): string {
  const lines: string[] = [];

  lines.push(generatePartA(data.generalInfo));
  lines.push("=========================================================");
  lines.push("PART B - AUDIT OBSERVATIONS");
  lines.push("=========================================================");
  lines.push("");

  for (const obs of data.observations) {
    lines.push(`Clause ${obs.clauseNumber}: ${obs.clauseTitle}`);
    if (obs.finding === "satisfied") {
      lines.push("   [SATISFIED]");
      lines.push(`   ${obs.comment}`);
    } else if (obs.finding === "qualified") {
      lines.push("   [QUALIFIED]");
      lines.push(`   ${obs.comment}`);
      if (obs.qualify) lines.push(`   Qualification: ${obs.qualify}`);
    } else {
      lines.push("   [NOT APPLICABLE]");
      lines.push(`   ${obs.comment}`);
    }
    lines.push("");
  }

  if (data.additionalNotes && data.additionalNotes.length > 0) {
    lines.push("=========================================================");
    lines.push("ADDITIONAL NOTES");
    lines.push("=========================================================");
    lines.push("");
    for (const note of data.additionalNotes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  lines.push("=========================================================");
  lines.push("DECLARATION");
  lines.push("=========================================================");
  lines.push("");
  lines.push("I/We, the undersigned, being the auditor of the above-named assessee, certify that:");
  lines.push("");
  lines.push(
    "1. I/We have verified the books of account and other relevant records of the assessee as required under section 44AB/44ADA of the Income-tax Act, 1961.",
  );
  lines.push("");
  lines.push(
    "2. The audit has been conducted in accordance with the provisions of the Income-tax Act, 1961 and the rules made thereunder.",
  );
  lines.push("");
  lines.push(
    "3. The observations made herein are based on the records examined by me/us and the information provided by the assessee.",
  );
  lines.push("");
  lines.push("4. I/We have obtained all the explanations and information necessary for the conduct of the audit.");
  lines.push("");
  lines.push("5. The report is prepared in the prescribed form and manner.");
  lines.push("");
  lines.push("Certified by:");
  lines.push("");
  lines.push("_____________________________");
  lines.push("Name: ______________________");
  lines.push("Membership No: _____________");
  lines.push("Address: __________________");
  lines.push("Date: ______________________");
  lines.push("Place: _____________________");

  return lines.join("\n");
}

export function clause13Turnover(
  turnover: number,
  exports: number | null,
  interState: number | null,
  intraState: number | null,
): AuditObservation {
  const lines: string[] = [`Turnover as per GST return: ${formatInr(turnover)}`];
  if (exports !== null) lines.push(`  Exports: ${formatInr(exports)}`);
  if (interState !== null) lines.push(`  Inter-state supplies: ${formatInr(interState)}`);
  if (intraState !== null) lines.push(`  Intra-state supplies: ${formatInr(intraState)}`);

  return {
    clauseNumber: "13",
    clauseTitle: "Summarised particulars of turnover",
    finding: "satisfied",
    comment: lines.join("\n"),
  };
}

export function clause14Expenditure(
  totalExpenditure: number,
  disallowed: number | null,
  reason?: string,
): AuditObservation {
  const lines: string[] = [`Total expenditure as per books: ${formatInr(totalExpenditure)}`];
  if (disallowed !== null && disallowed > 0) {
    lines.push(`Disallowed expenditure: ${formatInr(disallowed)}`);
    if (reason) lines.push(`Reason: ${reason}`);
  }

  return {
    clauseNumber: "14",
    clauseTitle: "Amount of expenditure",
    finding: disallowed !== null && disallowed > 0 ? "qualified" : "satisfied",
    comment: lines.join("\n"),
    qualify: disallowed !== null && disallowed > 0 ? `Disallowance of ${formatInr(disallowed)} u/s ______.` : undefined,
  };
}

export function clause17CashTransactions(totalCashReceipts: number, totalCashPayments: number): AuditObservation {
  return {
    clauseNumber: "17",
    clauseTitle: "Cash transactions",
    finding: "satisfied",
    comment: `Total cash receipts: ${formatInr(totalCashReceipts)}\nTotal cash payments: ${formatInr(totalCashPayments)}`,
  };
}

export function clause18TDS(totalTDS: number, totalDeposited: number): AuditObservation {
  const shortfall = totalTDS - totalDeposited;
  return {
    clauseNumber: "18",
    clauseTitle: "Income Tax/TDS deducted",
    finding: shortfall > 0 ? "qualified" : "satisfied",
    comment: `TDS deducted: ${formatInr(totalTDS)}\nTDS deposited: ${formatInr(totalDeposited)}${shortfall > 0 ? `\nShortfall: ${formatInr(shortfall)}` : ""}`,
    qualify: shortfall > 0 ? `TDS shortfall of ${formatInr(shortfall)}.` : undefined,
  };
}

export function clause20Presumptive(
  grossReceipts: number,
  presumptiveIncome: number,
  rateClaimed: number,
): AuditObservation {
  return {
    clauseNumber: "20",
    clauseTitle: "Presumptive taxation u/s 44ADA",
    finding: grossReceipts > 50_00_000 ? "qualified" : "satisfied",
    comment: `Gross receipts: ${formatInr(grossReceipts)}\nPresumptive income at ${rateClaimed * 100}%: ${formatInr(presumptiveIncome)}`,
    qualify: grossReceipts > 50_00_000 ? `Receipts exceed Rs. 50 lakh - audit required.` : undefined,
  };
}
