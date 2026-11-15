/**
 * Connector configuration validation (Zod — the same pattern lib/env.ts uses).
 *
 * Config objects are validated before they are ever encrypted and stored, and
 * again after decryption, so a corrupt or tampered blob fails with a readable
 * message instead of a crash. All connector kinds (PostgreSQL, Snowflake,
 * BigQuery, mySQL, MongoDB) are validated here.
 */
import { z } from "zod";

import { ConnectorError } from "./errors";

export const postgresConfigSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1, "Database name is required"),
  user: z.string().min(1, "User is required"),
  password: z.string().min(1, "Password is required"),
  ssl: z.boolean().default(false),
  /** Optional default schema for introspection (defaults to "public"). */
  schema: z.string().min(1).optional(),
});

export type PostgresConfig = z.infer<typeof postgresConfigSchema>;

export const snowflakeConfigSchema = z
  .object({
    account: z.string().min(1, "Account identifier is required"),
    username: z.string().min(1, "Username is required"),
    password: z.string().default(""),
    /** PEM RS256 private key for key-pair auth (preferred over password). */
    privateKeyPem: z.string().optional().default(""),
    role: z.string().optional(),
    warehouse: z.string().optional(),
    database: z.string().min(1, "Database is required"),
    schema: z.string().min(1, "Schema is required"),
  })
  .refine((c) => c.privateKeyPem.trim().length > 0 || c.password.length > 0, {
    message: "Provide a private key (key-pair auth) or a password.",
  });

export const bigqueryConfigSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  datasetId: z.string().min(1, "Dataset ID is required"),
  credentialsJson: z
    .string()
    .min(1, "Service-account credentials JSON is required")
    .refine(
      (raw) => {
        try {
          const parsed = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown };
          return typeof parsed.client_email === "string" && typeof parsed.private_key === "string";
        } catch {
          return false;
        }
      },
      { message: "credentialsJson must be service-account JSON containing client_email and private_key" },
    ),
});

export const mysqlConfigSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  database: z.string().min(1, "Database name is required"),
  user: z.string().min(1, "User is required"),
  /** Optional password — MySQL allows password-less local roles. */
  password: z.string().default(""),
  ssl: z.boolean().default(false),
  /** Optional default schema for introspection (defaults to the database name). */
  schema: z.string().min(1).optional(),
});

export type MySqlConfig = z.infer<typeof mysqlConfigSchema>;

export const mongodbConfigSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.coerce.number().int().min(1).max(65535).default(27017),
  database: z.string().min(1, "Database name is required"),
  /** Both user and password are optional — MongoDB allows auth-less deployments. */
  user: z.string().optional().default(""),
  password: z.string().optional().default(""),
  /** Which database authenticates the user against (defaults to the target database). */
  authSource: z.string().optional(),
  ssl: z.boolean().default(false),
});

export type MongoDbConfig = z.infer<typeof mongodbConfigSchema>;

/**
 * India-specific connectors (file-based, not database connections).
 * These parse local files uploaded by the user — Tally exports, GST returns,
 * bank statements — and convert them to the standard column/row format.
 */

export const tallyConfigSchema = z.object({
  /** Tally export format. TCML = XML-based Tally export; CSV = comma-separated. */
  format: z.enum(["tcml", "csv"]).default("tcml"),
  /** For CSV: which ledger/voucher type to extract (e.g., "Sales", "Purchase", "Journal"). */
  voucherType: z.string().optional(),
  /** For CSV: date column name (auto-detected if omitted). */
  dateColumn: z.string().optional(),
  /** For CSV: amount column name (auto-detected if omitted). */
  amountColumn: z.string().optional(),
  /** For TCML: Tally version (affects XML namespace). */
  tallyVersion: z.enum(["prime", "erp9", "tdl"]).default("prime"),
  /**
   * Live Tally XML gateway (TallyPrime HTTP server, default port 9000).
   * When `host` is non-empty the connector talks to the running Tally
   * instance over HTTP instead of parsing an uploaded export file; when it
   * is empty the connector stays in its original file-parser mode.
   */
  host: z.string().optional().default(""),
  port: z.coerce.number().int().min(1).max(65535).default(9000),
  /** Company name as shown in Tally. Defaults to the active company. */
  company: z.string().optional().default(""),
  /** Export period start. YYYY-MM-DD or YYYYMMDD; empty = Tally's active period. */
  fromDate: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2}|\d{8})?$/)
    .optional()
    .default(""),
  /** Export period end. YYYY-MM-DD or YYYYMMDD; empty = Tally's active period. */
  toDate: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2}|\d{8})?$/)
    .optional()
    .default(""),
});

/**
 * Shopify connector (D2C commerce data): read-only Admin REST pulls for
 * orders/products/customers with a custom-app access token.
 */
