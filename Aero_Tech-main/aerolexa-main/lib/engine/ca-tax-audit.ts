/**
 * Tax-audit determinations — whether the Indian book-audit requirement under
 * S.44AB is triggered for a business.
 *
 * SCOPE AND HONESTY: the thresholds below are the commonly referenced ones and
 * are surfaced on the result so a reviewer can verify them against the current
 * Finance Act / notification for the relevant FY. The engine is arithmetic on
 * caller-supplied turnover figures; it does not fetch live law and does not
 * issue a legal opinion.
 */

export interface AuditTrigger {
  name: string;
  applies: boolean;
  note: string;
}

export interface TaxAuditResult {
  fy: string;
  entityType: string;
  turnoverAnalysis: {
    grossTurnover: number;
    presumptiveTurnover: number;
    exemptTurnover: number;
    turnoverForAuditLimitation: number;
  };
  triggers: AuditTrigger[];
  checklist: string[];
  warnings: string[];
  methodology: string[];
}

const RESIDENT_LIMIT = {
  limit: 100_00_00_000,
  note: " resident individual/HUF/partnership/LLP limit commonly referenced for S.44AB.",
};

const TURNOVER_LIMITS: Record<string, { limit: number; note: string }> = {
  "domestic-company": {
    limit: 100_00_00_000,
    note: " domestic company limit commonly referenced for S.44AB (turnover/gross receipts).",
  },
  "unlisted-company": { limit: 100_00_00_000, note: " unlisted company limit commonly referenced for S.44AB." },
  "hindu-undivided-family": { limit: 100_00_00_000, note: " HUF limit commonly referenced for S.44AB." },
  "partnership-firm": { limit: 100_00_00_000, note: " partnership firm limit commonly referenced for S.44AB." },
  llp: { limit: 100_00_00_000, note: " LLP limit commonly referenced for S.44AB." },
  resident: RESIDENT_LIMIT,
  "non-resident": { limit: 100_00_00_000, note: " non-resident limit commonly referenced for S.44AB." },
};

export function determineTaxAudit(input: {
  fy: string;
  entityType: string;
  category?: string;
  turnover: number;
  presumptiveTurnover: number;
  exemptTurnover: number;
  booksRequired: boolean;
  auditedTurnoverFlag: boolean;
  professionalServices: boolean;
  presumptiveOpted: boolean;
  digitalReceiptsPct: number;
}): TaxAuditResult {
  const {
    fy,
    entityType,
    category = "resident",
    turnover,
    presumptiveTurnover,
    exemptTurnover,
    booksRequired,
    auditedTurnoverFlag,
    professionalServices,
    presumptiveOpted,
    digitalReceiptsPct,
  } = input;

  const effectiveCategory = TURNOVER_LIMITS[category] ? category : "resident";
  const limitRow = TURNOVER_LIMITS[effectiveCategory] ?? RESIDENT_LIMIT;
  const limitation = limitRow.limit;

  // Turnover/gross receipts for the limitation is generally the aggregate
  // turnover, including taxable + exempt + presumptive additions, less
  // inter-branch/ inter-company eliminations the assessee is entitled to.
  const turnoverForAuditLimitation = turnover + presumptiveTurnover + exemptTurnover;

  const triggers: AuditTrigger[] = [];

  triggers.push({
    name: "S.44AB book-audit (turnover/gross receipts above limitation)",
    applies: turnoverForAuditLimitation >= limitation,
    note: `Aggregate turnover/gross receipts of ${turnoverForAuditLimitation} vs the commonly referenced ${limitRow.limit} limitation for ${effectiveCategory}${limitRow.note}`,
  });

  triggers.push({
    name: "Books of account required to be maintained",
    applies: booksRequired,
    note: booksRequired
      ? "Books of account are required to be maintained; failure to maintain may have consequences beyond audit-threshold analysis."
      : "Books of account are not required to be maintained.",
  });

  triggers.push({
    name: "Audited turnover flag",
    applies: auditedTurnoverFlag,
    note: auditedTurnoverFlag ? "Audited turnover figure is flagged for review." : "No audited turnover flag supplied.",
  });

  if (professionalServices) {
    triggers.push({
      name: "Professional services — presumptive provisions may apply",
      applies: true,
      note: "If the assessee is carrying on a profession, the profession-specific presumptive provisions (e.g. S.44ADA) may be relevant and should be reviewed separately.",
    });
  }

  if (presumptiveOpted) {
    triggers.push({
      name: "Presumptive scheme opted (44AD/ADA/AGS)",
      applies: true,
      note: "Where a presumptive scheme is opted, the scheme conditions (including the 5% digital receipts rule for 44AD) and the consequences on exit should be reviewed.",
    });
    if (digitalReceiptsPct >= 5) {
      triggers.push({
        name: "Digital receipts >= 5% (44AD relevance)",
        applies: true,
        note: `Digital receipts share is ${digitalReceiptsPct}%, which is at or above the 5% level commonly referenced for 44AD eligibility.`,
      });
    } else {
      triggers.push({
        name: "Digital receipts < 5%",
        applies: true,
        note: `Digital receipts share is ${digitalReceiptsPct}%, which is below the 5% level commonly referenced for 44AD eligibility.`,
      });
    }
  }

  const checklist: string[] = [
    `Confirm the relevant FY is ${fy}.`,
    `Aggregate turnover/gross receipts: ${turnoverForAuditLimitation} (turnover ${turnover} + presumptive ${presumptiveTurnover} + exempt ${exemptTurnover}).`,
    `Applicable limitation for ${effectiveCategory}: ${limitation} (commonly referenced; verify current notification).`,
    `Audit threshold crossed: ${turnoverForAuditLimitation >= limitation}.`,
    `Books of account maintained: ${booksRequired}.`,
    `Professional services: ${professionalServices}.`,
    `Presumptive scheme opted: ${presumptiveOpted}.`,
    `Digital receipts share: ${digitalReceiptsPct}%.`,
  ];

  const warnings: string[] = [];
  if (turnoverForAuditLimitation < limitation) {
    warnings.push(
      `Based on the inputs, the commonly referenced S.44AB limitation of ${limitation} is not crossed; confirm whether any other provision requires an audit for this entity.`,
    );
  } else {
    warnings.push(
      `Based on the inputs, the commonly referenced S.44AB limitation of ${limitation} is crossed; confirm the computation basis and exclusions with the engagement team.`,
    );
  }

  return {
    fy,
    entityType,
    turnoverAnalysis: { grossTurnover: turnover, presumptiveTurnover, exemptTurnover, turnoverForAuditLimitation },
    triggers,
    checklist,
    warnings,
    methodology: [
      "The engine compares aggregate turnover/gross receipts against the commonly referenced S.44AB limitation for the entity category.",
      "Turnover for the limitation includes taxable + exempt + presumptive additions supplied by the caller.",
      "Thresholds are surfaced on the result so a reviewer can verify them against the current Finance Act / notification for the FY.",
    ],
  };
}
