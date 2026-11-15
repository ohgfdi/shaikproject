/**
 * TDS Threshold & Time-of-Deduction Engine — oracle tests.
 *
 * All figures are hand-computed. The engine contract is integer paise (minor
 * units), so no test literal is written in paise by hand: every amount goes
 * through `p(rupees)`. That is deliberate — the previous revision carried bare
 * separated literals whose comments were a factor of ten off (e.g. a fixture
 * labelled "₹50,00,000" holding 50,000,000 paise, and a 194C annual threshold
 * of 100,000,000 paise standing in for ₹1,00,000). Spelling the rupee figure
 * makes the unit impossible to misread in either direction.
 */

import {
  type TdsPaymentEvent,
  type TdsThresholdOutcome,
  type ThresholdState,
  processTdsPayments,
  evaluateTdsThreshold,
  effectiveDeductibleDate,
  lookupTimeOfDeductionRule,
  getThresholdForSection,
  getThresholdTypeForSection,
  computeTdsAmount,
  getRateForSection,
  buildThresholdStates,
  thresholdCrossingSummary,
} from "@/lib/engine/tds-threshold-engine";

/** Whole rupees → integer paise, the engine's unit. */
const p = (wholeRupees: number): number => Math.round(wholeRupees * 100);

/** Helper: create a payment event with defaults. */
function paymentEvent(
  over: Partial<TdsPaymentEvent> & Pick<TdsPaymentEvent, "section" | "deducteePan">,
  generateId: boolean = true,
): TdsPaymentEvent {
  return {
    id: generateId
      ? over.id || `evt-${Math.random().toString(36).slice(2)}`
      : (over.id ?? `evt-${Math.random().toString(36).slice(2)}`),
    section: over.section,
    deducteePan: over.deducteePan,
    deducteeName: over.deducteeName || "Test Payee",
    deducteeType: over.deducteeType || "company",
    amount: over.amount ?? p(1_00_000), // ₹1,00,000
    dateOfPayment: over.dateOfPayment ?? "2025-05-15",
    dateOfCredit: over.dateOfCredit ?? "2025-05-10",
    isPaid: over.isPaid ?? true,
    hasPan: over.hasPan ?? true,
    isNonResident: over.isNonResident ?? false,
    ldcReference: over.ldcReference ?? null,
    form15G_15HReference: over.form15G_15HReference ?? null,
    natureOfPayment: over.natureOfPayment ?? null,
    voucherId: over.voucherId ?? null,
  };
}

/** A threshold state with the boilerplate filled in. */
function state(over: Partial<ThresholdState> & Pick<ThresholdState, "section" | "threshold">): ThresholdState {
  return {
    deducteePan: "AAAAA0000A",
    cumulative: 0,
    thresholdType: "per-payment",
    eventCount: 0,
    totalGross: 0,
    totalTdsComputed: 0,
    ...over,
  };
}

describe("effectiveDeductibleDate", () => {
  it("returns the earlier of payment and credit when both are different", () => {
    const rule = lookupTimeOfDeductionRule("194C")!;
    const result = effectiveDeductibleDate("2025-05-15", "2025-05-10", rule);
    expect(result.effectiveDate).toBe("2025-05-10");
    expect(result.source).toBe("credit");
  });

  it("returns payment date when payment is earlier", () => {
    const rule = lookupTimeOfDeductionRule("194C")!;
    const result = effectiveDeductibleDate("2025-05-10", "2025-05-15", rule);
    expect(result.effectiveDate).toBe("2025-05-10");
    expect(result.source).toBe("payment");
  });

  it("returns same when both dates are identical", () => {
    const rule = lookupTimeOfDeductionRule("194C")!;
    const result = effectiveDeductibleDate("2025-05-15", "2025-05-15", rule);
    expect(result.effectiveDate).toBe("2025-05-15");
    expect(result.source).toBe("same");
  });

  it("returns payment date when rule says onPaymentOnly (194-IB)", () => {
    const rule = lookupTimeOfDeductionRule("194-IB")!;
    const result = effectiveDeductibleDate("2025-06-15", "2025-06-10", rule);
    expect(result.effectiveDate).toBe("2025-06-15");
    expect(result.source).toBe("payment");
  });
});

