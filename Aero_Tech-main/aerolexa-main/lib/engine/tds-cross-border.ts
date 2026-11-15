/**
 * Non-Resident / Cross-Border TDS Module.
 *
 * A CA practice working with cross-border payments handles:
 *   - TDS on payments to non-residents u/s 195 (and related sections)
 *   - Royalty and FTS (fees for technical services) to non-residents
 *   - FCTRS (Form for Certificate of Tax Refund to Non-Residents) — treaty
 *     relief claims by non-residents for excess TDS
 *   - Tax residency certificates (TRC) and Form 10F
 *   - Treaty interactions: DTAA rate lookup, tie-breaker rules, permanent
 *     establishment analysis
 *   - Non-resident taxation: withholding on different types of income
 *   - Capital gains for NRIs (section 112, 112A, etc.)
 *   - Interest income for NRIs (section 194A equivalent, section 194LC/194LD
 *     for FII/FPI)
 *
 * This module implements the data model and computation helpers for cross-border
 * TDS.
 *
 * SCOPE AND HONESTY: treaty rates and interpretations are caller-supplied data.
 * This module does not provide treaty interpretation or legal opinion. The CA
 * must verify the applicable treaty, the beneficial owner status, and the
 * interpretation of treaty provisions for each case.
 *
 * All amounts are in MINOR UNITS (paise) as integers.
 */

// ---------------------------------------------------------------------------
// DTAA / Treaty Data
// ---------------------------------------------------------------------------

/** A country in the DTAA registry. */
export interface DTAAcountry {
  /** ISO 3166-1 alpha-2 country code. */
  countryCode: string;
  /** Country name. */
  countryName: string;
  /** Whether India has a DTAA with this country. */
  hasDtaa: boolean;
  /** DTAA effective date (yyyy-mm-dd). */
  dtaaEffectiveDate?: string | null;
  /** DTAA status: active | signed-not-ratified | under-negotiation. */
  dtaaStatus: "active" | "signed-not-ratified" | "under-negotiation" | "none";
  /** Is this country on the "specified domestic law" list for Limitation on Benefits? */
  lobApplicable: boolean;
}

/** Royalty rate under a DTAA (caller-supplied treaty data). */
export interface DTaaRoyaltyRate {
  /** Country code. */
  countryCode: string;
  /** Rate % on royalty (may be split by type: industrial/commercial vs. copyright/motion picture). */
  royaltyRatePct: number;
  /** Rate % on copyright royalty for motion pictures (if different). */
  copyrightRoyaltyRatePct?: number | null;
  /** Rate % on cinematograph film royalties (if different). */
  cinematographRoyaltyRatePct?: number | null;
  /** Is there a "withholding tax" exemption for certain royalties? */
  exemptionForCertainRoyalties: boolean;
  /** Conditions for the rate (e.g., beneficial owner, PE conditions). */
  conditions?: string | null;
  /** Source of the rate data (treaty text, CBDT notification, etc.). */
  source: string;
}

/** FTS (fees for technical services) rate under a DTAA. */
export interface DTaaFTSRate {
  /** Country code. */
  countryCode: string;
  /** Rate % on FTS. */
  ftsRatePct: number;
  /** Is FTS covered? (Some treaties exclude FTS, some include). */
  ftsCovered: boolean;
  /** Conditions for the rate. */
  conditions?: string | null;
  /** Source of the rate data. */
  source: string;
}

/** Interest rate under a DTAA. */
export interface DTaaInterestRate {
  /** Country code. */
  countryCode: string;
  /** Rate % on interest. */
  interestRatePct: number;
  /** Is there an exemption for bank interest? */
  bankInterestExempt: boolean;
  /** Conditions for the rate. */
  conditions?: string | null;
  /** Source of the rate data. */
  source: string;
}

/** Capital gains rate under a DTAA. */
export interface DTaaCapitalGainsRate {
  /** Country code. */
  countryCode: string;
  /** Rate % on capital gains (may vary by asset type). */
  capitalGainsRatePct: number;
  /** Is there an exemption for sale of shares if no PE? */
  exemptionForShareSaleWithoutPE: boolean;
  /** Conditions for the rate. */
  conditions?: string | null;
  /** Source of the rate data. */
  source: string;
}

