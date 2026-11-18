/**
 * Xero Accounting Integration for Ledgerly CA Firm App
 * Connects with Xero API for financial data synchronization
 */

/* ============================================================
   Error Types
   ============================================================ */

export class XeroIntegrationError extends Error {
  constructor(message: string, _code?: string) {
    super(message);
    this.name = 'XeroIntegrationError';
  }
}

/* ============================================================
   Core Types - Xero API Models
   ============================================================ */

export interface XeroOrganization {
  OrganizationID: string;
  OrganizationType: string;
  Name: string;
  TaxNumber: string;
  Address: XeroAddress;
  ContactPersons?: XeroContactPerson[];
}

export interface XeroAddress {
  AddressType: string;
  Line1: string;
  Line2?: string;
  City: string;
  Region: string;
  PostalCode: string;
  Country: string;
}

export interface XeroContactPerson {
  ContactPersonID: string;
  FirstName: string;
  LastName: string;
  EmailAddress: string;
  Phones?: XeroPhone[];
}

export interface XeroPhone {
  PhoneType: string;
  PhoneNumber: string;
}

export interface XeroContact {
  ContactID: string;
  Name: string;
  FirstName: string;
  LastName: string;
  EmailAddress: string;
  Phones?: XeroPhone[];
  Addresses: XeroContactAddress[];
}

export interface XeroContactAddress {
  AddressType: string;
  Line1: string;
  Line2?: string;
  City: string;
  Region: string;
  PostalCode: string;
  Country: string;
}

export interface XeroInvoice {
  InvoiceID: string;
  Contact: XeroContact;
  Date: string;
  DueDate: string;
  Status: string;
  LineItems: XeroLineItem[];
  Total: number;
  SubTotal: number;
  TaxTotal: number;
  CurrencyCode: string;
}

export interface XeroLineItem {
  ItemCode?: string;
  Description: string;
  Quantity: number;
  UnitAmount: number;
  AccountCode?: string;
  Tracking?: XeroTracking[];
}

export interface XeroTracking {
  TrackingOptionName: string;
  TrackingOptionID: string;
}

export interface XeroBill {
  BillID: string;
  Contact: XeroContact;
  Date: string;
  DueDate: string;
  Status: string;
  LineItems: XeroLineItem[];
  Total: number;
  SubTotal: number;
  TaxTotal: number;
  CurrencyCode: string;
}

/* ============================================================
   Integration Client
   ============================================================ */

export class XeroClient {
  private accessToken: string;
  private refreshToken: string;
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;

  constructor(
    clientId: string,
    clientSecret: string,
    accessToken: string,
    refreshToken: string,
    tenantId: string
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tenantId = tenantId;
  }

  private getHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private async refreshAccessToken(): Promise<void> {
    const response = await fetch('https://login.xero.com/identity/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      throw new XeroIntegrationError('Failed to refresh Xero access token');
    }

    const data = await response.json();
    this.accessToken = data.access_token || this.accessToken;
    this.refreshToken = data.refresh_token || this.refreshToken;
  }

  private async apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    let headers = this.getHeaders();