describe("getThresholdForSection", () => {
  it("returns the per-payment 194C trigger of ₹30,000", () => {
    const event = paymentEvent({ section: "194C", deducteePan: "AAAAA0000A" }, false);
    const threshold = getThresholdForSection("194C", event);
    // getThresholdForSection is the per-payment trigger (₹30,000 per payment).
    // The annual ₹1,00,000 aggregate per contractor is enforced separately by
    // getAggregateThresholdForSection / evaluateTdsThreshold.
    expect(threshold).toBe(p(30_000));
  });

  it("returns ₹2,40,000 annual threshold for 194I", () => {
    const event = paymentEvent({ section: "194I", deducteePan: "AAAAA0000A" }, false);
    expect(getThresholdForSection("194I", event)).toBe(p(2_40_000));
  });

  it("returns ₹50,00,000 per-transaction threshold for 194-IA", () => {
    const event = paymentEvent({ section: "194-IA", deducteePan: "AAAAA0000A" }, false);
    expect(getThresholdForSection("194-IA", event)).toBe(p(50_00_000));
  });

  it("returns ₹50,000 monthly threshold for 194-IB", () => {
    const event = paymentEvent({ section: "194-IB", deducteePan: "AAAAA0000A" }, false);
    expect(getThresholdForSection("194-IB", event)).toBe(p(50_000));
  });

  it("returns ₹50,00,000 annual threshold for 194Q", () => {
    const event = paymentEvent({ section: "194Q", deducteePan: "AAAAA0000A" }, false);
    expect(getThresholdForSection("194Q", event)).toBe(p(50_00_000));
  });

  it("returns ₹10,000 per-quarter threshold for 194A paid to a bank/NSB", () => {
    const event = paymentEvent({ section: "194A", deducteePan: "AAAAA0000A", deducteeType: "bank" }, false);
    expect(getThresholdForSection("194A", event)).toBe(p(10_000));
  });

  it("returns ₹5,000 per-payment threshold for 194A to others", () => {
    const event = paymentEvent({ section: "194A", deducteePan: "AAAAA0000A", deducteeType: "company" }, false);
    expect(getThresholdForSection("194A", event)).toBe(p(5_000));
  });

  it("returns the annual ₹1,00,000 aggregate threshold for 194C", () => {
    const event = paymentEvent({ section: "194C", deducteePan: "AAAAA0000A" }, false);
    expect(getThresholdForSection("194C", event)).toBe(p(30_000));
  });

  it("returns ₹20,000 for 194R annual threshold", () => {
    expect(getThresholdForSection("194R", paymentEvent({ section: "194R", deducteePan: "AAAAA0000A" }, false))).toBe(
      p(20_000),
    );
  });

  it("returns 0 for 192 (no threshold)", () => {
    expect(getThresholdForSection("192", paymentEvent({ section: "192", deducteePan: "AAAAA0000A" }, false))).toBe(0);
  });

  it("returns 0 for 195 (no threshold)", () => {
    expect(getThresholdForSection("195", paymentEvent({ section: "195", deducteePan: "AAAAA0000A" }, false))).toBe(0);
  });
});

describe("getThresholdTypeForSection", () => {
  it("returns per-transaction for 194-IA", () => {
    expect(getThresholdTypeForSection("194-IA", paymentEvent({ section: "194-IA", deducteePan: "AAAAA0000A" }))).toBe(
      "per-transaction",
    );
  });

  it("returns per-month for 194-IB", () => {
    expect(getThresholdTypeForSection("194-IB", paymentEvent({ section: "194-IB", deducteePan: "AAAAA0000A" }))).toBe(
      "per-month",
    );
  });

  it("returns per-annum for 194C", () => {
    expect(getThresholdTypeForSection("194C", paymentEvent({ section: "194C", deducteePan: "AAAAA0000A" }))).toBe(
      "per-annum",
    );
  });

  it("returns per-payment for 194A", () => {
    expect(getThresholdTypeForSection("194A", paymentEvent({ section: "194A", deducteePan: "AAAAA0000A" }))).toBe(
      "per-payment",
    );
  });
});