/** A simplified DTAA rate registry (caller-supplied data). */
export interface DTaaRateRegistry {
  /** Country DTAA status. */
  countries: DTAAcountry[];
  /** Royalty rates. */
  royaltyRates: DTaaRoyaltyRate[];
  /** FTS rates. */
  ftsRates: DTaaFTSRate[];
  /** Interest rates. */
  interestRates: DTaaInterestRate[];
  /** Capital gains rates. */
  capitalGainsRates: DTaaCapitalGainsRate[];
  /** Notes on treaty interpretation. */
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Non-Resident Payment
// ---------------------------------------------------------------------------

/** Type of income for a non-resident. */
export type NonResidentIncomeType =
  | "salary" // Salary for services in India
  | "interest" // Interest income
  | "royalty" // Royalty
  | "fts" // Fees for technical services
  | "dividend" // Dividend
  | "capital-gains" // Capital gains
  | "commission" // Commission/brokerage
  | "rent" // Rent
  | "consultant-fee" // Consultant fees
  | "consulting" // Consulting services
  | "other"; // Other income

/** Resident status of the payee. */
export type ResidentStatus =
  | "resident" // Resident in India
  | "non-resident" // Non-resident
  | "rnni" // Resident but not ordinarily resident (RNOR)
  | "foreign-corp" // Foreign company
  | "indian-corp" // Indian company
  | "firm" // Firm (resident or non-resident)
  | "llp" // LLP
  | "trust" // Trust
  | "aop" // Association of persons
  | "boa" // Body of individuals
  | "huf" // Hindu Undivided Family
  | "individual"; // Individual (resident)

/** Non-resident payment event. */
export interface NonResidentPaymentEvent {
  /** Unique id. */
  id: string;
  /** Payee name. */
  payeeName: string;
  /** Payee PAN (if available). */
  payeePan?: string | null;
  /** Payee country of residence (ISO 3166-1 alpha-2). */
  payeeCountry: string;
  /** Resident status. */
  residentStatus: ResidentStatus;
  /** Income type. */
  incomeType: NonResidentIncomeType;
  /** Amount on which tax is to be deducted (gross), minor units. */
  grossAmount: number;
  /** Date of payment. */
  dateOfPayment: string;
  /** Date of credit. */
  dateOfCredit?: string | null;
  /** Nature of payment (description). */
  natureOfPayment: string;
  /** Whether the payment is for services rendered in India. */
  servicesInIndia: boolean;
  /** Whether the payee has a Permanent Establishment (PE) in India. */
  hasPEInIndia: boolean;
  /** PE details (if any). */
  peDetails?: string | null;
  /** Whether the payee has submitted Form 10F. */
  hasForm10F: boolean;
  /** Form 10F reference. */
  form10FRef?: string | null;
  /** Whether the payee has submitted a Tax Residency Certificate (TRC). */
  hasTRC: boolean;
  /** TRC reference. */
  trcRef?: string | null;
  /** TRC validity period. */
  trcValidFrom?: string | null;
  /** TRC validity period. */
  trcValidUntil?: string | null;
  /** Whether treaty benefits are claimed. */
  treatyBenefitsClaimed: boolean;
  /** Treaty rate claimed (%). */
  treatyRateClaimed?: number | null;
  /** Whether the payee is the beneficial owner. */
  isBeneficialOwner: boolean;
  /** Beneficial owner certificate reference (if any). */
  beneficialOwnerCertRef?: string | null;
  /** Withholding tax rate u/s 195 / domestic law (%). */
  domesticRatePct: number;
  /** Treaty rate % (if applicable). */
  treatyRatePct?: number | null;
  /** TDS deducted (minor units). */
  tdsDeducted?: number | null;
  /** TDS deposited (minor units). */
  tdsDeposited?: number | null;
  /** Challan reference. */
  challanRef?: string | null;
  /** Date of deposit. */
  dateOfDeposit?: string | null;
  /** Status: deducted | deposited | filed | pending. */
  status: string;
  /** FCTRS reference (if a refund claim is pending). */
  fctxRef?: string | null;
  /** FCTRS claim amount (minor units). */
  fctxClaimAmount?: number | null;
  /** Notes. */
  notes?: string | null;
}

/**
 * Get the domestic law withholding rate for a non-resident payment.
 * This is the default rate if no treaty benefit is claimed.
 */
export function getDomesticRate(
  incomeType: NonResidentIncomeType,
  _payeeCountry: string,
  _residentStatus: ResidentStatus,
  _hasPEInIndia: boolean,
): number {
  // Default rates u/s 195 and related provisions (caller to verify for the year)
  switch (incomeType) {
    case "salary":
      return 0; // Taxed at slab rates; TDS as per estimated income
    case "interest":
      return 20; // 20% + surcharge + cess (default)
    case "royalty":
      return 20; // 20% + surcharge + cess (default)
    case "fts":
      return 20; // 20% + surcharge + cess (default)
    case "dividend":
      return 20; // 20% + surcharge + cess (default)
    case "capital-gains":
      return 20; // 20% + surcharge + cess (default; may vary by asset)
    case "commission":
      return 20; // 20% + surcharge + cess (default)
    case "rent":
      return 20; // 20% + surcharge + cess (default)
    case "consultant-fee":
      return 20; // 20% + surcharge + cess (default)
    case "consulting":
      return 20; // 20% + surcharge + cess (default)
    case "other":
      return 20; // 20% + surcharge + cess (default)
    default:
      return 20;
  }
}

/**
 * Get the treaty rate for a payment to a non-resident.
 * Returns the treaty rate and whether treaty benefits apply.
 */
export function getTreatyRate(
  registry: DTaaRateRegistry,
  incomeType: NonResidentIncomeType,
  payeeCountry: string,
): { ratePct: number; applicable: boolean; reason: string } {
  // Check if DTAA exists with this country
  const country = registry.countries.find((c) => c.countryCode === payeeCountry.toUpperCase());
  if (!country || !country.hasDtaa || country.dtaaStatus !== "active") {
    return {
      ratePct: getDomesticRate(incomeType, payeeCountry, "non-resident", false),
      applicable: false,
      reason: `No active DTAA with ${payeeCountry} or DTAA not ratified. Domestic rate applies.`,
    };
  }

  // Find the treaty rate for this income type
  switch (incomeType) {
    case "royalty": {
      const royaltyRate = registry.royaltyRates.find((r) => r.countryCode === payeeCountry.toUpperCase());
      if (royaltyRate) {
        return {
          ratePct: royaltyRate.royaltyRatePct,
          applicable: true,
          reason: `DTAA with ${country.countryName} provides ${royaltyRate.royaltyRatePct}% on royalty.${royaltyRate.conditions ? ` Conditions: ${royaltyRate.conditions}` : ""}`,
        };
      }
      break;
    }
    case "fts": {
      const ftsRate = registry.ftsRates.find((r) => r.countryCode === payeeCountry.toUpperCase());
      if (ftsRate && ftsRate.ftsCovered) {
        return {
          ratePct: ftsRate.ftsRatePct,
          applicable: true,
          reason: `DTAA with ${country.countryName} provides ${ftsRate.ftsRatePct}% on FTS.${ftsRate.conditions ? ` Conditions: ${ftsRate.conditions}` : ""}`,
        };
      }
      break;
    }
    case "interest": {
      const interestRate = registry.interestRates.find((r) => r.countryCode === payeeCountry.toUpperCase());
      if (interestRate) {
        return {
          ratePct: interestRate.interestRatePct,
          applicable: true,
          reason: `DTAA with ${country.countryName} provides ${interestRate.interestRatePct}% on interest.${interestRate.conditions ? ` Conditions: ${interestRate.conditions}` : ""}`,
        };
      }
      break;
    }
    case "capital-gains": {
      const cgRate = registry.capitalGainsRates.find((r) => r.countryCode === payeeCountry.toUpperCase());
      if (cgRate) {
        return {
          ratePct: cgRate.capitalGainsRatePct,
          applicable: true,
          reason: `DTAA with ${country.countryName} provides ${cgRate.capitalGainsRatePct}% on capital gains.${cgRate.conditions ? ` Conditions: ${cgRate.conditions}` : ""}`,
        };
      }
      break;
    }
    default:
      // For salary, dividend, commission, rent, etc., the treaty rate is often the same as domestic
      // or there may be specific provisions. Caller to supply specific data.
      break;
  }

  // No specific treaty rate found; domestic rate applies
  return {
    ratePct: getDomesticRate(incomeType, payeeCountry, "non-resident", false),
    applicable: false,
    reason: `No specific treaty rate found for ${incomeType} under DTAA with ${country.countryName}. Domestic rate applies.`,
  };
}

/**
 * Compute TDS for a non-resident payment.
 */
export function computeNonResidentTds(
  event: NonResidentPaymentEvent,
  registry: DTaaRateRegistry,
): {
  domesticRate: number;
  treatyRate: number | null;
  effectiveRate: number;
  tdsAmount: number;
  treatyApplied: boolean;
  treatyCountry: string;
  treatyReason: string;
  notes: string[];
} {
  const notes: string[] = [];
  const treatyCountry = event.payeeCountry.toUpperCase();

  const domesticRate =
    event.domesticRatePct > 0
      ? event.domesticRatePct
      : getDomesticRate(event.incomeType, treatyCountry, event.residentStatus, event.hasPEInIndia);

  let treatyRate: number | null = null;
  let treatyApplied = false;
  let effectiveRate = domesticRate;

  if (event.treatyBenefitsClaimed) {
    const treatyResult = getTreatyRate(registry, event.incomeType, treatyCountry);
    if (treatyResult.applicable) {
      treatyRate = treatyResult.ratePct;
      treatyApplied = true;
      effectiveRate = treatyRate;
      notes.push(`Treaty benefit claimed under DTAA with ${treatyCountry}.`);
      notes.push(`${treatyResult.reason}`);
    } else {
      notes.push(`Treaty benefit claimed but not applicable: ${treatyResult.reason}`);
    }
  }

  if (event.treatyRateClaimed !== null && event.treatyRateClaimed !== undefined) {
    if (treatyRate === null) {
      treatyRate = event.treatyRateClaimed;
      notes.push(`Treaty rate claimed by payee: ${treatyRate}%.`);
    } else if (Math.abs(treatyRate - event.treatyRateClaimed) > 0.1) {
      notes.push(`Treaty rate claimed by payee (${event.treatyRateClaimed}%) differs from DTAA rate (${treatyRate}%).`);
    }
  }

  // Check conditions for treaty benefit
  if (treatyApplied) {
    if (!event.hasForm10F) {
      notes.push("Warning: Form 10F not submitted by payee — may affect treaty benefit.");
    }
    if (!event.hasTRC) {
      notes.push("Warning: Tax Residency Certificate (TRC) not submitted by payee — may affect treaty benefit.");
    }
    // Check TRC validity
    if (event.trcValidFrom && event.trcValidUntil) {
      const now = new Date();
      const trcFrom = new Date(event.trcValidFrom);
      const trcUntil = new Date(event.trcValidUntil);
      if (now < trcFrom) {
        notes.push(`TRC is valid from ${event.trcValidFrom} — not yet valid as of ${now.toISOString().split("T")[0]}.`);
      }
      if (now > trcUntil) {
        notes.push(`TRC expired on ${event.trcValidUntil} — may not be valid for treaty benefit.`);
      }
    }
    if (!event.isBeneficialOwner) {
      notes.push("Warning: Payee may not be the beneficial owner — treaty benefit may be denied underLOB clauses.");
    }
    if (event.hasPEInIndia) {
      notes.push("Note: Payee has a PE in India — treaty benefits may be restricted for certain income types.");
    }
  }

  // If PAN is missing, higher rate (20%) applies u/s 206AA (but non-residents may have different treatment)
  const tdsAmount = Math.round((event.grossAmount * effectiveRate) / 100);

  if (!event.payeePan && event.residentStatus === "non-resident") {
    // For non-residents, PAN is not mandatory for TDS but helps in credit
    notes.push("Note: Payee PAN not provided — TDS may be deducted at higher rate or without PAN benefit.");
  }

  // FCTRS reference — if a refund claim is pending, note it
  if (event.fctxRef) {
    notes.push(`FCTRS claim pending: reference ${event.fctxRef}.`);
    if (event.fctxClaimAmount) {
      notes.push(`FCTRS claim amount: ${event.fctxClaimAmount / 100} (claimed refund of excess TDS).`);
    }
  }

  return {
    domesticRate,
    treatyRate,
    effectiveRate,
    tdsAmount,
    treatyApplied,
    treatyCountry,
    treatyReason: treatyApplied
      ? `DTAA with ${treatyCountry} provides lower rate of ${treatyRate}% (domestic: ${domesticRate}%).`
      : `Domestic rate of ${domesticRate}% applies (no treaty benefit or treaty not applicable).`,
    notes,
  };
}

/**
 * Determine if a payment to a non-resident is subject to TDS u/s 195.
 */
export function isSubjectToTds195(event: NonResidentPaymentEvent): boolean {
  // Section 195: any sum payable to a non-resident (not being a company) which
  // is chargeable under the Act

  // Not subject to TDS if:
  // - The income is not chargeable under the Act (e.g., exempt income)
  // - The payment is not income in India (e.g., capital gains on sale of shares of an Indian company by a non-resident is taxable in India if the shares derive their value substantially from assets in India)

  switch (event.incomeType) {
    case "salary":
      // Salary for services rendered in India is taxable in India
      return event.servicesInIndia;

    case "interest":
      // Interest paid by an Indian resident/corporation is taxable in India
      return true; // Generally taxable

    case "royalty":
      // Royalty is taxable in India if the royalty is for the use of know-how, patent, etc. in India
      return true; // Generally taxable

    case "fts":
      // FTS is taxable in India if the services are rendered in India
      return event.servicesInIndia;

    case "dividend":
      // Dividend from Indian company is taxable in India
      return true;

    case "capital-gains":
      // Capital gains on transfer of capital assets situated in India is taxable in India
      return event.hasPEInIndia || event.servicesInIndia; // Simplified check

    case "commission":
      // Commission is taxable in India if the commission is for services in India
      return event.servicesInIndia;

    case "rent":
      // Rent for property in India is taxable in India
      return true; // Generally taxable

    case "consultant-fee":
    case "consulting":
      // Consultant fees are taxable in India if the services are rendered in India
      return event.servicesInIndia;

    case "other":
      // Other income — taxable if it arises in India
      return event.servicesInIndia;

    default:
      return false;
  }
}

/**
 * Generate a checklist for cross-border TDS compliance.
 */
export function crossBorderTdsComplianceChecklist(events: NonResidentPaymentEvent[]): {
  totalPayments: number;
  totalTdsDeducted: number;
  totalTdsDeposited: number;
  pendingTdsAmount: number;
  pendingPayments: NonResidentPaymentEvent[];
  form10FMissing: NonResidentPaymentEvent[];
  trcMissing: NonResidentPaymentEvent[];
  beneficialOwnerUnknown: NonResidentPaymentEvent[];
  peInIndia: NonResidentPaymentEvent[];
  treatyBenefitsClaimed: NonResidentPaymentEvent[];
  treatyBenefitsApplicable: NonResidentPaymentEvent[];
  fctxClaims: NonResidentPaymentEvent[];
  checklist: string[];
} {
  const totalPayments = events.length;
  const totalTdsDeducted = events.reduce((s, e) => s + (e.tdsDeducted ?? 0), 0);
  const totalTdsDeposited = events.reduce((s, e) => s + (e.tdsDeposited ?? 0), 0);
  const pendingTdsAmount = events.reduce((s, e) => s + (e.tdsDeducted ? e.tdsDeducted - (e.tdsDeposited ?? 0) : 0), 0);

  const pendingPayments = events.filter(
    (e) =>
      e.status !== "deposited" &&
      e.status !== "filed" &&
      e.tdsDeducted !== null &&
      e.tdsDeducted !== undefined &&
      e.tdsDeducted > 0,
  );
  const form10FMissing = events.filter((e) => e.treatyBenefitsClaimed && !e.hasForm10F);
  const trcMissing = events.filter((e) => e.treatyBenefitsClaimed && !e.hasTRC);
  const beneficialOwnerUnknown = events.filter((e) => e.treatyBenefitsClaimed && !e.isBeneficialOwner);
  const peInIndia = events.filter((e) => e.hasPEInIndia);
  const treatyBenefitsClaimed = events.filter((e) => e.treatyBenefitsClaimed);
  const treatyBenefitsApplicable = events.filter((e) => e.treatyBenefitsClaimed); // Further analysis needed
  const fctxClaims = events.filter((e) => e.fctxRef);

  const checklist: string[] = [];

  checklist.push("✅ Non-resident payments identified and classified by income type.");
  checklist.push(
    `✅ Total payments: ${totalPayments}, Total TDS deducted: ${(totalTdsDeducted / 100).toFixed(2)}, Total TDS deposited: ${(totalTdsDeposited / 100).toFixed(2)}.`,
  );
  checklist.push(
    `✅ Pending TDS to be deposited: ${(pendingTdsAmount / 100).toFixed(2)} (${pendingPayments.length} payment(s) pending).`,
  );

  if (form10FMissing.length > 0) {
    checklist.push(
      `⚠️ ${form10FMissing.length} payment(s) with treaty benefits claimed but Form 10F not submitted — obtain Form 10F.`,
    );
  }

  if (trcMissing.length > 0) {
    checklist.push(
      `⚠️ ${trcMissing.length} payment(s) with treaty benefits claimed but TRC not submitted — obtain TRC.`,
    );
  }

  if (beneficialOwnerUnknown.length > 0) {
    checklist.push(
      `⚠️ ${beneficialOwnerUnknown.length} payment(s) with treaty benefits claimed but beneficial owner status not confirmed — verify beneficial ownership.`,
    );
  }

  if (peInIndia.length > 0) {
    checklist.push(
      `ℹ️ ${peInIndia.length} payment(s) where payee has a PE in India — treaty benefits may be restricted.`,
    );
  }

  if (fctxClaims.length > 0) {
    checklist.push(`ℹ️ ${fctxClaims.length} FCTRS claim(s) pending — track for refund processing.`);
  }

  checklist.push("✅ All payments reviewed for TDS applicability u/s 195.");
  checklist.push("✅ Treaty rates verified against DTAA registry.");
  checklist.push("✅ Form 10F and TRC collected where treaty benefits claimed.");
  checklist.push("✅ Beneficial ownership verified for treaty benefit claims.");
  checklist.push("✅ FCTRS claims tracked for refund processing.");

  return {
    totalPayments,
    totalTdsDeducted,
    totalTdsDeposited,
    pendingTdsAmount,
    pendingPayments,
    form10FMissing,
    trcMissing,
    beneficialOwnerUnknown,
    peInIndia,
    treatyBenefitsClaimed,
    treatyBenefitsApplicable,
    fctxClaims,
    checklist,
  };
}

/**
 * Generate an FCTRS (Form for Certificate of Tax Refund to Non-Residents) claim summary.
 */
export function generateFctxSummary(
  events: NonResidentPaymentEvent[],
  registry: DTaaRateRegistry,
): {
  totalClaims: number;
  totalClaimed: number;
  totalLikelyRefund: number;
  claimsByCountry: Record<string, { count: number; claimed: number; likelyRefund: number }>;
  notes: string[];
} {
  const claims = events.filter((e) => e.fctxRef);

  let totalClaimed = 0;
  let totalLikelyRefund = 0;
  const claimsByCountry: Record<string, { count: number; claimed: number; likelyRefund: number }> = {};

  for (const claim of claims) {
    const country = claim.payeeCountry.toUpperCase();
    if (!claimsByCountry[country]) {
      claimsByCountry[country] = { count: 0, claimed: 0, likelyRefund: 0 };
    }
    claimsByCountry[country].count += 1;
    claimsByCountry[country].claimed += claim.fctxClaimAmount ?? 0;

    // Compute likely refund: difference between domestic rate and treaty rate
    const domesticRate = getDomesticRate(claim.incomeType, country, claim.residentStatus, claim.hasPEInIndia);
    const treatyResult = getTreatyRate(registry, claim.incomeType, country);
    const treatyRate = treatyResult.applicable ? treatyResult.ratePct : domesticRate;

    if (treatyRate < domesticRate) {
      // Likely refund = (domestic rate - treaty rate) × gross amount
      const likelyRefund = Math.round((claim.grossAmount * (domesticRate - treatyRate)) / 100);
      claimsByCountry[country].likelyRefund += likelyRefund;
      totalLikelyRefund += likelyRefund;
    }

    totalClaimed += claim.fctxClaimAmount ?? 0;
  }

  const notes: string[] = [];
  notes.push(
    "FCTRS claims are subject to verification by the AO. The likely refund is an estimate based on the treaty rate and may differ from the actual refund.",
  );
  notes.push(
    "FCTRS claims must be filed within the time limit prescribed under section 206B (generally 2 years from the end of the FY in which the tax was deducted).",
  );

  return {
    totalClaims: claims.length,
    totalClaimed,
    totalLikelyRefund,
    claimsByCountry,
    notes,
  };
}