    const response = await fetch(`https://api.xero.com${endpoint}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });

    if (response.status === 401) {
      await this.refreshAccessToken();
      headers = this.getHeaders();
      return fetch(`https://api.xero.com${endpoint}`, {
        ...options,
        headers: { ...headers, ...options.headers },
      }).then((res) => res.json() as Promise<T>);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new XeroIntegrationError(
        errorData.Message || `Xero API error: ${response.status}`,
        errorData.Code
      );
    }

    return response.json() as Promise<T>;
  }

  async getOrganization(): Promise<XeroOrganization> {
    return this.apiRequest<XeroOrganization>('/Organizations');
  }

  async getContacts(contactType: 'ALL' | 'CONTACTS' | 'SUPPLIERS' | 'CUSTOMERS' = 'ALL'): Promise<XeroContact[]> {
    return this.apiRequest<{ Contacts: XeroContact[] }>(`/Contacts?ContactType=${contactType}`).then(
      (res) => res.Contacts || []
    );
  }

  async getInvoices(status?: string): Promise<XeroInvoice[]> {
    const statusParam = status ? `&Status=${status}` : '';
    return this.apiRequest<{ Invoices: XeroInvoice[] }>(`/Invoices${statusParam}`).then(
      (res) => res.Invoices || []
    );
  }

  async createInvoice(invoice: {
    ContactID: string;
    LineItems: XeroLineItem[];
    DueDate?: string;
    Date?: string;
    Status?: string;
  }): Promise<XeroInvoice> {
    return this.apiRequest<XeroInvoice>('/Invoices', {
      method: 'POST',
      body: JSON.stringify(invoice),
    });
  }

  async getBills(status?: string): Promise<XeroBill[]> {
    const billStatus = status ? `Status=${status}&` : '';
    return this.apiRequest<{ Bills: XeroBill[] }>(`/Bills?${billStatus}`).then(
      (res) => res.Bills || []
    );
  }

  async getAccounts(): Promise<unknown[]> {
    return this.apiRequest(`/Accounts`);
  }

  async getBankTransactions(minDate?: string, maxDate?: string): Promise<unknown[]> {
    let url = '/BankTransactions';
    if (minDate) url += `?MinDate=${minDate}`;
    if (maxDate) {
      if (!minDate) url += '?';
      url += `&MaxDate=${maxDate}`;
    }
    return this.apiRequest(url);
  }

  async createBankTransactionImport(file: File, filename: string): Promise<unknown> {
    const formData = new FormData();
    formData.append('File', file, filename);
    formData.append('Encoding', 'UTF-8');

    return fetch(`https://api.xero.com/BankTransactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: formData,
    }).then(async (res) => {
      if (!res.ok) {
        const error = await res.json();
        throw new XeroIntegrationError(error.Message || 'Failed to import bank transactions');
      }
      return res.json();
    });
  }
}

/* ============================================================
   Mapping Helpers
   ============================================================ */

 /** Map Xero account codes to compliance categories */
export const XERO_ACCOUNT_MAPPING: Record<string, {
  complianceCategory: 'income' | 'expense' | 'asset' | 'liability' | 'equity';
  taxCode: string;
  description: string;
}> = {
  '200': {
    complianceCategory: 'asset',
    taxCode: 'GST',
    description: 'Accounts Receivable',
  },
  '210': {
    complianceCategory: 'expense',
    taxCode: 'GST',
    description: 'Accounts Payable',
  },
  '2000': {
    complianceCategory: 'income',
    taxCode: 'GST',
    description: 'Sales',
  },
  '3000': {
    complianceCategory: 'expense',
    taxCode: 'GST',
    description: 'Purchases',
  },
  default: {
    complianceCategory: 'expense',
    taxCode: 'GST',
    description: 'Uncategorized',
  },
};

/** Map Xero invoice status to risk levels */
export const XERO_INVOICE_RISK_MAPPING: Record<string, {
  riskLevel: 'low' | 'medium' | 'high';
  reason: string;
}> = {
  DRAFT: { riskLevel: 'low', reason: 'Invoice not yet sent' },
  SUBMITTED: { riskLevel: 'medium', reason: 'Awaiting payment' },
  AUTHORISED: { riskLevel: 'low', reason: 'Payment confirmed' },
  'PARTIALLY_AUTHORISED': {
    riskLevel: 'medium',
    reason: 'Partial payment received',
  },
  'PAYMENT_REQUIRED': { riskLevel: 'high', reason: 'Overdue payment required' },
  VOID: { riskLevel: 'low', reason: 'Invoice voided' },
  default: { riskLevel: 'medium', reason: 'Unknown status' },
};

/* ============================================================
   Sync Utility Functions
   ============================================================ *//** Sync Xero invoices and update compliance risk scores */
  export async function syncXeroInvoicesToDatabase(
    xeroClient: XeroClient,
    _clientId: string
): Promise<{
  invoicesProcessed: number;
  riskScoreImpact: number;
  syncedAt: Date;
}> {
  const invoices = await xeroClient.getInvoices();
  const syncedAt = new Date();
  const invoicesProcessed = invoices.length;
  let riskScoreImpact = 0;

  for (const invoice of invoices) {
    const riskLevel = (XERO_INVOICE_RISK_MAPPING[invoice.Status]?.riskLevel || (XERO_INVOICE_RISK_MAPPING.default?.riskLevel ?? 'medium')) as 'low' | 'medium' | 'high';
    const riskInfo = { riskLevel };

    const dueDate = new Date(invoice.DueDate);
    const today = new Date();
    const daysUntilDue = Math.max(
      0,
      Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    );

    let riskContribution = 0;
    if (riskInfo.riskLevel === 'high') {
      riskContribution = 15;
    } else if (riskInfo.riskLevel === 'medium' && daysUntilDue <= 30) {
      riskContribution = 8;
    } else if (riskInfo.riskLevel === 'medium') {
      riskContribution = 3;
    }

    riskScoreImpact += riskContribution;
  }

  return {
    invoicesProcessed: Math.max(0, invoicesProcessed),
    riskScoreImpact,
    syncedAt,
  };
}

/** Get Xero risk level for an invoice status */
export function getXeroRiskLevel(invoiceStatus: string): {
  riskLevel: 'low' | 'medium' | 'high';
  reason: string;
} {
  const mapped: { riskLevel: 'low' | 'medium' | 'high'; reason: string } = XERO_INVOICE_RISK_MAPPING[invoiceStatus] || XERO_INVOICE_RISK_MAPPING.default !;
  return {
    riskLevel: mapped.riskLevel,
    reason: mapped.reason,
  };
}

/* ============================================================
   QuickBooks Integration Stub
   ============================================================ */

/** QuickBooks Online configuration */
export interface QuickBooksConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  companyId: string;
  environment: 'production' | 'sandbox';
}

/** QuickBooks API client (starter implementation) */
export class QuickBooksClient {
  private config: QuickBooksConfig;

  constructor(config: QuickBooksConfig) {
    this.config = config;
  }

  async getCompanyInfo(): Promise<unknown> {
    return {};
  }

  async getCustomers(): Promise<unknown[]> {
    return [];
  }

  async getInvoices(): Promise<unknown[]> {
    return [];
  }

  async syncDataToDatabase(_clientId: string): Promise<{
    invoicesSynced: number;
    customersSynced: number;
    syncedAt: Date;
    riskImpact: number;
  }> {
    return {
      invoicesSynced: 0,
      customersSynced: 0,
      syncedAt: new Date(),
      riskImpact: 0,
    };
  }
}