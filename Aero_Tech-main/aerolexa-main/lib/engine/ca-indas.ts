/**
 * Ind AS / accounting-policy judgments — Ind AS applicability thresholds, the
 * policy-register scaffold, key judgment areas, transition-entry scaffolding and
 * the disclosure checklist.
 *
 * SCOPE AND HONESTY: the applicability thresholds and judgment areas are the
 * commonly referenced ones and are surfaced on the result so a reviewer can
 * verify them against the current Ind AS framework/notifications for the FY.
 * The engine is a planning scaffold on caller-supplied inputs; it does not
 * classify the entity's financial statements and does not issue an accounting
 * opinion.
 */

export interface JudgmentEntry {
  area: string;
  description: string;
  estimationUncertainty: boolean;
  critique: string;
}

export interface TransitionEntry {
  date: string;
  method: string;
  openingAdjustment: number;
  note: string;
}

export interface IndAsResult {
  fy: string;
  indAsApplicable: boolean;
  applicability: { threshold: string; note: string };
  standards: { standard: string; note: string }[];
  judgments: JudgmentEntry[];
  transition: TransitionEntry[];
  disclosureChecklist: string[];
  warnings: string[];
  methodology: string[];
}

const IND_AS_APPLICABILITY_THRESHOLD = "commonly referenced turnover/parameter threshold for Ind AS applicability";

const KEY_JUDGMENT_AREAS = [
  {
    area: "Ind AS 115",
    description:
      "Revenue from contracts with customers — recognition timing, performance obligations, variable consideration, stand-alone selling price.",
    estimationUncertainty: true,
  },
  {
    area: "Ind AS 36",
    description: "Impairment of assets — cash-generating units, recoverable amount, value-in-use, discount rates.",
    estimationUncertainty: true,
  },
  {
    area: "Ind AS 116",
    description: "Leases — right-of-use asset and lease liability measurement, lease term, discount rate.",
    estimationUncertainty: true,
  },
  {
    area: "Construction contracts",
    description: "Revenue recognition over time vs point in time, percentage of completion, estimates.",
    estimationUncertainty: true,
  },
  {
    area: "Ind AS 109",
    description: "Financial instruments — classification, impairment (expected credit losses), hedge accounting.",
    estimationUncertainty: true,
  },
  {
    area: "Inventory",
    description: "Cost formulas, net realisable value assessment, obsolescence provisions.",
    estimationUncertainty: true,
  },
  {
    area: "Provisions and contingencies",
    description: "Recognised provisions, contingent liabilities, discounting, reassessment.",
    estimationUncertainty: true,
  },
  {
    area: "Property, plant and equipment",
    description: "Componentisation, valuation, depreciation methods, residual values.",
    estimationUncertainty: true,
  },
  {
    area: "Income taxes",
    description: "Deferred tax assets/liabilities, uncertain tax positions, rate changes.",
    estimationUncertainty: true,
  },
  {
    area: "Related party disclosures",
    description: "Identification, disclosures, transactions with related parties.",
    estimationUncertainty: false,
  },
];

export function buildIndAsJudgmentRegister(input: {
  fy: string;
  indAsApplicable: boolean;
  standards: string[];
  judgments: { area: string; description: string; estimationUncertainty: boolean }[];
  transition: { date: string; method: string; openingAdjustment: number };
}): IndAsResult {
  const { fy, indAsApplicable, standards, judgments, transition } = input;

  const applicability = {
    threshold: IND_AS_APPLICABILITY_THRESHOLD,
    note: indAsApplicable
      ? "Based on the inputs, Ind AS is applicable for the entity for the FY; confirm the current threshold/parameter with the engagement team."
      : "Based on the inputs, Ind AS is not applicable for the entity for the FY; confirm the current threshold/parameter with the engagement team.",
  };

  const standardsOut = standards.map((s) => ({
    standard: s,
    note: `Reviewer to confirm the current scope and requirements of ${s} for the FY.`,
  }));

  // Key judgment areas scaffold: merge supplied judgments with the common list.
  const mergedJudgments = KEY_JUDGMENT_AREAS.concat(judgments).reduce<JudgmentEntry[]>((acc, j) => {
    const existing = acc.find((a) => a.area === j.area);
    if (existing) {
      existing.estimationUncertainty = existing.estimationUncertainty || j.estimationUncertainty;
      existing.description = existing.description;
    } else {
      acc.push({
        area: j.area,
        description: j.description || "Key judgment area; reviewer to document.",
        estimationUncertainty: true,
        critique: "Reviewer to document the judgment made and the key assumptions.",
      });
    }
    return acc;
  }, []);

  const transitionOut = [
    {
      date: transition.date,
      method: transition.method,
      openingAdjustment: transition.openingAdjustment,
      note: `Transition entry dated ${transition.date} under ${transition.method}; opening adjustment ${transition.openingAdjustment}.`,
    },
  ];

  const disclosureChecklist = [
    "Statement of compliance with Ind AS.",
    "Targets of existing management compensation plans.",
    " judgements and key assumptions in accounting estimates.",
    "Reconciliations of movements in equity.",
    "Segment reporting (if applicable).",
    "Related party disclosures (if applicable).",
    "Fair value hierarchy disclosures (if applicable).",
    "Information about assets, liabilities, equity, income and expenses (if applicable).",
  ];

  const warnings: string[] = [
    "Ind AS applicability thresholds and key judgment areas shown are the commonly referenced ones; verify against the current Ind AS framework/notifications for the FY.",
    "The policy register and transition entries are a planning scaffold; the reviewer should document the entity's actual accounting policies and transition.",
  ];

  return {
    fy,
    indAsApplicable,
    applicability,
    standards: standardsOut,
    judgments: mergedJudgments,
    transition: transitionOut,
    disclosureChecklist,
    warnings,
    methodology: [
      "The engine produces a planning scaffold for Ind AS applicability, the policy register, key judgment areas, transition entries and the disclosure checklist.",
      "Applicability thresholds and judgment areas are surfaced for reviewer verification against the current Ind AS framework/notifications.",
      "The output supports documentation of accounting policies and judgments; it does not classify the entity's financial statements.",
    ],
  };
}
