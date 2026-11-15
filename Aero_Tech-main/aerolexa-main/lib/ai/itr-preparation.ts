/** AI ITR Preparation Engine
 *  Natural-language → ITR preparation using LLMs.
 *  Partners describe tax situations in plain English.
 */

export interface ITRClientInfo {
  clientName: string;
  financialYear: string;
  entityKind: "individual" | "HUF" | "company" | "firm" | "LLP";
}

export interface ITRPreparationResult {
  clientInfo: ITRClientInfo;
  grossTotalIncome: number;
  totalDeductions: number;
  totalIncome: number;
  taxLiability: number;
  taxAfterRebate87A: number;
  itrForm: "ITR-1" | "ITR-2" | "ITR-3" | "ITR-4" | "ITR-5" | "ITR-6" | "ITR-7";
  formReason: string;
  filledSections: {
    salary: string;
    houseProperty: string;
    capitalGain: string;
    business: string;
    deductions: string;
    tax: string;
    totalIncome: string;
  };
  recommendations: string[];
  computationId: string;
  computedAt: string;
  modelUsed: string;
  promptsUsed: number;
}

/** Prepare ITR from natural-language description (demo version). */
export async function prepareITRInEnglish(params: {
  clientName: string;
  financialYear: string;
  totalIncome: string;
  entityKind?: "individual" | "HUF" | "company" | "firm" | "LLP";
}): Promise<ITRPreparationResult> {
  const { clientName, financialYear, totalIncome, entityKind = "individual" } = params;
  const grossTotalIncome = parseInt(totalIncome) || 0;
  const totalDeductions = 0;
  const totalIncomeAmount = grossTotalIncome - totalDeductions;
  const taxLiability = Math.round(grossTotalIncome * 0.3);
  const taxAfterRebate87A = Math.min(25000, taxLiability);

  let itrForm: "ITR-1" | "ITR-2" | "ITR-3" | "ITR-4" | "ITR-5" | "ITR-6" | "ITR-7";
  let formReason: string;

  if (entityKind === "individual") {
    itrForm = "ITR-1";
    formReason = "Individual, no business income";
  } else if (entityKind === "firm" || entityKind === "LLP") {
    itrForm = "ITR-5";
    formReason = "Firm/LLP";
  } else {
    itrForm = "ITR-2";
    formReason = "Individual with other income";
  }

  return {
    clientInfo: { clientName, financialYear, entityKind: entityKind as "individual" | "HUF" | "company" | "firm" | "LLP" },
    grossTotalIncome,
    totalDeductions,
    totalIncome: totalIncomeAmount,
    taxLiability,
    taxAfterRebate87A,
    itrForm,
    formReason,
    filledSections: {
      salary: "",
      houseProperty: "",
      capitalGain: "",
      business: "",
      deductions: "",
      tax: "",
      totalIncome: totalIncomeAmount.toString(),
    },
    recommendations: [],
    computationId: crypto.randomUUID(),
    computedAt: new Date().toISOString(),
    modelUsed: "demo",
    promptsUsed: 0,
  };
}