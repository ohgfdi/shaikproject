/**\n * Deliverable coefficient library — the firm's reusable wording, clause\n * references, and paragraph precedents for CA deliverables.\n *\n * Pure functions/consts only; no DB access.\n */

// ---------------------------------------------------------------------------
// Format to standard clause set
// ---------------------------------------------------------------------------

export type ClauseRef =
  | "SA 200"
  | "SA 210"
  | "SA 230"
  | "SA 240"
  | "SA 250"
  | "SA 260"
  | "SA 265"
  | "SA 270"
  | "SA 300"
  | "SA 315"
  | "SA 320"
  | "SA 330"
  | "SA 450"
  | "SA 450"
  | "SA 500"
  | "SA 505"
  | "SA 520"
  | "SA 530"
  | "SA 540"
  | "SA 550"
  | "SA 630"
  | "SA 630"
  | "SA 700"
  | "SA 705"
  | "SA 710"
  | "SA 800"
  | "SA 805"
  | "SA 810"
  | "S-2"
  | "S-4"
  | "44AB"
  | "44ADA"
  | "44AD"
  | "44AE"
  | "40a"
  | "43B"
  | "43BA"
  | "43C"
  | "80C"
  | "80D"
  | "80E"
  | "80G"
  | "80TTA"
  | "80TTB"
  | "92E"
  | "94B"
  | "GST"
  | "ITC"
  | "ROC"
  | "PT";

export const CLAUSE_LABELS: Record<ClauseRef, string> = {
  "SA 200": "SA 200 — Objective and general principles governing an audit of financial statements",
  "SA 210": "SA 210 — Agreeing the terms of audit engagements",
  "SA 230": "SA 230 — Audit documentation",
  "SA 240": "SA 240 — The auditor's responsibilities relating to fraud",
  "SA 250": "SA 250 — Consideration of laws and regulations in an audit of financial statements",
  "SA 260": "SA 260 — Communication with those charged with governance",
  "SA 265": "SA 265 — Communicating deficiencies in internal control to those charged with governance",
  "SA 270": "SA 270 — Going concern",
  "SA 300": "SA 300 — Planning an audit of financial statements",
  "SA 315": "SA 315 — Identifying and assessing the risks of material misstatement",
  "SA 320": "SA 320 — Materiality in planning and performing an audit",
  "SA 330": "SA 330 — The auditor's responses to assessed risks",
  "SA 450": "SA 450 — Evaluation of misstatements identified during the audit",
  "SA 500": "SA 500 — Audit evidence",
  "SA 505": "SA 505 — External confirmations",
  "SA 520": "SA 520 — Analytical procedures",
  "SA 530": "SA 530 — Audit sampling",
  "SA 540": "SA 540 — Auditing accounting estimates",
  "SA 550": "SA 550 — Related parties",
  "SA 630": "SA 630 — The auditor's consideration of internal control",
  "SA 700": "SA 700 — Forming an opinion and reporting on financial statements",
  "SA 705": "SA 705 — Modifications to the opinion in the independent auditor's report",
  "SA 710": "SA 710 — Other matter paragraphs in the independent auditor's report",
  "SA 800":
    "SA 800 — Special considerations—audit of financial statements prepared in accordance with a special purpose framework",
  "SA 805": "SA 805 — Special considerations—audit of individual financial statements",
  "SA 810": "SA 810 — Special considerations—audit of financial information in specific documents",
  "S-2": "S-2 — Audit report on consolidated financial statements",
  "S-4": "S-4 — Audit report under section 227 of the Companies Act",
  "44AB": "Section 44AB — Tax audit requirement (turnover/receipts threshold)",
  "44ADA": "Section 44ADA — Presumptive taxation for professional services",
  "44AD": "Section 44AD — Presumptive taxation for eligible businesses",
  "44AE": "Section 44AE — Presumptive taxation for heavy goods vehicles",
  "40a": "Section 40(a) — Disallowance of expenses on account of TDS default",
  "43B": "Section 43B — Deduction on actual payment basis",
  "43BA": "Section 43BA — Payment to micro/small enterprises (43B(h))",
  "43C": "Section 43C — Payment to crore-plus enterprises",
  "80C": "Section 80C — Deduction for investments/insurance/education",
  "80D": "Section 80D — Deduction for medical insurance premium",
  "80E": "Section 80E — Deduction for interest on education loan",
  "80G": "Section 80G — Deduction for donations",
  "80TTA": "Section 80TTA — Deduction for interest on savings account",
  "80TTB": "Section 80TTB — Deduction for interest for senior citizens",
  "92E": "Section 92E — Report by accountant (Form 3CEB)",
  "94B": "Section 94B — Thin capitalisation (interest limitation)",
  GST: "Goods and Services Tax — compliance and reconciliation",
  ITC: "Input Tax Credit — availability, reversal, reconciliation",
  ROC: "Registrar of Companies — compliance filings",
  PT: "Professional Tax — state-level compliance",
};

