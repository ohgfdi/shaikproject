import {
  RCM_CATEGORIES,
  calculateRcmTax,
  determineRcmItcEligibility,
  buildRcmRegister,
  type RcmSupply,
  type RcmCategory,
} from "@/lib/engine/gst-rcm";
import { INR } from "@/lib/engine/india-tax";

describe("GST RCM Engine", () => {
  describe("RCM_CATEGORIES", () => {
    it("should have all required RCM categories", () => {
      expect(RCM_CATEGORIES).toHaveProperty("gta");
      expect(RCM_CATEGORIES).toHaveProperty("legal-service");
      expect(RCM_CATEGORIES).toHaveProperty("sponsorship");
      expect(RCM_CATEGORIES).toHaveProperty("director-fees");
      expect(RCM_CATEGORIES).toHaveProperty("import-of-services");
      expect(RCM_CATEGORIES).toHaveProperty("ecom-transport");
      expect(RCM_CATEGORIES).toHaveProperty("ecom-restaurant");
    });

    it("should have correct rate for GTA (5%)", () => {
      expect(RCM_CATEGORIES.gta.ratePct).toBe(5);
    });

    it("should have correct rate for legal services (18%)", () => {
      expect(RCM_CATEGORIES["legal-service"].ratePct).toBe(18);
    });

    it("should have correct rate for e-commerce transport (5%)", () => {
      expect(RCM_CATEGORIES["ecom-transport"].ratePct).toBe(5);
    });
  });

  describe("calculateRcmTax", () => {
    it("should calculate IGST for inter-state supply", () => {
      const supply: RcmSupply = {
        category: "gta",
        supplierName: "ABC Transport",
        recipientGstin: "27AAAAA0000A1Z5",
        recipientName: "XYZ Corp",
        placeOfSupply: "27", // Maharashtra
        taxableValue: INR(1000), // ₹1,000
        invoiceNumber: "INV-001",
        invoiceDate: "2025-01-15",
        hsnSac: "996511",
      };

      // Recipient in Karnataka (29), supplier in Maharashtra (27) = inter-state
      const tax = calculateRcmTax(supply, "29");

      expect(tax.igst).toBe(INR(50)); // 5% of ₹1,000 = ₹50
      expect(tax.cgst).toBe(0);
      expect(tax.sgst).toBe(0);
      expect(tax.taxableValue).toBe(INR(1000));
    });

    it("should calculate CGST+SGST for intra-state supply", () => {
      const supply: RcmSupply = {
        category: "legal-service",
        supplierName: "Legal Associates",
        recipientGstin: "27AAAAA0000A1Z5",
        recipientName: "XYZ Corp",
        placeOfSupply: "27", // Maharashtra
        taxableValue: INR(2000), // ₹2,000
        invoiceNumber: "INV-002",
        invoiceDate: "2025-01-15",
        hsnSac: "998213",
      };

      // Recipient also in Maharashtra (27) = intra-state
      const tax = calculateRcmTax(supply, "27");

      expect(tax.igst).toBe(0);
      expect(tax.cgst + tax.sgst).toBe(INR(360)); // 18% of ₹2,000 = ₹360
      expect(tax.cgst).toBe(INR(180));
      expect(tax.sgst).toBe(INR(180));
    });
  });

  describe("determineRcmItcEligibility", () => {
    const baseSupply: RcmSupply = {
      category: "gta",
      supplierName: "ABC Transport",
      recipientGstin: "27AAAAA0000A1Z5",
      recipientName: "XYZ Corp",
      placeOfSupply: "27",
      taxableValue: INR(100000),
      invoiceNumber: "INV-001",
      invoiceDate: "2025-01-15",
      hsnSac: "996511",
    };

    const baseTax = {
      taxableValue: INR(100000),
      igst: 0,
      cgst: INR(250),
      sgst: INR(250),
      cess: 0,
    };

    it("should return blocked for s17(5) categories", () => {
      const result = determineRcmItcEligibility(baseSupply, baseTax, {
        isBusinessPurpose: true,
        blockedCategory: "motor-vehicle",
        taxPaid: true,
      });

      expect(result.status).toBe("blocked-s17-5");
      expect(result.blockedSection).toBe("s 17(5)");
      expect(result.claimableItc.igst).toBe(0);
    });

    it("should return ineligible for personal consumption", () => {
      const result = determineRcmItcEligibility(baseSupply, baseTax, {
        isBusinessPurpose: false,
        taxPaid: true,
      });

      expect(result.status).toBe("ineligible-personal");
      expect(result.blockedSection).toBe("s 17(5)(g)");
    });

    it("should return pending-payment when tax not paid", () => {
      const result = determineRcmItcEligibility(baseSupply, baseTax, {
        isBusinessPurpose: true,
        taxPaid: false,
      });

      expect(result.status).toBe("pending-payment");
      expect(result.claimableItc.igst).toBe(0);
    });

    it("should return eligible-after-payment when all conditions met", () => {
      const result = determineRcmItcEligibility(baseSupply, baseTax, {
        isBusinessPurpose: true,
        taxPaid: true,
      });

      expect(result.status).toBe("eligible-after-payment");
      expect(result.claimableItc.cgst).toBe(INR(250));
      expect(result.claimableItc.sgst).toBe(INR(250));
      expect(result.methodology.some((m) => m.includes("s 16(2)(aa) does not apply"))).toBe(true);
    });
  });

  describe("buildRcmRegister", () => {
    it("should aggregate RCM register entries correctly", () => {
      const entries = [
        {
          id: "1",
          period: "2025-01",
          supply: {
            category: "gta" as RcmCategory,
            supplierName: "ABC Transport",
            recipientGstin: "27AAAAA0000A1Z5",
            recipientName: "XYZ Corp",
            placeOfSupply: "27",
            taxableValue: INR(100000),
            invoiceNumber: "INV-001",
            invoiceDate: "2025-01-15",
            hsnSac: "996511",
          },
          taxAmounts: {
            taxableValue: INR(100000),
            igst: 0,
            cgst: INR(250),
            sgst: INR(250),
            cess: 0,
          },
          itcEligibility: {
            status: "eligible-after-payment" as const,
            reason: "Paid",
            payableTax: { igst: 0, cgst: INR(250), sgst: INR(250), cess: 0 },
            claimableItc: { igst: 0, cgst: INR(250), sgst: INR(250), cess: 0 },
            methodology: [],
          },
          paymentStatus: "paid-cash" as const,
          gstr3bTable4A3Reported: true,
          createdAt: "2025-01-15T00:00:00Z",
          createdById: "user-1",
        },
        {
          id: "2",
          period: "2025-01",
          supply: {
            category: "legal-service" as RcmCategory,
            supplierName: "Legal Associates",
            recipientGstin: "27AAAAA0000A1Z5",
            recipientName: "XYZ Corp",
            placeOfSupply: "27",
            taxableValue: INR(200000),
            invoiceNumber: "INV-002",
            invoiceDate: "2025-01-20",
            hsnSac: "998213",
          },
          taxAmounts: {
            taxableValue: INR(200000),
            igst: 0,
            cgst: INR(1800),
            sgst: INR(1800),
            cess: 0,
          },
          itcEligibility: {
            status: "pending-payment" as const,
            reason: "Not paid",
            payableTax: { igst: 0, cgst: INR(1800), sgst: INR(1800), cess: 0 },
            claimableItc: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
            methodology: [],
          },
          paymentStatus: "unpaid" as const,
          gstr3bTable4A3Reported: false,
          createdAt: "2025-01-20T00:00:00Z",
          createdById: "user-1",
        },
      ];

      const result = buildRcmRegister(entries);

      expect(result.payableTax.total).toBe(INR(4100)); // 500 + 3600
      expect(result.claimableItc.total).toBe(INR(500)); // Only first entry eligible
      expect(result.pendingItc.total).toBe(INR(3600)); // Second entry pending
      expect(result.byCategory.gta.count).toBe(1);
      expect(result.byCategory["legal-service"].count).toBe(1);
    });
  });
});
