import {
  validateSupplyAgainstEntity,
  generateMultiGstinReturnPlan,
  distributeIsdCredit,
  type MultiGstinEntity,
  type SupplyContext,
} from "@/lib/engine/gst-multi-gstin";
import { INR } from "@/lib/engine/india-tax";

describe("GST Multi-GSTIN Engine", () => {
  const createTestEntity = (): MultiGstinEntity => ({
    id: "entity-1",
    entityName: "Test Corp Pvt Ltd",
    pan: "AAAAA0000A",
    entityType: "company",
    primaryGstin: "27AAAAA0000A1Z5",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    gstinRegistrations: [
      {
        gstin: "27AAAAA0000A1Z5",
        legalName: "Test Corp Pvt Ltd",
        tradeName: "Test Corp",
        stateCode: "27",
        stateName: "Maharashtra",
        registrationType: "regular",
        status: "active",
        registrationDate: "2017-07-01",
        constitution: "company",
        address: { buildingNo: "101", street: "MG Road", city: "Mumbai", district: "Mumbai", pincode: 400001 },
        authorizedSignatories: [
          {
            name: "John Doe",
            designation: "Director",
            pan: "ABCDE1234F",
            mobile: "9876543210",
            email: "john@test.com",
          },
        ],
      },
      {
        gstin: "29AAAAA0000A2Z4",
        legalName: "Test Corp Pvt Ltd",
        tradeName: "Test Corp Bangalore",
        stateCode: "29",
        stateName: "Karnataka",
        registrationType: "regular",
        status: "active",
        registrationDate: "2018-01-01",
        constitution: "company",
        address: {
          buildingNo: "202",
          street: "Brigade Road",
          city: "Bangalore",
          district: "Bangalore Urban",
          pincode: 560001,
        },
        authorizedSignatories: [
          {
            name: "Jane Smith",
            designation: "Director",
            pan: "FGHIJ5678K",
            mobile: "9876543211",
            email: "jane@test.com",
          },
        ],
      },
    ],
  });

  const createSupplyContext = (overrides: Partial<SupplyContext> = {}): SupplyContext => ({
    supplierGstin: "27AAAAA0000A1Z5",
    supplierStateCode: "27",
    recipientGstin: "29BBBBB0000B1Z4",
    recipientStateCode: "29",
    placeOfSupply: "29",
    supplyType: "inter",
    invoiceType: "b2b",
    invoiceNumber: "INV-001",
    invoiceDate: "2025-01-15",
    taxableValue: INR(100000),
    ...overrides,
  });

  describe("validateSupplyAgainstEntity", () => {
    it("should pass validation for valid inter-state B2B supply", () => {
      const context = createSupplyContext();
      const entity = createTestEntity();

      const mismatches = validateSupplyAgainstEntity(context, entity);

      // Should have POS-supplier mismatch (inter-state is normal)
      const posMismatch = mismatches.find((m) => m.type === "pos-supplier-state-mismatch");
      expect(posMismatch).toBeDefined();
      expect(posMismatch?.severity).toBe("info");
    });

    it("should detect cancelled GSTIN", () => {
      const entity = createTestEntity();
      entity.gstinRegistrations[0]!.status = "cancelled";

      const context = createSupplyContext();
      const mismatches = validateSupplyAgainstEntity(context, entity);

      const cancelled = mismatches.find((m) => m.type === "cancelled-gstin-used");
      expect(cancelled).toBeDefined();
      expect(cancelled?.severity).toBe("error");
    });

    it("should detect composition dealer making inter-state supply", () => {
      const entity = createTestEntity();
      entity.gstinRegistrations[0]!.registrationType = "composition";

      const context = createSupplyContext();
      const mismatches = validateSupplyAgainstEntity(context, entity);

      const composition = mismatches.find((m) => m.type === "composition-interstate-supply");
      expect(composition).toBeDefined();
      expect(composition?.severity).toBe("error");
    });

    it("should detect composition dealer issuing tax invoice", () => {
      const entity = createTestEntity();
      entity.gstinRegistrations[0]!.registrationType = "composition";

      const context = createSupplyContext({ supplyType: "intra", placeOfSupply: "27" });
      const mismatches = validateSupplyAgainstEntity(context, entity);

      const composition = mismatches.find((m) => m.type === "composition-b2b-supply");
      expect(composition).toBeDefined();
      expect(composition?.severity).toBe("error");
    });

    it("should detect GSTIN not registered under entity", () => {
      const entity = createTestEntity();
      const context = createSupplyContext({ supplierGstin: "99XXXXXXXXXX1Z9" });
      const mismatches = validateSupplyAgainstEntity(context, entity);

      const notFound = mismatches.find((m) => m.type === "invalid-gstin-format");
      expect(notFound).toBeDefined();
      expect(notFound?.message).toContain("not registered under this entity");
    });
  });

  describe("generateMultiGstinReturnPlan", () => {
    it("should generate plan for multiple GSTINs", () => {
      const entity = createTestEntity();
      const period = "2025-01";

      const outwardInvoices: SupplyContext[] = [
        createSupplyContext({
          supplierGstin: "27AAAAA0000A1Z5",
          supplierStateCode: "27",
          placeOfSupply: "29",
          taxableValue: INR(100000),
        }),
        createSupplyContext({
          supplierGstin: "29AAAAA0000A2Z4",
          supplierStateCode: "29",
          placeOfSupply: "27",
          taxableValue: INR(200000),
        }),
      ];

      const inwardInvoices: SupplyContext[] = [
        createSupplyContext({
          recipientGstin: "27AAAAA0000A1Z5",
          recipientStateCode: "27",
          supplierGstin: "29BBBBB0000B1Z4",
          taxableValue: INR(50000),
        }),
      ];

      const plan = generateMultiGstinReturnPlan(entity, period, {
        outwardInvoices,
        inwardInvoices,
      });

      expect(plan.stateSummaries).toHaveLength(2);
      expect(plan.consolidated.totalOutwardTaxable).toBe(INR(300000));
      expect(plan.stateSummaries[0]!.gstin).toBe("27AAAAA0000A1Z5");
      expect(plan.stateSummaries[1]!.gstin).toBe("29AAAAA0000A2Z4");
    });

    it("should set correct due dates for regular vs composition", () => {
      const entity = createTestEntity();
      entity.gstinRegistrations[0]!.registrationType = "composition";

      const plan = generateMultiGstinReturnPlan(entity, "2025-01", {
        outwardInvoices: [],
        inwardInvoices: [],
      });

      // Composition GSTR-1 due 13th, regular 11th
      const compDue = plan.stateSummaries.find((s) => s.registrationType === "composition")?.dueDate;
      const regDue = plan.stateSummaries.find((s) => s.registrationType === "regular")?.dueDate;

      expect(compDue).toContain("-13");
      expect(regDue).toContain("-11");
    });
  });

  describe("distributeIsdCredit", () => {
    it("should distribute common credit based on turnover ratio", () => {
      const distribution = distributeIsdCredit(
        "27AAAAA0000A1Z5",
        "2025-01",
        { igst: INR(10000), cgst: INR(5000), sgst: INR(5000), cess: 0 },
        [
          { gstin: "27AAAAA0000A1Z5", stateCode: "27", turnoverRatio: 0.6 },
          { gstin: "29AAAAA0000A2Z4", stateCode: "29", turnoverRatio: 0.4 },
        ],
      );

      expect(distribution.distributions).toHaveLength(2);
      expect(distribution.distributions[0]!.igst).toBe(INR(6000));
      expect(distribution.distributions[1]!.igst).toBe(INR(4000));
      expect(distribution.distributions[0]!.ratio).toBe(0.6);
      expect(distribution.distributions[1]!.ratio).toBe(0.4);
    });

    it("should normalize ratios if they don't sum to 1", () => {
      const distribution = distributeIsdCredit(
        "27AAAAA0000A1Z5",
        "2025-01",
        { igst: INR(10000), cgst: 0, sgst: 0, cess: 0 },
        [
          { gstin: "27AAAAA0000A1Z5", stateCode: "27", turnoverRatio: 3 },
          { gstin: "29AAAAA0000A2Z4", stateCode: "29", turnoverRatio: 2 },
        ],
      );

      expect(distribution.distributions[0]!.ratio).toBeCloseTo(0.6);
      expect(distribution.distributions[1]!.ratio).toBeCloseTo(0.4);
    });
  });
});
