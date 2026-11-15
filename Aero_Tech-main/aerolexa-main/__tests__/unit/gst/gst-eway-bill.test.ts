import {
  calculateEwayBillValidity,
  buildEwayBillPayload,
  validateEwayBillInput,
  validateEwayBillInvoiceLink,
  calculateEwayBillPenalty,
  type EwayBillGenerateInput,
} from "@/lib/engine/gst-eway-bill";
import { INR } from "@/lib/engine/india-tax";

const createValidInput = (overrides: Partial<EwayBillGenerateInput> = {}): EwayBillGenerateInput => ({
  docType: "INV",
  docNo: "INV-001",
  docDate: "2025-01-15",
  docValue: INR(100000),
  supplyType: "B2B",
  transactionType: "regular",
  supplier: {
    gstin: "27AAAAA0000A1Z5",
    name: "Supplier Corp",
    address: "101 MG Road",
    place: "Mumbai",
    pincode: 400001,
    stateCode: "27",
  },
  recipient: {
    gstin: "29BBBBB0000B1Z4",
    name: "Recipient Corp",
    address: "202 Brigade Road",
    place: "Bangalore",
    pincode: 560001,
    stateCode: "29",
  },
  items: [
    {
      slNo: 1,
      productName: "Product A",
      hsnCode: "847130",
      quantity: 10,
      unit: "PCS",
      taxableValue: INR(100000),
      taxRate: 18,
    },
  ],
  transport: {
    mode: "road",
    distance: 1000,
    vehicleNo: "MH01AB1234",
    vehicleType: "regular",
    fromPlace: "Mumbai",
    fromStateCode: "27",
    fromPincode: 400001,
    toPlace: "Bangalore",
    toStateCode: "29",
    toPincode: 560001,
  },
  ...overrides,
});

