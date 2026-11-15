/**
 * Statutory compliance calendar for an Indian client.
 *
 * The firm-wide calendar was a missing P0 capability: the app could compute
 * individual filings, but nothing told a partner what is due next week across
 * every client. This engine turns a client's registration profile into the
 * dated obligations a CA firm actually chases.
 *
 * Scope and honesty:
 *  - Financial years are 1 April → 31 March. The due dates below are the
 *    central (non-extended) statutory dates for the common cases.
 *  - Weekend/holiday extension, state-specific GST QRMP groups (22nd vs 24th),
 *    and CBDT extension notifications are NOT modelled. The task note says so
 *    where a variation exists. A firm must still read the portal notice.
 *  - Only obligations implied by the profile are generated; nothing is invented
 *    for a client that is not registered for that law.
 */

export type EntityKind = "company" | "llp" | "partnership" | "proprietorship" | "trust" | "individual";
export type GstFrequency = "monthly" | "quarterly";

export const ENTITY_KINDS: readonly EntityKind[] = [
  "company",
  "llp",
  "partnership",
  "proprietorship",
  "trust",
  "individual",
];

export const GST_FREQUENCIES: readonly GstFrequency[] = ["monthly", "quarterly"];

export interface ClientComplianceProfileInput {
  clientId: string;
  clientName: string;
  entityKind: EntityKind;
  financialYear: string; // "2025-26"
  gstRegistered: boolean;
  gstFrequency: GstFrequency;
  tdsDeductor: boolean;
  taxAuditApplicable: boolean;
  transferPricingApplicable: boolean;
  listedCompany: boolean;
  state: string | null;
  employsStaff: boolean;
}

export type ComplianceTaskCode =
  | "GSTR-1"
  | "GSTR-3B"
  | "TDS-PAYMENT"
  | "TDS-26Q"
  | "ADVANCE-TAX"
  | "ITR"
  | "TAX-AUDIT-3CD"
  | "AOC-4"
  | "MGT-7"
  | "DIR-3-KYC"
  | "LLP-11"
  | "LLP-8"
  | "PT-RETURN"
  | "EPF-ECR"
  | "ESI-RETURN";