/** The clause refs a deliverable of this format typically needs to cite. */
export function defaultClausesForFormat(formatCode: string): ClauseRef[] {
  const sets: Record<string, ClauseRef[]> = {
    FINANCIALS: ["SA 200", "SA 210", "SA 300", "SA 700", "S-2"],
    PROFIT_LOSS: ["SA 700", "S-4"],
    BALANCE_SHEET: ["SA 700", "S-4"],
    NOTES: ["SA 500", "SA 700", "S-4"],
    SCHEDULES: ["SA 700", "S-4"],
    MGMT_LETTER: ["SA 260", "SA 265", "SA 315", "SA 630"],
    TAX_COMPUTATION: ["40a", "43B", "43BA", "43C"],
    CERTIFICATE_44AB: ["44AB"],
    CERTIFICATE_44ADA: ["44ADA"],
    CERTIFICATE_44AD: ["44AD"],
    TAX_CONCLUSION: ["40a", "43B", "43BA", "43C", "80C", "80D", "80E", "80G", "80TTA", "80TTB"],
    AUDIT_FINDINGS: ["SA 260", "SA 265", "SA 315", "SA 450", "SA 500", "SA 540"],
    MANAGING_AGENT_LETTER: ["SA 260", "SA 265"],
    LETTER_TO_CLIENT: ["SA 210", "SA 260", "SA 700"],
  };
  return sets[formatCode] ?? ["SA 700"];
}

// ---------------------------------------------------------------------------
// Certificate wording
// ---------------------------------------------------------------------------

export function certificate44ABWording(params: {
  firmName: string;
  clientName: string;
  assessmentYear: string;
  periodEnding: string;
  turnoverGross: string;
  turnoverExempt: string;
  cashReceipts: string;
  bookkeeping: string;
  auditPerformedBy: string;
  auditPerformedFrom: string;
  auditPerformedTo: string;
  notes: string[];
}): string {
  const noteLines = params.notes.length
    ? params.notes.map((n, i) => `${i + 1}. ${n}`).join("\n")
    : "No observations to report.";
  return `**Certificate under section 44AB of the Income-tax Act, 1961**

We, ${params.auditPerformedBy}, are a chartered accountant within the meaning of the Chartered Accountants Act, 1949 and we are in practice as a firm.

We have audited the accounts of ${params.clientName} for the period ended ${params.periodEnding} relevant to the assessment year ${params.assessmentYear}.

---

**Statement of facts**

| Particulars | Amount |
|---|---|
| a. Turnover or gross receipts as per the books of account | ${params.turnoverGross} |
| b. Turnover or gross receipts as per the return of income | ${params.turnoverGross} |
| c. Amount of turnover or gross receipts not taxable under sections 44AB/44ADA | ${params.turnoverExempt} |
| d. Cash received during the year (as per books) | ${params.cashReceipts} |
| e. Whether books of account are kept on a regular basis | ${params.bookkeeping} |
| f. Whether accounts have been audited earlier | No |

---

**Opinion**

Based on our audit, and subject to the remarks/qualifications, if any, set out in the accompanying report, we report that:

1. The books of account maintained by ${params.clientName} necessary to give a true and fair view of the state of affairs are correct to the best of our knowledge and belief.
2. The turnover or gross receipts from all the businesses/professions carried on by the assessee and the amounts referred to in clauses (a) to (d) above are correctly stated in the return of income.
3. The deductions/upwards adjustments, if any, from the turnover/gross receipts claimed by the assessee in the return of income are correctly stated.
4. The information, particulars, and explanations required to be furnished under the provisions of section 44AB are true and correct.

We further report that:

${noteLines}

---

We understand that penalty proceedings under section 271B/271BB of the Income-tax Act, 1961 may be initiated against the assessee if the return of income is not furnished by the due date.

Signed for and on behalf of

${params.auditPerformedBy}
Chartered Accountant, Firm Reg. No. ____________
UDIN: ____________
Address: ${params.firmName}
Date: ${params.auditPerformedTo}
Place: ____________`;
}