export const shopifyConfigSchema = z.object({
  /** Shop domain, e.g. acme-india.myshopify.com (or a custom domain). */
  shopDomain: z
    .string()
    .min(1, "Shop domain is required")
    .refine((v) => /^[a-z0-9][a-z0-9-]*\.[a-z.]{2,}$/i.test(v.trim()), {
      message: "Enter the shop domain, e.g. acme-india.myshopify.com",
    }),
  /** Admin API access token from a custom app (Theme → Apps → Develop apps). */
  accessToken: z.string().min(1, "Admin API access token is required"),
  /** Admin API version (date-pinned; defaults to a recent stable). */
  apiVersion: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default("2024-10"),
});

export type ShopifyConfig = z.infer<typeof shopifyConfigSchema>;

/**
 * Zoho Books connector (India-first accounting SaaS): read-only REST pulls
 * through the Books API v3 with a developer self-client refresh token.
 * Credentials are encrypted at rest; access tokens are minted per operation
 * and never stored.
 */
export const zohoBooksConfigSchema = z.object({
  /** Regional data center the Zoho account lives in (India = "in"). */
  region: z.enum(["us", "in", "eu", "au", "jp", "cn", "sa", "ca"]).default("in"),
  /** Self-client ID from api-console.zoho.com. */
  clientId: z.string().min(1, "Client ID is required"),
  /** Self-client secret. */
  clientSecret: z.string().min(1, "Client secret is required"),
  /** Refresh token minted with a read-only Books scope (e.g. ZohoBooks.fullaccess.read). */
  refreshToken: z.string().min(1, "Refresh token is required"),
  /** Organization ID. Defaults to the first organization on the account. */
  organizationId: z.string().optional().default(""),
});

export type ZohoBooksConfig = z.infer<typeof zohoBooksConfigSchema>;

/**
 * Xero Accounting API v2.
 *
 * Authorise the app once with the accounting read scopes; the refresh token is
 * the only long-lived secret. Xero rotates it on every exchange, so the
 * connector stores the newest value through the pull hook (see
 * lib/engine/connectors/xero.ts).
 */
export const xeroConfigSchema = z.object({
  clientId: z.string().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client secret is required"),
  refreshToken: z.string().min(1, "Refresh token is required"),
  /** Tenant (organisation) id shown by Xero after authorisation. */
  tenantId: z.string().min(1, "Tenant id is required"),
});

export type XeroConfig = z.infer<typeof xeroConfigSchema>;

export type TallyConfig = z.infer<typeof tallyConfigSchema>;

export const gstConfigSchema = z.object({
  /** GST return type to parse. */
  returnType: z.enum(["gstr1", "gstr2a", "gstr2b", "gstr3b"]).default("gstr1"),
  /** Input format: JSON (from GST portal download) or XML (older format). */
  format: z.enum(["json", "xml"]).default("json"),
  /** GSTIN of the taxpayer (for validation). */
  gstin: z
    .string()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, "Invalid GSTIN format")
    .optional(),
  /** Financial year (e.g., "2024-25") for period validation. */
  financialYear: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Financial year must be YYYY-YY")
    .optional(),
});

export type GstConfig = z.infer<typeof gstConfigSchema>;

export const tdsChallanConfigSchema = z.object({
  /** TDS challan format. */
  format: z.enum(["csv", "excel", "json"]).default("csv"),
  /** TAN of the deductor. */
  tan: z.string().optional(),
  /** Financial year. */
  financialYear: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  /** Skip header rows for CSV. */
  skipRows: z.coerce.number().int().min(0).default(0),
});

export type TdsChallanConfig = z.infer<typeof tdsChallanConfigSchema>;

export const payrollExportConfigSchema = z.object({
  /** Payroll export format. */
  format: z.enum(["csv", "excel", "json"]).default("csv"),
  /** Month in YYYY-MM format. */
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  /** Payroll system name for mapping hints. */
  system: z.string().optional(),
  /** Skip header rows for CSV. */
  skipRows: z.coerce.number().int().min(0).default(0),
});

export type PayrollExportConfig = z.infer<typeof payrollExportConfigSchema>;

