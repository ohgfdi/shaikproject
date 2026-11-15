/**
 * Compliance calendar — statutory filing due dates across GST, income-tax,
 * TDS/TCS, ROC/MCA, professional tax and labour/statutory returns.
 *
 * SCOPE AND HONESTY: the due dates below are the commonly referenced statutory
 * due dates and are surfaced on the result so a reviewer can verify them
 * against the current law/notification. The engine is date arithmetic on
 * caller-supplied parameters; it does not fetch live law and does not issue a
 * legal opinion.
 */

export interface ComplianceItem {
  jurisdiction: "india";
  area: "gst" | "income-tax" | "tds-tcs" | "roc-mca" | "professional-tax" | "labour-statutory";
  filingType: string;
  dueDate: string; // ISO YYYY-MM-DD
  status: "upcoming" | "due" | "overdue";
  daysToDue: number;
  note: string;
}

export interface ComplianceCalendar {
  periodStart: string;
  periodEnd: string;
  items: ComplianceItem[];
  warnings: string[];
}

function parseISODate(s: string): Date {
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO date: ${s}`);
  return d;
}

function daysBetween(from: Date, to: Date): number {
  // Whole-day difference between two dates.
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / msPerDay);
}

function statusOf(
  dueDate: Date,
  periodStart: Date,
  periodEnd: Date,
  windowEnd: Date,
): { status: "upcoming" | "due" | "overdue"; daysToDue: number } {
  const today = windowEnd;
  if (dueDate.getTime() < today.getTime()) {
    return { status: "overdue", daysToDue: daysBetween(dueDate, today) };
  }
  const days = daysBetween(today, dueDate);
  if (days === 0) return { status: "due", daysToDue: 0 };
  return { status: "upcoming", daysToDue: days };
}

export function buildComplianceCalendar(input: {
  periodStart: string;
  periodEnd: string;
  jurisdiction: "india";
  entityType: "company" | "llp" | "partnership" | "proprietorship" | "individual";
  gstRegistered: boolean;
  withholdingAgent: boolean;
  professionalTaxState?: string;
  windowDays: number;
}): ComplianceCalendar {
  const {
    periodStart,
    periodEnd,
    jurisdiction,
    entityType,
    gstRegistered,
    withholdingAgent,
    professionalTaxState,
    windowDays,
  } = input;

  const periodStartD = parseISODate(periodStart);
  const periodEndD = parseISODate(periodEnd);
  const windowEnd = parseISODate(
    new Date(periodEndD.getUTCFullYear(), periodEndD.getUTCMonth(), periodEndD.getUTCDate() + windowDays)
      .toISOString()
      .slice(0, 10),
  );

  const items: ComplianceItem[] = [];

  // GST — GSTR-1 and GSTR-3B are generally monthly; GSTR-9/9C annual.
  if (gstRegistered) {
    const gstEnd = new Date(periodEndD.getUTCFullYear(), periodEndD.getUTCMonth() + 1, 0);
    // GSTR-1 generally due 11th of the following month; GSTR-3B generally due 20th.
    const gstr1Due = new Date(gstEnd.getUTCFullYear(), gstEnd.getUTCMonth() + 1, 11);
    const gstr3bDue = new Date(gstEnd.getUTCFullYear(), gstEnd.getUTCMonth() + 1, 20);
    items.push({
      jurisdiction,
      area: "gst",
      filingType: "GSTR-1",
      dueDate: gstr1Due.toISOString().slice(0, 10),
      ...statusOf(gstr1Due, periodStartD, periodEndD, windowEnd),
      note: "Outward supply statement; generally due 11th of the month following the tax period.",
    });
    items.push({
      jurisdiction,
      area: "gst",
      filingType: "GSTR-3B",
      dueDate: gstr3bDue.toISOString().slice(0, 10),
      ...statusOf(gstr3bDue, periodStartD, periodEndD, windowEnd),
      note: "Monthly summary return; generally due 20th of the month following the tax period.",
    });
    // Annual return GSTR-9 generally due 31st December of the year following the FY.
    const fyEnd = new Date(periodEndD.getUTCFullYear(), periodEndD.getUTCMonth(), periodEndD.getUTCDate());
    const gstr9Due = new Date(fyEnd.getUTCFullYear() + 1, 11, 31);
    items.push({
      jurisdiction,
      area: "gst",
      filingType: "GSTR-9 (annual)",
      dueDate: gstr9Due.toISOString().slice(0, 10),
      ...statusOf(gstr9Due, periodStartD, periodEndD, windowEnd),
      note: "Annual return; generally due 31st December of the year following the financial year.",
    });
    items.push({
      jurisdiction,
      area: "gst",
      filingType: "GSTR-9C (reconciliation, if applicable)",
      dueDate: gstr9Due.toISOString().slice(0, 10),
      ...statusOf(gstr9Due, periodStartD, periodEndD, windowEnd),
      note: "Reconciliation statement; generally due with GSTR-9 for eligible taxpayers.",
    });
  }

  // Income-tax — ITR generally due 31st July for individuals; 30th Sept for
  // companies; audit reports generally due 30th Sept (30th Nov for some cases).
  const fyEndYear = periodEndD.getUTCFullYear();
  const itrDueIndividual = new Date(fyEndYear + 1, 6, 31);
  const itrDueCompany = new Date(fyEndYear + 1, 8, 30);
  const auditReportDueSept = new Date(fyEndYear + 1, 8, 30);
  const auditReportDueNov = new Date(fyEndYear + 1, 10, 30);

  if (entityType === "individual" || entityType === "proprietorship") {
    items.push({
      jurisdiction,
      area: "income-tax",
      filingType: "ITR (individual/proprietor)",
      dueDate: itrDueIndividual.toISOString().slice(0, 10),
      ...statusOf(itrDueIndividual, periodStartD, periodEndD, windowEnd),
      note: "Income-tax return; generally due 31st July of the assessment year for individuals.",
    });
  }
  if (entityType === "company" || entityType === "llp" || entityType === "partnership") {
    items.push({
      jurisdiction,
      area: "income-tax",
      filingType: "ITR (company/firm)",
      dueDate: itrDueCompany.toISOString().slice(0, 10),
      ...statusOf(itrDueCompany, periodStartD, periodEndD, windowEnd),
      note: "Income-tax return; generally due 30th September of the assessment year for companies.",
    });
  }

  items.push({
    jurisdiction,
    area: "income-tax",
    filingType: "Audit report (S.44AB etc.)",
    dueDate: auditReportDueSept.toISOString().slice(0, 10),
    ...statusOf(auditReportDueSept, periodStartD, periodEndD, windowEnd),
    note: "Tax audit report generally due 30th September of the assessment year; certain cases may be 30th November.",
  });
  items.push({
    jurisdiction,
    area: "income-tax",
    filingType: "Audit report (alternative due date)",
    dueDate: auditReportDueNov.toISOString().slice(0, 10),
    ...statusOf(auditReportDueNov, periodStartD, periodEndD, windowEnd),
    note: "Alternative audit report due date 30th November for certain cases; confirm applicability.",
  });

  // Advance-tax instalments — non-corporate generally Jun/ Sept/ Dec/ Mar;
  // corporate generally Jun/ Sept/ Dec/ Mar (15th of the month).
  if (entityType === "individual" || entityType === "proprietorship") {
    const adv1 = new Date(fyEndYear, 5, 15);
    const adv2 = new Date(fyEndYear, 8, 15);
    const adv3 = new Date(fyEndYear, 11, 15);
    const adv4 = new Date(fyEndYear + 1, 2, 15);
    items.push({
      jurisdiction,
      area: "income-tax",
      filingType: "Advance-tax instalment 1",
      dueDate: adv1.toISOString().slice(0, 10),
      ...statusOf(adv1, periodStartD, periodEndD, windowEnd),
      note: "Advance-tax instalment 1 for non-corporate; generally due 15th June.",
    });
    items.push({
      jurisdiction,
      area: "income-tax",
      filingType: "Advance-tax instalment 2",
      dueDate: adv2.toISOString().slice(0, 10),
      ...statusOf(adv2, periodStartD, periodEndD, windowEnd),
      note: "Advance-tax instalment 2 for non-corporate; generally due 15th September.",
    });
    items.push({
      jurisdiction,
      area: "income-tax",
      filingType: "Advance-tax instalment 3",
      dueDate: adv3.toISOString().slice(0, 10),
      ...statusOf(adv3, periodStartD, periodEndD, windowEnd),
      note: "Advance-tax instalment 3 for non-corporate; generally due 15th December.",
    });
    items.push({
      jurisdiction,
      area: "income-tax",
      filingType: "Advance-tax instalment 4",
      dueDate: adv4.toISOString().slice(0, 10),
      ...statusOf(adv4, periodStartD, periodEndD, windowEnd),
      note: "Advance-tax instalment 4 for non-corporate; generally due 15th March.",
    });
  } else {
    // Corporate instalments generally due 15th of Jun, Sep, Dec, Mar (FY).
    const cadv1 = new Date(fyEndYear, 5, 15);
    const cadv2 = new Date(fyEndYear, 8, 15);
    const cadv3 = new Date(fyEndYear, 11, 15);
    const cadv4 = new Date(fyEndYear + 1, 2, 15);
    items.push({
      jurisdiction,
      area: "income-tax",
      filingType: "Advance-tax instalment 1 (corporate)",
      dueDate: cadv1.toISOString().slice(0, 10),
      ...statusOf(cadv1, periodStartD, periodEndD, windowEnd),
      note: "Advance-tax instalment 1 for corporate; generally due 15th June of FY.",
    });
    items.push({
      jurisdiction,
      area: "income-tax",
      filingType: "Advance-tax instalment 2 (corporate)",
      dueDate: cadv2.toISOString().slice(0, 10),
      ...statusOf(cadv2, periodStartD, periodEndD, windowEnd),
      note: "Advance-tax instalment 2 for corporate; generally due 15th September of FY.",
    });
    items.push({
      jurisdiction,
      area: "income-tax",
      filingType: "Advance-tax instalment 3 (corporate)",
      dueDate: cadv3.toISOString().slice(0, 10),
      ...statusOf(cadv3, periodStartD, periodEndD, windowEnd),
      note: "Advance-tax instalment 3 for corporate; generally due 15th December of FY.",
    });
    items.push({
      jurisdiction,
      area: "income-tax",
      filingType: "Advance-tax instalment 4 (corporate)",
      dueDate: cadv4.toISOString().slice(0, 10),
      ...statusOf(cadv4, periodStartD, periodEndD, windowEnd),
      note: "Advance-tax instalment 4 for corporate; generally due 15th March of FY.",
    });
  }

  // TDS/TCS — challan deposit generally by 7th of the following month;
  // statements (24Q/26Q/27Q) generally due 31st July (Q1), 31st Oct (Q2),
  // 31st Jan (Q3), 31st May (Q4); annual/false certificate due 31st Jan.
  if (withholdingAgent) {
    // Quarterly statement due dates.
    const q1Due = new Date(fyEndYear, 6, 31);
    const q2Due = new Date(fyEndYear, 9, 31);
    const q3Due = new Date(fyEndYear + 1, 0, 31);
    const q4Due = new Date(fyEndYear + 1, 4, 31);
    items.push({
      jurisdiction,
      area: "tds-tcs",
      filingType: "TDS/TCS statement Q1",
      dueDate: q1Due.toISOString().slice(0, 10),
      ...statusOf(q1Due, periodStartD, periodEndD, windowEnd),
      note: "Quarterly TDS statement; generally due 31st July of FY.",
    });
    items.push({
      jurisdiction,
      area: "tds-tcs",
      filingType: "TDS/TCS statement Q2",
      dueDate: q2Due.toISOString().slice(0, 10),
      ...statusOf(q2Due, periodStartD, periodEndD, windowEnd),
      note: "Quarterly TDS statement; generally due 31st October of FY.",
    });
    items.push({
      jurisdiction,
      area: "tds-tcs",
      filingType: "TDS/TCS statement Q3",
      dueDate: q3Due.toISOString().slice(0, 10),
      ...statusOf(q3Due, periodStartD, periodEndD, windowEnd),
      note: "Quarterly TDS statement; generally due 31st January of AY.",
    });
    items.push({
      jurisdiction,
      area: "tds-tcs",
      filingType: "TDS/TCS statement Q4",
      dueDate: q4Due.toISOString().slice(0, 10),
      ...statusOf(q4Due, periodStartD, periodEndD, windowEnd),
      note: "Quarterly TDS statement; generally due 31st May of AY.",
    });
    items.push({
      jurisdiction,
      area: "tds-tcs",
      filingType: "TDS/TCS statement (annual/furnishing)",
      dueDate: new Date(fyEndYear + 1, 0, 31).toISOString().slice(0, 10),
      ...statusOf(new Date(fyEndYear + 1, 0, 31), periodStartD, periodEndD, windowEnd),
      note: "Annual statement furnishing; generally due 31st January of AY.",
    });
  }

  // ROC/MCA — AOC-4 generally within 30 days of AGM; MGT-7 generally within
  // 60 days of AGM; charges generally within 30 days of creation; DIR-3 KYC
  // annual window generally April–June.
  if (entityType === "company" || entityType === "llp") {
    items.push({
      jurisdiction,
      area: "roc-mca",
      filingType: "AOC-4 (financial statements)",
      dueDate: new Date(periodEndD.getUTCFullYear() + 1, 3, 31).toISOString().slice(0, 10),
      ...statusOf(new Date(periodEndD.getUTCFullYear() + 1, 3, 31), periodStartD, periodEndD, windowEnd),
      note: "AOC-4 generally due within 30 days of AGM; date shown is illustrative.",
    });
    items.push({
      jurisdiction,
      area: "roc-mca",
      filingType: "MGT-7 (annual return)",
      dueDate: new Date(periodEndD.getUTCFullYear() + 1, 4, 15).toISOString().slice(0, 10),
      ...statusOf(new Date(periodEndD.getUTCFullYear() + 1, 4, 15), periodStartD, periodEndD, windowEnd),
      note: "MGT-7 generally due within 60 days of AGM; date shown is illustrative.",
    });
    items.push({
      jurisdiction,
      area: "roc-mca",
      filingType: "DIR-3 KYC (annual)",
      dueDate: new Date(fyEndYear + 1, 5, 30).toISOString().slice(0, 10),
      ...statusOf(new Date(fyEndYear + 1, 5, 30), periodStartD, periodEndD, windowEnd),
      note: "DIR-3 KYC annual window generally April–June; date shown is illustrative.",
    });
  }

  // Professional tax — monthly returns generally due by the 20th/25th of the
  // following month depending on the state; annual generally by end of May.
  if (professionalTaxState) {
    const ptMonthDue = new Date(periodEndD.getUTCFullYear(), periodEndD.getUTCMonth() + 1, 20);
    items.push({
      jurisdiction,
      area: "professional-tax",
      filingType: "Professional tax monthly return",
      dueDate: ptMonthDue.toISOString().slice(0, 10),
      ...statusOf(ptMonthDue, periodStartD, periodEndD, windowEnd),
      note: `Professional tax monthly return for ${professionalTaxState}; due date depends on the state rules.`,
    });
    items.push({
      jurisdiction,
      area: "professional-tax",
      filingType: "Professional tax annual return",
      dueDate: new Date(fyEndYear + 1, 4, 31).toISOString().slice(0, 10),
      ...statusOf(new Date(fyEndYear + 1, 4, 31), periodStartD, periodEndD, windowEnd),
      note: "Professional tax annual return; generally due end of May of the assessment year for the state.",
    });
  }

  // Labour/statutory — Provident Fund monthly return generally due by 15th of
  // the following month; ESI monthly generally by 15th; labour returns vary.
  items.push({
    jurisdiction,
    area: "labour-statutory",
    filingType: "EPF monthly return (ECR)",
    dueDate: new Date(periodEndD.getUTCFullYear(), periodEndD.getUTCMonth() + 1, 15).toISOString().slice(0, 10),
    ...statusOf(
      new Date(periodEndD.getUTCFullYear(), periodEndD.getUTCMonth() + 1, 15),
      periodStartD,
      periodEndD,
      windowEnd,
    ),
    note: "EPFO monthly return/ECR generally due by 15th of the following month.",
  });
  items.push({
    jurisdiction,
    area: "labour-statutory",
    filingType: "ESI monthly contribution",
    dueDate: new Date(periodEndD.getUTCFullYear(), periodEndD.getUTCMonth() + 1, 15).toISOString().slice(0, 10),
    ...statusOf(
      new Date(periodEndD.getUTCFullYear(), periodEndD.getUTCMonth() + 1, 15),
      periodStartD,
      periodEndD,
      windowEnd,
    ),
    note: "ESI monthly contribution generally due by 15th of the following month.",
  });

  const warnings: string[] = [
    "Due dates shown are the commonly referenced statutory due dates and should be verified against the current law/notification for the jurisdiction and FY.",
    "Due dates for AGM-linked filings (AOC-4/MGT-7) depend on the actual AGM date; the dates shown are illustrative.",
  ];

  return { periodStart, periodEnd, items, warnings };
}