export function certificate44ADAWording(params: {
  firmName: string;
  clientName: string;
  assessmentYear: string;
  periodEnding: string;
  grossReceiptsPerBooks: string;
  grossReceiptsPerReturn: string;
  bankingChannelPct: string;
  presumptiveIncomeDeclared: string;
  expensesClaimedOver80Pct: string;
  auditPerformedBy: string;
  auditPerformedFrom: string;
  auditPerformedTo: string;
  notes: string[];
}): string {
  const noteLines = params.notes.length
    ? params.notes.map((n, i) => `${i + 1}. ${n}`).join("\n")
    : "The audit did not throw up any observation to report.";
  return `**Certificate under section 44ADA of the Income-tax Act, 1961**

We, ${params.auditPerformedBy}, chartered accountant in practice, have audited the accounts of ${params.clientName} for the period ended ${params.periodEnding} relevant to the assessment year ${params.assessmentYear}.

---

**Statement of facts**

| Particulars | Amount |
|---|---|
| a. Gross receipts/professional income as per books of account | ${params.grossReceiptsPerBooks} |
| b. Gross receipts/professional income as per return of income | ${params.grossReceiptsPerReturn} |
| c. Banking channel percentage | ${params.bankingChannelPct}% |
| d. Claimed presumptive income | ${params.presumptiveIncomeDeclared} |
| e. Whether total expenditure claimed exceeds 50% of gross receipts | ${params.expensesClaimedOver80Pct} |

---

**Observations**

${noteLines}

Signed for and on behalf of

${params.auditPerformedBy}
Chartered Accountant, Firm Reg. No. ____________
UDIN: ____________
Address: ${params.firmName}
Date: ${params.auditPerformedTo}
Place: ____________`;
}

export function certificate44ADWording(params: {
  firmName: string;
  clientName: string;
  assessmentYear: string;
  periodEnding: string;
  turnoverGross: string;
  cashReceipts: string;
  bankingChannelPct: string;
  presumptiveIncomeDeclared: string;
  auditPerformedBy: string;
  auditPerformedFrom: string;
  auditPerformedTo: string;
  notes: string[];
}): string {
  const noteLines = params.notes.length
    ? params.notes.map((n, i) => `${i + 1}. ${n}`).join("\n")
    : "No observations to report.";
  return `**Certificate under section 44AD of the Income-tax Act, 1961**

We, ${params.auditPerformedBy}, have audited the accounts of ${params.clientName} for the period ended ${params.periodEnding} relevant to the assessment year ${params.assessmentYear}.

---

**Statement of facts**

| Particulars | Amount |
|---|---|
| a. Turnover or gross receipts as per books of account | ${params.turnoverGross} |
| b. Turnover or gross receipts as per return of income | ${params.turnoverGross} |
| c. Cash received during the year | ${params.cashReceipts} |
| d. Percentage of receipts through banking channel | ${params.bankingChannelPct}% |
| e. Presumptive income declared | ${params.presumptiveIncomeDeclared} |

---

**Observations**

${noteLines}

Signed for and on behalf of

${params.auditPerformedBy}
Chartered Accountant, Firm Reg. No. ____________
UDIN: ____________
Address: ${params.firmName}
Date: ${params.auditPerformedTo}
Place: ____________`;
}

export function advanceTaxComputationWording(params: {
  firmName: string;
  clientName: string;
  assessmentYear: string;
  periodEnding: string;
  totalIncomeComputed: string;
  taxLiabilityTotal: string;
  tdsTcsCredit: string;
  advanceTaxPaid: string;
  selfAssessmentTaxPayable: string;
  instalmentDueDates: { dueDate: string; payable: string }[];
  signingCa: string;
}): string {
  const instalmentRows = params.instalmentDueDates.map((inst) => `| ${inst.dueDate} | ${inst.payable} |`).join("\n");
  return `**Computation of advance tax payable for the assessment year ${params.assessmentYear}**

Prepared by ${params.signingCa} on behalf of ${params.clientName} for the period ended ${params.periodEnding}.

---

| Step | Particulars | Amount |
|---|---|---|
| 1 | Total income computed for the year | ${params.totalIncomeComputed} |
| 2 | Tax on total income as per applicable rates | ${params.taxLiabilityTotal} |
| 3 | Less: TDS/TCS credit available | (${params.tdsTcsCredit}) |
| 4 | Net tax payable after TDS/TCS | (${params.tdsTcsCredit}) |
| 5 | Less: Advance tax already paid | (${params.advanceTaxPaid}) |
| 6 | Self-assessment tax payable before filing | ${params.selfAssessmentTaxPayable} |

---

**Instalment schedule**

| Due date | Advance tax payable |
|---|---|
${instalmentRows}

---

This computation is based on the estimates and books of account available to us as at the date of signing. Figures are subject to finalisation on completion of the year.

Signed for and on behalf of

${params.signingCa}
Chartered Accountant
Date: ${params.periodEnding}
`;
}