export const imsEinvoiceConfigSchema = z.object({
  /** IMS/e-invoice data format. */
  format: z.enum(["json", "xml", "csv"]).default("json"),
  /** GSTIN. */
  gstin: z
    .string()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/)
    .optional(),
  /** Return period (YYYYMM). */
  period: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export type ImsEinvoiceConfig = z.infer<typeof imsEinvoiceConfigSchema>;

export const razorpayConfigSchema = z.object({
  /** Razorpay API key ID. */
  keyId: z.string().min(1, "Key ID is required"),
  /** Razorpay API key secret. */
  keySecret: z.string().min(1, "Key secret is required"),
  /** Webhook secret for verification (optional). */
  webhookSecret: z.string().optional(),
  /** Account type. */
  accountType: z.enum(["standard", "route"]).default("standard"),
});

export type RazorpayConfig = z.infer<typeof razorpayConfigSchema>;

export const payuConfigSchema = z.object({
  /** PayU merchant key. */
  merchantKey: z.string().min(1, "Merchant key is required"),
  /** PayU merchant salt. */
  merchantSalt: z.string().min(1, "Merchant salt is required"),
  /** PayU API environment. */
  environment: z.enum(["test", "production"]).default("test"),
});

export type PayuConfig = z.infer<typeof payuConfigSchema>;

export const busyAccountingConfigSchema = z.object({
  /** Busy accounting export format. */
  format: z.enum(["xml", "csv", "dbf"]).default("xml"),
  /** Company name. */
  companyName: z.string().optional(),
});

export type BusyAccountingConfig = z.infer<typeof busyAccountingConfigSchema>;

export const margConfigSchema = z.object({
  /** Marg ERP export format. */
  format: z.enum(["xml", "csv", "dbf"]).default("xml"),
  /** Company name. */
  companyName: z.string().optional(),
});
export type MargConfig = z.infer<typeof margConfigSchema>;

// ---------------------------------------------------------------------------
// CA portal filing connectors — certificate-based auth + submission engines
// ---------------------------------------------------------------------------

/**
 * DSC (Digital Signature Certificate) credentials for CA portal authentication.
 * Class 2/3 DSC certificates are used to sign submissions on GST, Income Tax,
 * ROC and TDS portals. The private key must be PKCS#8 PEM; the certificate
 * is X.509 PEM. PIN is the smart-card/USB-token PIN or the file-based key PIN.
 *
 * Signing method matrix (mirrors ca-efiling.ts):
 *   - "dsc"  — DSC-based signing (audit reports, ROC forms, some ITRs)
 *   - "evc"  — EVC via pre-validated bank account (most ITRs, TDS statements)
 *   - "etm"  — E-Token Manager / Aadhaar eSign for simpler filings
 */
export const dscCredentialSchema = z.object({
  /** Certificate serial number (from the DSC, used for acknowledgement tracking). */
  certificateSerial: z
    .string()
    .regex(/^[0-9A-Fa-f]{8,}$/, "Certificate serial must be hex (8+ chars)")
    .optional()
    .default(""),
  /** Thumbprint of the certificate (SHA-256, uppercase hex) — used for portal lookup. */
  thumbprint: z
    .string()
    .regex(/^[0-9A-F]{64}$/, "Thumbprint must be 64-char uppercase hex SHA-256")
    .optional()
    .default(""),
});

export type DscCredential = z.infer<typeof dscCredentialSchema>;

/**
 * GST portal connector — live GSTN integration for GSTR-1, GSTR-3B, GSTR-9
 * and other GST return filings with DSC/EVC signing and acknowledgement capture.
 *
 * Auth: DSC certificate (preferred for B2B-heavy returns) or EVC via pre-validated
 * bank account. The GST portal requires the taxpayer's GSTIN and the filing period.
 *
 * NOTE: This implements the credential schema and auth flow. Actual portal endpoints
 * (https://services.gst.gov.in) require proper TLS client-certificate auth and are
 * subject to GSTN's rate limits and filing-window restrictions. The engine surfaces
 * the workflow so a reviewer can verify against the current GST portal behavior.
 */
export const gstPortalConfigSchema = z.object({
  /** Taxpayer GSTIN (20-char PAN-based + state code + entity number + Z + checksum). */
  gstin: z
    .string()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, "Invalid GSTIN format")
    .min(1, "GSTIN is required"),
  /** Filings to enable for this connector (GSTR-1, GSTR-3B, GSTR-9, etc.). */
  filingTypes: z
    .array(z.enum(["gstr-1", "gstr-3b", "gstr-9", "gstr-9c", "gtr-3b-refund", "itr-9", "annual-return"]))
    .min(1, "At least one filing type must be enabled")
    .default(["gstr-1", "gstr-3b"]),
  /**
   * Signing method: "dsc" (Digital Signature Certificate), "evc" (EVC via
   * pre-validated bank account), or "etm" (E-Token Manager / Aadhaar eSign).
   * The GST portal allows EVC for most returns; DSC is required for certain
   * category of filers and audit-related returns.
   */
  signingMethod: z.enum(["dsc", "evc", "etm"]).default("evc"),
  /** DSC credentials (required when signingMethod is "dsc"). */
  dsc: dscCredentialSchema.optional(),
  /**
   * EVC bank account number — required when signingMethod is "evc". The
   * account must be pre-validated on the GST portal (linked to the GSTIN).
   */
  evcBankAccount: z.string().optional(),
  /** Timeout for portal interactions (seconds). Default 30s — GSTN can be slow. */
  timeoutSeconds: z.coerce.number().int().min(5).max(120).default(30),
  /** Max retries for transient GSTN errors (5xx, timeouts). Default 3. */
  maxRetries: z.coerce.number().int().min(0).max(10).default(3),
});

