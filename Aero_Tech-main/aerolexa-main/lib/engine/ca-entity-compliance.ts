/**
 * Corporate-compliance operating workflow — the entity lifecycle a CA/CS firm
 * actually runs, not just "which dates are due".
 *
 * The existing `roc-compliance.ts` validates individual forms and
 * `ca-compliance-calendar.ts` lists due dates. This module closes the gap a
 * corporate-compliance practice needs:
 *
 *   1. Entity master data lifecycle — incorporation specifics, CIN/LLPIN,
 *      registered office, objects, authorised/paid-up capital, the director and
 *      shareholder registers, the charge register, and the event→form mapping
 *      an entity's changes travel through.
 *   2. Form-by-form filing workflow — the ROC form for each event type
 *      (AOC-4, MGT-7/7A, DIR-3 KYC, DIR-12, DIR-6, CHG-1/CHG-4, INC-22, SH-7,
 *      PAS-3, MGT-14, ADT-1, FC-GPR …) with due-date rules, attachments and
 *      dependency chains.
 *   3. Board and shareholder meeting mechanics — notice periods, consents,
 *      resolutions and their filing.
 *   4. State/other obligations — professional tax, Shops & Establishments,
 *      labour-law (PF/ESI/LWF) and FEMA reporting where relevant.
 *   5. A document repository tied to each entity and form, a deadline-driven
 *      workflow with dependencies, an entity-specific and firm-wide calendar,
 *      and year-over-year carry-forward with updated masters.
 *
 * SCOPE AND HONESTY: this is the workflow arithmetic and data model a reviewer
 * checks. Every form number, due-date rule and fee basis is DATA the caller can
 * override from the MCA/state notification for the year; the module does not
 * file anything and does not substitute for the MCA V3 portal or legal advice.
 *
 * Money is in MINOR UNITS (paise) as integers, matching every CA engine.
 */

export class EntityComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityComplianceError";
  }
}

function toDate(iso: string): Date {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new EntityComplianceError(`Invalid ISO date: ${iso}`);
  return d;
}

function addDays(iso: string, days: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((toDate(toIso).getTime() - toDate(fromIso).getTime()) / (24 * 60 * 60 * 1000));
}

// ===========================================================================
// 1. Entity master data lifecycle
// ===========================================================================

export type EntityType =
  | "private-limited"
  | "public-limited"
  | "one-person-company"
  | "section-8"
  | "deemed-public"
  | "llp"
  | "foreign-subsidiary";

export const COMPANY_ENTITY_TYPES: readonly EntityType[] = [
  "private-limited",
  "public-limited",
  "one-person-company",
  "section-8",
  "deemed-public",
  "foreign-subsidiary",
];

export interface RegisteredOffice {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  pincode: string;
  /** The date the current address took effect (for INC-22 / MGT-14 trails). */
  changedOn?: string | null;
}

export interface CapitalStructure {
  authorisedMinor: number;
  paidUpMinor: number;
}

export type DirectorDesignation =
  "managing-director" | "whole-time-director" | "director" | "nominee-director" | "independent-director";

export interface Director {
  name: string;
  din: string;
  designation: DirectorDesignation;
  appointedOn: string;
  resignedOn?: string | null;
  /** Last date DIR-3 KYC was filed (annual obligation). */
  dinKycFiledOn?: string | null;
  disqualified?: boolean;
}

export interface Shareholder {
  name: string;
  pan?: string | null;
  shareClass: "equity" | "preference";
  shares: number;
}

export type ChargeType = "creation" | "modification" | "satisfaction";

export interface Charge {
  id: string;
  chargeType: ChargeType;
  holder: string;
  amountMinor: number;
  createdOn: string;
  registeredOn?: string | null;
}

export interface Auditor {
  name: string;
  appointedOn: string;
  /** The AGM at/after which the term ends and ADT-1 renewal is due. */
  termEndsOn: string;
}

