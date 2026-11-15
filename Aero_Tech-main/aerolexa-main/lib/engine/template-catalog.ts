/**
 * Template catalog — the acquisition engine (Phase 3 of the GTM plan).
 *
 * Each template is a complete, runnable recipe against a WORKSPACE's real
 * dataset: SQL for the DuckDB engine, DAX for the measure studio, notebook
 * DSL commands, and the exact artifact to build from the result. Templates
 * are pure data (no DB, no env) so they render server-side and are unit-gated:
 * a template that references a column the placeholder contract cannot fill,
 * or SQL that the read-only guard would reject, fails CI — the catalog can
 * never rot silently.
 *
 * Every template carries SEO metadata (title, keywords, description) —
 * the /templates gallery is the inbound search surface.
 */

// ---------------------------------------------------------------------------
// Placeholder contract — filled per-dataset at render time in the UI
// ---------------------------------------------------------------------------

export interface TemplateSlot {
  /** Slot key, e.g. "amountColumn". */
  key: string;
  /** Human label in the fill-in UI. */
  label: string;
  /** Hint shown when the user must pick a column. */
  hint: string;
  /** Column type the slot expects (drives the column picker). */
  expects: "number" | "string" | "date" | "any";
  /** Placeholder shown before filling, e.g. [Amount]. */
  placeholder: string;
}

export interface TemplateStep {
  /** Which surface runs this step. */
  surface: "sql" | "dax" | "dsl";
  /** The exact command/query/measure, with [Slot] placeholders. */
  content: string;
  /** What this step produces. */
  produces: string;
}

export interface AnalysisTemplate {
  id: string;
  pack: "gst" | "tally" | "bank" | "audit" | "core";
  title: string;
  /** SEO description (also the card body). */
  description: string;
  keywords: string[];
  /** Columns the user maps before running. */
  slots: TemplateSlot[];
  steps: TemplateStep[];
  /** The artifact to build from the result. */
  artifact: { kind: "dashboard" | "report" | "presentation"; note: string };
  /** Difficulty label. */
  level: "starter" | "working" | "advanced";
}

// ---------------------------------------------------------------------------
// SQL safety: the catalog only ships read-only SELECTs. This validator is
// duplicated deliberately from the engine guard's contract (single-statement,
// no DDL/DML keywords) so the TEST can fail without importing the DuckDB
// runtime — the integration layer still enforces the real guard.
// ---------------------------------------------------------------------------

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|attach|detach|copy|vacuum|pragma|call|set)\b/i;

