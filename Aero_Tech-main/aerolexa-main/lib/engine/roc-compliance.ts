/** ROC/MCA compliance tracking for Indian companies */

export class RoCComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoCComplianceError";
  }
}

import { formatInr } from "./india-tax";

// ---------------------------------------------------------------------------
// Company profile
// ---------------------------------------------------------------------------

export interface CompanyProfile {
  companyName: string;
  cin: string; // Corporate Identity Number (21 characters)
  regNumber?: string | null; // Registration number
  incorporationDate: string; // yyyy-mm-dd
  registeredOfficeAddress: string;
  rocCode: string; // ROC jurisdiction code (e.g., "ROC-MUMBAI")
  companyType: "public" | "private" | "one-person" | "section-8" | "llp";
  registeredCapital: number; // minor units
  paidUpCapital: number;
  authorizedCapital: number;
  shareholders: number;
  directors: number;
  gstin?: string | null;
  pan?: string | null;
  financeYearEnd: string; // e.g., "03-31"
  status: "active" | "under-process" | "strike-off" | "amalgamated" | "dissolved";
}

export function validateCompanyProfile(profile: CompanyProfile): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(profile.cin)) {
    errors.push("CIN must be valid 21-character format.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(profile.incorporationDate)) {
    errors.push("incorporationDate must be yyyy-mm-dd.");
  }
  if (profile.registeredCapital < 0 || profile.paidUpCapital < 0 || profile.authorizedCapital < 0) {
    errors.push("Capital amounts cannot be negative.");
  }
  if (profile.paidUpCapital > profile.authorizedCapital) {
    errors.push("Paid-up capital cannot exceed authorized capital.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// ROC Filing Calendar
// ---------------------------------------------------------------------------

export interface RocFiling {
  filingId: string;
  companyCin: string;
  formType: "AOC-4" | "MGT-7" | "DIR-3 KYC" | "DIR-6" | "CHG-1" | "CHG-2" | "PAS-3" | "ADT-1" | "NCLT-1" | " Other";
  formDescription: string;
  dueDate: string; // yyyy-mm-dd
  filingDate?: string | null;
  status: "pending" | "filed" | "defective" | "not-required" | "exempt";
  filingFees: number; // minor units
  paidAmount: number;
  balanceDue: number;
  attachmentCount?: number | null;
  attachmentDetails?: string[] | null;
  remarks?: string | null;
}

export interface RocFilingCalendar {
  companyCin: string;
  financialYear: string; // "2025-26"
  filings: RocFiling[];
  pendingFilings: RocFiling[];
  overdueFilings: RocFiling[];
  filedFilings: RocFiling[];
  upcomingFilings: RocFiling[];
  totalFees: number;
  totalPaid: number;
  totalDue: number;
  warningList: string[];
  methodology: string[];
}

export function buildRocFilingCalendar(profile: CompanyProfile, filings: RocFiling[]): RocFilingCalendar {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(profile.incorporationDate)) {
    throw new RoCComplianceError("incorporationDate must be yyyy-mm-dd.");
  }

  const now = new Date();
  const pendingFilings = filings.filter((f) => f.status === "pending");
  const overdueFilings = filings.filter((f) => f.status === "pending" && new Date(f.dueDate) < now);
  const filedFilings = filings.filter((f) => f.status === "filed" || f.status === "defective");
  const upcomingFilings = filings.filter((f) => f.status === "pending" && new Date(f.dueDate) >= now);

  const totalFees = filings.reduce((s, f) => s + f.filingFees, 0);
  const totalPaid = filings.reduce((s, f) => s + f.paidAmount, 0);
  const totalDue = filings.reduce((s, f) => s + f.balanceDue, 0);

  const warnings: string[] = [];
  if (overdueFilings.length > 0) {
    warnings.push(`${overdueFilings.length} filing(s) overdue - penalty u/s 403/404/405 applies.`);
  }

  return {
    companyCin: profile.cin,
    financialYear: "2025-26",
    filings,
    pendingFilings,
    overdueFilings,
    filedFilings,
    upcomingFilings,
    totalFees,
    totalPaid,
    totalDue,
    warningList: warnings,
    methodology: [
      `ROC filing calendar for ${profile.companyName} (CIN: ${profile.cin}), FY 2025-26.`,
      `${pendingFilings.length} pending, ${overdueFilings.length} overdue, ${filedFilings.length} filed.`,
      `Total fees: ${formatInr(totalFees)}, paid: ${formatInr(totalPaid)}, due: ${formatInr(totalDue)}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// AOC-4 (Annual Financial Statements)
// ---------------------------------------------------------------------------

export interface AOC4Filing {
  filingId: string;
  companyCin: string;
  financialYear: string;
  formType: "AOC-4";
  formDescription: "Annual Financial Statements";
  dueDate: string;
  filingDate?: string | null;
  status: "pending" | "filed" | "defective" | "not-required";
  balanceSheet: {
    totalAssets: number;
    totalLiabilities: number;
    equity: number;
    liabilities: number;
    netWorth: number;
  };
  profitLoss: {
    revenue: number;
    expenses: number;
    profitBeforeTax: number;
    tax: number;
    netProfit: number;
    eps: number;
  };
  notesToAccounts: string[];
  auditorName?: string | null;
  auditorMembershipNo?: string | null;
  auditorReportDate?: string | null;
  auditorReportType: "unqualified" | "qualified" | "adverse" | "disclaimer";
  attachmentCount?: number | null;
  attachmentDetails?: string[] | null;
  filingFees?: number | null;
  paidAmount?: number | null;
  balanceDue?: number | null;
  remarks?: string | null;
}

export function validateAOC4Filing(filing: AOC4Filing): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(filing.dueDate)) {
    errors.push("dueDate must be yyyy-mm-dd.");
  }
  if (
    filing.balanceSheet.totalAssets < 0 ||
    filing.balanceSheet.totalLiabilities < 0 ||
    filing.balanceSheet.equity < 0
  ) {
    errors.push("Balance sheet figures cannot be negative.");
  }
  if (filing.balanceSheet.totalAssets !== filing.balanceSheet.totalLiabilities + filing.balanceSheet.equity) {
    errors.push("Balance sheet does not balance.");
  }
  if (filing.profitLoss.revenue < 0 || filing.profitLoss.expenses < 0) {
    errors.push("Profit and loss figures cannot be negative.");
  }
  if (
    filing.auditorReportType !== "unqualified" &&
    filing.auditorReportType !== "qualified" &&
    filing.auditorReportType !== "adverse" &&
    filing.auditorReportType !== "disclaimer"
  ) {
    errors.push("auditorReportType must be unqualified/qualified/adverse/disclaimer.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function generateAOC4ExpiryDate(financialYear: string): string {
  const fyStartYear = Number(financialYear.slice(0, 4));
  // AOC-4 due 30 days after board meeting, which must be within 6 months of FY end
  // FY end: March 31
  // Board meeting: by September 30
  // Filing: by October 31
  return `${fyStartYear + 1}-10-31`;
}

// ---------------------------------------------------------------------------
// MGT-7 (Annual Return)
// ---------------------------------------------------------------------------

export interface MGT7Filing {
  filingId: string;
  companyCin: string;
  financialYear: string;
  formType: "MGT-7";
  formDescription: "Annual Return of Company";
  dueDate: string;
  filingDate?: string | null;
  status: "pending" | "filed" | "defective" | "not-required";
  partA: {
    companyInfo: {
      companyName: string;
      cin: string;
      registeredOfficeAddress: string;
      rocCode: string;
      companyType: string;
      registeredCapital: number;
      paidUpCapital: number;
      shareholdingPattern: {
        residentHolding: number;
        nonResidentHolding: number;
        promoterHolding: number;
        publicHolding: number;
      };
    };
    directors: {
      totalCount: number;
      indianDirectors: number;
      womenDirectors: number;
      independentDirectors: number;
      smallShareholderDirectors: number;
    };
    keyManagerialPersonnel: {
      managingDirector: string | null;
      wholeTimeDirector: string | null;
      manager: string | null;
      keyManager: string | null;
    };
    shareholderDetails: {
      totalShareholders: number;
      individualShareholders: number;
      nonIndividualShareholders: number;
    };
  };
  partB: {
    shareholdingPattern: Record<string, unknown>[];
    indebtedness: {
      totalIndebtedness: number;
      securedLoans: number;
      unsecuredLoans: number;
    };
    investment: {
      totalInvestment: number;
      investmentInShares: number;
      investmentInDebt: number;
      investmentInForeignSecurities: number;
    };
    grants: {
      totalGrants: number;
      grantsToGovernment: number;
      grantsToLocalAuthority: number;
      grantsToOther: number;
    };
  };
  attachmentCount?: number | null;
  attachmentDetails?: string[] | null;
  filingFees?: number | null;
  paidAmount?: number | null;
  balanceDue?: number | null;
  remarks?: string | null;
}

export function validateMGT7Filing(filing: MGT7Filing): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(filing.dueDate)) {
    errors.push("dueDate must be yyyy-mm-dd.");
  }
  if (
    filing.partA.companyInfo.shareholdingPattern.residentHolding +
      filing.partA.companyInfo.shareholdingPattern.nonResidentHolding !==
    100
  ) {
    errors.push("Shareholding pattern must total 100%.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function generateMGT7ExpiryDate(financialYear: string): string {
  const fyStartYear = Number(financialYear.slice(0, 4));
  // MGT-7 due 60 days after AGM, which must be within 6 months of FY end
  // FY end: March 31
  // AGM: by September 30
  // Filing: by November 30
  return `${fyStartYear + 1}-11-30`;
}

// ---------------------------------------------------------------------------
// Director KYC (DIR-3 KYC)
// ---------------------------------------------------------------------------

export interface DIR3KYCFiling {
  filingId: string;
  cin: string;
  directorPan: string;
  directorName: string;
  dateOfBirth?: string | null;
  dueDate: string;
  filingDate?: string | null;
  status: "pending" | "filed" | "defective" | "not-required";
  aadhaarVerified?: boolean | null;
  bankAccountVerified?: boolean | null;
  mobileVerified?: boolean | null;
  emailVerified?: boolean | null;
  identityProof?: string | null;
  addressProof?: string | null;
  photograph?: string | null;
  attachmentCount?: number | null;
  remarks?: string | null;
}

export function validateDIR3KYCFiling(filing: DIR3KYCFiling): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(filing.dueDate)) {
    errors.push("dueDate must be yyyy-mm-dd.");
  }
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(filing.directorPan)) {
    errors.push("Director PAN must be valid format.");
  }
  if (!filing.aadhaarVerified || !filing.bankAccountVerified || !filing.mobileVerified || !filing.emailVerified) {
    errors.push("All verifications (Aadhaar, bank, mobile, email) must be completed.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function generateDIR3KYCDueDate(): string {
  // DIR-3 KYC due by September 30 every year
  const now = new Date();
  return `${now.getFullYear()}-09-30`;
}

// ---------------------------------------------------------------------------
// Compliance score
// ---------------------------------------------------------------------------

export interface ComplianceScore {
  companyCin: string;
  financialYear: string;
  score: number; // 0-100
  maxScore: number;
  deductions: {
    category: "aoc4" | "mgt7" | "dir3kyc" | "other" | "late-filing";
    description: string;
    deduction: number;
    remainingScore: number;
  }[];
  status: "excellent" | "good" | "satisfactory" | "needs-improvement" | "poor";
  warnings: string[];
}

export function computeComplianceScore(profile: CompanyProfile, calendar: RocFilingCalendar): ComplianceScore {
  let score = 100;
  const deductions: ComplianceScore["deductions"] = [];

  // AOC-4 deduction
  if (calendar.filings.some((f) => f.formType === "AOC-4" && f.status === "pending")) {
    deductions.push({
      category: "aoc4",
      description: "AOC-4 not filed",
      deduction: 10,
      remainingScore: 90,
    });
    score -= 10;
  }

  // MGT-7 deduction
  if (calendar.filings.some((f) => f.formType === "MGT-7" && f.status === "pending")) {
    deductions.push({
      category: "mgt7",
      description: "MGT-7 not filed",
      deduction: 15,
      remainingScore: score - 15,
    });
    score -= 15;
  }

  // DIR-3 KYC deduction
  if (calendar.filings.some((f) => f.formType === "DIR-3 KYC" && f.status === "pending")) {
    deductions.push({
      category: "dir3kyc",
      description: "DIR-3 KYC not filed for directors",
      deduction: 20,
      remainingScore: score - 20,
    });
    score -= 20;
  }

  // Late filing deduction (calculated per overdue filing)
  const overdueFilings = calendar.overdueFilings;
  let latePenalty = 0;
  for (const f of overdueFilings) {
    const daysLate = Math.floor((new Date().getTime() - new Date(f.dueDate).getTime()) / 86400000);
    latePenalty += Math.round(f.filingFees * 0.02 * daysLate); // 2% per day
  }
  if (latePenalty > 0) {
    deductions.push({
      category: "late-filing",
      description: `Late filing penalties: ${formatInr(latePenalty)}`,
      deduction: Math.min(25, Math.round(latePenalty / 10000)),
      remainingScore: score - Math.min(25, Math.round(latePenalty / 10000)),
    });
    score -= Math.min(25, Math.round(latePenalty / 10000));
  }

  score = Math.max(0, Math.min(100, score));

  let status: "excellent" | "good" | "satisfactory" | "needs-improvement" | "poor";
  if (score >= 90) status = "excellent";
  else if (score >= 75) status = "good";
  else if (score >= 60) status = "satisfactory";
  else if (score >= 40) status = "needs-improvement";
  else status = "poor";

  return {
    companyCin: profile.cin,
    financialYear: "2025-26",
    score,
    maxScore: 100,
    deductions,
    status,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Board Meeting Compliance
// ---------------------------------------------------------------------------

export interface BoardMeeting {
  meetingId: string;
  companyCin: string;
  meetingType: "board" | "board-committee";
  meetingDate: string;
  dueDate: string;
  status: "scheduled" | "held" | "postponed" | "cancelled";
  agenda: string[];
  attendees: string[];
  absentees: string[];
  resolutionCount: number;
  resolutions: string[];
  minutesFiled: boolean;
  minutesFiledDate?: string | null;
  complianceStatus: "compliant" | "non-compliant";
}

export interface BoardMeetingReport {
  meetings: BoardMeeting[];
  totalMeetings: number;
  heldMeetings: number;
  scheduledMeetings: number;
  postponedMeetings: number;
  cancelledMeetings: number;
  totalResolutions: number;
  minutesFiledCount: number;
  compliantMeetings: number;
  nonCompliantMeetings: number;
  warnings: string[];
  methodology: string[];
}

export function buildBoardMeetingReport(meetings: BoardMeeting[]): BoardMeetingReport {
  const now = new Date();

  const heldMeetings = meetings.filter((m) => m.status === "held");
  const scheduledMeetings = meetings.filter((m) => m.status === "scheduled");
  const postponedMeetings = meetings.filter((m) => m.status === "postponed");
  const cancelledMeetings = meetings.filter((m) => m.status === "cancelled");
  const compliantMeetings = meetings.filter((m) => m.complianceStatus === "compliant");
  const minutesFiledCount = meetings.filter((m) => m.minutesFiled && m.minutesFiledDate).length;

  const warnings: string[] = [];
  for (const m of scheduledMeetings) {
    if (new Date(m.dueDate) < now) {
      warnings.push(`Board meeting scheduled on ${m.meetingDate} (due ${m.dueDate}) is overdue - hold or cancel.`);
    }
  }
  for (const m of heldMeetings) {
    if (m.resolutionCount > 0 && !m.minutesFiled) {
      warnings.push(`Minutes for board meeting on ${m.meetingDate} not yet filed - file within 15 days of meeting.`);
    }
  }

  return {
    meetings,
    totalMeetings: meetings.length,
    heldMeetings: heldMeetings.length,
    scheduledMeetings: scheduledMeetings.length,
    postponedMeetings: postponedMeetings.length,
    cancelledMeetings: cancelledMeetings.length,
    totalResolutions: meetings.reduce((s, m) => s + m.resolutionCount, 0),
    minutesFiledCount,
    compliantMeetings: compliantMeetings.length,
    nonCompliantMeetings: meetings.length - compliantMeetings.length,
    warnings,
    methodology: [
      `Board meeting report: ${meetings.length} meeting(s), ${heldMeetings.length} held, ${scheduledMeetings.length} scheduled, ${cancelledMeetings.length} cancelled.`,
      `${compliantMeetings.length} compliant, ${meetings.length - compliantMeetings.length} non-compliant.`,
      `${minutesFiledCount} meetings have filed minutes.`,
    ],
  };
}