export interface EntityMaster {
  entityId: string;
  legalName: string;
  /** Company CIN, or null for an LLP. */
  cin: string | null;
  /** LLP identification number. */
  llpin?: string | null;
  entityType: EntityType;
  incorporationDate: string;
  registeredOffice: RegisteredOffice;
  objects: string[];
  capital: CapitalStructure;
  directors: Director[];
  shareholders: Shareholder[];
  charges: Charge[];
  auditor?: Auditor | null;
  /** Current financial-year end, e.g. "2026-03-31". */
  financialYearEnd: string;
  /** Date of the last annual general meeting, if held. */
  lastAgmDate?: string | null;
}

const CIN_PATTERN = /^[LUu][0-9]{5}[A-Za-z]{2}[0-9]{4}[A-Za-z]{3}[0-9]{6}$/;
const LLPIN_PATTERN = /^[A-Za-z]{3}-[0-9]{4}$/;

/** Validate the entity master before it drives any filing workflow. */
export function validateEntityMaster(entity: EntityMaster): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!entity.legalName.trim()) errors.push("Legal name is required.");
  if (!entity.objects || entity.objects.length === 0) errors.push("At least one main object is required.");

  const isLlp = entity.entityType === "llp";
  if (isLlp) {
    if (!entity.llpin || !LLPIN_PATTERN.test(entity.llpin))
      errors.push("A valid LLPIN (AAA-9999) is required for an LLP.");
  } else if (!entity.cin || !CIN_PATTERN.test(entity.cin)) {
    errors.push("A valid 21-character CIN is required for a company.");
  }

  if (entity.capital.paidUpMinor > entity.capital.authorisedMinor) {
    errors.push("Paid-up capital cannot exceed authorised capital.");
  }
  if (entity.capital.authorisedMinor <= 0) errors.push("Authorised capital must be positive.");

  if (entity.directors.length === 0) errors.push("At least one director is required.");
  const activeDirectors = entity.directors.filter((d) => !d.resignedOn);
  if (entity.entityType === "private-limited" && activeDirectors.length < 2) {
    errors.push("A private limited company requires at least two directors.");
  }
  if (entity.entityType === "public-limited" && activeDirectors.length < 3) {
    errors.push("A public limited company requires at least three directors.");
  }
  if (!isLlp && activeDirectors.length < 1) {
    errors.push("A company requires at least one director.");
  }
  for (const director of entity.directors) {
    if (!/^[0-9]{8}$/.test(director.din)) errors.push(`Director ${director.name} has an invalid DIN.`);
  }

  const pincode = entity.registeredOffice.pincode;
  if (!/^[0-9]{6}$/.test(pincode)) errors.push("Registered office pincode must be 6 digits.");
  if (!entity.registeredOffice.state.trim()) errors.push("Registered office state is required.");

  return { valid: errors.length === 0, errors };
}

export interface EntityRegister {
  activeDirectors: number;
  resignedDirectors: number;
  disqualifiedDirectors: string[];
  equityShares: number;
  preferenceShares: number;
  registeredShareholders: number;
  charges: { creation: number; modification: number; satisfaction: number };
  outstandingChargeMinor: number;
}

/** Snapshot the registers (director, shareholder, charge) the master carries. */
export function entityRegister(entity: EntityMaster): EntityRegister {
  const activeDirectors = entity.directors.filter((d) => !d.resignedOn);
  const resignedDirectors = entity.directors.filter((d) => d.resignedOn);
  const equityShares = entity.shareholders
    .filter((s) => s.shareClass === "equity")
    .reduce((sum, s) => sum + s.shares, 0);
  const preferenceShares = entity.shareholders
    .filter((s) => s.shareClass === "preference")
    .reduce((sum, s) => sum + s.shares, 0);

  const charges = { creation: 0, modification: 0, satisfaction: 0 };
  let outstandingChargeMinor = 0;
  for (const charge of entity.charges) {
    charges[charge.chargeType] += 1;
    if (charge.chargeType === "creation" || charge.chargeType === "modification")
      outstandingChargeMinor += charge.amountMinor;
    if (charge.chargeType === "satisfaction") outstandingChargeMinor -= charge.amountMinor;
  }

  return {
    activeDirectors: activeDirectors.length,
    resignedDirectors: resignedDirectors.length,
    disqualifiedDirectors: entity.directors.filter((d) => d.disqualified).map((d) => d.din),
    equityShares,
    preferenceShares,
    registeredShareholders: entity.shareholders.length,
    charges,
    outstandingChargeMinor: Math.max(0, outstandingChargeMinor),
  };
}