describe("GST E-Way Bill Engine", () => {
  describe("calculateEwayBillValidity", () => {
    it("should calculate 1 day per 200km for regular cargo", () => {
      const result = calculateEwayBillValidity(150, "regular", "2025-01-15T10:00:00Z");
      expect(result.days).toBe(1);

      const result2 = calculateEwayBillValidity(250, "regular", "2025-01-15T10:00:00Z");
      expect(result2.days).toBe(2);

      const result3 = calculateEwayBillValidity(500, "regular", "2025-01-15T10:00:00Z");
      expect(result3.days).toBe(3);
    });

    it("should calculate 1 day per 20km for over-dimensional cargo", () => {
      const result = calculateEwayBillValidity(15, "over-dimensional", "2025-01-15T10:00:00Z");
      expect(result.days).toBe(1);

      const result2 = calculateEwayBillValidity(25, "over-dimensional", "2025-01-15T10:00:00Z");
      expect(result2.days).toBe(2);

      const result3 = calculateEwayBillValidity(100, "over-dimensional", "2025-01-15T10:00:00Z");
      expect(result3.days).toBe(5);
    });

    it("should set validFrom to generation date", () => {
      const result = calculateEwayBillValidity(250, "regular", "2025-01-15T10:00:00Z");
      expect(result.validFrom).toBe("2025-01-15");
      // 250 km = 2 days, validUpto should be 2025-01-17
      expect(result.validUpto).toContain("2025-01-17");
    });
  });

  describe("validateEwayBillInput", () => {
    it("should pass validation for valid inter-state supply", () => {
      const input = createValidInput();
      const result = validateEwayBillInput(input);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail for invalid supplier GSTIN", () => {
      const input = createValidInput({ supplier: { ...createValidInput().supplier, gstin: "INVALID" } });
      const result = validateEwayBillInput(input);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Supplier GSTIN"))).toBe(true);
    });

    it("should fail for mismatched state code in GSTIN", () => {
      const input = createValidInput({ supplier: { ...createValidInput().supplier, stateCode: "29" } });
      const result = validateEwayBillInput(input);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("doesn't match GSTIN"))).toBe(true);
    });

    it("should warn for value below ₹50,000 threshold", () => {
      const input = createValidInput({ docValue: INR(25000) });
      const result = validateEwayBillInput(input);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("below ₹50,000"))).toBe(true);
    });

    it("should warn for missing vehicle number in road transport", () => {
      const input = createValidInput({ transport: { ...createValidInput().transport, vehicleNo: undefined } });
      const result = validateEwayBillInput(input);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("Vehicle number not provided"))).toBe(true);
    });

    it("should fail for invalid HSN code", () => {
      const input = createValidInput({ items: [{ ...createValidInput().items[0]!, hsnCode: "ABC" }] });
      const result = validateEwayBillInput(input);

      expect(result.valid).toBe(true); // HSN warning only
      expect(result.warnings.some((w) => w.includes("HSN code"))).toBe(true);
    });
  });

  describe("buildEwayBillPayload", () => {
    it("should build valid payload for inter-state supply", () => {
      const input = createValidInput();
      const payload = buildEwayBillPayload(input);

      expect(payload.version).toBe("1.0.0221");
      expect(payload.billType).toBe("O"); // Outward
      expect(payload.docType).toBe("INV");
      expect(payload.docNo).toBe("INV-001");
      expect(payload.fromGstin).toBe("27AAAAA0000A1Z5");
      expect(payload.toGstin).toBe("29BBBBB0000B1Z4");
      expect(payload.fromStateCode).toBe(27);
      expect(payload.toStateCode).toBe(29);
      expect(payload.itemList).toHaveLength(1);
      expect(payload.transMode).toBe(1); // Road
      expect(payload.transDistance).toBe(1000);
    });

    it("should calculate IGST for inter-state", () => {
      const input = createValidInput();
      const payload = buildEwayBillPayload(input);

      const item = payload.itemList[0]!;
      expect(item.igstAmt).toBe(INR(18000)); // 18% of 100000
      expect(item.cgstAmt).toBe(0);
      expect(item.sgstAmt).toBe(0);
    });

    it("should calculate CGST+SGST for intra-state", () => {
      const input = createValidInput({
        recipient: { ...createValidInput().recipient, stateCode: "27", place: "Pune", pincode: 411001 },
        transport: { ...createValidInput().transport, toStateCode: "27", toPlace: "Pune", toPincode: 411001 },
      });
      const payload = buildEwayBillPayload(input);

      const item = payload.itemList[0]!;
      expect(item.igstAmt).toBe(0);
      expect(item.cgstAmt).toBe(INR(9000));
      expect(item.sgstAmt).toBe(INR(9000));
    });
  });

  describe("validateEwayBillInvoiceLink", () => {
    it("should return high match score for matching documents", () => {
      const ewayBill = {
        docNo: "INV-001",
        docDate: "2025-01-15",
        docValue: INR(118000),
        fromGstin: "27AAAAA0000A1Z5",
        toGstin: "29BBBBB0000B1Z4",
        items: [{ hsnCode: "847130" }],
      };

      const invoice = {
        invoiceNumber: "INV-001",
        invoiceDate: "2025-01-15",
        taxableValue: INR(100000),
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: INR(18000),
        cessAmount: 0,
        supplierGstin: "27AAAAA0000A1Z5",
        recipientGstin: "29BBBBB0000B1Z4",
        items: [{ hsn: "847130", taxableValue: INR(100000) }],
      };

      const result = validateEwayBillInvoiceLink(ewayBill, invoice);

      expect(result.valid).toBe(true);
      expect(result.matchScore).toBeGreaterThanOrEqual(90);
      expect(result.mismatches).toHaveLength(0);
    });

    it("should detect document number mismatch", () => {
      const result = validateEwayBillInvoiceLink(
        {
          docNo: "EWB-001",
          docDate: "2025-01-15",
          docValue: INR(118000),
          fromGstin: "27AAAAA0000A1Z5",
          toGstin: "29BBBBB0000B1Z4",
          items: [{ hsnCode: "847130" }],
        },
        {
          invoiceNumber: "INV-001",
          invoiceDate: "2025-01-15",
          taxableValue: INR(100000),
          cgstAmount: 0,
          sgstAmount: 0,
          igstAmount: INR(18000),
          cessAmount: 0,
          supplierGstin: "27AAAAA0000A1Z5",
          recipientGstin: "29BBBBB0000B1Z4",
          items: [{ hsn: "847130", taxableValue: INR(100000) }],
        },
      );

      expect(result.matchScore).toBeLessThan(100);
      expect(result.mismatches.some((m) => m.includes("Document number mismatch"))).toBe(true);
    });

    it("should detect value mismatch", () => {
      const result = validateEwayBillInvoiceLink(
        {
          docNo: "INV-001",
          docDate: "2025-01-15",
          docValue: INR(150000),
          fromGstin: "27AAAAA0000A1Z5",
          toGstin: "29BBBBB0000B1Z4",
          items: [{ hsnCode: "847130" }],
        },
        {
          invoiceNumber: "INV-001",
          invoiceDate: "2025-01-15",
          taxableValue: INR(100000),
          cgstAmount: 0,
          sgstAmount: 0,
          igstAmount: INR(18000),
          cessAmount: 0,
          supplierGstin: "27AAAAA0000A1Z5",
          recipientGstin: "29BBBBB0000B1Z4",
          items: [{ hsn: "847130", taxableValue: INR(100000) }],
        },
      );

      expect(result.matchScore).toBeLessThan(80);
      expect(result.mismatches.some((m) => m.includes("Value mismatch"))).toBe(true);
    });
  });

  describe("calculateEwayBillPenalty", () => {
    it("should calculate 100% tax or ₹10,000 for non-generation", () => {
      const penalty = calculateEwayBillPenalty("not-generated", INR(50000), INR(500000));

      expect(penalty.applicable).toBe(true);
      expect(penalty.section).toBe("s 129(1)(a)");
      expect(penalty.penaltyAmount).toBe(INR(50000)); // Max of tax and ₹10,000
      expect(penalty.compoundable).toBe(true);
    });

    it("should calculate minimum ₹10,000 when tax is lower", () => {
      const penalty = calculateEwayBillPenalty("not-generated", INR(5000), INR(50000));

      expect(penalty.penaltyAmount).toBe(INR(10000));
    });

    it("should calculate 50% tax for expired transit", () => {
      const penalty = calculateEwayBillPenalty("expired-transit", INR(50000), INR(500000));

      expect(penalty.section).toBe("s 129(1)(d)");
      expect(penalty.penaltyAmount).toBe(INR(25000)); // 50% of tax
    });

    it("should not apply penalty for exempt goods", () => {
      const penalty = calculateEwayBillPenalty("not-generated", INR(50000), INR(500000), true);

      expect(penalty.applicable).toBe(false);
      expect(penalty.penaltyAmount).toBe(0);
    });

    it("should apply s 130 for fake bill", () => {
      const penalty = calculateEwayBillPenalty("fake-bill", INR(50000), INR(500000));

      expect(penalty.section).toBe("s 130");
      expect(penalty.compoundable).toBe(false);
    });
  });
});