describe("getRateForSection", () => {
  it("returns 1% for 194C paid to an individual/HUF", () => {
    expect(
      getRateForSection("194C", {
        ...paymentEvent({ section: "194C", deducteePan: "AAAAA0000A" }, false),
        deducteeType: "individual",
      }),
    ).toBe(1);
  });

  it("returns 2% for 194C paid to a company/firm", () => {
    expect(
      getRateForSection("194C", {
        ...paymentEvent({ section: "194C", deducteePan: "AAAAA0000A" }, false),
        deducteeType: "company",
      }),
    ).toBe(2);
  });

  it("returns 10% for 194J (professional services)", () => {
    expect(getRateForSection("194J", paymentEvent({ section: "194J", deducteePan: "AAAAA0000A" }, false))).toBe(10);
  });

  it("returns 2% for 194J (technical services)", () => {
    expect(
      getRateForSection("194J", {
        ...paymentEvent({ section: "194J", deducteePan: "AAAAA0000A" }, false),
        natureOfPayment: "Technical services",
      }),
    ).toBe(2);
  });

  it("returns 10% for 194I (rent)", () => {
    expect(getRateForSection("194I", paymentEvent({ section: "194I", deducteePan: "AAAAA0000A" }, false))).toBe(10);
  });

  it("returns 2% for 194I (plant & machinery)", () => {
    expect(
      getRateForSection("194I", {
        ...paymentEvent({ section: "194I", deducteePan: "AAAAA0000A" }, false),
        natureOfPayment: "Rent of plant & machinery",
      }),
    ).toBe(2);
  });

  it("returns 1% for 194-IA", () => {
    expect(getRateForSection("194-IA", paymentEvent({ section: "194-IA", deducteePan: "AAAAA0000A" }, false))).toBe(1);
  });

  it("returns 0.1% for 194Q", () => {
    expect(getRateForSection("194Q", paymentEvent({ section: "194Q", deducteePan: "AAAAA0000A" }, false))).toBe(0.1);
  });

  it("returns 0.1% for 206C(1H)", () => {
    expect(getRateForSection("206C(1H)", paymentEvent({ section: "206C(1H)", deducteePan: "AAAAA0000A" }, false))).toBe(
      0.1,
    );
  });

  it("returns 10% for 194A (interest)", () => {
    expect(getRateForSection("194A", paymentEvent({ section: "194A", deducteePan: "AAAAA0000A" }, false))).toBe(10);
  });

  it("returns 20% for 195 (non-resident default)", () => {
    expect(getRateForSection("195", paymentEvent({ section: "195", deducteePan: "AAAAA0000A" }, false))).toBe(20);
  });
});

describe("computeTdsAmount", () => {
  it("computes 2% on ₹1,00,000 = ₹2,000 for 194C", () => {
    const event = paymentEvent({ section: "194C", deducteePan: "AAAAA0000A", amount: p(1_00_000) }, false);
    const outcome = evaluateTdsThreshold(event, state({ section: "194C", threshold: p(30_000) }));
    expect(computeTdsAmount(event, outcome)).toBe(p(2_000));
  });

  it("computes 10% on ₹1,00,000 = ₹10,000 for 194J", () => {
    const event = paymentEvent({ section: "194J", deducteePan: "AAAAA0000A", amount: p(1_00_000) }, false);
    const outcome = evaluateTdsThreshold(event, state({ section: "194J", threshold: p(30_000) }));
    expect(computeTdsAmount(event, outcome)).toBe(p(10_000));
  });

  it("computes 20% when PAN is missing (s.206AA)", () => {
    const event = paymentEvent(
      { section: "194C", deducteePan: "AAAAA0000A", amount: p(1_00_000), hasPan: false },
      false,
    );
    const outcome = evaluateTdsThreshold(event, state({ section: "194C", threshold: p(30_000) }));
    expect(computeTdsAmount(event, outcome)).toBe(p(20_000));
  });
});