// ===========================================================================
// 2. Form-by-form filing workflow
// ===========================================================================

export type RocEventType =
  | "annual-financial-statements"
  | "annual-return"
  | "director-kyc"
  | "auditor-appointment"
  | "director-appointment"
  | "director-cessation"
  | "director-particulars-change"
  | "registered-office-change"
  | "authorised-capital-change"
  | "share-allotment"
  | "charge-creation"
  | "charge-satisfaction"
  | "board-resolution"
  | "related-party-transaction"
  | "scheme-merger";

export type DueRule =
  | { kind: "days-from-event"; days: number }
  | { kind: "days-from-agm"; days: number }
  | { kind: "annual-fixed"; monthDay: string }
  | { kind: "days-from-fy-end"; days: number };

export interface RocFormSpec {
  form: string;
  event: RocEventType;
  description: string;
  dueRule: DueRule;
  attachments: string[];
  feeBasis: "capital" | "flat" | "event";
  /** Form-level dependency: this form cannot be filed until these are filed. */
  dependsOn?: string[];
}

/** The MCA form each corporate event travels through. */
export const ROC_FORM_MAP: readonly RocFormSpec[] = [
  {
    form: "AOC-4",
    event: "annual-financial-statements",
    description: "Filing of financial statements",
    dueRule: { kind: "days-from-agm", days: 30 },
    attachments: ["financial-statements", "board-report", "auditor-report"],
    feeBasis: "capital",
    dependsOn: ["ADT-1"],
  },
  {
    form: "MGT-7",
    event: "annual-return",
    description: "Annual return (MGT-7A for OPC/small companies)",
    dueRule: { kind: "days-from-agm", days: 60 },
    attachments: ["annual-return", "shareholding-pattern"],
    feeBasis: "capital",
    dependsOn: ["AOC-4"],
  },
  {
    form: "DIR-3 KYC",
    event: "director-kyc",
    description: "Annual KYC of every director holding a DIN",
    dueRule: { kind: "annual-fixed", monthDay: "09-30" },
    attachments: ["kyc"],
    feeBasis: "flat",
  },
  {
    form: "ADT-1",
    event: "auditor-appointment",
    description: "Notice of appointment/re-appointment of auditor",
    dueRule: { kind: "days-from-event", days: 15 },
    attachments: ["auditor-consent", "board-resolution"],
    feeBasis: "flat",
  },
  {
    form: "DIR-12",
    event: "director-appointment",
    description: "Particulars of appointment of directors/key managerial personnel",
    dueRule: { kind: "days-from-event", days: 30 },
    attachments: ["board-resolution", "director-consent"],
    feeBasis: "flat",
  },
  {
    form: "DIR-12",
    event: "director-cessation",
    description: "Particulars of cessation of a director",
    dueRule: { kind: "days-from-event", days: 30 },
    attachments: ["board-resolution"],
    feeBasis: "flat",
  },
  {
    form: "DIR-6",
    event: "director-particulars-change",
    description: "Intimation of a change in a director's particulars (address, DIN details) to the Central Government",
    dueRule: { kind: "days-from-event", days: 30 },
    attachments: ["kyc", "board-resolution"],
    feeBasis: "flat",
  },
  {
    form: "INC-22",
    event: "registered-office-change",
    description: "Notice of change of registered office",
    dueRule: { kind: "days-from-event", days: 30 },
    attachments: ["board-resolution", "address-proof"],
    feeBasis: "flat",
  },
  {
    form: "SH-7",
    event: "authorised-capital-change",
    description: "Notice of increase in authorised share capital",
    dueRule: { kind: "days-from-event", days: 30 },
    attachments: ["board-resolution", "shareholder-resolution"],
    feeBasis: "capital",
    dependsOn: ["MGT-14"],
  },
  {
    form: "PAS-3",
    event: "share-allotment",
    description: "Return of allotment of shares",
    dueRule: { kind: "days-from-event", days: 30 },
    attachments: ["shareholding-pattern", "board-resolution"],
    feeBasis: "capital",
    dependsOn: ["MGT-14"],
  },
  {
    form: "CHG-1",
    event: "charge-creation",
    description: "Registration of charge (creation/modification)",
    dueRule: { kind: "days-from-event", days: 30 },
    attachments: ["charge-instrument", "board-resolution"],
    feeBasis: "event",
  },
  {
    form: "CHG-4",
    event: "charge-satisfaction",
    description: "Satisfaction of charge",
    dueRule: { kind: "days-from-event", days: 30 },
    attachments: ["charge-instrument"],
    feeBasis: "event",
  },
  {
    form: "MGT-14",
    event: "board-resolution",
    description: "Filing of board/shareholder resolutions",
    dueRule: { kind: "days-from-event", days: 30 },
    attachments: ["board-resolution"],
    feeBasis: "flat",
  },
  {
    form: "AOC-2",
    event: "related-party-transaction",
    description: "Disclosure of related-party contracts/arrangements annexed to the Board's report filed with AOC-4",
    dueRule: { kind: "days-from-agm", days: 30 },
    attachments: ["related-party-disclosure", "board-resolution"],
    feeBasis: "flat",
  },
  {
    form: "INC-27 / scheme",
    event: "scheme-merger",
    description: "Scheme of merger/amalgamation (NCLT route forms as applicable)",
    dueRule: { kind: "days-from-event", days: 30 },
    attachments: ["board-resolution", "shareholder-resolution", "scheme-document"],
    feeBasis: "event",
  },
];

