/**
 * Route-level integration for `POST /api/ca/compute` with
 * `kind: "payroll-operations"`. Proves the route reaches the payroll adapter,
 * converts rupees to paise, and maps an engine refusal to a 400 (not a 500).
 */

import { POST } from "@/app/api/ca/compute/route";

jest.mock("@/lib/auth/guard", () => {
  const actual = jest.requireActual("@/lib/auth/guard");
  return {
    ...actual,
    requireAuth: jest.fn(async () => ({
      user: { id: "u1" },
      workspace: { id: "w1" },
      settings: {},
      organization: null,
      organizationRole: null,
    })),
  };
});

function post(payload: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/ca/compute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

describe("POST /api/ca/compute · payroll-operations", () => {
  it("routes a payroll op through the workflow engine and converts rupees to paise", async () => {
    const res = await post({
      kind: "payroll-operations",
      op: "run-line",
      line: {
        employeeId: "E001",
        paidDays: 30,
        lopDays: 0,
        overtimeHours: 4,
        overtimeRatePerHour: 300,
        bonus: 0,
        arrear: 1_000,
        advanceRecovery: 2_000,
        advanceOutstanding: 10_000,
      },
      monthlyGross: 60_000,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.payrollOperations.overtimePayMinor).toBe(120_000);
    expect(json.data.payrollOperations.grossEarningsMinor).toBe(6_220_000);
  });

  it("computes labour registers through the route", async () => {
    const res = await post({
      kind: "payroll-operations",
      op: "registers",
      profile: {
        state: "Maharashtra",
        employeeCount: 45,
        employsContractLabour: true,
        employsWomen: true,
        hasOvertime: true,
        isShopsEstablishment: true,
      },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.payrollOperations.map((r: { register: string }) => r.register)).toContain("PF & ESI registers");
  });

  it("maps an engine refusal (negative leave balance) to a 400", async () => {
    const res = await post({
      kind: "payroll-operations",
      op: "leave-encashment",
      leaveBalanceDays: -1,
      dailyWage: 1_000,
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("PAYROLL_OPERATIONS_INPUT");
  });

  it("rejects an invalid payload with a 400, not a 500", async () => {
    const res = await post({ kind: "payroll-operations", op: "validate-employee" }); // missing profile
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});
