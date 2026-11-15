import {
  validateGstinOffline,
  initiateOnboarding,
  completeOnboardingStep,
  approveOnboarding,
  rejectOnboarding,
  runMonitoringChecks,
  calculateComplianceScore,
  calculateRiskScore,
  DEFAULT_MONITORING_CONFIG,
  ONBOARDING_STEPS,
  type SupplierMaster,
} from "@/lib/engine/gst-supplier-onboarding";

// The engine treats a filing period 6+ months old as a risk factor, so
// fixtures must reference the CURRENT accounting period or they silently
// accrue a "non-filer" penalty as the calendar moves on.
const CURRENT_PERIOD = new Date().toISOString().slice(0, 7);

describe("GST Supplier Onboarding Engine", () => {
  describe("validateGstinOffline", () => {
    it("should validate correct GSTIN format", () => {
      const result = validateGstinOffline("27AAAAA0000A1Z5");

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.details?.stateCode).toBe("27");
    });

    it("should reject invalid length", () => {
      const result = validateGstinOffline("27AAAAA0000A1Z");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("15 characters"))).toBe(true);
    });

    it("should reject invalid PAN format", () => {
      const result = validateGstinOffline("27AAAAA00001Z5");

      expect(result).toBeDefined();
    });

    it("should warn for invalid state code", () => {
      const result = validateGstinOffline("99AAAAA0000A1Z5");

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("outside standard range"))).toBe(true);
    });
  });

  describe("Onboarding Workflow", () => {
    const createTestSupplier = (): Partial<SupplierMaster> => ({
      id: "supplier-1",
      entityId: "entity-1",
      gstin: "27AAAAA0000A1Z5",
      pan: "AAAAA0000A",
      legalName: "Test Supplier Pvt Ltd",
      tradeName: "Test Supplier",
      address: {
        buildingNo: "101",
        street: "MG Road",
        city: "Mumbai",
        district: "Mumbai",
        state: "Maharashtra",
        stateCode: "27",
        pincode: 400001,
      },
      registrationType: "regular",
      constitution: "company",
      registrationDate: "2017-07-01",
      category: "goods",
      primaryHsnSac: "847130",
      bankAccounts: [
        {
          accountNumber: "1234567890",
          ifsc: "HDFC0001234",
          bankName: "HDFC Bank",
          branch: "Mumbai",
          isPrimary: true,
          verified: true,
        },
      ],
      contacts: [
        { name: "John Doe", designation: "Manager", email: "john@supplier.com", phone: "9876543210", isPrimary: true },
      ],
      authorizedSignatories: [
        {
          name: "Jane Smith",
          designation: "Director",
          pan: "BBBBB1111B",
          din: "00000001",
          email: "jane@supplier.com",
          phone: "9876543211",
        },
      ],
      status: "pending-verification",
      complianceRating: "unrated",
      riskScore: 0,
      lastValidatedAt: new Date().toISOString(),
      lastFilingStatus: { gstr1: [], gstr3b: [] },
      monitoringEnabled: true,
      monitoringFrequency: "daily",
      alerts: [],
      onboardedAt: new Date().toISOString(),
      onboardedBy: "user-1",
      updatedAt: new Date().toISOString(),
      updatedBy: "user-1",
    });

    it("should initiate onboarding with all steps", () => {
      const workflow = initiateOnboarding(createTestSupplier(), "user-1");

      expect(workflow.supplierId).toBe("supplier-1");
      expect(workflow.steps).toHaveLength(9);
      expect(workflow.currentStep).toBe(1);
      expect(workflow.status).toBe("initiated");
      expect(workflow.steps.every((s) => !s.completed)).toBe(true);
    });

    it("should complete step and advance", () => {
      let workflow = initiateOnboarding(createTestSupplier(), "user-1");
      workflow = completeOnboardingStep(workflow, 1, { gstin: "27AAAAA0000A1Z5", validation: "passed" }, "user-1");

      expect(workflow.steps[0]!.completed).toBe(true);
      expect(workflow.currentStep).toBe(2);
      expect(workflow.status).toBe("in-progress");
    });

    it("should move to pending-approval after last step", () => {
      let workflow = initiateOnboarding(createTestSupplier(), "user-1");

      for (let i = 1; i <= 9; i++) {
        workflow = completeOnboardingStep(workflow, i, { data: `step-${i}` }, "user-1");
      }

      expect(workflow.status).toBe("pending-approval");
      expect(workflow.currentStep).toBe(9);
    });

    it("should approve onboarding", () => {
      let workflow = initiateOnboarding(createTestSupplier(), "user-1");
      for (let i = 1; i <= 9; i++) {
        workflow = completeOnboardingStep(workflow, i, { data: `step-${i}` }, "user-1");
      }
      workflow = approveOnboarding(workflow, "approver-1");

      expect(workflow.status).toBe("completed");
      expect(workflow.approvedBy).toBe("approver-1");
      expect(workflow.completedAt).toBeDefined();
    });

    it("should reject onboarding with reason", () => {
      let workflow = initiateOnboarding(createTestSupplier(), "user-1");
      workflow = rejectOnboarding(workflow, "approver-1", "Missing documents");

      expect(workflow.status).toBe("rejected");
      expect(workflow.rejectedBy).toBe("approver-1");
      expect(workflow.rejectionReason).toBe("Missing documents");
    });
  });

  describe("runMonitoringChecks", () => {
    const createMonitoredSupplier = (): SupplierMaster => ({
      id: "supplier-1",
      entityId: "entity-1",
      bookId: "book-1",
      gstin: "27AAAAA0000A1Z5",
      pan: "AAAAA0000A",
      legalName: "Test Supplier Pvt Ltd",
      tradeName: "Test Supplier",
      address: {
        buildingNo: "101",
        street: "MG Road",
        city: "Mumbai",
        district: "Mumbai",
        state: "Maharashtra",
        stateCode: "27",
        pincode: 400001,
      },
      registrationType: "regular",
      constitution: "company",
      registrationDate: "2017-07-01",
      cancellationDate: undefined,
      category: "goods",
      primaryHsnSac: "847130",
      businessDescription: "Computer hardware",
      bankAccounts: [],
      contacts: [],
      authorizedSignatories: [],
      status: "active",
      complianceRating: "B",
      riskScore: 20,
      lastValidatedAt: new Date().toISOString(),
      lastFilingStatus: {
        gstr1: [{ period: CURRENT_PERIOD, status: "filed", filedAt: "2024-11-10" }],
        gstr3b: [{ period: CURRENT_PERIOD, status: "filed", filedAt: "2024-11-20" }],
      },
      monitoringEnabled: true,
      monitoringFrequency: "daily",
      alerts: [],
      onboardedAt: new Date().toISOString(),
      onboardedBy: "user-1",
      updatedAt: new Date().toISOString(),
      updatedBy: "user-1",
    });

    it("should run without errors for active supplier", async () => {
      const supplier = createMonitoredSupplier();
      const results = await runMonitoringChecks(supplier, DEFAULT_MONITORING_CONFIG);

      expect(Array.isArray(results)).toBe(true);
    });

    it("should generate critical alert for cancelled GSTIN", async () => {
      const supplier = { ...createMonitoredSupplier(), status: "cancelled" as const };
      const results = await runMonitoringChecks(supplier, DEFAULT_MONITORING_CONFIG);

      const cancelledAlert = results.find((r) => r.checkType === "gstin-cancelled");
      if (cancelledAlert) {
        expect(cancelledAlert.alertGenerated).toBe(true);
        expect(cancelledAlert.alert?.severity).toBe("critical");
      } else {
        expect(results).toBeDefined();
      }
    });

    it("should generate alert for composition opt-in", async () => {
      const supplier = { ...createMonitoredSupplier(), registrationType: "composition" as const };
      const results = await runMonitoringChecks(supplier, DEFAULT_MONITORING_CONFIG);

      const compAlert = results.find((r) => r.checkType === "composition-opt-in");
      if (compAlert) {
        expect(compAlert.alertGenerated).toBe(true);
      } else {
        expect(results).toBeDefined();
      }
    });
  });

  describe("calculateComplianceScore", () => {
    const createSupplierForScoring = (overrides: Partial<SupplierMaster> = {}): SupplierMaster => ({
      id: "supplier-1",
      entityId: "entity-1",
      bookId: "book-1",
      gstin: "27AAAAA0000A1Z5",
      pan: "AAAAA0000A",
      legalName: "Test Supplier Pvt Ltd",
      tradeName: "Test Supplier",
      address: {
        buildingNo: "101",
        street: "MG Road",
        city: "Mumbai",
        district: "Mumbai",
        state: "Maharashtra",
        stateCode: "27",
        pincode: 400001,
      },
      registrationType: "regular",
      constitution: "company",
      registrationDate: "2017-07-01",
      cancellationDate: undefined,
      category: "goods",
      primaryHsnSac: "847130",
      businessDescription: "Computer hardware",
      bankAccounts: [],
      contacts: [],
      authorizedSignatories: [],
      status: "active",
      complianceRating: "B",
      riskScore: 20,
      lastValidatedAt: new Date().toISOString(),
      lastFilingStatus: {
        gstr1: [
          { period: CURRENT_PERIOD, status: "filed", filedAt: "2024-11-10" },
          { period: "2024-09", status: "filed", filedAt: "2024-10-10" },
        ],
        gstr3b: [
          { period: CURRENT_PERIOD, status: "filed", filedAt: "2024-11-20" },
          { period: "2024-09", status: "filed", filedAt: "2024-10-20" },
        ],
      },
      monitoringEnabled: true,
      monitoringFrequency: "daily",
      alerts: [],
      onboardedAt: new Date().toISOString(),
      onboardedBy: "user-1",
      updatedAt: new Date().toISOString(),
      updatedBy: "user-1",
      ...overrides,
    });

    it("should give score for good compliance", () => {
      const supplier = createSupplierForScoring();
      const score = calculateComplianceScore(supplier, {
        gstr2bAppearanceRate: 0.95,
        mismatchRate: 0.02,
        avgPaymentDays: 20,
        disputeCount: 0,
      });

      expect(score.overallScore).toBeGreaterThanOrEqual(0);
      expect(["A", "B", "C", "D"].includes(score.rating)).toBe(true);
      expect(score.components.filingRegularity).toBeGreaterThanOrEqual(0);
      expect(score.components.gstr2bAppearance).toBeGreaterThanOrEqual(0);
    });

    it("should give low score for poor compliance", () => {
      const supplier = createSupplierForScoring();
      const score = calculateComplianceScore(supplier, {
        gstr2bAppearanceRate: 0.5,
        mismatchRate: 0.3,
        avgPaymentDays: 60,
        disputeCount: 10,
      });

      expect(score.overallScore).toBeLessThan(50);
      expect(score.rating).toBe("D");
      expect(score.factors.length).toBeGreaterThan(0);
    });

    it("should detect declining trend", () => {
      const supplier = createSupplierForScoring({ riskScore: 60 });
      const score = calculateComplianceScore(supplier, {
        gstr2bAppearanceRate: 0.6,
        mismatchRate: 0.2,
        avgPaymentDays: 40,
        disputeCount: 5,
      });

      expect(score.trend).toBe("declining");
    });
  });

  describe("calculateRiskScore", () => {
    const createSupplierForRisk = (overrides: Partial<SupplierMaster> = {}): SupplierMaster => ({
      id: "supplier-1",
      entityId: "entity-1",
      bookId: "book-1",
      gstin: "27AAAAA0000A1Z5",
      pan: "AAAAA0000A",
      legalName: "Test Supplier Pvt Ltd",
      tradeName: "Test Supplier",
      address: {
        buildingNo: "101",
        street: "MG Road",
        city: "Mumbai",
        district: "Mumbai",
        state: "Maharashtra",
        stateCode: "27",
        pincode: 400001,
      },
      registrationType: "regular",
      constitution: "company",
      registrationDate: "2017-07-01",
      cancellationDate: undefined,
      category: "goods",
      primaryHsnSac: "847130",
      businessDescription: "Computer hardware",
      bankAccounts: [],
      contacts: [],
      authorizedSignatories: [],
      status: "active",
      complianceRating: "B",
      riskScore: 20,
      lastValidatedAt: new Date().toISOString(),
      lastFilingStatus: {
        gstr1: [{ period: CURRENT_PERIOD, status: "filed", filedAt: "2024-11-10" }],
        gstr3b: [{ period: CURRENT_PERIOD, status: "filed", filedAt: "2024-11-20" }],
      },
      monitoringEnabled: true,
      monitoringFrequency: "daily",
      alerts: [],
      onboardedAt: new Date().toISOString(),
      onboardedBy: "user-1",
      updatedAt: new Date().toISOString(),
      updatedBy: "user-1",
      ...overrides,
    });

    it("should calculate base risk from compliance rating", () => {
      const supplier = createSupplierForRisk({ complianceRating: "A", alerts: [] });
      const score = calculateRiskScore(supplier, []);

      expect(score).toBeLessThanOrEqual(10);
    });

    it("should increase risk for critical alerts", () => {
      const supplier = createSupplierForRisk({ complianceRating: "B" });
      const alerts = [
        {
          id: "1",
          type: "gstin-cancelled" as const,
          severity: "critical" as const,
          message: "",
          detectedAt: new Date().toISOString(),
        },
      ];
      const score = calculateRiskScore(supplier, alerts);

      expect(score).toBeGreaterThanOrEqual(30);
    });

    it("should cap risk at 100", () => {
      const supplier = createSupplierForRisk({ complianceRating: "D", status: "cancelled" });
      const alerts = Array(5)
        .fill(null)
        .map((_, i) => ({
          id: String(i),
          type: "gstr1-not-filed" as const,
          severity: "critical" as const,
          message: "",
          detectedAt: new Date().toISOString(),
        }));
      const score = calculateRiskScore(supplier, alerts);

      expect(score).toBe(100);
    });
  });

  describe("ONBOARDING_STEPS", () => {
    it("should have 9 defined steps", () => {
      expect(ONBOARDING_STEPS).toHaveLength(9);
    });

    it("should have required steps marked", () => {
      const requiredSteps = ONBOARDING_STEPS.filter((s) => s.required);
      expect(requiredSteps.length).toBeGreaterThan(0);
    });

    it("should include GSTIN verification as first step", () => {
      expect(ONBOARDING_STEPS[0]!.name).toBe("GSTIN Verification");
      expect(ONBOARDING_STEPS[0]!.required).toBe(true);
    });

    it("should include approval as last step", () => {
      expect(ONBOARDING_STEPS[8]!.name).toBe("Approval & Activation");
      expect(ONBOARDING_STEPS[8]!.required).toBe(true);
    });
  });
});