/** All ROC forms triggered by an event type. */
export function rocFormsForEvent(event: RocEventType): RocFormSpec[] {
  return ROC_FORM_MAP.filter((spec) => spec.event === event);
}

export interface DueContext {
  eventDate?: string;
  agmDate?: string;
  financialYearEnd?: string;
  /** The FY whose annual-fixed deadline applies, e.g. "2026-09-30" fallback. */
  asOf?: string;
}

/** Compute the statutory due date for a form from its due rule. */
export function computeRocDueDate(spec: RocFormSpec, context: DueContext): string {
  const rule = spec.dueRule;
  if (rule.kind === "days-from-event") {
    if (!context.eventDate) throw new EntityComplianceError(`${spec.form} requires an event date.`);
    return addDays(context.eventDate, rule.days);
  }
  if (rule.kind === "days-from-agm") {
    if (!context.agmDate) throw new EntityComplianceError(`${spec.form} requires an AGM date.`);
    return addDays(context.agmDate, rule.days);
  }
  if (rule.kind === "days-from-fy-end") {
    if (!context.financialYearEnd) throw new EntityComplianceError(`${spec.form} requires the financial-year end.`);
    return addDays(context.financialYearEnd, rule.days);
  }
  const [month, day] = rule.monthDay.split("-");
  const year = context.asOf ? Number(context.asOf.slice(0, 4)) : Number(new Date().getUTCFullYear());
  return `${year}-${month}-${day}`;
}

export type FilingStatus = "pending" | "filed" | "overdue" | "not-applicable";

export interface EntityFilingTask {
  id: string;
  entityId: string;
  form: string;
  event: RocEventType;
  description: string;
  dueDate: string;
  status: FilingStatus;
  dependsOn: string[];
  blockedBy: string[];
  documentRefs: string[];
  filedOn: string | null;
  srn: string | null;
}

export interface FilingEvent {
  event: RocEventType;
  eventDate: string;
  /** Optional explicit form code if the event maps to more than one. */
  form?: string;
}

export interface EntityFilingCalendar {
  entityId: string;
  asOf: string;
  tasks: EntityFilingTask[];
  overdue: string[];
  dueWithin30Days: string[];
  blockedByDependencies: string[];
}

/**
 * Build the entity's filing calendar from the events that occurred, resolving
 * each event to its ROC form, its due date and its dependency chain. A task
 * whose dependency is unfiled is marked blocked (still pending, but flagged).
 */