export type GstPortalConfig = z.infer<typeof gstPortalConfigSchema>;

/**
 * Income Tax e-filing portal connector — ITR, audit report (ATR), and
 * TAN-based filings with DSC/EVC/ETM signing. The portal is at
 * https://www.incometax.gov.in and requires the assessee's PAN.
 *
 * Auth flows:
 *   - DSC: Certificate-based signing for audit reports, ITR-6, ITR-7 etc.
 *   - EVC: EVC via pre-validated bank account or Aadhaar OTP for individual ITRs
 *   - ETM: E-Token Manager for simplified signing
 *
 * The engine prepares the pre-submission payload (via ca-efiling.ts) and then
 * orchestrates the portal submission flow, capturing the acknowledgement (ACK
 * number, date, status) and handling resubmission for errors/rejections.
 */
export const itPortalConfigSchema = z.object({
  /** Assessee PAN (10-char alphanumeric). */
  pan: z
    .string()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, "Invalid PAN format (expected 5+4+1 uppercase alphanumeric)")
    .min(1, "PAN is required"),
  /** Assessment year, e.g. "2026-27" (FY 2025-26). */
  assessmentYear: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Assessment year must be YYYY-YY")
    .min(1, "Assessment year is required"),
  /** Form type to file: ITR-1 through ITR-7, audit-report, etc. */
  formType: z.enum([
    "itr-1",
    "itr-2",
    "itr-3",
    "itr-4",
    "itr-5",
    "itr-6",
    "itr-7",
    "audit-report",
    "tds-statement",
    "proforma",
  ]),
  /**
   * Signing method. The IT portal uses EVC (bank A/C validation) for most
   * individual ITRs, DSC for audit reports and certain corporate returns,
   * and ETM / Aadhaar eSign as alternatives.
   */
  signingMethod: z.enum(["dsc", "evc", "etm"]).default("evc"),
  /** DSC credentials (required when signingMethod is "dsc"). */
  dsc: dscCredentialSchema.optional(),
  /** EVC options when signingMethod is "evc". */
  evc: z
    .object({
      /** Pre-validated bank account number (EVC via net-banking). */
      bankAccount: z.string().optional(),
      /** Aadhaar number for Aadhaar-based EVC (masked in storage, last 4 only). */
      aadhaarLast4: z
        .string()
        .regex(/^[0-9]{4}$/, "Aadhaar last 4 must be 4 digits")
        .optional(),
    })
    .optional(),
  /** Timeout for portal interactions (seconds). Default 45s — IT portal SLA. */
  timeoutSeconds: z.coerce.number().int().min(5).max(120).default(45),
  /** Max retries for transient portal errors. Default 3. */
  maxRetries: z.coerce.number().int().min(0).max(10).default(3),
});

export type ItPortalConfig = z.infer<typeof itPortalConfigSchema>;

/**
 * ROC (Registrar of Companies) portal connector — MCA filings (DIR-3 KYC,
 * AOC-4, MGT-7, CHG-4, etc.) with DSC-based signing. ROC forms overwhelmingly
 * require DSC; EVC is not generally available for ROC filings.
 *
 * The MCA portal (https://www.mca.gov.in and https://www.arcotmcaus.gov.in)
 * requires a Class 2/3 DSC registered with the MCA. The certificate's PAN is
 * used as the user identifier.
 */
export const rocPortalConfigSchema = z.object({
  /** Company CIN (CIN = State(2) + RegType(1) + PAN(10) + RegYear(4) + EntityNo(6) +>. */
  cin: z
    .string()
    .regex(/^[0-9]{2}[A-Z]{1}[A-Z0-9]{10}[0-9]{4}[0-9]{6}[A-Z]{1}$/, "Invalid CIN format")
    .min(1, "CIN is required"),
  /** Form type to file. */
  formType: z.enum(["dir-3-kyc", "aoc-4", "mgt-7", "mgt-7a", "chg-4", "form-mr-3", "form-abc"]),
  /** DSC credentials — ROC forms require DSC signing (no EVC path). */
  dsc: dscCredentialSchema.refine(
    (v) => v.certificateSerial !== "" || v.thumbprint !== "",
    "DSC credentials are required for ROC filings",
  ),
  /** DSC PAN — the DSC must be registered with the MCA under this PAN. */
  dscPan: z
    .string()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, "Invalid PAN format")
    .min(1, "DSC PAN (registered with MCA) is required"),
  /** Timeout for portal interactions (seconds). Default 60s — MCA portal can be slow. */
  timeoutSeconds: z.coerce.number().int().min(5).max(180).default(60),
  /** Max retries for transient MCA errors. Default 3. */
  maxRetries: z.coerce.number().int().min(0).max(10).default(3),
  /**
   * MCA portal environment: "prod" (www.mca.gov.in) or "evo" (MCA21 V3
   * evolution portal at www.arcotmcaus.gov.in). EVO is the newer portal.
   */
  environment: z.enum(["prod", "evo"]).default("prod"),
});

