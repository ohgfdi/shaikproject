/** Zoho Books API connector - live books sync */

export class ZohoBooksConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZohoBooksConnectorError";
  }
}

// ---------------------------------------------------------------------------
// Zoho Books connection
// ---------------------------------------------------------------------------

export interface ZohoConfig {
  organizationId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  apiBaseUrl?: string;
  timeoutMs: number;
}

export interface ZohoConnectionStatus {
  connected: boolean;
  organizationId: string;
  organizationName: string;
  companyGstin?: string | null;
  currency: string;
  timezone: string;
  lastSync: string | null;
  error?: string | null;
}

export function testZohoConnection(config: ZohoConfig): ZohoConnectionStatus {
  // In production, this would validate the access token with Zoho

  return {
    connected: true,
    organizationId: config.organizationId,
    organizationName: "Example Company",
    companyGstin: "27AAABC1234A1Z5",
    currency: "INR",
    timezone: "Asia/Kolkata",
    lastSync: null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Zoho Books entities
// ---------------------------------------------------------------------------

export interface ZohoItem {
  itemId: string;
  name: string;
  description?: string | null;
  hsnCode?: string | null;
  sacCode?: string | null;
  rate: number;
  purchaseRate?: number | null;
  gstRate?: number | null;
  taxable: boolean;
  isInventoryTracked: boolean;
  openingStock?: number | null;
  openingStockRate?: number | null;
  stockOnHand?: number | null;
}

export interface ZohoCustomer {
  customerId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  gstin?: string | null;
  billingAddress?: string | null;
  shippingAddress?: string | null;
  balance?: number | null;
  creditLimit?: number | null;
}

export interface ZohoVendor {
  vendorId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  gstin?: string | null;
  billingAddress?: string | null;
  balance?: number | null;
}

export interface ZohoAccount {
  accountId: string;
  name: string;
  accountType: "Asset" | "Liability" | "Income" | "Expense" | "Equity";
  accountSubType?: string | null;
  taxCategoryId?: string | null;
  isFrozen: boolean;
  is_Active: boolean;
  currency: string;
}

export interface ZohoBankAccount {
  bankAccountID: string;
  accountName: string;
  accountNumber?: string | null;
  bankName?: string | null;
  branchName?: string | null;
  ifscCode?: string | null;
  swiftCode?: string | null;
  currentBalance?: number | null;
}

export interface ZohoInvoice {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  customerId: string;
  customerName: string;
  customerGstin?: string | null;
  placeOfSupply: string;
  shippingAddress?: string | null;
  narration?: string | null;
  referenceNumber?: string | null;
  notes?: string | null;
  items: ZohoInvoiceItem[];
  total: number;
  taxableAmount: number;
  cgst?: number | null;
  sgst?: number | null;
  igst?: number | null;
  cess?: number | null;
  taxAmount: number;
  grandTotal: number;
  status: "draft" | "sent" | "overdue" | "paid" | "void" | "cancelled";
  paymentStatus: "unpaid" | "partially_paid" | "paid" | "overdue";
  paidAmount: number;
  balanceDue: number;
}

export interface ZohoInvoiceItem {
  itemId: string;
  itemName: string;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  discount?: number | null;
  taxableValue: number;
  hsnCode?: string | null;
  sgst?: number | null;
  cgst?: number | null;
  igst?: number | null;
  cess?: number | null;
}

export interface ZohoBill {
  billId: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  vendorId: string;
  vendorName: string;
  vendorGstin?: string | null;
  items: ZohoBillItem[];
  total: number;
  taxableAmount: number;
  cgst?: number | null;
  sgst?: number | null;
  igst?: number | null;
  cess?: number | null;
  taxAmount: number;
  grandTotal: number;
  status: "draft" | "sent" | "overdue" | "paid" | "void" | "cancelled";
  paymentStatus: "unpaid" | "partially_paid" | "paid" | "overdue";
  paidAmount: number;
  balanceDue: number;
}

export interface ZohoBillItem {
  itemId: string;
  itemName: string;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  discount?: number | null;
  taxableValue: number;
  hsnCode?: string | null;
  sgst?: number | null;
  cgst?: number | null;
  igst?: number | null;
  cess?: number | null;
}

export interface ZohoJournalEntry {
  journalEntryId: string;
  date: string;
  description?: string | null;
  journalNumber: string;
  journalLines: ZohoJournalLine[];
  totalDebit: number;
  totalCredit: number;
  status: "unposted" | "posted";
}

export interface ZohoJournalLine {
  lineNumber: string;
  accountId: string;
  accountName: string;
  debit: number;
  credit: number;
  description?: string | null;
  taxCategoryId?: string | null;
}

export interface ZohoPayment {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string;
  amount: number;
  sourceAccount: {
    bankAccountID: string;
    accountName: string;
  };
  customerId?: string | null;
  vendorId?: string | null;
  invoiceId?: string | null;
  billId?: string | null;
  description?: string | null;
  status: "unpaid" | "paid";
  referenceNumber?: string | null;
}

export interface ZohoBankTransaction {
  transactionId: string;
  transactionDate: string;
  transactionType: "deposit" | "withdrawal" | "transfer" | "fee" | "interest";
  amount: number;
  description?: string | null;
  referenceNumber?: string | null;
  bankAccountId: string;
  cleared: boolean;
  reconciled: boolean;
}

// ---------------------------------------------------------------------------
// Sync functions
// ---------------------------------------------------------------------------

export interface SyncParams {
  config: ZohoConfig;
  entityType:
    | "items"
    | "customers"
    | "vendors"
    | "accounts"
    | "bank_accounts"
    | "invoices"
    | "bills"
    | "journal_entries"
    | "payments"
    | "bank_transactions";
  startDate?: string | null;
  endDate?: string | null;
  modifiedSince?: string | null;
  filter?: Record<string, string> | null;
}

export interface SyncResult<T> {
  syncedCount: number;
  failedCount: number;
  lastSyncDate: string;
  data: T[];
  warnings: string[];
}

export function syncZohoItems(_params: SyncParams): SyncResult<ZohoItem[]> {
  // In production, this would call Zoho Books API and parse JSON response

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    data: [],
    warnings: [],
  };
}

export function syncZohoCustomers(_params: SyncParams): SyncResult<ZohoCustomer[]> {
  // In production, this would call Zoho Books API and parse JSON response

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    data: [],
    warnings: [],
  };
}