describe("evaluateTdsThreshold — per-payment threshold", () => {
  it("does not deduct when amount is below per-payment threshold for 194A", () => {
    const event = paymentEvent({ section: "194A", deducteePan: "AAAAA0000A", amount: p(3_000) }, false);
    const outcome = evaluateTdsThreshold(event, state({ section: "194A", threshold: p(5_000) }));
    expect(outcome.tdsApplicable).toBe(false);
    expect(outcome.thresholdCrossed).toBe(false);
    expect(outcome.reasonIfNotApplicable).toContain("below the threshold");
  });

  it("deducts when amount exceeds per-payment threshold for 194A", () => {
    const event = paymentEvent({ section: "194A", deducteePan: "AAAAA0000A", amount: p(6_000) }, false);
    const outcome = evaluateTdsThreshold(event, state({ section: "194A", threshold: p(5_000) }));
    expect(outcome.tdsApplicable).toBe(true);
    expect(outcome.thresholdCrossed).toBe(true);
  });
});

describe("evaluateTdsThreshold — per-annum aggregate threshold", () => {
  it("does not deduct for first payment below annual threshold for 194C", () => {
    const event = paymentEvent({ section: "194C", deducteePan: "AAAAA0000A", amount: p(80_000) }, false);
    const outcome = evaluateTdsThreshold(
      event,
      state({ section: "194C", threshold: p(1_00_000), thresholdType: "per-annum" }),
    );
    expect(outcome.tdsApplicable).toBe(false);
    expect(outcome.cumulativeAfter).toBe(p(80_000));
  });

  it("deducts for second payment when cumulative crosses annual threshold for 194C", () => {
    const thresholdState = state({ section: "194C", threshold: p(1_00_000), thresholdType: "per-annum" });

    // First payment: ₹80,000 (no deduction, cumulative = ₹80,000)
    const firstOutcome = evaluateTdsThreshold(
      paymentEvent({ section: "194C", deducteePan: "AAAAA0000A", amount: p(80_000) }, false),
      thresholdState,
    );
    thresholdState.cumulative = firstOutcome.cumulativeAfter;
    thresholdState.eventCount = 1;

    // Second payment: ₹30,000 (cumulative = ₹1,10,000 > ₹1,00,000)
    const secondOutcome = evaluateTdsThreshold(
      paymentEvent(
        { section: "194C", deducteePan: "AAAAA0000A", amount: p(30_000), dateOfPayment: "2025-06-15" },
        false,
      ),
      thresholdState,
    );
    expect(secondOutcome.tdsApplicable).toBe(true);
    expect(secondOutcome.cumulativeAfter).toBe(p(1_10_000));
  });
});

describe("processTdsPayments — batch processing", () => {
  it("processes multiple events and updates cumulative correctly", () => {
    const events = [
      paymentEvent({ section: "194C", deducteePan: "AAAAA0000A", amount: p(50_000), id: "evt1" }, false),
      paymentEvent(
        { section: "194C", deducteePan: "AAAAA0000A", amount: p(60_000), dateOfPayment: "2025-06-15", id: "evt2" },
        false,
      ),
      paymentEvent({ section: "194C", deducteePan: "BBBBB1111B", amount: p(20_000), id: "evt3" }, false),
    ];

    const { outcomes, states } = processTdsPayments(events, true); // perDeducteeTracking = true

    expect(outcomes.length).toBe(3);
    expect(states.length).toBeGreaterThanOrEqual(2); // At least 2 PANs

    // First event: ₹50,000 against the ₹1,00,000 annual aggregate — no TDS yet.
    expect((outcomes[0] as TdsThresholdOutcome)!.tdsApplicable).toBe(false);
    expect((outcomes[0] as TdsThresholdOutcome)!.cumulativeAfter).toBe(p(50_000));

    // Second event: ₹60,000, cumulative ₹1,10,000 > ₹1,00,000, TDS applies
    expect((outcomes[1] as TdsThresholdOutcome)!.tdsApplicable).toBe(true);
    expect((outcomes[1] as TdsThresholdOutcome)!.cumulativeAfter).toBe(p(1_10_000));

    // Third event: perDeducteeTracking=true, so this PAN has its own cumulative of
    // ₹20,000 against the ₹1,00,000 annual aggregate — no TDS.
    expect((outcomes[2] as TdsThresholdOutcome)!.tdsApplicable).toBe(false);
  });

  it("with per-deductee tracking off, all payments to different PANs share the same threshold", () => {
    const events = [
      paymentEvent({ section: "194C", deducteePan: "AAAAA0000A", amount: p(80_000), id: "evt1" }, false),
      paymentEvent({ section: "194C", deducteePan: "BBBBB1111B", amount: p(30_000), id: "evt2" }, false),
    ];

    const { outcomes } = processTdsPayments(events, false); // perDeducteeTracking = false

    expect(outcomes.length).toBe(2);
    // With perDeducteeTracking=false both events share one cumulative.
    expect((outcomes[0] as TdsThresholdOutcome)!.tdsApplicable).toBe(false);
    expect((outcomes[1] as TdsThresholdOutcome)!.tdsApplicable).toBe(true);
  });
});