export type RocPortalConfig = z.infer<typeof rocPortalConfigSchema>;

/**
 * TDS portal connector — TDS/TCS statement filing (Form 24Q, 26Q, 27Q, 27EQ)
 * through the Income Tax e-filing portal with DSC/EVC signing.
 *
 * The TDS statement is filed by the deductor (employer/payer) using their TAN.
 * The filing flow: prepare → sign (DSC/EVC) → submit → capture acknowledgement →
 * handle resubmission for errors.
 *
 * TDS statements require the TAN, assessment year, and the preparer's credentials.
 */
export const tdsPortalConfigSchema = z.object({
  /** Deductor TAN (10-char alphanumeric: alphabetic + 4 digits + alphabetic). */
  tan: z
    .string()
    .regex(/^[A-Z]{4}[0-9]{6}[A-Z]{1}$/, "Invalid TAN format (expected AAAA999999A)")
    .min(1, "TAN is required"),
  /** Assessment year, e.g. "2026-27". */
  assessmentYear: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Assessment year must be YYYY-YY")
    .min(1, "Assessment year is required"),
  /** TDS statement form type. */
  statementType: z.enum(["24q", "26q", "27q", "27eq", "24g", "27d"]),
  /** Employer/deductor name (for the statement header). */
  deductorName: z.string().min(1, "Deductor name is required"),
  /**
   * Signing method. TDS statements can use EVC (bank validation) or DSC
   * (for corporate deductors / signed statements). ETM is available for
   * simplified signing.
   */
  signingMethod: z.enum(["dsc", "evc", "etm"]).default("evc"),
  /** DSC credentials (required when signingMethod is "dsc"). */
  dsc: dscCredentialSchema.optional(),
  /** EVC via bank account (required when signingMethod is "evc"). */
  evcBankAccount: z.string().optional(),
  /** Timeout for portal interactions (seconds). Default 45s. */
  timeoutSeconds: z.coerce.number().int().min(5).max(120).default(45),
  /** Max retries for transient errors. Default 3. */
  maxRetries: z.coerce.number().int().min(0).max(10).default(3),
});

export type TdsPortalConfig = z.infer<typeof tdsPortalConfigSchema>;

export const bankStatementConfigSchema = z.object({
  /** Bank statement format. */
  format: z.enum(["csv", "excel", "pdf"]).default("csv"),
  /** Bank name (helps auto-detect column mapping). */
  bank: z.string().optional(),
  /** Account type for categorization. */
  accountType: z.enum(["savings", "current", "credit", "overdraft"]).default("current"),
  /** Column mapping hints (auto-detected if omitted). */
  dateColumn: z.string().optional(),
  descriptionColumn: z.string().optional(),
  debitColumn: z.string().optional(),
  creditColumn: z.string().optional(),
  balanceColumn: z.string().optional(),
  /** Reference/UTR/cheque-number column hint (auto-detected if omitted). */
  referenceColumn: z.string().optional(),
  /** Date format hint (auto-detected if omitted). */
  dateFormat: z.string().optional(),
  /** Skip header rows. */
  skipRows: z.coerce.number().int().min(0).default(0),
  /** Encoding for CSV (e.g., "utf-8", "latin1"). */
  encoding: z.string().default("utf-8"),
});

export type BankStatementConfig = z.infer<typeof bankStatementConfigSchema>;

/**
 * S3/CSV connector (ROADMAP 1.3): one CSV object in an S3-compatible bucket.
 */
export const s3CsvConfigSchema = z.object({
  /** S3-compatible endpoint; omit for AWS. */
  endpoint: z.string().url().optional(),
  region: z.string().min(1, "Region is required"),
  bucket: z.string().min(1, "Bucket is required"),
  /** Object key (full path inside the bucket). */
  key: z.string().min(1, "Object key is required"),
  accessKeyId: z.string().min(1, "Access key ID is required"),
  secretAccessKey: z.string().min(1, "Secret access key is required"),
  forcePathStyle: z.boolean().optional(),
  headerRow: z.boolean().optional(),
});

export type S3CsvConfig = z.infer<typeof s3CsvConfigSchema>;

/**
 * Generic HTTP polling connector (ROADMAP 1.3): JSON/CSV from any public URL.
 */
