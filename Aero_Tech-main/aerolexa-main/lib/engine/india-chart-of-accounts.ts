/** India-specific chart of accounts templates */

export class ChartOfAccountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartOfAccountsError";
  }
}

export type AccountType = "asset" | "liability" | "capital" | "income" | "expense" | "drawing";
export type AccountGroup =
  | "fixed-assets"
  | "current-assets"
  | "investments"
  | "current-liabilities"
  | "loans-indirect"
  | "reserves-surplus"
  | "capital-account"
  | "sales"
  | "purchases"
  | "direct-expenses"
  | "indirect-expenses"
  | "indirect-incomes"
  | "other-assets"
  | "other-liabilities"
  | "provisions";

export interface CoaEntry {
  code: string;
  name: string;
  nameLocal?: string | null;
  type: AccountType;
  group: AccountGroup;
  parentCode?: string | null;
  isControlAccount: boolean;
  normalBalance: "debit" | "credit";
  defaultNarration?: string | null;
  gstCategory?: "supply" | "purchase" | "import" | "export" | "itc" | "capital-exempt" | null;
  taxHead?: "salary" | "house-property" | "business-profits" | "capital-gains" | "other-sources" | "other" | null;
  notes?: string[];
}

export const ASSET_ACCOUNTS: CoaEntry[] = [
  {
    code: "1010",
    name: "Land and Buildings",
    type: "asset",
    group: "fixed-assets",
    isControlAccount: true,
    normalBalance: "debit",
    gstCategory: "capital-exempt",
    taxHead: "capital-gains",
  },
  {
    code: "1020",
    name: "Plant and Machinery",
    type: "asset",
    group: "fixed-assets",
    isControlAccount: true,
    normalBalance: "debit",
    gstCategory: "purchase",
    taxHead: "business-profits",
  },
  {
    code: "1030",
    name: "Furniture and Fixtures",
    type: "asset",
    group: "fixed-assets",
    isControlAccount: true,
    normalBalance: "debit",
    gstCategory: "purchase",
  },
  {
    code: "1040",
    name: "Office Equipment",
    type: "asset",
    group: "fixed-assets",
    isControlAccount: true,
    normalBalance: "debit",
    gstCategory: "purchase",
  },
  {
    code: "1050",
    name: "Motor Vehicles",
    type: "asset",
    group: "fixed-assets",
    isControlAccount: true,
    normalBalance: "debit",
    gstCategory: "purchase",
  },
  {
    code: "1210",
    name: "Stock-in-Hand",
    type: "asset",
    group: "current-assets",
    isControlAccount: true,
    normalBalance: "debit",
    gstCategory: "capital-exempt",
  },
  {
    code: "1230",
    name: "Sundry Debtors",
    type: "asset",
    group: "current-assets",
    isControlAccount: true,
    normalBalance: "debit",
    gstCategory: "supply",
  },
  {
    code: "1250",
    name: "Cash in Hand",
    type: "asset",
    group: "current-assets",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "1260",
    name: "Bank Accounts",
    type: "asset",
    group: "current-assets",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "1320",
    name: "GST Input Tax Credit",
    type: "asset",
    group: "current-assets",
    isControlAccount: true,
    normalBalance: "debit",
    gstCategory: "itc",
  },
];

export const LIABILITY_ACCOUNTS: CoaEntry[] = [
  {
    code: "2010",
    name: "Sundry Creditors",
    type: "liability",
    group: "current-liabilities",
    isControlAccount: true,
    normalBalance: "credit",
    gstCategory: "purchase",
  },
  {
    code: "2030",
    name: "Outstanding Expenses",
    type: "liability",
    group: "current-liabilities",
    isControlAccount: true,
    normalBalance: "credit",
  },
  {
    code: "2040",
    name: "Provident Fund (Employee Share)",
    type: "liability",
    group: "current-liabilities",
    isControlAccount: true,
    normalBalance: "credit",
  },
  {
    code: "2080",
    name: "Tax Deducted at Source (TDS)",
    type: "liability",
    group: "current-liabilities",
    isControlAccount: true,
    normalBalance: "credit",
  },
  {
    code: "2090",
    name: "GST Payable",
    type: "liability",
    group: "current-liabilities",
    isControlAccount: true,
    normalBalance: "credit",
    gstCategory: "itc",
  },
  {
    code: "2120",
    name: "Professional Tax Payable",
    type: "liability",
    group: "current-liabilities",
    isControlAccount: true,
    normalBalance: "credit",
  },
];

export const CAPITAL_ACCOUNTS: CoaEntry[] = [
  {
    code: "3010",
    name: "Share Capital (Equity)",
    type: "capital",
    group: "capital-account",
    isControlAccount: true,
    normalBalance: "credit",
  },
  {
    code: "3030",
    name: "Partners' Capital Accounts",
    type: "capital",
    group: "capital-account",
    isControlAccount: true,
    normalBalance: "credit",
  },
  {
    code: "3040",
    name: "Proprietor's Capital Account",
    type: "capital",
    group: "capital-account",
    isControlAccount: true,
    normalBalance: "credit",
  },
];

export const REVENUE_ACCOUNTS: CoaEntry[] = [
  {
    code: "4010",
    name: "Sales",
    type: "income",
    group: "sales",
    isControlAccount: true,
    normalBalance: "credit",
    gstCategory: "supply",
  },
  {
    code: "4030",
    name: "Services Rendered",
    type: "income",
    group: "sales",
    isControlAccount: true,
    normalBalance: "credit",
    gstCategory: "supply",
  },
  {
    code: "4040",
    name: "Export Sales",
    type: "income",
    group: "sales",
    isControlAccount: true,
    normalBalance: "credit",
    gstCategory: "export",
  },
  {
    code: "4110",
    name: "Interest Received",
    type: "income",
    group: "indirect-incomes",
    isControlAccount: true,
    normalBalance: "credit",
  },
  {
    code: "4120",
    name: "Dividend Received",
    type: "income",
    group: "indirect-incomes",
    isControlAccount: true,
    normalBalance: "credit",
  },
];

export const DIRECT_EXPENSE_ACCOUNTS: CoaEntry[] = [
  {
    code: "5010",
    name: "Purchases",
    type: "expense",
    group: "purchases",
    isControlAccount: true,
    normalBalance: "debit",
    gstCategory: "purchase",
  },
  {
    code: "5110",
    name: "Wages",
    type: "expense",
    group: "direct-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "5120",
    name: "Salaries - Factory",
    type: "expense",
    group: "direct-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
];

export const INDIRECT_EXPENSE_ACCOUNTS: CoaEntry[] = [
  {
    code: "6010",
    name: "Office Expenses",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6020",
    name: "Rent and Rates",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6030",
    name: "Salary and Wages - Office",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
    taxHead: "salary",
  },
  {
    code: "6040",
    name: "Depreciation",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6050",
    name: "Repairs and Maintenance",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6060",
    name: "Travel and Conveyance",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6070",
    name: "Postage and Telephone",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6080",
    name: "Insurance",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6090",
    name: "Interest on Borrowings",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6100",
    name: "Professional Tax",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6110",
    name: "TDS Paid",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6120",
    name: "Audit Fees",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
  {
    code: "6130",
    name: "Legal Expenses",
    type: "expense",
    group: "indirect-expenses",
    isControlAccount: true,
    normalBalance: "debit",
  },
];