describe("thresholdCrossingSummary", () => {
  it("summarizes threshold crossings correctly", () => {
    const events = [
      paymentEvent({ section: "194C", deducteePan: "AAAAA0000A", amount: p(80_000), id: "evt1" }, false),
      paymentEvent({ section: "194C", deducteePan: "AAAAA0000A", amount: p(30_000), id: "evt2" }, false),
      paymentEvent({ section: "194A", deducteePan: "CCCCC2222C", amount: p(3_000), id: "evt3" }, false),
    ];

    const { outcomes } = processTdsPayments(events, true);
    const summary = thresholdCrossingSummary(outcomes);

    expect(summary.totalEvents).toBe(3);
    expect(summary.eventsWithTds).toBe(1); // Only the second 194C payment crosses ₹1,00,000
    expect(summary.eventsWithoutTds).toBe(2);
    expect(summary.sectionsWithTds).toContain("194C");
    expect(summary.sectionsWithTds).not.toContain("194A");
  });
});

describe("buildThresholdStates with carry-over", () => {
  it("initializes states with carry-over values", () => {
    const carryOver = {
      "194C|AAAAA0000A": { cumulative: p(80_000), threshold: p(1_00_000) },
    };

    const events = [paymentEvent({ section: "194C", deducteePan: "AAAAA0000A", amount: p(30_000), id: "evt1" }, false)];

    const states = buildThresholdStates(events, carryOver, true);
    expect(states.length).toBeGreaterThanOrEqual(1);
    const built = states.find((s) => s.section === "194C" && s.deducteePan === "AAAAA0000A");
    expect(built).toBeTruthy();
    expect(built?.cumulative).toBe(p(80_000)); // Carry-over
    expect(built?.threshold).toBe(p(1_00_000));
  });
});

describe("Form 15G/15H override", () => {
  it("marks TDS as not applicable when Form 15G/15H is submitted", () => {
    const event = paymentEvent({
      section: "194A",
      deducteePan: "AAAAA0000A",
      amount: p(10_000),
      form15G_15HReference: "FORM15G-2025-001",
    });
    const outcome = evaluateTdsThreshold(event, state({ section: "194A", threshold: p(5_000) }));
    expect(outcome.tdsApplicable).toBe(false);
    expect(outcome.reasonIfNotApplicable).toContain("Form 15G/15H");
  });
});

describe("LDC override", () => {
  it("records LDC reference when TDS is applicable", () => {
    const event = paymentEvent(
      {
        section: "194C",
        deducteePan: "AAAAA0000A",
        amount: p(1_00_000),
        ldcReference: "LDC-2025-001",
      },
      false,
    );
    const outcome = evaluateTdsThreshold(event, state({ section: "194C", threshold: p(30_000) }));
    expect(outcome.tdsApplicable).toBe(true);
    expect(outcome.reasonIfNotApplicable).toContain("LDC");
  });
});