export interface ComplianceTask {
  id: string;
  clientId: string;
  clientName: string;
  code: ComplianceTaskCode;
  title: string;
  authority: string;
  period: string;
  dueDate: string;
  note: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** States that levy professional tax on employers (same list as the entity engine). */
export const PT_STATES: readonly string[] = [
  "maharashtra",
  "karnataka",
  "west-bengal",
  "tamil-nadu",
  "andhra-pradesh",
  "telangana",
  "gujarat",
  "madhya-pradesh",
  "odisha",
  "assam",
  "kerala",
  "meghalaya",
  "sikkim",
  "tripura",
  "bihar",
  "jharkhand",
  "puducherry",
];

const pad = (n: number): string => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** "2025-26" → { startYear: 2025, endYear: 2026 }. */
export function parseFinancialYear(fy: string): { startYear: number; endYear: number; assessmentYear: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(fy.trim());
  if (!match) throw new Error(`Financial year must look like 2025-26, got "${fy}".`);
  const startYear = Number(match[1]);
  const endYear = startYear + 1;
  return { startYear, endYear, assessmentYear: `${endYear}-${String(endYear + 1).slice(2)}` };
}

/** The Indian financial year that contains `today` (1 April – 31 March). */
export function financialYearFor(today: string): string {
  const date = new Date(`${today}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date "${today}".`);
  const year = date.getUTCFullYear();
  const start = date.getUTCMonth() + 1 >= 4 ? year : year - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

interface TaskSeed {
  code: ComplianceTaskCode;
  title: string;
  authority: string;
  period: string;
  dueDate: string;
  note?: string;
}

/**
 * Build the dated obligations for one client and one financial year.
 *
 * Returned ids are deterministic (`client:code:period`) so a filed/waived
 * status can be stored against them and survive regeneration.
 */
export function buildClientComplianceCalendar(input: ClientComplianceProfileInput): ComplianceTask[] {
  const { startYear, endYear } = parseFinancialYear(input.financialYear);
  const seeds: TaskSeed[] = [];
  const isCompany = input.entityKind === "company";
  const isLlp = input.entityKind === "llp";
  const audit = input.taxAuditApplicable || isCompany;

  // ---- GST ---------------------------------------------------------------
  if (input.gstRegistered) {
    if (input.gstFrequency === "quarterly") {
      const quarters: { label: string; endMonth: number; endYear: number }[] = [
        { label: `Apr–Jun ${startYear}`, endMonth: 6, endYear: startYear },
        { label: `Jul–Sep ${startYear}`, endMonth: 9, endYear: startYear },
        { label: `Oct–Dec ${startYear}`, endMonth: 12, endYear: startYear },
        { label: `Jan–Mar ${endYear}`, endMonth: 3, endYear: endYear },
      ];
      for (const q of quarters) {
        const after = nextMonth(q.endYear, q.endMonth);
        seeds.push({
          code: "GSTR-1",
          title: "GSTR-1 (quarterly)",
          authority: "GSTN",
          period: q.label,
          dueDate: iso(after.year, after.month, 13),
          note: "QRMP quarterly filers; the 13th is the central date.",
        });
        seeds.push({
          code: "GSTR-3B",
          title: "GSTR-3B (quarterly)",
          authority: "GSTN",
          period: q.label,
          dueDate: iso(after.year, after.month, 22),
          note: "QRMP state groups file on the 22nd or 24th; confirm the client's group.",
        });
      }
    } else {
      for (let m = 4; m <= 15; m++) {
        const year = m <= 12 ? startYear : endYear;
        const month = m <= 12 ? m : m - 12;
        const after = nextMonth(year, month);
        const label = `${MONTHS[month - 1]} ${year}`;
        seeds.push({
          code: "GSTR-1",
          title: "GSTR-1",
          authority: "GSTN",
          period: label,
          dueDate: iso(after.year, after.month, 11),
        });
        seeds.push({
          code: "GSTR-3B",
          title: "GSTR-3B",
          authority: "GSTN",
          period: label,
          dueDate: iso(after.year, after.month, 20),
        });
      }
    }
  }

  // ---- TDS ---------------------------------------------------------------
  if (input.tdsDeductor) {
    for (let m = 4; m <= 15; m++) {
      const year = m <= 12 ? startYear : endYear;
      const month = m <= 12 ? m : m - 12;
      const label = `${MONTHS[month - 1]} ${year}`;
      // March payment is due 30 April; every other month the 7th of the next.
      const after = nextMonth(year, month);
      const dueDate = month === 3 ? iso(year, 4, 30) : iso(after.year, after.month, 7);
      seeds.push({
        code: "TDS-PAYMENT",
        title: "TDS/TCS payment",
        authority: "Income Tax Department",
        period: label,
        dueDate,
      });
    }

    seeds.push(
      {
        code: "TDS-26Q",
        title: "TDS return — Form 26Q (Q1)",
        authority: "Income Tax Department",
        period: `Apr–Jun ${startYear}`,
        dueDate: iso(startYear, 7, 31),
      },
      {
        code: "TDS-26Q",
        title: "TDS return — Form 26Q (Q2)",
        authority: "Income Tax Department",
        period: `Jul–Sep ${startYear}`,
        dueDate: iso(startYear, 10, 31),
      },
      {
        code: "TDS-26Q",
        title: "TDS return — Form 26Q (Q3)",
        authority: "Income Tax Department",
        period: `Oct–Dec ${startYear}`,
        dueDate: iso(endYear, 1, 31),
      },
      {
        code: "TDS-26Q",
        title: "TDS return — Form 26Q (Q4)",
        authority: "Income Tax Department",
        period: `Jan–Mar ${endYear}`,
        dueDate: iso(endYear, 5, 31),
      },
    );
  }

  // ---- Advance tax -------------------------------------------------------
  seeds.push(
    {
      code: "ADVANCE-TAX",
      title: "Advance tax — 15% instalment",
      authority: "Income Tax Department",
      period: `FY ${input.financialYear}`,
      dueDate: iso(startYear, 6, 15),
    },
    {
      code: "ADVANCE-TAX",
      title: "Advance tax — 45% instalment",
      authority: "Income Tax Department",
      period: `FY ${input.financialYear}`,
      dueDate: iso(startYear, 9, 15),
    },
    {
      code: "ADVANCE-TAX",
      title: "Advance tax — 75% instalment",
      authority: "Income Tax Department",
      period: `FY ${input.financialYear}`,
      dueDate: iso(startYear, 12, 15),
    },
    {
      code: "ADVANCE-TAX",
      title: "Advance tax — 100% instalment",
      authority: "Income Tax Department",
      period: `FY ${input.financialYear}`,
      dueDate: iso(endYear, 3, 15),
    },
  );

  // ---- Income tax return and audit --------------------------------------
  const itrDue = input.transferPricingApplicable
    ? iso(endYear, 11, 30)
    : audit
      ? iso(endYear, 10, 31)
      : iso(endYear, 7, 31);
  seeds.push({
    code: "ITR",
    title: "Income tax return",
    authority: "Income Tax Department",
    period: `AY ${parseFinancialYear(input.financialYear).assessmentYear}`,
    dueDate: itrDue,
    note: input.transferPricingApplicable
      ? "Transfer-pricing cases use the 30 November date."
      : audit
        ? "Audit cases use the 31 October date."
        : "Non-audit cases use the 31 July date.",
  });

  if (audit) {
    seeds.push({
      code: "TAX-AUDIT-3CD",
      title: "Tax audit report — Forms 3CA/3CB with 3CD",
      authority: "Income Tax Department",
      period: `FY ${input.financialYear}`,
      dueDate: iso(endYear, 9, 30),
    });
  }

  // ---- Corporate / LLP annual filings -----------------------------------
  if (isCompany) {
    seeds.push(
      {
        code: "AOC-4",
        title: "AOC-4 — financial statements",
        authority: "MCA",
        period: `FY ${input.financialYear}`,
        dueDate: iso(endYear, 10, 30),
        note: "Assumes the AGM is held on 30 September; AOC-4 is due 30 days after the AGM.",
      },
      {
        code: "MGT-7",
        title: "MGT-7/7A — annual return",
        authority: "MCA",
        period: `FY ${input.financialYear}`,
        dueDate: iso(endYear, 11, 29),
        note: "60 days after the assumed 30 September AGM.",
      },
    );
  }
  if (isLlp) {
    seeds.push(
      {
        code: "LLP-11",
        title: "Form 11 — LLP annual return",
        authority: "MCA",
        period: `FY ${input.financialYear}`,
        dueDate: iso(endYear, 5, 30),
      },
      {
        code: "LLP-8",
        title: "Form 8 — statement of accounts and solvency",
        authority: "MCA",
        period: `FY ${input.financialYear}`,
        dueDate: iso(endYear, 10, 30),
      },
    );
  }
  if (isCompany || isLlp) {
    seeds.push({
      code: "DIR-3-KYC",
      title: "DIR-3 KYC — director KYC",
      authority: "MCA",
      period: `FY ${input.financialYear}`,
      dueDate: iso(endYear, 9, 30),
    });
  }

  // ---- Professional tax --------------------------------------------------
  const state = input.state?.trim().toLowerCase() ?? "";
  if (state && PT_STATES.includes(state) && input.employsStaff) {
    for (let m = 4; m <= 15; m++) {
      const year = m <= 12 ? startYear : endYear;
      const month = m <= 12 ? m : m - 12;
      const after = nextMonth(year, month);
      seeds.push({
        code: "PT-RETURN",
        title: "Professional tax return and payment",
        authority: `${input.state} Professional Tax authority`,
        period: `${MONTHS[month - 1]} ${year}`,
        dueDate: iso(after.year, after.month, 20),
        note: "State-specific due dates and rates apply.",
      });
    }
  }

  // ---- Labour / social security -----------------------------------------
  // An employer's monthly EPF ECR and ESI contribution are as much a filing
  // obligation as GST, and a client that employs staff is chased for both.
  if (input.employsStaff) {
    for (let m = 4; m <= 15; m++) {
      const year = m <= 12 ? startYear : endYear;
      const month = m <= 12 ? m : m - 12;
      const after = nextMonth(year, month);
      const label = `${MONTHS[month - 1]} ${year}`;
      seeds.push({
        code: "EPF-ECR",
        title: "EPF electronic challan cum return (ECR)",
        authority: "EPFO",
        period: label,
        dueDate: iso(after.year, after.month, 15),
        note: "Monthly ECR and contribution are generally due by the 15th of the following month.",
      });
      seeds.push({
        code: "ESI-RETURN",
        title: "ESI monthly contribution return",
        authority: "ESIC",
        period: label,
        dueDate: iso(after.year, after.month, 15),
        note: "Monthly ESI contribution is generally due by the 15th of the following month.",
      });
    }
  }

  const seen = new Map<string, number>();
  return seeds
    .map((seed) => {
      const key = `${seed.code}:${seed.period}`;
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      return {
        id: `${input.clientId}:${seed.code}:${seed.period.replace(/\s+/g, "-")}:${occurrence}`,
        clientId: input.clientId,
        clientName: input.clientName,
        code: seed.code,
        title: seed.title,
        authority: seed.authority,
        period: seed.period,
        dueDate: seed.dueDate,
        note: seed.note ?? null,
      } satisfies ComplianceTask;
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.code.localeCompare(b.code));
}

export type ComplianceTaskState = "overdue" | "due-soon" | "upcoming" | "filed" | "waived";

export const DUE_SOON_DAYS = 30;

/** Days from `today` to `dueDate` (positive = future). */
export function daysUntil(today: string, dueDate: string): number {
  const from = Date.parse(`${today}T00:00:00Z`);
  const to = Date.parse(`${dueDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

/** Display state, given any stored filing status. */
export function complianceTaskState(
  dueDate: string,
  today: string,
  filed?: "filed" | "waived" | null,
): ComplianceTaskState {
  if (filed === "filed") return "filed";
  if (filed === "waived") return "waived";
  const diff = daysUntil(today, dueDate);
  if (diff < 0) return "overdue";
  if (diff <= DUE_SOON_DAYS) return "due-soon";
  return "upcoming";
}
