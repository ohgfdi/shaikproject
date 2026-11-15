/** @jest-environment jsdom */
/**
 * Component-level verification of the CA compute workspace — the UI the direct-tax
 * engines never had. These tests drive the REAL component through a mocked HTTP
 * helper and assert the exact payloads it posts, including the ITR → advance-tax
 * advisory bridge (the ITR engine returns rupees; the advisory engine takes paise).
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CaComputeWorkspace } from "@/components/ca/ca-compute-workspace";
import { api } from "@/lib/client/api";

jest.mock("@/lib/client/api", () => ({
  api: jest.fn(),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : "Something went wrong."),
}));

const mockApi = api as jest.MockedFunction<typeof api>;

function bodyOf(call: number): Record<string, unknown> {
  const init = mockApi.mock.calls[call]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

const ITR = {
  computation: {
    fy: "2025-26",
    regime: "new",
    grossTotalIncome: 1_260_000,
    totalIncomeAfterDeductions: 1_260_000,
    basicIncome: 1_260_000,
    taxBeforeRebate: 105_000,
    rebate87A: 0,
    taxAfterRebate: 105_000,
    surcharge: 0,
    cess: 4_200,
    totalTaxLiability: 109_200,
    prepaidTax: 50_000,
    netTaxPayableOrRefundable: 59_200,
    formType: "ITR-1",
    computationSteps: ["Gross total income 1260000."],
  },
  warnings: ["Verify slabs against the Finance Act."],
};

const ADVISORY = {
  totalTax: 10_920_000,
  advanceTaxPaid: 0,
  installments: [
    {
      label: "1st instalment (by 15 June)",
      dueDate: "2025-06-15",
      targetAmount: 1_638_000,
      shortfall: 1_638_000,
      interest234C: 49_140,
    },
  ],
  interest234C: 49_140,
  interest234B: 294_840,
  interest234A: 0,
  totalInterestExposure: 343_980,
  payNow: 9_828_000,
  warnings: [],
};

describe("CaComputeWorkspace", () => {
  it("posts an ITR compute then bridges its rupee liability into the paise advisory engine", async () => {
    const user = userEvent.setup();
    mockApi.mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body)) as { kind: string };
      return body.kind === "itr" ? { itr: ITR } : { advanceTaxAdvisory: ADVISORY };
    });

    render(<CaComputeWorkspace />);
    await user.click(screen.getByRole("button", { name: "Compute tax" }));

    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(2));
    expect(bodyOf(0).kind).toBe("itr");
    expect(bodyOf(0).fy).toBe("2025-26");
    expect(bodyOf(1).kind).toBe("advance-tax-advisory");
    // The bridge: the advisory receives the ITR liability verbatim (rupees).
    expect(bodyOf(1).totalTax).toBe(109_200);
    expect(bodyOf(1).regimeId).toBe("new");

    // ITR figures render in rupees (×100 into minor units); advisory figures are already paise.
    // formatInr omits the decimal part when there are no paise.
    expect(await screen.findByText("1,05,000")).toBeInTheDocument();
    expect(await screen.findByText("98,280")).toBeInTheDocument();
  });

  it("posts a salary-head compute with the component amounts in rupees", async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValue({
      salaryHead: {
        regimeLabel: "New regime (default taxation)",
        grossSalary17_1: 84_000_000,
        grossTotalSalary: 84_000_000,
        exemptUnder10: 12_000_000,
        standardDeduction: 7_500_000,
        professionalTax: 240_000,
        taxableSalary: 64_260_000,
        slip: [],
        regimeComparison: null,
        methodology: ["Gross salary u/s 17(1): 8,40,000."],
      },
    });

    render(<CaComputeWorkspace />);
    await user.click(screen.getByRole("tab", { name: "Salary head" }));
    await user.click(screen.getByRole("button", { name: "Compute salary" }));

    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
    const body = bodyOf(0);
    expect(body.kind).toBe("income-head-salary");
    const components = body.components as { amount: number }[];
    expect(components[0]?.amount).toBe(600_000);
    expect(await screen.findByText("6,42,600")).toBeInTheDocument();
  });

  it("derives the holding period from the dates and posts capital gains", async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValue({
      capitalGains: {
        totalShortTermCapitalGain: 10_000_000,
        totalLongTermCapitalGain: 30_000_000,
        totalCapitalGain: 40_000_000,
        netStcgAfterSetOff: 10_000_000,
        netLtcgAfterSetOff: 30_000_000,
        transactions: [
          {
            id: "CG-1",
            grossGain: 30_000_000,
            shortTerm: false,
            specialRate: { section: "112A", ratePct: 12.5 },
            taxAtSpecialRate: 2_187_500,
            notes: [],
          },
        ],
        methodology: ["Total LTCG: 3,00,000."],
      },
    });

    render(<CaComputeWorkspace />);
    await user.click(screen.getByRole("tab", { name: "Capital gains" }));
    await user.click(screen.getByRole("button", { name: "Compute capital gains" }));

    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
    const tx = (
      bodyOf(0).transactions as { holding: { daysHeld: number; longTerm: boolean }; assetClass: string }[]
    )[0]!;
    expect(bodyOf(0).kind).toBe("capital-gains");
    expect(tx.assetClass).toBe("listed-equity-shares");
    // 2021-05-01 → 2025-08-01 = 1553 days; classification comes from the UI toggle.
    expect(tx.holding.daysHeld).toBe(1553);
    expect(tx.holding.longTerm).toBe(true);
    expect(await screen.findByText("4,00,000")).toBeInTheDocument();
  });

  it("posts the TDS threshold batch in rupees and renders the paise threshold the engine applied", async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValue({
      outcomes: [
        {
          eventId: "P1",
          section: "194C",
          amount: 8_000_000,
          effectiveDeductibleDate: "2025-05-10",
          deductibleDateSource: "credit",
          thresholdCrossed: false,
          cumulativeAfter: 8_000_000,
          threshold: 10_000_000,
          tdsApplicable: false,
          reasonIfNotApplicable: "Cumulative is below the threshold of ₹1,00,000 for section 194C.",
          panMissingConsequence: null,
        },
      ],
      summary: { totalEvents: 1, eventsWithTds: 0, eventsWithoutTds: 1, totalTdsComputed: 0, sectionsWithTds: [] },
    });

    render(<CaComputeWorkspace />);
    await user.click(screen.getByRole("tab", { name: "TDS" }));
    await user.click(screen.getByRole("button", { name: "Evaluate thresholds" }));

    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
    const body = bodyOf(0);
    expect(body.kind).toBe("tds-threshold");
    expect(body.perDeducteeTracking).toBe(true);
    const events = body.events as { amount: number; dateOfCredit: string }[];
    expect(events).toHaveLength(2);
    // Money crosses the boundary in RUPEES — the panel must not pre-multiply.
    expect(events[0]!.amount).toBe(80_000);
    expect(events[1]!.amount).toBe(30_000);
    expect(events[0]!.dateOfCredit).toBe("2025-05-10");

    // ₹1,00,000 of true paise arrives as 10,000,000 and is rendered as rupees.
    expect(await screen.findByText(/Threshold applied on the first payment/)).toBeInTheDocument();
    expect(await screen.findByText("80,000")).toBeInTheDocument();
  });

  it("builds a Form 16 without leaking the 16A-only section field into the salary entries", async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValue({
      partA: {
        totalSalaryPaid: 115_000_000,
        totalTdsDeducted: 11_500_000,
        totalTdsDeposited: 11_500_000,
        quarters: [],
      },
      partB: {
        taxComputation: {
          totalIncome: 87_500_000,
          taxOnTotalIncome: 8_750_000,
          rebate87A: 0,
          cess: 350_000,
          totalTaxLiability: 9_100_000,
        },
      },
      validation: { valid: true, issues: [] },
    });

    render(<CaComputeWorkspace />);
    await user.click(screen.getByRole("tab", { name: "TDS" }));
    await user.click(screen.getByRole("button", { name: "Build certificate" }));

    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
    const body = bodyOf(0);
    expect(body.kind).toBe("tds-form16");
    expect(body.op).toBe("16");
    const salaryEntries = body.salaryEntries as Record<string, unknown>[];
    expect(salaryEntries[0]!.quarter).toBe("Q1");
    // `section` is a Form 16A field — it must not ride along on a salary entry.
    expect("section" in salaryEntries[0]!).toBe(false);
    expect((body.salary as { totalSalary: number }).totalSalary).toBe(1_150_000);
    expect(await screen.findByText("91,000")).toBeInTheDocument();
  });

  it("determines the S.44AB audit from rupee turnover and renders the limitation in rupees", async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValue({
      taxAudit: {
        fy: "2025-26",
        turnoverAnalysis: {
          grossTurnover: 1_000_000_000,
          presumptiveTurnover: 0,
          exemptTurnover: 0,
          turnoverForAuditLimitation: 1_000_000_000,
        },
        triggers: [
          {
            name: "S.44AB book-audit (turnover/gross receipts above limitation)",
            applies: true,
            note: "above the limit",
          },
        ],
        warnings: ["The limitation is crossed."],
        methodology: ["Compares aggregate turnover against the limitation."],
      },
    });

    render(<CaComputeWorkspace />);
    await user.click(screen.getByRole("tab", { name: "Audit & schedules" }));
    await user.click(screen.getByRole("button", { name: "Determine audit" }));

    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
    const body = bodyOf(0);
    expect(body.kind).toBe("tax-audit");
    // Rupee-native engine: the boundary value is sent verbatim.
    expect(body.turnover).toBe(1_000_000_000);
    expect(body.category).toBe("domestic-company");
    // ₹100 crore of rupees arrives as 1e9 and is rendered as 100,00,00,000.
    expect(await screen.findByText("1,00,00,00,000")).toBeInTheDocument();
  });

  it("assembles the ITR schedule document with rupees in and the required schedules for the form", async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValue({
      itrSchedules: {
        xml: '<ITR form_type="ITR-5"><Schedule code="BP"></Schedule></ITR>',
        validation: { valid: true, errors: [], warnings: [] },
      },
    });

    render(<CaComputeWorkspace />);
    await user.click(screen.getByRole("tab", { name: "Audit & schedules" }));
    await user.click(screen.getByRole("button", { name: "Assemble schedules" }));

    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
    const body = bodyOf(0);
    expect(body.kind).toBe("itr-schedules");
    expect(body.formType).toBe("ITR-5");
    const schedules = body.schedules as Record<string, { lines: { amount: number }[] }>;
    // ITR-5 requires BP + PMT, both sent in RUPEES for the route to convert.
    expect(schedules.BP!.lines[0]!.amount).toBe(200_000);
    expect(schedules.PMT!.lines[0]!.amount).toBe(150_000);
    expect((body.income as Record<string, number>)["Gross Total Income"]).toBe(200_000);
    expect(await screen.findByText("All required schedules present.")).toBeInTheDocument();
  });
});
