/** Professional Tax registry for Indian states */

import { INR, formatInr } from "./india-tax";

export class ProfessionalTaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfessionalTaxError";
  }
}

export interface PtSlab {
  upTo: number | null;
  amount: number;
}

export interface PtStateConfig {
  stateCode: string;
  stateName: string;
  applies: boolean;
  slabs: PtSlab[];
  annualCap?: number | null;
  registrationThreshold?: number;
  notes?: string[];
}

export const PT_REGISTRY: Record<string, PtStateConfig> = {
  "14": {
    stateCode: "14",
    stateName: "Maharashtra",
    applies: true,
    slabs: [
      { upTo: INR(7500), amount: 0 },
      { upTo: INR(10000), amount: INR(175) },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(7500),
    notes: ["Feb: 300 instead of 200."],
  },
  "29": {
    stateCode: "29",
    stateName: "Karnataka",
    applies: true,
    slabs: [
      { upTo: INR(15000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(15000),
  },
  "23": {
    stateCode: "23",
    stateName: "Tamil Nadu",
    applies: true,
    slabs: [
      { upTo: INR(3500), amount: 0 },
      { upTo: INR(7500), amount: INR(225) },
      { upTo: INR(10000), amount: INR(525) },
      { upTo: INR(12500), amount: INR(750) },
      { upTo: null, amount: INR(1000) },
    ],
    registrationThreshold: INR(3500),
  },
  "07": {
    stateCode: "07",
    stateName: "Gujarat",
    applies: true,
    slabs: [
      { upTo: INR(5999), amount: 0 },
      { upTo: INR(8333), amount: INR(80) },
      { upTo: INR(12500), amount: INR(150) },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(5999),
  },
  "01": {
    stateCode: "01",
    stateName: "Andhra Pradesh",
    applies: true,
    slabs: [
      { upTo: INR(15000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(15000),
  },
  "24": {
    stateCode: "24",
    stateName: "Telangana",
    applies: true,
    slabs: [
      { upTo: INR(15000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(15000),
  },
  "12": {
    stateCode: "12",
    stateName: "Kerala",
    applies: true,
    slabs: [
      { upTo: INR(10725), amount: INR(20) },
      { upTo: INR(15435), amount: INR(30) },
      { upTo: INR(20700), amount: INR(50) },
      { upTo: null, amount: INR(750) },
    ],
    registrationThreshold: INR(10725),
  },
  "21": {
    stateCode: "21",
    stateName: "Rajasthan",
    applies: true,
    slabs: [
      { upTo: INR(10000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(10000),
  },
  "13": {
    stateCode: "13",
    stateName: "Madhya Pradesh",
    applies: true,
    slabs: [
      { upTo: INR(75000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(75000),
  },
  "28": {
    stateCode: "28",
    stateName: "West Bengal",
    applies: true,
    slabs: [
      { upTo: INR(10000), amount: 0 },
      { upTo: INR(15000), amount: INR(110) },
      { upTo: null, amount: INR(150) },
    ],
    registrationThreshold: INR(10000),
  },
  "03": {
    stateCode: "03",
    stateName: "Assam",
    applies: true,
    slabs: [
      { upTo: INR(10000), amount: 0 },
      { upTo: null, amount: INR(100) },
    ],
    registrationThreshold: INR(10000),
  },
  "05": {
    stateCode: "05",
    stateName: "Chhattisgarh",
    applies: true,
    slabs: [
      { upTo: INR(15000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(15000),
  },
  "10": {
    stateCode: "10",
    stateName: "Jharkhand",
    applies: true,
    slabs: [
      { upTo: INR(15000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(15000),
  },
  "27": {
    stateCode: "27",
    stateName: "Uttarakhand",
    applies: true,
    slabs: [
      { upTo: INR(15000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(15000),
  },
  "06": {
    stateCode: "06",
    stateName: "Goa",
    applies: true,
    slabs: [
      { upTo: INR(9999), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(9999),
  },
  "22": {
    stateCode: "22",
    stateName: "Sikkim",
    applies: true,
    slabs: [
      { upTo: INR(25000), amount: 0 },
      { upTo: null, amount: INR(300) },
    ],
    registrationThreshold: INR(25000),
  },
  "25": {
    stateCode: "25",
    stateName: "Tripura",
    applies: true,
    slabs: [
      { upTo: INR(15000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(15000),
  },
  "33": {
    stateCode: "33",
    stateName: "Puducherry",
    applies: true,
    slabs: [
      { upTo: INR(15000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(15000),
  },
  "31": {
    stateCode: "31",
    stateName: "Dadra and Nagar Haveli and Daman and Diu",
    applies: true,
    slabs: [
      { upTo: INR(15000), amount: 0 },
      { upTo: null, amount: INR(200) },
    ],
    registrationThreshold: INR(15000),
  },
  "08": {
    stateCode: "08",
    stateName: "Haryana",
    applies: false,
    slabs: [],
    notes: ["Haryana does not levy professional tax."],
  },
  "09": {
    stateCode: "09",
    stateName: "Himachal Pradesh",
    applies: false,
    slabs: [],
    notes: ["Himachal Pradesh does not levy professional tax."],
  },
  "20": {
    stateCode: "20",
    stateName: "Punjab",
    applies: false,
    slabs: [],
    notes: ["Punjab does not levy professional tax."],
  },
  "26": {
    stateCode: "26",
    stateName: "Uttar Pradesh",
    applies: false,
    slabs: [],
    notes: ["UP stopped levying PT from 2019-20."],
  },
  "32": {
    stateCode: "32",
    stateName: "Delhi",
    applies: false,
    slabs: [],
    notes: ["Delhi does not levy professional tax."],
  },
};

export interface PtComputation {
  stateCode: string;
  stateName: string;
  grossSalary: number;
  ptAmount: number;
  slab: string;
  applies: boolean;
  notes: string[];
  methodology: string[];
}

export function computeProfessionalTax(opts: { stateCode: string; grossSalary: number }): PtComputation {
  const config = PT_REGISTRY[opts.stateCode];
  if (!config) {
    throw new ProfessionalTaxError(`Unknown state code "${opts.stateCode}".`);
  }

  const gross = Math.max(0, Math.round(opts.grossSalary));

  if (!config.applies) {
    return {
      stateCode: opts.stateCode,
      stateName: config.stateName,
      grossSalary: gross,
      ptAmount: 0,
      slab: "PT not applicable",
      applies: false,
      notes: config.notes ?? ["This state does not levy professional tax."],
      methodology: [
        `${config.stateName} does not levy professional tax - no deduction.`,
        `Gross salary: ${formatInr(gross)}.`,
      ],
    };
  }

  const sortedSlabs = [...config.slabs].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  let applicableSlab: PtSlab | null = null;
  for (const slab of sortedSlabs) {
    if (slab.upTo === null || gross <= slab.upTo) {
      applicableSlab = slab;
      break;
    }
  }

  if (!applicableSlab) {
    return {
      stateCode: opts.stateCode,
      stateName: config.stateName,
      grossSalary: gross,
      ptAmount: 0,
      slab: "No applicable slab",
      applies: true,
      notes: config.notes ?? [],
      methodology: [`${config.stateName}: no qualifying PT slab for gross salary ${formatInr(gross)}.`],
    };
  }

  const ptAmount = Math.round(applicableSlab.amount);
  const slabDesc = applicableSlab.upTo === null ? "Above threshold (open top slab)" : `Up to threshold`;

  return {
    stateCode: opts.stateCode,
    stateName: config.stateName,
    grossSalary: gross,
    ptAmount,
    slab: slabDesc,
    applies: true,
    notes: config.notes ?? [],
    methodology: [
      `${config.stateName} PT: gross salary ${formatInr(gross)} falls in slab - PT ${formatInr(ptAmount)}.`,
    ],
  };
}

export function stateLeviatesPt(stateCode: string): boolean {
  return PT_REGISTRY[stateCode]?.applies ?? false;
}

export function ptConfigForState(stateCode: string): PtStateConfig | null {
  return PT_REGISTRY[stateCode] ?? null;
}