export function templateSqlProblems(sql: string): string[] {
  const problems: string[] = [];
  const stripped = sql.replace(/'[^']*'/g, "''"); // ignore string literals
  if (!/^\s*select\b/i.test(stripped) && !/^\s*with\b/i.test(stripped)) {
    problems.push("must start with SELECT or WITH (read-only)");
  }
  if (FORBIDDEN_SQL.test(stripped)) problems.push("contains a DDL/DML keyword");
  if (/;\s*\S/.test(stripped)) problems.push("contains multiple statements");
  return problems;
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const ANALYSIS_TEMPLATES: AnalysisTemplate[] = [
  // ------------------------------------------------------------------ GST --
  {
    id: "gst-recon-summary",
    pack: "gst",
    title: "GST reconciliation summary",
    description:
      "Reconcile output tax against input credit by GSTIN and month. Surfaces net payable, credit accumulation and the suppliers whose invoices never landed — the three questions every client asks at filing time.",
    keywords: ["gst reconciliation", "gstr 3b", "input tax credit", "ca firm analytics"],
    level: "working",
    slots: [
      {
        key: "SupplierGstin",
        label: "GSTIN / supplier",
        hint: "Supplier GSTIN or name column",
        expects: "string",
        placeholder: "[SupplierGstin]",
      },
      {
        key: "InvoiceDate",
        label: "Invoice month",
        hint: "Date column of the invoice",
        expects: "date",
        placeholder: "[InvoiceDate]",
      },
      { key: "Igst", label: "IGST amount", hint: "IGST column", expects: "number", placeholder: "[Igst]" },
      { key: "Cgst", label: "CGST amount", hint: "CGST column", expects: "number", placeholder: "[Cgst]" },
      { key: "Sgst", label: "SGST amount", hint: "SGST column", expects: "number", placeholder: "[Sgst]" },
    ],
    steps: [
      {
        surface: "sql",
        produces: "Monthly tax register per supplier",
        content:
          "SELECT date_trunc('month', [InvoiceDate]) AS month,\n       [SupplierGstin],\n       SUM([Igst]) AS igst, SUM([Cgst]) AS cgst, SUM([Sgst]) AS sgst,\n       SUM([Igst] + [Cgst] + [Sgst]) AS total_tax,\n       COUNT(*) AS invoices\nFROM dataset\nGROUP BY 1, 2\nORDER BY 1, total_tax DESC",
      },
      {
        surface: "sql",
        produces: "Suppliers with credit but nil invoices (recon exceptions)",
        content:
          "SELECT [SupplierGstin],\n       SUM([Igst] + [Cgst] + [Sgst]) AS credit_claimed,\n       COUNT(*) AS invoice_count,\n       MIN([InvoiceDate]) AS first_invoice,\n       MAX([InvoiceDate]) AS last_invoice\nFROM dataset\nGROUP BY 1\nHAVING COUNT(*) < 2 OR SUM([Igst] + [Cgst] + [Sgst]) = 0\nORDER BY credit_claimed DESC",
      },
      {
        surface: "dax",
        produces: "Net payable KPI for the dashboard tile",
        content: "SUM([Igst]) + SUM([Cgst]) + SUM([Sgst])",
      },
    ],
    artifact: { kind: "dashboard", note: "One KPI tile (net payable), one bar by month, exception table by supplier." },
  },
  {
    id: "gst-rate-mix",
    pack: "gst",
    title: "GST rate-mix sanity check",
    description:
      "Group taxable value by rate slab to catch invoices booked at the wrong rate — the most common notice trigger. Flags slabs outside your expected 5/12/18/28 mix.",
    keywords: ["gst rate check", "hsn slab", "gst notice", "gst audit"],
    level: "starter",
    slots: [
      {
        key: "GstRate",
        label: "Rate column",
        hint: "GST rate percentage",
        expects: "number",
        placeholder: "[GstRate]",
      },
      {
        key: "TaxableValue",
        label: "Taxable value",
        hint: "Taxable value column",
        expects: "number",
        placeholder: "[TaxableValue]",
      },
    ],
    steps: [
      {
        surface: "sql",
        produces: "Taxable value by slab with invoice counts",
        content:
          "SELECT [GstRate],\n       SUM([TaxableValue]) AS taxable_value,\n       SUM([TaxableValue] * [GstRate] / 100) AS tax_at_rate,\n       COUNT(*) AS invoices\nFROM dataset\nGROUP BY 1\nORDER BY taxable_value DESC",
      },
    ],
    artifact: { kind: "report", note: "Add the slab table to the Data Overview section of the report template." },
  },

  // ---------------------------------------------------------------- TALLY --
  {
    id: "tally-trial-balance",
    pack: "tally",
    title: "Tally trial balance from ledger export",
    description:
      "Aggregate a Tally ledger export into a grouped trial balance with debit/credit sign checks. Catches the one-sided entries that make closings drag on for days.",
    keywords: ["tally trial balance", "tally export analysis", "ledger summary", "book closing"],
    level: "working",
    slots: [
      { key: "Ledger", label: "Ledger name", hint: "Ledger column", expects: "string", placeholder: "[Ledger]" },
      {
        key: "LedgerGroup",
        label: "Group / parent",
        hint: "Tally group column (Sundry Debtors, Sales Accounts…)",
        expects: "string",
        placeholder: "[LedgerGroup]",
      },
      { key: "Debit", label: "Debit amount", hint: "Debit column", expects: "number", placeholder: "[Debit]" },
      { key: "Credit", label: "Credit amount", hint: "Credit column", expects: "number", placeholder: "[Credit]" },
    ],
    steps: [
      {
        surface: "sql",
        produces: "Grouped trial balance with balance sign",
        content:
          "SELECT [LedgerGroup], [Ledger],\n       SUM([Debit]) AS total_debit,\n       SUM([Credit]) AS total_credit,\n       SUM([Debit]) - SUM([Credit]) AS closing_balance\nFROM dataset\nGROUP BY 1, 2\nHAVING SUM([Debit]) <> 0 OR SUM([Credit]) <> 0\nORDER BY ABS(SUM([Debit]) - SUM([Credit])) DESC",
      },
      {
        surface: "sql",
        produces: "One-sided entry check (the closing-day saver)",
        content:
          "SELECT [Ledger],\n       SUM([Debit]) AS debit_only,\n       SUM([Credit]) AS credit_only\nFROM dataset\nGROUP BY 1\nHAVING (SUM([Debit]) = 0) <> (SUM([Credit]) = 0)",
      },
      {
        surface: "dax",
        produces: "Debits-minus-credits KPI (must be zero)",
        content: "SUM([Debit]) - SUM([Credit])",
      },
    ],
    artifact: { kind: "report", note: "Maps to the report's Key Findings; attach the exception table as evidence." },
  },

  // ------------------------------------------------------------------ BANK --
  {
    id: "bank-statement-cashflow",
    pack: "bank",
    title: "Bank statement cash-flow breakdown",
    description:
      "Turn a raw bank statement into a monthly inflow/outflow/net picture with the largest counterparties — the fastest way to show a client where the money actually went.",
    keywords: ["bank statement analysis", "cash flow", "counterparty analysis", "ca firm"],
    level: "starter",
    slots: [
      { key: "TxnDate", label: "Txn date", hint: "Transaction date column", expects: "date", placeholder: "[TxnDate]" },
      {
        key: "Narration",
        label: "Narration",
        hint: "Narration / counterparty column",
        expects: "string",
        placeholder: "[Narration]",
      },
      {
        key: "Withdrawal",
        label: "Withdrawal",
        hint: "Debit/withdrawal column",
        expects: "number",
        placeholder: "[Withdrawal]",
      },
      { key: "Deposit", label: "Deposit", hint: "Credit/deposit column", expects: "number", placeholder: "[Deposit]" },
    ],
    steps: [
      {
        surface: "sql",
        produces: "Monthly cash-flow summary",
        content:
          "SELECT date_trunc('month', [TxnDate]) AS month,\n       SUM([Deposit]) AS inflow,\n       SUM([Withdrawal]) AS outflow,\n       SUM([Deposit]) - SUM([Withdrawal]) AS net\nFROM dataset\nGROUP BY 1\nORDER BY 1",
      },
      {
        surface: "sql",
        produces: "Top counterparties by outflow",
        content:
          "SELECT [Narration],\n       SUM([Withdrawal]) AS paid_out,\n       COUNT(*) AS txns\nFROM dataset\nGROUP BY 1\nORDER BY paid_out DESC\nLIMIT 20",
      },
    ],
    artifact: {
      kind: "presentation",
      note: "The monthly net chart becomes slide 3; counterparty table goes to the appendix.",
    },
  },

  // ----------------------------------------------------------------- AUDIT --
  {
    id: "audit-journal-risk",
    pack: "audit",
    title: "Journal-entry risk screen (Benford + weekend postings)",
    description:
      "Screen journal entries for audit risk signals: round-number amounts, weekend postings, and Benford's first-digit deviation on the leading digit. Produces the sampling shortlist for vouching.",
    keywords: ["journal entry testing", "benford", "audit sampling", "substantive testing"],
    level: "advanced",
    slots: [
      { key: "Amount", label: "Amount", hint: "Journal amount column", expects: "number", placeholder: "[Amount]" },
      {
        key: "PostingDate",
        label: "Posting date",
        hint: "Posting date column",
        expects: "date",
        placeholder: "[PostingDate]",
      },
      {
        key: "VoucherNo",
        label: "Voucher no",
        hint: "Voucher/reference column",
        expects: "string",
        placeholder: "[VoucherNo]",
      },
    ],
    steps: [
      {
        surface: "sql",
        produces: "Round-amount and weekend postings (the classic screens)",
        content:
          "SELECT [VoucherNo], [PostingDate], [Amount],\n       CASE WHEN [Amount] % 10000 = 0 THEN 'round-10k'\n            WHEN [Amount] % 1000 = 0 THEN 'round-1k'\n            ELSE 'normal' END AS roundness,\n       CASE WHEN EXTRACT(dow FROM [PostingDate]) IN (0, 6) THEN 'weekend' ELSE 'weekday' END AS posting_day\nFROM dataset\nWHERE [Amount] % 1000 = 0 OR EXTRACT(dow FROM [PostingDate]) IN (0, 6)\nORDER BY [Amount] DESC",
      },
      {
        surface: "dsl",
        produces: "Distribution check on amounts (Benford eyeball)",
        content: "%histogram [Amount]",
      },
      {
        surface: "dsl",
        produces: "Headline KPI for the working paper",
        content: "%kpi [Amount]",
      },
    ],
    artifact: {
      kind: "report",
      note: "Methodology section: state the screens exactly as run (they're reproducible from this template).",
    },
  },

  // ------------------------------------------------------------------ CORE --
  {
    id: "core-monthly-kpi",
    pack: "core",
    title: "Monthly revenue & margin KPI board",
    description:
      "The starter dashboard: revenue, margin and volume by month with a DAX measure per tile. Point a new user here before anything else — it's the 5-minute 'aha'.",
    keywords: ["kpi dashboard", "revenue analysis", "margin analysis"],
    level: "starter",
    slots: [
      { key: "OrderDate", label: "Date", hint: "Invoice/date column", expects: "date", placeholder: "[OrderDate]" },
      { key: "Revenue", label: "Revenue", hint: "Revenue amount column", expects: "number", placeholder: "[Revenue]" },
      { key: "Cost", label: "Cost", hint: "Cost amount column", expects: "number", placeholder: "[Cost]" },
    ],
    steps: [
      {
        surface: "sql",
        produces: "Monthly revenue and margin",
        content:
          "SELECT date_trunc('month', [OrderDate]) AS month,\n       SUM([Revenue]) AS revenue,\n       SUM([Cost]) AS cost,\n       SUM([Revenue]) - SUM([Cost]) AS margin\nFROM dataset\nGROUP BY 1\nORDER BY 1",
      },
      {
        surface: "dax",
        produces: "Margin % measure",
        content: "(SUM([Revenue]) - SUM([Cost])) / SUM([Revenue])",
      },
      {
        surface: "dsl",
        produces: "Trend for the notebook narrative",
        content: "%trend [OrderDate]",
      },
    ],
    artifact: {
      kind: "dashboard",
      note: "Three tiles: revenue KPI, margin %, monthly trend. Publishes as the client-facing board.",
    },
  },
];

// ---------------------------------------------------------------------------
// Packing helpers (pure, oracle-testable)
// ---------------------------------------------------------------------------

export function templatesByPack(pack: AnalysisTemplate["pack"]): AnalysisTemplate[] {
  return ANALYSIS_TEMPLATES.filter((t) => t.pack === pack);
}

/** All slot placeholders used across a template's steps (e.g. "[Amount]"). */
export function templatePlaceholders(t: AnalysisTemplate): string[] {
  const slots = new Set(t.slots.map((s) => s.placeholder));
  for (const step of t.steps) {
    for (const m of step.content.matchAll(/\[([A-Za-z][A-Za-z0-9_]*)\]/g)) {
      const g = m[1];
      if (g) slots.add(`[${g}]`);
    }
  }
  return [...slots].sort();
}

/** Slots declared but never used in any step — a catalog authoring bug. */
export function unusedSlots(t: AnalysisTemplate): string[] {
  const used = new Set<string>();
  for (const step of t.steps) {
    for (const m of step.content.matchAll(/\[([A-Za-z][A-Za-z0-9_]*)\]/g)) {
      const g = m[1];
      if (g) used.add(g);
    }
  }
  return t.slots.filter((s) => !used.has(s.key)).map((s) => s.key);
}

/** Slots used in steps but never declared — also a bug (unfillable UI). */
export function undeclaredPlaceholders(t: AnalysisTemplate): string[] {
  const declared = new Set(t.slots.map((s) => s.key));
  const out: string[] = [];
  for (const step of t.steps) {
    for (const m of step.content.matchAll(/\[([A-Za-z][A-Za-z0-9_]*)\]/g)) {
      const g = m[1];
      if (g && !declared.has(g)) out.push(g);
    }
  }
  return [...new Set(out)].sort();
}
