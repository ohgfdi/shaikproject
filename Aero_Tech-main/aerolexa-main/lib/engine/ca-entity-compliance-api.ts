/**
 * Corporate-compliance operating workflow — API adapter.
 *
 * `ca-entity-compliance.ts` is the pure entity-lifecycle / ROC workflow engine;
 * it speaks in MINOR UNITS (paise) and carries a rich `EntityMaster` type. This
 * module makes it reachable from `POST /api/ca/compute` under
 * `kind: "entity-compliance"`: it validates an op-shaped payload with Zod and
 * converts the API's RUPEES-as-decimals into integer PAISE (capital, charge
 * amounts), matching every other CA engine.
 *
 * Kept as a pure, exported dispatcher (rather than inline in the route) so the
 * rupee→paise conversion on the nested entity master is unit-testable without a
 * server or a database.
 *
 * Nothing here files with the MCA or a state portal; it computes the workflow a
 * reviewer checks against the current notification.
 */

import { z } from "zod";

import {
  EntityComplianceError,
  attachDocument,
  boardResolutionsForFiling,
  buildEntityFilingCalendar,
  buildFirmWideCalendar,
  carryForwardEntity,
  computeMeetingNotice,
  computeRocDueDate,
  documentReadiness,
  entityRegister,
  markTaskFiled,
  obligationsForEntity,
  rocFormsForEvent,
  validateEntityMaster,
  ROC_FORM_MAP,
  type Auditor,
  type CapitalStructure,
  type Charge,
  type Director,
  type EntityCarryForwardChanges,
  type EntityMaster,
  type RegisteredOffice,
  type Shareholder,
} from "./ca-entity-compliance";

/** Rupee amount (major units) as it arrives over the API. */
const rupees = z.number().finite().safe();
/** Convert rupees (major) to paise (minor), the engine's unit. */
const paise = (n: number) => Math.round(n * 100);

const entityType = z.enum([
  "private-limited",
  "public-limited",
  "one-person-company",
  "section-8",
  "deemed-public",
  "llp",
  "foreign-subsidiary",
]);

const rocEvent = z.enum([
  "annual-financial-statements",
  "annual-return",
  "director-kyc",
  "auditor-appointment",
  "director-appointment",
  "director-cessation",
  "director-particulars-change",
  "registered-office-change",
  "authorised-capital-change",
  "share-allotment",
  "charge-creation",
  "charge-satisfaction",
  "board-resolution",
  "related-party-transaction",
  "scheme-merger",
]);

const designation = z.enum([
  "managing-director",
  "whole-time-director",
  "director",
  "nominee-director",
  "independent-director",
]);
const chargeType = z.enum(["creation", "modification", "satisfaction"]);
const meetingType = z.enum(["board", "agm", "egm", "class"]);
const documentKind = z.enum([
  "certificate-of-incorporation",
  "moa",
  "aoa",
  "board-resolution",
  "shareholder-resolution",
  "financial-statements",
  "board-report",
  "auditor-report",
  "annual-return",
  "shareholding-pattern",
  "charge-instrument",
  "auditor-consent",
  "director-consent",
  "address-proof",
  "related-party-disclosure",
  "kyc",
  "scheme-document",
]);

const registeredOffice = z.object({
  line1: z.string(),
  line2: z.string().nullish(),
  city: z.string(),
  state: z.string(),
  pincode: z.string(),
  changedOn: z.string().nullish(),
});

/** Capital in RUPEES at the API boundary; converted to paise for the engine. */
const capital = z.object({ authorised: rupees, paidUp: rupees });

const director = z.object({
  name: z.string(),
  din: z.string(),
  designation,
  appointedOn: z.string(),
  resignedOn: z.string().nullish(),
  dinKycFiledOn: z.string().nullish(),
  disqualified: z.boolean().optional(),
});

const shareholder = z.object({
  name: z.string(),
  pan: z.string().nullish(),
  shareClass: z.enum(["equity", "preference"]),
  shares: z.number().finite(),
});

/** Charge amount in RUPEES at the API boundary. */
const charge = z.object({
  id: z.string(),
  chargeType,
  holder: z.string(),
  amount: rupees,
  createdOn: z.string(),
  registeredOn: z.string().nullish(),
});

const auditor = z.object({ name: z.string(), appointedOn: z.string(), termEndsOn: z.string() });

