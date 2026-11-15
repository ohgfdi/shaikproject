import { missingGstVouchers, summarizeGstRegister } from "@/lib/server/gst-invoices";

describe("summarizeGstRegister", () => {
  it("sums invoice values in integer paise", () => {
    const totals = summarizeGstRegister([
      { taxableValue: 100_000, cgstAmount: 9_000, sgstAmount: 9_000, igstAmount: 0, cessAmount: 0 },
      { taxableValue: 50_000, cgstAmount: 0, sgstAmount: 0, igstAmount: 9_000, cessAmount: 500 },
    ]);
    expect(totals).toEqual({
      invoiceCount: 2,
      taxableValue: 150_000,
      cgst: 9_000,
      sgst: 9_000,
      igst: 9_000,
      cess: 500,
    });
  });

  it("returns zeroed totals for an empty register", () => {
    expect(summarizeGstRegister([])).toEqual({
      invoiceCount: 0,
      taxableValue: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      cess: 0,
    });
  });
});

describe("missingGstVouchers", () => {
  const invoices = [
    { id: "inv_1", invoiceNumber: "INV-1", status: "posted" },
    { id: "inv_2", invoiceNumber: "INV-2", status: "posted" },
    { id: "inv_3", invoiceNumber: "INV-3", status: "draft" },
  ];

  it("reports only posted invoices that lack a GST:<id> voucher", () => {
    const result = missingGstVouchers(invoices, new Set(["GST:inv_1"]));
    expect(result.postedInvoiceCount).toBe(2);
    expect(result.missing.map((i) => i.invoiceNumber)).toEqual(["INV-2"]);
  });

  it("is reconciled when every posted invoice has a voucher", () => {
    const result = missingGstVouchers(invoices, new Set(["GST:inv_1", "GST:inv_2"]));
    expect(result.missing).toEqual([]);
  });

  it("does not require a voucher for draft invoices", () => {
    const result = missingGstVouchers(invoices, new Set());
    expect(result.missing.map((i) => i.id)).toEqual(["inv_1", "inv_2"]);
  });
});