// ---------------------------------------------------------------------------
// Management letter paragraph library
// ---------------------------------------------------------------------------

export interface MgmtLetterSection {
  heading: string;
  kind: "required" | "optional" | "observations";
  body: string;
}

export const MGMT_LETTER_SKELETON: MgmtLetterSection[] = [
  {
    heading: "Introduction and scope",
    kind: "required",
    body: `We have examined the financial statements of {clientName} for the period ended {periodEnding} and performed our audit in accordance with the Standards on Auditing issued by the Institute of Chartered Accountants of India (ICAI). This management letter sets out our observations, suggestions, and recommendations arising from our audit for the improvement of the internal control system, accounting systems, and practices of the entity.`,
  },
  {
    heading: "Basis of preparation",
    kind: "required",
    body: `The financial statements have been prepared under the historical cost convention and on the going concern basis, and they comply in all material respects with the Accounting Standards notified under the Companies (Accounting Standards) Rules and with the provisions of the Income-tax Act, 1961, as applicable.`,
  },
  {
    heading: "Summary of observations",
    kind: "observations",
    body: `{observations}

The above observations are made solely for the purpose of bringing to the attention of the management points that may require action. These do not in any way reflect on the fair presentation of the financial statements, which we have audited and reported on separately.`,
  },
  {
    heading: "Suggestions for improvement",
    kind: "optional",
    body: `{suggestions}

We would be happy to discuss any of the above with the management at its convenience.`,
  },
];

// ---------------------------------------------------------------------------
// Letter to client
// ---------------------------------------------------------------------------

export function letterToClientWording(params: {
  firmName: string;
  clientName: string;
  engagementName: string;
  periodEnding: string;
  reportDate: string;
  scopeSummary: string;
  reportingFramework: string;
  managementResponsibilities: string;
  expectedDelivery: string;
}): string {
  return `**Letter to the client — Report on audit of financial statements**

${params.clientName}

Dear Sirs/Madams,

We have audited the financial statements of ${params.clientName} for the period ended ${params.periodEnding}. We refer to our letter of engagement dated {engagementLetterDate} and the terms agreed therein.

---

**Scope of audit**

${params.scopeSummary}

The financial statements have been prepared on the {reportingFramework} basis. The financial statements are the responsibility of the management. Our responsibility is to express an opinion on these financial statements based on our audit.

---

**Management's responsibilities**

${params.managementResponsibilities}

---

**Reporting**

We will issue our report on the audit of the financial statements to you by ${params.expectedDelivery}. The report will be addressed to the members/shareholders of the entity as applicable, and we will also communicate certain matters to those charged with governance as required under the Standards on Auditing.

This report is confidential and intended solely for the addressee. It must not be used for any other purpose without our prior written consent.

Yours faithfully,

${params.firmName}
${params.reportDate}`;
}

// ---------------------------------------------------------------------------
// Notes-to-accounts skeleton
// ---------------------------------------------------------------------------

export const NOTES_SKELETON_TITLES: string[] = [
  "Significant accounting policies",
  "Revenue from operations",
  "Significant estimates and judgments",
  "Fixed assets",
  "Investments",
  "Borrowed funds and other liabilities",
  "Provisions and contingent liabilities",
  "Related party transactions",
  "Employee benefits",
  "Income tax / tax expense",
  "Earnings per share (if applicable)",
  "Segment information (if applicable)",
  "Events occurring after the balance sheet date",
  "Related party disclosures",
  "Fair value measurements",
  "Financial instruments",
];

// ---------------------------------------------------------------------------
// Audit findings summary
// ---------------------------------------------------------------------------

export interface AuditFinding {
  ref: string;
  title: string;
  severity: "material" | "significant" | "observation";
  description: string;
  recommendation: string;
  managementResponse: string | null;
  saRef?: ClauseRef;
}

export function auditFindingsSummary(findings: AuditFinding[]): string {
  if (!findings.length) {
    return "No observations to report from the audit procedures performed for the period.";
  }
  const blocks = findings.map((f) => {
    const severityLabel =
      f.severity === "material" ? "Material" : f.severity === "significant" ? "Significant" : "Observation";
    const sa = f.saRef ? ` | ${f.saRef}` : "";
    return `**${severityLabel} — ${f.title}** (Ref: ${f.ref}${sa})

${f.description}

*Recommendation:* ${f.recommendation}

*Management response:* ${f.managementResponse ?? "Not yet provided."}

`;
  });
  return blocks.join("\n---\n");
}