export const httpSourceConfigSchema = z.object({
  url: z.string().url().min(1, "Endpoint URL is required"),
  /** Extra request headers, e.g. { "Authorization": "Bearer …" }. */
  headers: z.record(z.string()).optional(),
  format: z.enum(["json", "csv", "auto"]).default("auto"),
});

export type HttpSourceConfigZod = z.infer<typeof httpSourceConfigSchema>;

/**
 * Google Sheets connector: real read-only pulls through the Sheets REST API v4
 * with service-account auth (JWT → OAuth2, the same flow as BigQuery).
 * The service account's client_email must be shared on the spreadsheet as
 * Viewer; the connection test reports that remedy when it is not.
 */
export const sheetsConfigSchema = z.object({
  /** Spreadsheet ID from the sheet URL: …/d/<ID>/edit. */
  spreadsheetId: z
    .string()
    .min(10, "Spreadsheet ID is required")
    .refine((v) => /^[A-Za-z0-9_-]{10,}$/.test(v.trim()), {
      message: "Enter the spreadsheet ID from the URL (…/d/<ID>/edit) — not the whole URL.",
    }),
  /** Service-account JSON containing client_email and private_key. */
  credentialsJson: z
    .string()
    .min(1, "Service-account credentials JSON is required")
    .refine(
      (raw) => {
        try {
          const parsed = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown };
          return typeof parsed.client_email === "string" && typeof parsed.private_key === "string";
        } catch {
          return false;
        }
      },
      { message: "credentialsJson must be service-account JSON containing client_email and private_key" },
    ),
});

export type SheetsConfig = z.infer<typeof sheetsConfigSchema>;

/**
 * Excel via OneDrive/SharePoint connector (ROADMAP 1.3): a real read-only
 * pull of one .xlsx workbook through the Microsoft Graph API
 * (`/sites/{host}:/...` for SharePoint, `/me/drive` for OneDrive personal).
 * Auth is a Microsoft identity-platform access token minted per operation
 * from tenant/client credentials (client-credentials flow, no user consent).
 * The workbook is downloaded as binary and parsed with the installed `xlsx`
 * package — the SAME parser the upload pipeline uses, so column typing and
 * paste-down semantics are identical to a manual upload.
 */
export const onedriveExcelConfigSchema = z.object({
  /** "sharepoint" (document library path) or "onedrive" (personal drive root). */
  source: z.enum(["sharepoint", "onedrive"]).default("sharepoint"),
  /** SharePoint host, e.g. contoso.sharepoint.com (sharepoint mode only). */
  siteHost: z.string().optional().default(""),
  /** Server-relative path to the workbook, e.g. "/sites/Finance/Reports/sales.xlsx". */
  filePath: z
    .string()
    .min(1, "Workbook path is required")
    .refine((v) => /\.xlsx?$/i.test(v.trim()), {
      message: "Path must point at an .xlsx or .xls workbook.",
    }),
  /** Azure AD tenant id. */
  tenantId: z.string().min(1, "Tenant ID is required"),
  /** Application (client) id with Files.Read.All / Sites.Read.All app rights. */
  clientId: z.string().min(1, "Client ID is required"),
  /** Client secret. Stored encrypted; only used to mint short-lived tokens. */
  clientSecret: z.string().min(1, "Client secret is required"),
  /** Worksheet name. Defaults to the first visible sheet. */
  worksheet: z.string().optional().default(""),
});

export type OneDriveExcelConfig = z.infer<typeof onedriveExcelConfigSchema>;

export type SnowflakeConfig = z.infer<typeof snowflakeConfigSchema>;

export type BigQueryConfig = z.infer<typeof bigqueryConfigSchema>;

/** Union of every connector kind's config — extensible for future phases. */
export type ConnectorConfig =
  | { kind: "postgres"; postgres: PostgresConfig }
  | { kind: "snowflake"; snowflake: SnowflakeConfig }
  | { kind: "bigquery"; bigquery: BigQueryConfig }
  | { kind: "mysql"; mysql: MySqlConfig }
  | { kind: "mongodb"; mongodb: MongoDbConfig }
  | { kind: "tally"; tally: TallyConfig }
  | { kind: "zoho-books"; zohoBooks: ZohoBooksConfig }
  | { kind: "xero"; xero: XeroConfig }
  | { kind: "shopify"; shopify: ShopifyConfig }
  | { kind: "gst"; gst: GstConfig }
  | { kind: "bank-statement"; bankStatement: BankStatementConfig }
  | { kind: "s3-csv"; s3Csv: S3CsvConfig }
  | { kind: "http"; http: HttpSourceConfigZod }
  | { kind: "sheets"; sheets: SheetsConfig }
  | { kind: "onedrive-excel"; onedriveExcel: OneDriveExcelConfig }
  | { kind: "tds-challan"; tdsChallan: TdsChallanConfig }
  | { kind: "payroll-export"; payrollExport: PayrollExportConfig }
  | { kind: "ims-einvoice"; imsEinvoice: ImsEinvoiceConfig }
  | { kind: "razorpay"; razorpay: RazorpayConfig }
  | { kind: "payu"; payu: PayuConfig }
  | { kind: "busy"; busy: BusyAccountingConfig }
  | { kind: "marg"; marg: MargConfig }
  // CA portal filing connectors.
  | { kind: "gst-portal"; gstPortal: GstPortalConfig }
  | { kind: "it-portal"; itPortal: ItPortalConfig }
  | { kind: "roc-portal"; rocPortal: RocPortalConfig }
  | { kind: "tds-portal"; tdsPortal: TdsPortalConfig };