const entityMaster = z.object({
  entityId: z.string().min(1),
  legalName: z.string().min(1),
  cin: z.string().nullish(),
  llpin: z.string().nullish(),
  entityType,
  incorporationDate: z.string(),
  registeredOffice,
  objects: z.array(z.string()),
  capital,
  directors: z.array(director),
  shareholders: z.array(shareholder),
  charges: z.array(charge),
  auditor: auditor.nullish(),
  financialYearEnd: z.string(),
  lastAgmDate: z.string().nullish(),
});

const entityDocument = z.object({
  id: z.string().min(1),
  entityId: z.string().min(1),
  kind: documentKind,
  title: z.string(),
  version: z.number().int().nonnegative(),
  uploadedAt: z.string(),
  linkedForm: z.string().nullish(),
});

const filingTask = z.object({
  id: z.string().min(1),
  entityId: z.string().min(1),
  form: z.string().min(1),
  event: rocEvent,
  description: z.string(),
  dueDate: z.string(),
  status: z.enum(["pending", "filed", "overdue", "not-applicable"]),
  dependsOn: z.array(z.string()),
  blockedBy: z.array(z.string()),
  documentRefs: z.array(z.string()),
  filedOn: z.string().nullable(),
  srn: z.string().nullable(),
});

const resolution = z.object({
  id: z.string().min(1),
  meetingType,
  meetingDate: z.string(),
  subject: z.string(),
  voteRequirement: z.enum(["ordinary", "special", "unanimous"]),
  passed: z.boolean(),
  requiresMgst14: z.boolean(),
});

const carryForwardChanges = z.object({
  newFinancialYearEnd: z.string(),
  lastAgmDate: z.string().nullish(),
  directors: z.array(director).optional(),
  shareholders: z.array(shareholder).optional(),
  charges: z.array(charge).optional(),
  auditor: auditor.nullish(),
  registeredOffice: registeredOffice.optional(),
  capital: capital.optional(),
});

// ---------------------------------------------------------------------------
// rupee → paise conversion on the nested entity master
// ---------------------------------------------------------------------------

function toRegisteredOffice(input: z.infer<typeof registeredOffice>): RegisteredOffice {
  return { ...input, line2: input.line2 ?? null, changedOn: input.changedOn ?? null };
}

function toCapital(input: z.infer<typeof capital>): CapitalStructure {
  return { authorisedMinor: paise(input.authorised), paidUpMinor: paise(input.paidUp) };
}

function toDirector(input: z.infer<typeof director>): Director {
  return { ...input, resignedOn: input.resignedOn ?? null, dinKycFiledOn: input.dinKycFiledOn ?? null };
}

function toShareholder(input: z.infer<typeof shareholder>): Shareholder {
  return { ...input, pan: input.pan ?? null };
}

function toCharge(input: z.infer<typeof charge>): Charge {
  return {
    id: input.id,
    chargeType: input.chargeType,
    holder: input.holder,
    amountMinor: paise(input.amount),
    createdOn: input.createdOn,
    registeredOn: input.registeredOn ?? null,
  };
}

function toAuditor(input: z.infer<typeof auditor>): Auditor {
  return { name: input.name, appointedOn: input.appointedOn, termEndsOn: input.termEndsOn };
}

function toEntityMaster(input: z.infer<typeof entityMaster>): EntityMaster {
  return {
    entityId: input.entityId,
    legalName: input.legalName,
    cin: input.cin ?? null,
    llpin: input.llpin ?? null,
    entityType: input.entityType,
    incorporationDate: input.incorporationDate,
    registeredOffice: toRegisteredOffice(input.registeredOffice),
    objects: input.objects,
    capital: toCapital(input.capital),
    directors: input.directors.map(toDirector),
    shareholders: input.shareholders.map(toShareholder),
    charges: input.charges.map(toCharge),
    auditor: input.auditor ? toAuditor(input.auditor) : null,
    financialYearEnd: input.financialYearEnd,
    lastAgmDate: input.lastAgmDate ?? null,
  };
}

function toCarryForwardChanges(input: z.infer<typeof carryForwardChanges>): EntityCarryForwardChanges {
  return {
    newFinancialYearEnd: input.newFinancialYearEnd,
    lastAgmDate: input.lastAgmDate !== undefined ? input.lastAgmDate : undefined,
    directors: input.directors?.map(toDirector),
    shareholders: input.shareholders?.map(toShareholder),
    charges: input.charges?.map(toCharge),
    auditor: input.auditor !== undefined ? (input.auditor ? toAuditor(input.auditor) : null) : undefined,
    registeredOffice: input.registeredOffice ? toRegisteredOffice(input.registeredOffice) : undefined,
    capital: input.capital ? toCapital(input.capital) : undefined,
  };
}

