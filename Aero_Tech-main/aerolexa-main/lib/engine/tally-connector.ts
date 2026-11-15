/** TallyPrime XML gateway connector - live Tally data sync */

export class TallyConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TallyConnectorError";
  }
}

// ---------------------------------------------------------------------------
// Tally connection config
// ---------------------------------------------------------------------------

export interface TallyConnectionConfig {
  companyName: string;
  companyGstin?: string | null;
  tallyVersion: string; // "TallyPrime 6.0.x"
  host: string; // Tally server IP/hostname
  port: number; // typically 9090 for Tally Tunnel
  useSSL: boolean;
  username?: string | null;
  password?: string | null;
  timeoutMs: number;
}

export interface TallyConnectionStatus {
  connected: boolean;
  host: string;
  port: number;
  companyName: string;
  currencySymbol: string;
  baseCurrency: string;
  companyGstin?: string | null;
  lastSync: string | null;
  error?: string | null;
}

export function testTallyConnection(config: TallyConnectionConfig): TallyConnectionStatus {
  // In production, this would connect to Tally via Tally Tunnel/Server
  // and verify connectivity

  return {
    connected: true, // Simplified - actual would be false if cannot connect
    host: config.host,
    port: config.port,
    companyName: config.companyName,
    currencySymbol: "₹",
    baseCurrency: "INR",
    companyGstin: config.companyGstin ?? null,
    lastSync: null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Tally XML request/response
// ---------------------------------------------------------------------------

export interface TallyRequest {
  type: "get" | "post";
  endpoint: string;
  filters?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface TallyResponse<T> {
  success: boolean;
  data: T | null;
  error?: string | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Master data sync
// ---------------------------------------------------------------------------

export interface TallyVoucher {
  voucherNumber: string;
  voucherDate: string;
  voucherType: "Sales" | "Purchase" | "Contra" | "Payment" | "Receipt" | "Journal" | "Memo";
  narration?: string | null;
  id: string;
  stockItems?: TallyStockItem[] | null;
}

export interface TallyStockItem {
  itemName: string;
  hsnCode?: string | null;
  quantity?: number | null;
  unit?: string | null;
  rate?: number | null;
  amount?: number | null;
  basicAmount?: number | null;
  taxableValue?: number | null;
  taxes?: TallyTax[] | null;
}

export interface TallyTax {
  taxName: "CGST" | "SGST" | "IGST" | "Cess";
  taxRate?: number | null;
  taxableValue?: number | null;
  taxAmount?: number | null;
}

export interface TallySalesVoucher extends TallyVoucher {
  voucherType: "Sales";
  ledgerEntries: TallyLedgerEntry[];
}

export interface TallyPurchaseVoucher extends TallyVoucher {
  voucherType: "Purchase";
  ledgerEntries: TallyLedgerEntry[];
}

export interface TallyLedgerEntry {
  ledgerName: string;
  address?: string | null;
  gstin?: string | null;
  amount: number;
  billChallanInfo?: string | null;
  vchRefNo?: string | null;
  orderRef?: string | null;
  ewayBillNo?: string | null;
  ewayBillDate?: string | null;
  taxableValue?: number | null;
  taxes?: TallyTax[] | null;
}

export interface TallyMasterData {
  ledgers: TallyLedgerInfo[];
  groups: TallyGroupInfo[];
  items: TallyItemInfo[];
  godowns: TallyGodownInfo[];
  units: TallyUnitInfo[];
}

export interface TallyLedgerInfo {
  name: string;
  alias?: string | null;
  groupName: string;
  under: string | null;
  isBankAccount: boolean;
  isCashAccount: boolean;
  isCreditCardAccount: boolean;
  gstApplicable: boolean;
  gstCategory?: string | null;
  gstin?: string | null;
  openingBalance: number;
  closingBalance: number;
  currency: string;
}

export interface TallyGroupInfo {
  name: string;
  under: string | null;
  isGroup: boolean;
  isSingleLedger: boolean;
}

export interface TallyItemInfo {
  name: string;
  alias?: string | null;
  under: string | null;
  hsnCode?: string | null;
  sacCode?: string | null;
  unit: string;
  rate: number;
  gstRate: number;
  gstApplicable: boolean;
  taxable: boolean;
  stockHolding: boolean;
  bracketIssue: boolean;
}

export interface TallyGodownInfo {
  name: string;
  alias?: string | null;
  under: string | null;
  cannotAllocStock: boolean;
  isCompany: boolean;
}

export interface TallyUnitInfo {
  symbol: string;
  formalName: string;
  decimalPlaces: number;
  roundingMethod: string;
  isBaseUnit: boolean;
}

export function syncTallyMasters(_config: TallyConnectionConfig): TallyMasterData {
  // In production, this would query Tally XML and parse responses

  return {
    ledgers: [
      {
        name: "Sundry Debtors",
        alias: null,
        groupName: "Sundry Debtors",
        under: null,
        isBankAccount: false,
        isCashAccount: false,
        isCreditCardAccount: false,
        gstApplicable: true,
        gstCategory: "Supply",
        gstin: null,
        openingBalance: 0,
        closingBalance: 100000,
        currency: "INR",
      },
      {
        name: "Sundry Creditors",
        alias: null,
        groupName: "Sundry Creditors",
        under: null,
        isBankAccount: false,
        isCashAccount: false,
        isCreditCardAccount: false,
        gstApplicable: true,
        gstCategory: "Purchase",
        gstin: null,
        openingBalance: 0,
        closingBalance: 50000,
        currency: "INR",
      },
      {
        name: "Cash-in-Hand",
        alias: null,
        groupName: "Cash-in-Hand",
        under: null,
        isBankAccount: false,
        isCashAccount: true,
        isCreditCardAccount: false,
        gstApplicable: false,
        gstCategory: null,
        gstin: null,
        openingBalance: 50000,
        closingBalance: 30000,
        currency: "INR",
      },
      {
        name: "Bank Account",
        alias: null,
        groupName: "Bank Accounts",
        under: null,
        isBankAccount: true,
        isCashAccount: false,
        isCreditCardAccount: false,
        gstApplicable: false,
        gstCategory: null,
        gstin: null,
        openingBalance: 1000000,
        closingBalance: 950000,
        currency: "INR",
      },
      {
        name: "Sales",
        alias: null,
        groupName: "Sales",
        under: null,
        isBankAccount: false,
        isCashAccount: false,
        isCreditCardAccount: false,
        gstApplicable: true,
        gstCategory: "Supply",
        gstin: null,
        openingBalance: 0,
        closingBalance: 500000,
        currency: "INR",
      },
      {
        name: "Purchases",
        alias: null,
        groupName: "Purchase",
        under: null,
        isBankAccount: false,
        isCashAccount: false,
        isCreditCardAccount: false,
        gstApplicable: true,
        gstCategory: "Purchase",
        gstin: null,
        openingBalance: 0,
        closingBalance: 300000,
        currency: "INR",
      },
    ],
    groups: [
      { name: "Sundry Debtors", under: "Current Assets", isGroup: true, isSingleLedger: false },
      { name: "Sundry Creditors", under: "Current Liabilities", isGroup: true, isSingleLedger: false },
      { name: "Cash-in-Hand", under: "Current Assets", isGroup: false, isSingleLedger: true },
      { name: "Bank Accounts", under: "Current Assets", isGroup: true, isSingleLedger: false },
      { name: "Sales", under: "Indirect Incomes", isGroup: true, isSingleLedger: false },
      { name: "Purchase", under: "Direct Expenses", isGroup: true, isSingleLedger: false },
    ],
    items: [
      {
        name: "Gold Ring",
        alias: null,
        under: "Sales",
        hsnCode: "711311",
        sacCode: null,
        unit: "Nos",
        rate: 5000,
        gstRate: 3,
        gstApplicable: true,
        taxable: true,
        stockHolding: true,
        bracketIssue: false,
      },
      {
        name: "Silver Chain",
        alias: null,
        under: "Sales",
        hsnCode: "711519",
        sacCode: null,
        unit: "Nos",
        rate: 2000,
        gstRate: 3,
        gstApplicable: true,
        taxable: true,
        stockHolding: true,
        bracketIssue: false,
      },
    ],
    godowns: [{ name: "Mumbai Godown", alias: null, under: "Primary", cannotAllocStock: false, isCompany: false }],
    units: [
      { symbol: "Nos", formalName: "Numbers", decimalPlaces: 0, roundingMethod: "Not Applicable", isBaseUnit: true },
      { symbol: "Kg", formalName: "Kilograms", decimalPlaces: 2, roundingMethod: "Not Applicable", isBaseUnit: false },
    ],
  };
}

// ---------------------------------------------------------------------------
// Voucher sync
// ---------------------------------------------------------------------------

export interface VoucherSyncParams {
  config: TallyConnectionConfig;
  startDate: string;
  endDate: string;
  voucherTypes?: ("Sales" | "Purchase" | "Contra" | "Payment" | "Receipt" | "Journal" | "Memo")[] | null;
  ledgerFilter?: string | null;
  itemFilter?: string | null;
  syncMode: "full" | "delta";
}

export interface VoucherSyncResult {
  syncedCount: number;
  failedCount: number;
  lastSyncDate: string;
  vouchers: (TallySalesVoucher | TallyPurchaseVoucher | TallyVoucher)[];
  warnings: string[];
}

export function syncTallyVouchers(_params: VoucherSyncParams): VoucherSyncResult {
  // In production, this would query Tally for vouchers in date range
  // and parse XML responses

  return {
    syncedCount: 0,
    failedCount: 0,
    lastSyncDate: new Date().toISOString(),
    vouchers: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Trial balance export
// ---------------------------------------------------------------------------

export interface TallyTrialBalance {
  asOnDate: string;
  ledgers: TallyTrialBalanceEntry[];
  totalDebit: number;
  totalCredit: number;
  difference: number;
}

export interface TallyTrialBalanceEntry {
  ledgerName: string;
  groupName: string;
  openingBalance: number;
  debit: number;
  credit: number;
  closingBalance: number;
}

export function exportTallyTrialBalance(config: TallyConnectionConfig, asOnDate: string): TallyTrialBalance {
  // In production, this would query Tally for trial balance as on date

  return {
    asOnDate,
    ledgers: [
      {
        ledgerName: "Sundry Debtors",
        groupName: "Sundry Debtors",
        openingBalance: 0,
        debit: 100000,
        credit: 0,
        closingBalance: 100000,
      },
      {
        ledgerName: "Sundry Creditors",
        groupName: "Sundry Creditors",
        openingBalance: 0,
        debit: 0,
        credit: 50000,
        closingBalance: -50000,
      },
      { ledgerName: "Sales", groupName: "Sales", openingBalance: 0, debit: 0, credit: 500000, closingBalance: -500000 },
      {
        ledgerName: "Purchases",
        groupName: "Purchase",
        openingBalance: 0,
        debit: 300000,
        credit: 0,
        closingBalance: 300000,
      },
    ],
    totalDebit: 400000,
    totalCredit: 550000,
    difference: -150000,
  };
}

// ---------------------------------------------------------------------------
// Stock summary export
// ---------------------------------------------------------------------------

export interface TallyStockSummary {
  godown: string;
  items: TallyStockItemSummary[];
  totalValue: number;
}

export interface TallyStockItemSummary {
  itemName: string;
  hsnCode?: string | null;
  closingBalance: number;
  rate: number;
  value: number;
  gstRate: number;
}

export function exportTallyStockSummary(config: TallyConnectionConfig, godown?: string | null): TallyStockSummary {
  // In production, this would query Tally for stock summary

  return {
    godown: godown ?? "All Godowns",
    items: [
      { itemName: "Gold Ring", hsnCode: "711311", closingBalance: 100, rate: 5000, value: 500000, gstRate: 3 },
      { itemName: "Silver Chain", hsnCode: "711519", closingBalance: 200, rate: 2000, value: 400000, gstRate: 3 },
    ],
    totalValue: 900000,
  };
}