export const CONNECTOR_KINDS = [
  "postgres",
  "snowflake",
  "bigquery",
  "mysql",
  "mongodb",
  "tally",
  "zoho-books",
  "xero",
  "shopify",
  "gst",
  "bank-statement",
  "s3-csv",
  "http",
  "sheets",
  "onedrive-excel",
  "tds-challan",
  "payroll-export",
  "ims-einvoice",
  "razorpay",
  "payu",
  "busy",
  "marg",
  // CA portal filing connectors — certificate-based auth + submission engines.
  "gst-portal",
  "it-portal",
  "roc-portal",
  "tds-portal",
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/**
 * Validate a config object for a connector kind. Accepts both the stored
 * shape (`{ kind, ...config }`) and the bare field shape (what the
 * client sends on create), so create + decrypt paths validate identically.
 *
 * Typed over the kind literal via overloads: `validateConnectorConfig("sheets", x)`
 * is typed as the `{ kind: "sheets"; sheets: SheetsConfig }` arm, so callers get
 * automatic narrowing without a kind check. A runtime-unknown kind (the stored
 * `connector.kind` column is a plain string) falls back to the full union via
 * the `string` overload, preserving exhaustiveness checks in dispatch code.
 */
export function validateConnectorConfig<K extends ConnectorKind>(
  kind: K,
  raw: unknown,
): Extract<ConnectorConfig, { kind: K }>;
export function validateConnectorConfig(kind: string, raw: unknown): ConnectorConfig;
export function validateConnectorConfig(kind: string, raw: unknown): ConnectorConfig {
  return validateConnectorConfigImpl(kind, raw);
}

/** Implementation shared by the typed wrapper above. */
function validateConnectorConfigImpl(kind: string, raw: unknown): ConnectorConfig {
  switch (kind) {
    case "postgres": {
      const candidate =
        raw !== null && typeof raw === "object" && "postgres" in (raw as Record<string, unknown>)
          ? (raw as { postgres: unknown }).postgres
          : raw;
      const parsed = postgresConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid connection settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "postgres", postgres: parsed.data };
    }
    case "snowflake": {
      const hasWrapper = raw !== null && typeof raw === "object" && "snowflake" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { snowflake: unknown }).snowflake : raw;
      const parsed = snowflakeConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid Snowflake settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "snowflake", snowflake: parsed.data };
    }
    case "bigquery": {
      const hasWrapper = raw !== null && typeof raw === "object" && "bigquery" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { bigquery: unknown }).bigquery : raw;
      const parsed = bigqueryConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid BigQuery settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "bigquery", bigquery: parsed.data };
    }
    case "mysql": {
      const hasWrapper = raw !== null && typeof raw === "object" && "mysql" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { mysql: unknown }).mysql : raw;
      const parsed = mysqlConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid mySQL settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "mysql", mysql: parsed.data };
    }
    case "mongodb": {
      const hasWrapper = raw !== null && typeof raw === "object" && "mongodb" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { mongodb: unknown }).mongodb : raw;
      const parsed = mongodbConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid MongoDB settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "mongodb", mongodb: parsed.data };
    }
    case "tally": {
      const hasWrapper = raw !== null && typeof raw === "object" && "tally" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { tally: unknown }).tally : raw;
      const parsed = tallyConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid Tally settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "tally", tally: parsed.data };
    }
    case "zoho-books": {
      const hasWrapper = raw !== null && typeof raw === "object" && "zohoBooks" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { zohoBooks: unknown }).zohoBooks : raw;
      const parsed = zohoBooksConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid Zoho Books settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "zoho-books", zohoBooks: parsed.data };
    }
    case "shopify": {
      const hasWrapper = raw !== null && typeof raw === "object" && "shopify" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { shopify: unknown }).shopify : raw;
      const parsed = shopifyConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid Shopify settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "shopify", shopify: parsed.data };
    }
    case "gst": {
      const hasWrapper = raw !== null && typeof raw === "object" && "gst" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { gst: unknown }).gst : raw;
      const parsed = gstConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid GST settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "gst", gst: parsed.data };
    }
    case "bank-statement": {
      const hasWrapper =
        raw !== null && typeof raw === "object" && "bank-statement" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { "bank-statement": unknown })["bank-statement"] : raw;
      const parsed = bankStatementConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid bank statement settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "bank-statement", bankStatement: parsed.data };
    }
    case "s3-csv": {
      const hasWrapper = raw !== null && typeof raw === "object" && "s3Csv" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { s3Csv: unknown }).s3Csv : raw;
      const parsed = s3CsvConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid S3/CSV settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "s3-csv", s3Csv: parsed.data };
    }
    case "http": {
      const hasWrapper = raw !== null && typeof raw === "object" && "http" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { http: unknown }).http : raw;
      const parsed = httpSourceConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid HTTP source settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "http", http: parsed.data };
    }
    case "sheets": {
      const hasWrapper = raw !== null && typeof raw === "object" && "sheets" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { sheets: unknown }).sheets : raw;
      const parsed = sheetsConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid Google Sheets settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "sheets", sheets: parsed.data };
    }
    case "onedrive-excel": {
      const hasWrapper = raw !== null && typeof raw === "object" && "onedriveExcel" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { onedriveExcel: unknown }).onedriveExcel : raw;
      const parsed = onedriveExcelConfigSchema
        .refine((c) => c.source !== "sharepoint" || c.siteHost.trim() !== "", {
          message: "SharePoint mode requires the site host (e.g. contoso.sharepoint.com).",
          path: ["siteHost"],
        })
        .safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid OneDrive/SharePoint Excel settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "onedrive-excel", onedriveExcel: parsed.data };
    }
    case "tds-challan": {
      const hasWrapper = raw !== null && typeof raw === "object" && "tdsChallan" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { tdsChallan: unknown }).tdsChallan : raw;
      const parsed = tdsChallanConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid TDS challan settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "tds-challan", tdsChallan: parsed.data };
    }
    case "payroll-export": {
      const hasWrapper = raw !== null && typeof raw === "object" && "payrollExport" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { payrollExport: unknown }).payrollExport : raw;
      const parsed = payrollExportConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid payroll export settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "payroll-export", payrollExport: parsed.data };
    }
    case "ims-einvoice": {
      const hasWrapper = raw !== null && typeof raw === "object" && "imsEinvoice" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { imsEinvoice: unknown }).imsEinvoice : raw;
      const parsed = imsEinvoiceConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid IMS/e-invoice settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "ims-einvoice", imsEinvoice: parsed.data };
    }
    case "razorpay": {
      const hasWrapper = raw !== null && typeof raw === "object" && "razorpay" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { razorpay: unknown }).razorpay : raw;
      const parsed = razorpayConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid Razorpay settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "razorpay", razorpay: parsed.data };
    }
    case "payu": {
      const hasWrapper = raw !== null && typeof raw === "object" && "payu" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { payu: unknown }).payu : raw;
      const parsed = payuConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid PayU settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "payu", payu: parsed.data };
    }
    case "busy": {
      const hasWrapper = raw !== null && typeof raw === "object" && "busy" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { busy: unknown }).busy : raw;
      const parsed = busyAccountingConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid Busy accounting settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "busy", busy: parsed.data };
    }
    case "marg": {
      const hasWrapper = raw !== null && typeof raw === "object" && "marg" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { marg: unknown }).marg : raw;
      const parsed = margConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid Marg ERP settings: ${field} ${first?.message ?? "is missing"}. How to fix: review the highlighted field and save again.`,
        );
      }
      return { kind: "marg", marg: parsed.data };
    }
    case "xero": {
      const hasWrapper = raw !== null && typeof raw === "object" && "xero" in (raw as Record<string, unknown>);
      const candidate = hasWrapper ? (raw as { xero: unknown }).xero : raw;
      const parsed = xeroConfigSchema.safeParse(candidate ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const field = first?.path.join(".") || "one of the fields";
        throw new ConnectorError(
          `Invalid Xero settings: ${field} ${first?.message ?? "is missing"}. How to fix: check the client id, secret, refresh token and tenant id from your Xero app, then save again.`,
        );
      }
      return { kind: "xero", xero: parsed.data };
    }
    default:
      throw new ConnectorError(`The ${kind} connector is not implemented.`);
  }
}

/** Re-validate a decrypted config blob (guards against tampering/corruption). */
export function parseStoredConfig(kind: string, value: unknown): ConnectorConfig {
  return validateConnectorConfigImpl(kind, value);
}