export function buildEntityFilingCalendar(input: {
  entity: Pick<EntityMaster, "entityId" | "financialYearEnd" | "lastAgmDate" | "entityType">;
  events: FilingEvent[];
  asOf: string;
  requiredForms?: string[];
}): EntityFilingCalendar {
  const agmDate = input.entity.lastAgmDate ?? undefined;
  const tasks: EntityFilingTask[] = [];

  // Annual MGT-7A substitution for small/OPC entities.
  const isSmallOrOpc = input.entity.entityType === "one-person-company";
  const annualReturnForm = isSmallOrOpc ? "MGT-7A" : "MGT-7";

  const specsByForm = new Map<string, RocFormSpec>();
  for (const spec of ROC_FORM_MAP) specsByForm.set(spec.form, spec);

  for (const event of input.events) {
    const specs = rocFormsForEvent(event.event).filter((s) => (event.form ? s.form === event.form : true));
    for (const spec of specs) {
      if (spec.form === "MGT-7" && annualReturnForm === "MGT-7A") continue;
      const dueDate = computeRocDueDate(spec, {
        eventDate: event.eventDate,
        agmDate,
        financialYearEnd: input.entity.financialYearEnd,
        asOf: input.asOf,
      });
      tasks.push({
        id: `${input.entity.entityId}:${spec.form}:${event.eventDate}`,
        entityId: input.entity.entityId,
        form: spec.form,
        event: spec.event,
        description: spec.description,
        dueDate,
        status: daysBetween(input.asOf, dueDate) < 0 ? "overdue" : "pending",
        dependsOn: spec.dependsOn ?? [],
        blockedBy: [],
        documentRefs: [],
        filedOn: null,
        srn: null,
      });
    }
  }

  const filedForms = new Set(tasks.filter((t) => t.status === "filed").map((t) => t.form));
  // Also treat a required form already filed (passed in) as filed for dependency purposes.
  for (const form of input.requiredForms ?? []) filedForms.add(form);

  const blockedByDependencies: string[] = [];
  for (const task of tasks) {
    task.blockedBy = task.dependsOn.filter((dep) => !filedForms.has(dep));
    if (task.blockedBy.length > 0) blockedByDependencies.push(task.form);
  }

  const overdue = tasks.filter((t) => t.status === "overdue").map((t) => t.form);
  const dueWithin30Days = tasks
    .filter((t) => {
      const diff = daysBetween(input.asOf, t.dueDate);
      return diff >= 0 && diff <= 30;
    })
    .map((t) => t.form);

  return { entityId: input.entity.entityId, asOf: input.asOf, tasks, overdue, dueWithin30Days, blockedByDependencies };
}

/** Mark a task filed (returns a new task). */
export function markTaskFiled(task: EntityFilingTask, filedOn: string, srn: string): EntityFilingTask {
  if (task.blockedBy.length > 0) {
    throw new EntityComplianceError(`Cannot file ${task.form}: blocked by ${task.blockedBy.join(", ")}.`);
  }
  return { ...task, status: "filed", filedOn, srn };
}

// ===========================================================================
// 3. Board and shareholder meeting mechanics
// ===========================================================================

export type MeetingType = "board" | "agm" | "egm" | "class";

export interface MeetingNoticeResult {
  type: MeetingType;
  minimumNoticeDays: number;
  clearDaysAvailable: number;
  valid: boolean;
  reason: string;
}

/**
 * Compute the notice mechanics for a meeting under the Companies Act 2013:
 * board meetings need 7 days' notice (shorter with director consent); general
 * meetings need 21 clear days (EGM shorter with 95% consent). "Clear days"
 * exclude the day of service and the day of the meeting.
 */
export function computeMeetingNotice(input: {
  type: MeetingType;
  calledOn: string;
  meetingDate: string;
  consentWaiverPct?: number;
}): MeetingNoticeResult {
  const minimumNoticeDays = input.type === "board" ? 7 : 21;
  // Clear days: exclude the day of service and the day of the meeting.
  const clearDaysAvailable = daysBetween(input.calledOn, input.meetingDate) - 1;

  let valid = clearDaysAvailable >= minimumNoticeDays;
  let reason = valid
    ? `${clearDaysAvailable} clear days meet the ${minimumNoticeDays}-day minimum.`
    : `${clearDaysAvailable} clear days fall short of the ${minimumNoticeDays}-day minimum.`;

  if (!valid && input.type === "board" && (input.consentWaiverPct ?? 0) > 0) {
    valid = true;
    reason = "Shorter notice valid with the consent of all directors.";
  }
  if (!valid && input.type === "egm" && (input.consentWaiverPct ?? 0) >= 95) {
    valid = true;
    reason = "Shorter notice valid with the consent of at least 95% of members entitled to vote.";
  }

  return { type: input.type, minimumNoticeDays, clearDaysAvailable, valid, reason };
}

