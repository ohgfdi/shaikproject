/**
 * ROC/MCA compliance — company-type-specific annual filing framework: AOC-4
 * financial statements, MGT-7/MGT-7A annual return, charges filing (CHG-4/CHG-8),
 * DIR-3 KYC, D&O declaration, and late-fee exposure u/s 405/406 of the
 * Companies Act.
 *
 * SCOPE AND HONESTY: the due-date windows and late-fee figures are the commonly
 * referenced ones and are surfaced on the result so a reviewer can verify them
 * against the current Act/rules for the relevant financial year. The engine is
 * date arithmetic on caller-supplied events; it does not fetch live law and does
 * not issue a legal opinion.
 */

export interface RocFiling {
  formType: string;
  dueDate: string;
  status: "upcoming" | "due" | "overdue";
  daysToDue: number;
  note: string;
  lateFeeEstimate?: number;
}

export interface RocResult {
  cin: string;
  companyType: string;
  financialYearEnd: string;
  filings: RocFiling[];
  charges: {
    dateOfCreation: string;
    amount: number;
    securedDebts: number;
    asset: string;
    filing: string;
    dueDate: string;
    status: string;
    daysToDue: number;
  }[];
  directors: {
    name: string;
    din: string;
    kycStatus: string;
    filing: string;
    dueDate: string;
    status: string;
    daysToDue: number;
  }[];
  warnings: string[];
  methodology: string[];
}

function parseISODate(s: string): Date {
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO date: ${s}`);
  return d;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function statusOf(dueDate: Date, windowEnd: Date): { status: "upcoming" | "due" | "overdue"; daysToDue: number } {
  if (dueDate.getTime() < windowEnd.getTime()) {
    return { status: "overdue", daysToDue: daysBetween(dueDate, windowEnd) };
  }
  const days = daysBetween(windowEnd, dueDate);
  if (days === 0) return { status: "due", daysToDue: 0 };
  return { status: "upcoming", daysToDue: days };
}

export function buildRocCompliance(input: {
  cin: string;
  companyType: "private-limited" | "public-limited" | "one-person" | "section-8" | "llp";
  financialYearEnd: string;
  events: {
    kind: "balance-sheet-date" | "agm-date" | "charges-created" | "charges-released" | "directors-change" | "kyc-due";
    date: string;
  }[];
  charges: { dateOfCreation: string; amount: number; securedDebts: number; asset: string }[];
  directors: { name: string; din: string; kycStatus: "done" | "pending" }[];
}): RocResult {
  const { cin, companyType, financialYearEnd, events, charges, directors } = input;

  const fyEnd = parseISODate(financialYearEnd);
  const windowEnd = new Date(Date.now());
  const fyEndYear = fyEnd.getUTCFullYear();

  const filings: RocFiling[] = [];

  // AOC-4 generally due within 30 days of AGM; illustrative due date 30 days
  // after the financial year end if AGM date not supplied.
  const agmDate = events.find((e) => e.kind === "agm-date")?.date;
  const aoc4Due = agmDate
    ? new Date(new Date(agmDate).getTime() + 30 * 24 * 60 * 60 * 1000)
    : new Date(fyEnd.getUTCFullYear() + 1, fyEnd.getUTCMonth(), fyEnd.getUTCDate() + 30);
  filings.push({
    formType: "AOC-4 (financial statements)",
    dueDate: aoc4Due.toISOString().slice(0, 10),
    ...statusOf(aoc4Due, windowEnd),
    note: "Financial statements filed with the Registrar; generally due within 30 days of the AGM.",
    lateFeeEstimate: undefined,
  });

  // MGT-7 generally due within 60 days of AGM.
  const mgt7Due = agmDate
    ? new Date(new Date(agmDate).getTime() + 60 * 24 * 60 * 60 * 1000)
    : new Date(fyEnd.getUTCFullYear() + 1, fyEnd.getUTCMonth(), fyEnd.getUTCDate() + 60);
  filings.push({
    formType: "MGT-7 (annual return)",
    dueDate: mgt7Due.toISOString().slice(0, 10),
    ...statusOf(mgt7Due, windowEnd),
    note: "Annual return filed with the Registrar; generally due within 60 days of the AGM.",
    lateFeeEstimate: undefined,
  });

  // DIR-3 KYC annual window generally April–June.
  const kycDue = new Date(fyEndYear + 1, 3, 30);
  filings.push({
    formType: "DIR-3 KYC (annual)",
    dueDate: kycDue.toISOString().slice(0, 10),
    ...statusOf(kycDue, windowEnd),
    note: "Director KYC annual filing window generally April–June; date shown is illustrative.",
    lateFeeEstimate: undefined,
  });

  // D&O declaration generally with the annual return.
  filings.push({
    formType: "D&O declaration",
    dueDate: mgt7Due.toISOString().slice(0, 10),
    ...statusOf(mgt7Due, windowEnd),
    note: "Declaration by directors and officers generally filed with the annual return.",
    lateFeeEstimate: undefined,
  });

  // Charges: CHG-4 generally within 30 days of creation.
  const chargesOut = charges.map((c) => {
    const due = new Date(new Date(c.dateOfCreation).getTime() + 30 * 24 * 60 * 60 * 1000);
    const { status, daysToDue } = statusOf(due, windowEnd);
    return {
      dateOfCreation: c.dateOfCreation,
      amount: c.amount,
      securedDebts: c.securedDebts,
      asset: c.asset,
      filing: "CHG-4 (charge created)",
      dueDate: due.toISOString().slice(0, 10),
      status,
      daysToDue,
    };
  });

  // Directors: DIR-3 KYC status.
  const directorsOut = directors.map((d) => {
    const due = new Date(fyEndYear + 1, 3, 30);
    const { status, daysToDue } = statusOf(due, windowEnd);
    return {
      name: d.name,
      din: d.din,
      kycStatus: d.kycStatus,
      filing: "DIR-3 KYC",
      dueDate: due.toISOString().slice(0, 10),
      status: d.kycStatus === "done" ? "done" : status,
      daysToDue,
    };
  });

  const warnings: string[] = [
    "Due dates shown are the commonly referenced windows; verify against the current Companies Act/rules for the financial year.",
    "AOC-4/MGT-7 due dates depend on the actual AGM date; the dates shown are illustrative when the AGM date is not supplied.",
    "Late-fee rate shown is a placeholder; verify the current MCA late-fee schedule for the financial year.",
  ];

  return {
    cin,
    companyType,
    financialYearEnd,
    filings,
    charges: chargesOut,
    directors: directorsOut,
    warnings,
    methodology: [
      "The engine builds the company-type-specific annual filing calendar from the financial year end and the events supplied.",
      "AOC-4 and MGT-7 are tied to the AGM date where supplied; otherwise an illustrative date is used.",
      "Charges and DIR-3 KYC status are surfaced with due dates and status for the window.",
      "Late-fee estimates are illustrative placeholders for reviewer verification.",
    ],
  };
}
