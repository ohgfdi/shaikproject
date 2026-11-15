/**
 * Payroll practice engine tests
 */
import { INR } from "@/lib/engine/india-tax";
import {
  calculateGratuityAccrual,
  generateECRData,
  generateESIData,
  reconcilePayrollToBooks,
  createPayrollRun,
  type EmployeeMaster,
} from "@/lib/engine/payroll-practice";

describe("Payroll practice engine", () => {
  const emp: EmployeeMaster = {
    employeeId: "E001",
    name: "Alice",
    gender: "F",
    dateOfBirth: "1990-01-01",
    dateOfJoining: "2020-01-01",
    status: "active",
    employmentType: "permanent",
    designation: "Manager",
    department: "Finance",
    location: "Mumbai",
    pan: "ABCDE1234F",
    uan: "123456789012",
    pfMember: true,
    esiMember: true,
    ptApplicable: true,
    maritalStatus: "married",
    bankName: "HDFC",
    bankAccountNumber: "1234567890",
    ifscCode: "HDFC0001234",
    basic: INR(8000),
    dearnessAllowance: INR(2000),
    hra: INR(3000),
    conveyanceAllowance: INR(1600),
    medicalAllowance: INR(1250),
    specialAllowance: INR(1000),
    otherAllowances: INR(500),
    leaveBalance: 12,
    leavesTakenThisMonth: 2,
    overtimeHours: 10,
    overtimeRate: INR(150),
    advanceBalance: INR(5000),
    loanBalance: 0,
    taxRegime: {
      label: "New regime",
      ay: "2026-27",
      id: "new",
      slabs: [],
      surcharge: [],
      cessPct: 4,
      standardDeduction: 0,
    },
    proofSubmitted: true,
  };

  test("calculates gratuity accrual correctly", () => {
    const accrual = calculateGratuityAccrual(INR(20000), INR(5000), 5);
    expect(accrual).toBeGreaterThan(0);
    expect(accrual).toBe(Math.round((INR(25000) * 15 * 5) / 26 / 12));
  });

  test("creates payroll run with validations", () => {
    const run = createPayrollRun("2025-04", [emp], "regular", "user123");
    expect(run.month).toBe("2025-04");
    expect(run.status).toBe("draft");
    expect(run.employees.length).toBe(1);
    expect(run.register.payslips.length).toBe(1);
  });

  test("generates ECR data", () => {
    const run = createPayrollRun("2025-04", [emp], "regular", "user123");
    const ecr = generateECRData(run);
    expect(ecr.month).toBe("2025-04");
    expect(ecr.pfMembers).toBe(1);
    expect(ecr.totalContribution).toBeGreaterThan(0);
  });

  test("generates ESI data", () => {
    const run = createPayrollRun("2025-04", [emp], "regular", "user123");
    const esi = generateESIData(run);
    expect(esi.month).toBe("2025-04");
    expect(esi.insuredPersons).toBe(1);
  });

  test("reconciles payroll to books", () => {
    const run = createPayrollRun("2025-04", [emp], "regular", "user123");
    const recon = reconcilePayrollToBooks(run, {
      pf:
        run.register.totals.epfEmployee +
        run.register.totals.epfEmployer +
        run.register.totals.epsEmployer +
        run.register.totals.edli +
        run.register.totals.epfAdmin,
      esi: run.register.totals.esiEmployee + run.register.totals.esiEmployer,
      pt: run.register.totals.professionalTax,
      tds: run.register.totals.tds,
      netPay: run.register.totals.netPay,
    });
    expect(recon.overallStatus).toBe("matched");
    expect(recon.totalDifference).toBe(0);
  });
});