export interface Resolution {
  id: string;
  meetingType: MeetingType;
  meetingDate: string;
  subject: string;
  /** ordinary majority / special (75%) / unanimous. */
  voteRequirement: "ordinary" | "special" | "unanimous";
  passed: boolean;
  /** Does this resolution require MGT-14 filing? */
  requiresMgst14: boolean;
}

/** Board resolutions requiring MGT-14 filing, and their filing due date. */
export function boardResolutionsForFiling(resolutions: Resolution[]): { resolution: Resolution; dueDate: string }[] {
  return resolutions
    .filter((r) => r.passed && r.requiresMgst14)
    .map((r) => ({ resolution: r, dueDate: addDays(r.meetingDate, 30) }));
}

// ===========================================================================
// 4. State / professional tax / labour-law / FEMA obligations
// ===========================================================================

export type ObligationKind = "professional-tax" | "shops-establishments" | "labour-law" | "fema" | "other";

export interface AdditionalObligation {
  kind: ObligationKind;
  authority: string;
  description: string;
  frequency: "monthly" | "quarterly" | "annual" | "event";
  /** Human-readable due rule, e.g. "Return by 20th of the following month". */
  dueRule: string;
}

/** States that levy professional tax on employers. */
export const PROFESSIONAL_TAX_STATES: readonly string[] = [
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

/** State-specific and activity-specific obligations beyond the ROC calendar. */
export function obligationsForEntity(
  entity: Pick<EntityMaster, "entityType" | "registeredOffice" | "incorporationDate">,
  opts: { states?: string[]; employsStaff?: boolean; foreignInvestment?: boolean } = {},
): AdditionalObligation[] {
  const obligations: AdditionalObligation[] = [];
  const states = new Set(
    [entity.registeredOffice.state, ...(opts.states ?? [])].map((s) => s.trim().toLowerCase()).filter(Boolean),
  );

  for (const state of states) {
    if (PROFESSIONAL_TAX_STATES.includes(state)) {
      obligations.push({
        kind: "professional-tax",
        authority: `${state} Professional Tax authority`,
        description: `Professional tax registration and returns for ${state}`,
        frequency: "monthly",
        dueRule: "Monthly return and payment by the 20th of the following month (state-specific).",
      });
    }
    obligations.push({
      kind: "shops-establishments",
      authority: `${state} Labour Department`,
      description: `Shops & Establishments registration/renewal for ${state}`,
      frequency: "event",
      dueRule: "Registration within 30 days of commencement; renewal per state cycle.",
    });
  }

  if (opts.employsStaff) {
    obligations.push({
      kind: "labour-law",
      authority: "EPFO",
      description: "Provident fund (EPF) monthly return",
      frequency: "monthly",
      dueRule: "ECR by the 15th of the following month.",
    });
    obligations.push({
      kind: "labour-law",
      authority: "ESIC",
      description: "Employees' State Insurance (ESI) monthly contribution",
      frequency: "monthly",
      dueRule: "Contribution by the 15th of the following month.",
    });
  }

  if (opts.foreignInvestment || entity.entityType === "foreign-subsidiary") {
    obligations.push({
      kind: "fema",
      authority: "RBI / AD Bank",
      description: "FEMA reporting on foreign investment (FC-GPR / FCTRS)",
      frequency: "event",
      dueRule: "FC-GPR within 30 days of allotment; FCTRS within 30 days of transfer.",
    });
  }

  return obligations;
}

// ===========================================================================
// 5. Document repository, firm-wide calendar, year-over-year carry-forward
// ===========================================================================

export type DocumentKind =
  | "certificate-of-incorporation"
  | "moa"
  | "aoa"
  | "board-resolution"
  | "shareholder-resolution"
  | "financial-statements"
  | "board-report"
  | "auditor-report"
  | "annual-return"
  | "shareholding-pattern"
  | "charge-instrument"
  | "auditor-consent"
  | "director-consent"
  | "address-proof"
  | "related-party-disclosure"
  | "kyc"
  | "scheme-document";

export interface EntityDocument {
  id: string;
  entityId: string;
  kind: DocumentKind;
  title: string;
  version: number;
  uploadedAt: string;
  linkedForm?: string | null;
}

export interface DocumentReadiness {
  complete: boolean;
  present: DocumentKind[];
  missing: DocumentKind[];
}

/** Check the repository holds every document a form requires. */
export function documentReadiness(documents: EntityDocument[], requiredKinds: DocumentKind[]): DocumentReadiness {
  const present = new Set(documents.map((d) => d.kind));
  const missing = requiredKinds.filter((k) => !present.has(k));
  return { complete: missing.length === 0, present: requiredKinds.filter((k) => present.has(k)), missing };
}

/** Attach (or version) a document against an entity and optional form. */
export function attachDocument(
  documents: EntityDocument[],
  doc: {
    id: string;
    entityId: string;
    kind: DocumentKind;
    title: string;
    uploadedAt: string;
    linkedForm?: string | null;
  },
): EntityDocument[] {
  const priorVersions = documents.filter((d) => d.entityId === doc.entityId && d.kind === doc.kind);
  return [...documents, { ...doc, version: priorVersions.length + 1, linkedForm: doc.linkedForm ?? null }];
}

export interface FirmCalendarEntry {
  entityId: string;
  entityName: string;
  tasks: EntityFilingTask[];
}

export interface FirmWideCalendar {
  asOf: string;
  totalTasks: number;
  overdue: { entityId: string; form: string; dueDate: string }[];
  dueNext30Days: { entityId: string; form: string; dueDate: string }[];
  byEntity: Record<string, number>;
  byForm: Record<string, number>;
}

/** Roll every entity's filing calendar into the firm-wide view. */
export function buildFirmWideCalendar(entries: FirmCalendarEntry[], asOf: string): FirmWideCalendar {
  const byEntity: Record<string, number> = {};
  const byForm: Record<string, number> = {};
  const overdue: FirmWideCalendar["overdue"] = [];
  const dueNext30Days: FirmWideCalendar["dueNext30Days"] = [];
  let totalTasks = 0;

  for (const entry of entries) {
    byEntity[entry.entityId] = (byEntity[entry.entityId] ?? 0) + entry.tasks.length;
    for (const task of entry.tasks) {
      totalTasks += 1;
      byForm[task.form] = (byForm[task.form] ?? 0) + 1;
      const diff = daysBetween(asOf, task.dueDate);
      if (task.status === "overdue" || diff < 0) {
        overdue.push({ entityId: entry.entityId, form: task.form, dueDate: task.dueDate });
      } else if (diff <= 30) {
        dueNext30Days.push({ entityId: entry.entityId, form: task.form, dueDate: task.dueDate });
      }
    }
  }

  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { asOf, totalTasks, overdue, dueNext30Days, byEntity, byForm };
}

export interface EntityCarryForwardChanges {
  newFinancialYearEnd: string;
  lastAgmDate?: string | null;
  directors?: Director[];
  shareholders?: Shareholder[];
  charges?: Charge[];
  auditor?: Auditor | null;
  registeredOffice?: RegisteredOffice;
  capital?: CapitalStructure;
}

/**
 * Carry the entity master into the next year: retain the registers by default
 * (a firm should not have to rebuild them each year), apply only the changes
 * supplied, and roll the financial-year end / AGM date forward.
 */
export function carryForwardEntity(entity: EntityMaster, changes: EntityCarryForwardChanges): EntityMaster {
  return {
    ...entity,
    financialYearEnd: changes.newFinancialYearEnd,
    lastAgmDate: changes.lastAgmDate !== undefined ? changes.lastAgmDate : entity.lastAgmDate,
    directors: changes.directors ?? entity.directors,
    shareholders: changes.shareholders ?? entity.shareholders,
    charges: changes.charges ?? entity.charges,
    auditor: changes.auditor !== undefined ? changes.auditor : entity.auditor,
    registeredOffice: changes.registeredOffice ?? entity.registeredOffice,
    capital: changes.capital ?? entity.capital,
  };
}