/** The discriminated union the route parses. Money fields are RUPEES. */
export const entityComplianceInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("validate-master"), entity: entityMaster }),
  z.object({ op: z.literal("register"), entity: entityMaster }),
  z.object({ op: z.literal("roc-forms"), event: rocEvent }),
  z.object({
    op: z.literal("due-date"),
    form: z.string().min(1),
    context: z.object({
      eventDate: z.string().optional(),
      agmDate: z.string().optional(),
      financialYearEnd: z.string().optional(),
      asOf: z.string().optional(),
    }),
  }),
  z.object({
    op: z.literal("filing-calendar"),
    entity: entityMaster,
    events: z.array(z.object({ event: rocEvent, eventDate: z.string(), form: z.string().optional() })),
    asOf: z.string(),
    requiredForms: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal("mark-filed"),
    task: filingTask,
    filedOn: z.string(),
    srn: z.string(),
  }),
  z.object({
    op: z.literal("meeting-notice"),
    type: meetingType,
    calledOn: z.string(),
    meetingDate: z.string(),
    consentWaiverPct: z.number().finite().optional(),
  }),
  z.object({ op: z.literal("resolutions-for-filing"), resolutions: z.array(resolution) }),
  z.object({
    op: z.literal("obligations"),
    entity: entityMaster,
    opts: z
      .object({
        states: z.array(z.string()).optional(),
        employsStaff: z.boolean().optional(),
        foreignInvestment: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({
    op: z.literal("document-readiness"),
    documents: z.array(entityDocument),
    requiredKinds: z.array(documentKind),
  }),
  z.object({
    op: z.literal("attach-document"),
    documents: z.array(entityDocument),
    doc: z.object({
      id: z.string().min(1),
      entityId: z.string().min(1),
      kind: documentKind,
      title: z.string(),
      uploadedAt: z.string(),
      linkedForm: z.string().nullish(),
    }),
  }),
  z.object({
    op: z.literal("firm-calendar"),
    entries: z.array(z.object({ entityId: z.string().min(1), entityName: z.string(), tasks: z.array(filingTask) })),
    asOf: z.string(),
  }),
  z.object({ op: z.literal("carry-forward"), entity: entityMaster, changes: carryForwardChanges }),
]);

export type EntityComplianceRequest = z.infer<typeof entityComplianceInput>;

/** Dispatch a validated op to the engine, converting rupee money fields to paise. */
export function computeEntityCompliance(input: EntityComplianceRequest): unknown {
  switch (input.op) {
    case "validate-master":
      return validateEntityMaster(toEntityMaster(input.entity));

    case "register":
      return entityRegister(toEntityMaster(input.entity));

    case "roc-forms":
      return rocFormsForEvent(input.event);

    case "due-date": {
      const spec = ROC_FORM_MAP.find((s) => s.form === input.form);
      if (!spec) throw new EntityComplianceError(`Unknown ROC form: ${input.form}`);
      return {
        form: spec.form,
        event: spec.event,
        description: spec.description,
        dueDate: computeRocDueDate(spec, input.context),
        attachments: spec.attachments,
        dependsOn: spec.dependsOn ?? [],
      };
    }

    case "filing-calendar":
      return buildEntityFilingCalendar({
        entity: toEntityMaster(input.entity),
        events: input.events,
        asOf: input.asOf,
        requiredForms: input.requiredForms,
      });

    case "mark-filed":
      return markTaskFiled(input.task, input.filedOn, input.srn);

    case "meeting-notice":
      return computeMeetingNotice({
        type: input.type,
        calledOn: input.calledOn,
        meetingDate: input.meetingDate,
        consentWaiverPct: input.consentWaiverPct,
      });

    case "resolutions-for-filing":
      return boardResolutionsForFiling(input.resolutions);

    case "obligations":
      return obligationsForEntity(toEntityMaster(input.entity), input.opts ?? {});

    case "document-readiness":
      return documentReadiness(
        input.documents.map((d) => ({ ...d, linkedForm: d.linkedForm ?? null })),
        input.requiredKinds,
      );

    case "attach-document":
      return attachDocument(
        input.documents.map((d) => ({ ...d, linkedForm: d.linkedForm ?? null })),
        {
          id: input.doc.id,
          entityId: input.doc.entityId,
          kind: input.doc.kind,
          title: input.doc.title,
          uploadedAt: input.doc.uploadedAt,
          linkedForm: input.doc.linkedForm ?? null,
        },
      );

    case "firm-calendar":
      return buildFirmWideCalendar(input.entries, input.asOf);

    case "carry-forward":
      return carryForwardEntity(toEntityMaster(input.entity), toCarryForwardChanges(input.changes));
  }
}