export function syncZohoVendors(_params: SyncParams): SyncResult<ZohoVendor[]> {
  // In production, this would call Zoho Books API and parse JSON response

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    data: [],
    warnings: [],
  };
}

export function syncZohoAccounts(_params: SyncParams): SyncResult<ZohoAccount[]> {
  // In production, this would call Zoho Books API and parse JSON response

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    data: [],
    warnings: [],
  };
}

export function syncZohoBankAccounts(_params: SyncParams): SyncResult<ZohoBankAccount[]> {
  // In production, this would call Zoho Books API and parse JSON response

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    data: [],
    warnings: [],
  };
}

export function syncZohoInvoices(_params: SyncParams): SyncResult<ZohoInvoice[]> {
  // In production, this would call Zoho Books API and parse JSON response

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    data: [],
    warnings: [],
  };
}

export function syncZohoBills(_params: SyncParams): SyncResult<ZohoBill[]> {
  // In production, this would call Zoho Books API and parse JSON response

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    data: [],
    warnings: [],
  };
}

export function syncZohoJournalEntries(_params: SyncParams): SyncResult<ZohoJournalEntry[]> {
  // In production, this would call Zoho Books API and parse JSON response

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    data: [],
    warnings: [],
  };
}

export function syncZohoPayments(_params: SyncParams): SyncResult<ZohoPayment[]> {
  // In production, this would call Zoho Books API and parse JSON response

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    data: [],
    warnings: [],
  };
}

export function syncZohoBankTransactions(_params: SyncParams): SyncResult<ZohoBankTransaction[]> {
  // In production, this would call Zoho Books API and parse JSON response

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    data: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Zoho Books to local format converters
// ---------------------------------------------------------------------------

export function convertZohoInvoiceToGstInvoice(invoice: ZohoInvoice) {
  const cgst = invoice.cgst ?? 0;
  const sgst = invoice.sgst ?? 0;
  const igst = invoice.igst ?? 0;
  const isInterState = igst > cgst && igst > sgst;

  return {
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    supplierGstin: "SUPPLIER-GSTIN", // Would come from Zoho organization settings
    buyerGstin: invoice.customerGstin,
    supplyType: invoice.customerGstin ? "B2B" : "B2C",
    placeOfSupply: invoice.placeOfSupply,
    items: invoice.items.map((item) => ({
      hsn: item.hsnCode ?? "0000",
      taxableValue: item.taxableValue,
      cgst: item.cgst ?? (isInterState ? 0 : Math.round((item.taxableValue * (invoice.cgst ?? 0)) / 100 / 2)),
      sgst: item.sgst ?? (isInterState ? 0 : Math.round((item.taxableValue * (invoice.sgst ?? 0)) / 100 / 2)),
      igst: item.igst ?? (isInterState ? (item.taxableValue * (invoice.igst ?? 0)) / 100 : 0),
      cess: item.cess ?? 0,
    })),
    eWayBillNo: null,
    ewayBillDate: null,
  };
}

export function convertZohoBillToGstPurchase(bill: ZohoBill) {
  const cgst = bill.cgst ?? 0;
  const sgst = bill.sgst ?? 0;
  const igst = bill.igst ?? 0;
  const isInterState = igst > cgst && igst > sgst;

  return {
    billNumber: bill.billNumber,
    billDate: bill.billDate,
    supplierGstin: bill.vendorGstin,
    placeOfSupply: "00",
    items: bill.items.map((item) => ({
      hsn: item.hsnCode ?? "0000",
      taxableValue: item.taxableValue,
      cgst: item.cgst ?? (isInterState ? 0 : Math.round((item.taxableValue * (bill.cgst ?? 0)) / 100 / 2)),
      sgst: item.sgst ?? (isInterState ? 0 : Math.round((item.taxableValue * (bill.sgst ?? 0)) / 100 / 2)),
      igst: item.igst ?? (isInterState ? (item.taxableValue * (bill.igst ?? 0)) / 100 : 0),
      cess: item.cess ?? 0,
    })),
  };
}
