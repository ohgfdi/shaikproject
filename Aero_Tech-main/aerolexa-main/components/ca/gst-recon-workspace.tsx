"use client";

import { AlertTriangle, Play, RotateCcw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/form";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";

/**
 * GST reconciliation workspace.
 *
 * Contract: POST /api/gst/itc-recon. The engine decides every verdict; this
 * component only parses the caller's CSV, validates it enough to give a useful
 * message, and renders the response verbatim. It never computes a tax figure.
 *
 * Confidentiality: inputs are NOT persisted (no localStorage, no server row).
 * A refresh clears the form, which is the correct default for client tax data.
 */

const TWO_B_COLUMNS = [
  "gstin",
  "supplierName",
  "invoiceNumber",
  "invoiceDate",
  "taxableValue",
  "igst",
  "cgst",
  "sgst",
  "placeOfSupply",
  "supplierFiledGstr1",
] as const;

const BOOKS_COLUMNS = [
  "gstin",
  "invoiceNumber",
  "invoiceDate",
  "taxableValue",
  "igst",
  "cgst",
  "sgst",
  "placeOfSupply",
  "blockedCategory",
] as const;

const EXAMPLE_2B = `gstin,supplierName,invoiceNumber,invoiceDate,taxableValue,igst,cgst,sgst,placeOfSupply,supplierFiledGstr1
27AAPFU0939F1ZV,Alpha Traders,INV-001,2026-09-01,1000,180,0,0,27,true
29AABCU9603R1ZM,Beta Supplies,INV-002,2026-09-05,2000,0,180,180,29,true
27AAACR5055K1Z1,Gamma Services,INV-003,2026-09-10,500,90,0,0,27,true
27AACCM1234A1Z5,Delta Motors,INV-005,2026-09-15,1000,180,0,0,27,true`;

const EXAMPLE_BOOKS = `gstin,invoiceNumber,invoiceDate,taxableValue,igst,cgst,sgst,placeOfSupply,blockedCategory
27AAPFU0939F1ZV,INV-001,2026-09-01,1000,180,0,0,27,
29AABCU9603R1ZM,INV-002,2026-09-05,2000,0,180,180,29,
27AACCM1234A1Z5,INV-005,2026-09-15,1000,90,0,0,27,
24AAACC1206D1ZM,INV-004,2026-09-12,800,144,0,0,24,`;

interface TaxAmounts {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

interface ReconInvoice {
  key: string;
  gstin: string;
  supplierName: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  verdict: string;
  taxDifference: number;
  blockedLabel: string | null;
  reasons: string[];
}

interface Reconciliation {
  counts: Record<string, number>;
  table4: {
    itcAvailed: TaxAmounts;
    itcAvailedRcm: TaxAmounts;
    itcReversed: TaxAmounts;
    netItc: TaxAmounts;
    rule364Excess: number;
    pending2b: TaxAmounts;
  };
  invoices: ReconInvoice[];
  warnings: string[];
  methodology: string[];
}

const VERDICT_LABEL: Record<string, string> = {
  "matched-eligible": "Matched — eligible",
  "matched-eligible-rcm": "Matched — reverse charge",
  "matched-blocked": "Matched — blocked s17(5)",
  "matched-rule37": "Matched — rule 37 exposure",
  "matched-expired-s16": "Matched — s16(4) expired",
  "amount-mismatch": "Amount mismatch",
  "in-2b-only": "In 2B only",
  "in-books-only": "In books only",
};

const VERDICT_TONE: Record<string, "success" | "warning" | "critical" | "info" | "default"> = {
  "matched-eligible": "success",
  "matched-eligible-rcm": "info",
  "matched-blocked": "warning",
  "matched-rule37": "warning",
  "matched-expired-s16": "critical",
  "amount-mismatch": "critical",
  "in-2b-only": "warning",
  "in-books-only": "critical",
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      out.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current.trim());
  return out;
}

function parseCsv(text: string, side: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error(`${side}: add a header row and at least one data row.`);
  const headers = splitCsvLine(lines[0]!).map((header) => header.trim());
  return lines.slice(1).map((line, index) => {
    const cells = splitCsvLine(line);
    if (cells.length !== headers.length) {
      throw new Error(`${side}: row ${index + 2} has ${cells.length} cells but the header has ${headers.length}.`);
    }
    return Object.fromEntries(headers.map((header, cell) => [header, cells[cell] ?? ""]));
  });
}

function requireNumber(row: Record<string, string>, key: string, rowNumber: number, side: string): number {
  const raw = row[key];
  if (raw === undefined || raw === "") throw new Error(`${side}: row ${rowNumber} is missing "${key}".`);
  const value = Number(raw.replace(/[₹,\s]/g, ""));
  if (!Number.isFinite(value)) throw new Error(`${side}: row ${rowNumber} has a non-numeric "${key}" (${raw}).`);
  return value;
}

function optionalNumber(row: Record<string, string>, key: string, rowNumber: number, side: string): number {
  if (!row[key]) return 0;
  return requireNumber(row, key, rowNumber, side);
}

function requireText(row: Record<string, string>, key: string, rowNumber: number, side: string): string {
  const value = (row[key] ?? "").trim();
  if (!value) throw new Error(`${side}: row ${rowNumber} is missing "${key}".`);
  return value;
}

function optionalFlag(row: Record<string, string>, key: string): boolean | undefined {
  if (!row[key]) return undefined;
  return row[key]!.trim().toLowerCase() === "true";
}

function buildTwoB(rows: Record<string, string>[]) {
  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const gstin = requireText(row, "gstin", rowNumber, "GSTR-2B");
    if (gstin.length !== 15) throw new Error(`GSTR-2B: row ${rowNumber} GSTIN must be 15 characters.`);
    const invoiceDate = requireText(row, "invoiceDate", rowNumber, "GSTR-2B");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
      throw new Error(`GSTR-2B: row ${rowNumber} invoiceDate must be yyyy-mm-dd.`);
    }
    return {
      gstin,
      supplierName: row.supplierName?.trim() || undefined,
      invoiceNumber: requireText(row, "invoiceNumber", rowNumber, "GSTR-2B"),
      invoiceDate,
      taxableValue: requireNumber(row, "taxableValue", rowNumber, "GSTR-2B"),
      igst: requireNumber(row, "igst", rowNumber, "GSTR-2B"),
      cgst: requireNumber(row, "cgst", rowNumber, "GSTR-2B"),
      sgst: requireNumber(row, "sgst", rowNumber, "GSTR-2B"),
      placeOfSupply: requireText(row, "placeOfSupply", rowNumber, "GSTR-2B"),
      supplierFiledGstr1: optionalFlag(row, "supplierFiledGstr1"),
    };
  });
}

function buildPurchases(rows: Record<string, string>[]) {
  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const gstin = requireText(row, "gstin", rowNumber, "Purchase register");
    if (gstin.length !== 15) throw new Error(`Purchase register: row ${rowNumber} GSTIN must be 15 characters.`);
    const invoiceDate = requireText(row, "invoiceDate", rowNumber, "Purchase register");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
      throw new Error(`Purchase register: row ${rowNumber} invoiceDate must be yyyy-mm-dd.`);
    }
    return {
      gstin,
      invoiceNumber: requireText(row, "invoiceNumber", rowNumber, "Purchase register"),
      invoiceDate,
      taxableValue: requireNumber(row, "taxableValue", rowNumber, "Purchase register"),
      igst: requireNumber(row, "igst", rowNumber, "Purchase register"),
      cgst: optionalNumber(row, "cgst", rowNumber, "Purchase register"),
      sgst: optionalNumber(row, "sgst", rowNumber, "Purchase register"),
      placeOfSupply: requireText(row, "placeOfSupply", rowNumber, "Purchase register"),
      blockedCategory: row.blockedCategory?.trim() || undefined,
    };
  });
}

function formatPaise(paise: number): string {
  return (paise / 100).toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function GstReconWorkspace() {
  const [twoBText, setTwoBText] = useState("");
  const [booksText, setBooksText] = useState("");
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [tolerance, setTolerance] = useState("1");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Reconciliation | null>(null);

  const runReconciliation = async () => {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      if (!twoBText.trim() || !booksText.trim()) {
        throw new Error("Both sides are required: paste the GSTR-2B rows and the purchase register rows.");
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error("As-of date must be yyyy-mm-dd.");
      const toleranceValue = Number(tolerance);
      if (!Number.isFinite(toleranceValue) || toleranceValue < 0) {
        throw new Error("Tolerance must be a number of rupees (0 or more).");
      }
      const twoB = buildTwoB(parseCsv(twoBText, "GSTR-2B"));
      const purchases = buildPurchases(parseCsv(booksText, "Purchase register"));
      const data = await api<{ reconciliation: Reconciliation }>("/api/gst/itc-recon", {
        method: "POST",
        body: JSON.stringify({ asOfDate, tolerance: toleranceValue, twoB, purchases }),
      });
      setResult(data.reconciliation);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setTwoBText("");
    setBooksText("");
    setResult(null);
    setError(null);
  };

  const loadExample = () => {
    setTwoBText(EXAMPLE_2B);
    setBooksText(EXAMPLE_BOOKS);
    setResult(null);
    setError(null);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-h3 text-foreground">Reconcile a period</h2>
              <p className="mt-1 max-w-3xl text-sm text-muted">
                Paste both sides as CSV. The engine matches on GSTIN + document number + document type, applies
                s16(2)(aa), s17(5), s16(4), rule 36(4) and rule 37, and returns the Table 4 figure. Amounts are in
                rupees.
              </p>
            </div>
            <Button type="button" variant="secondary" onClick={loadExample}>
              Load labelled example (5 test rows)
            </Button>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Textarea
              id="gst-2b-csv"
              label="GSTR-2B rows"
              helper={`Required columns: ${TWO_B_COLUMNS.join(", ")}. docType/cess are optional.`}
              value={twoBText}
              onChange={(event) => setTwoBText(event.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={
                "gstin,supplierName,invoiceNumber,invoiceDate,taxableValue,igst,cgst,sgst,placeOfSupply,supplierFiledGstr1\n27AAPFU0939F1ZV,Alpha Traders,INV-001,2026-09-01,1000,180,0,0,27,true"
              }
              className="font-mono text-caption"
            />
            <Textarea
              id="gst-books-csv"
              label="Purchase register rows"
              helper={`Required columns: ${BOOKS_COLUMNS.join(", ")}. docType/cess/reverseCharge are optional; blockedCategory must be an s17(5) key.`}
              value={booksText}
              onChange={(event) => setBooksText(event.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={
                "gstin,invoiceNumber,invoiceDate,taxableValue,igst,cgst,sgst,placeOfSupply,blockedCategory\n27AAPFU0939F1ZV,INV-001,2026-09-01,1000,180,0,0,27,"
              }
              className="font-mono text-caption"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-md">
            <Input
              id="gst-as-of"
              label="As-of date"
              type="date"
              value={asOfDate}
              onChange={(event) => setAsOfDate(event.target.value)}
              helper="Used for the s16(4) time limit."
            />
            <Input
              id="gst-tolerance"
              label="Tolerance (₹)"
              type="number"
              min={0}
              step="0.01"
              value={tolerance}
              onChange={(event) => setTolerance(event.target.value)}
              helper="Tax difference treated as a match."
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              loading={loading}
              onClick={() => void runReconciliation()}
              icon={<Play aria-hidden className="size-4" />}
            >
              Reconcile
            </Button>
            <Button type="button" variant="ghost" onClick={reset} icon={<RotateCcw aria-hidden className="size-4" />}>
              Clear
            </Button>
            <span className="text-caption text-muted">Compute only — inputs are not saved anywhere.</span>
          </div>

          <div aria-live="polite" role="status">
            {error && (
              <p className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-foreground">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
                <span>{error}</span>
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {result && <ReconciliationResult result={result} />}
    </div>
  );
}

function ReconciliationResult({ result }: { result: Reconciliation }) {
  const counts = result.counts;
  const matchedEligible = counts["matched-eligible"] ?? 0;
  const mismatch = counts["amount-mismatch"] ?? 0;
  const twoBOnly = counts["in-2b-only"] ?? 0;
  const booksOnly = counts["in-books-only"] ?? 0;
  const exceptions = result.invoices.filter(
    (invoice) => invoice.verdict !== "matched-eligible" && invoice.verdict !== "matched-eligible-rcm",
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Matched & eligible" value={matchedEligible} tone="success" />
        <SummaryCard label="Amount mismatch" value={mismatch} tone={mismatch > 0 ? "critical" : "default"} />
        <SummaryCard label="In 2B only" value={twoBOnly} tone={twoBOnly > 0 ? "warning" : "default"} />
        <SummaryCard label="In books only" value={booksOnly} tone={booksOnly > 0 ? "critical" : "default"} />
      </div>

      <Card>
        <CardContent>
          <h2 className="text-h3 text-foreground">GSTR-3B Table 4</h2>
          <p className="mt-1 text-caption text-muted">
            Derived by the engine from this reconciliation. Net = availed (including RCM) − reversed.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <caption className="sr-only">GSTR-3B Table 4 ITC by tax head</caption>
              <thead>
                <tr className="border-b border-line text-left text-caption uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Line
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    IGST
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    CGST
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    SGST
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Cess
                  </th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                <TableRow label="4(A) ITC availed" amounts={result.table4.itcAvailed} />
                <TableRow label="4(A)(3) RCM ITC" amounts={result.table4.itcAvailedRcm} />
                <TableRow label="4(B)(1) reversed" amounts={result.table4.itcReversed} />
                <TableRow label="4(C) net ITC" amounts={result.table4.netItc} strong />
              </tbody>
            </table>
          </div>
          <dl className="mt-4 grid gap-2 text-caption sm:grid-cols-2">
            <div>
              <dt className="text-muted">Rule 36(4) excess reversed</dt>
              <dd className="text-foreground">{formatPaise(result.table4.rule364Excess)}</dd>
            </div>
            <div>
              <dt className="text-muted">ITC held back — books only (s16(2)(aa))</dt>
              <dd className="text-foreground">
                {formatPaise(
                  result.table4.pending2b.igst +
                    result.table4.pending2b.cgst +
                    result.table4.pending2b.sgst +
                    result.table4.pending2b.cess,
                )}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="text-h3 text-foreground">Exceptions ({exceptions.length})</h2>
          {exceptions.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Every invoice matched and is eligible. Nothing needs review.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {exceptions.map((invoice) => (
                <li key={invoice.key} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {invoice.invoiceNumber} · {invoice.supplierName ?? invoice.gstin}
                    </p>
                    <p className="text-caption text-muted">
                      {invoice.invoiceDate} · {invoice.gstin}
                      {invoice.taxDifference > 0 ? ` · tax difference ${formatPaise(invoice.taxDifference)}` : ""}
                    </p>
                    <p className="mt-1 text-caption text-muted">{invoice.reasons.join(" ")}</p>
                  </div>
                  <Badge variant={VERDICT_TONE[invoice.verdict] ?? "default"} className="shrink-0">
                    {VERDICT_LABEL[invoice.verdict] ?? invoice.verdict}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="text-h3 text-foreground">All verdicts</h2>
          <ul className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
            {Object.entries(result.counts).map(([verdict, count]) => (
              <li key={verdict} className="flex items-center justify-between gap-3 border-b border-line/60 py-1.5">
                <span className="text-muted">{VERDICT_LABEL[verdict] ?? verdict}</span>
                <span className="font-medium text-foreground">{count}</span>
              </li>
            ))}
          </ul>
          {result.warnings.length > 0 && (
            <div className="mt-4 rounded-md border border-amber/40 bg-amber/10 px-3 py-2">
              <h3 className="text-sm font-medium text-foreground">Warnings</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-caption text-muted">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-muted hover:text-foreground">Methodology</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-caption text-muted">
              {result.methodology.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "critical" | "default";
}) {
  return (
    <Card>
      <CardContent>
        <p className="text-caption text-muted">{label}</p>
        <p
          className={cn(
            "mt-1 text-h2 font-semibold",
            tone === "success" && "text-[#7ED096]",
            tone === "warning" && "text-[#F5A878]",
            tone === "critical" && "text-[#F08A9B]",
            tone === "default" && "text-foreground",
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function TableRow({ label, amounts, strong }: { label: string; amounts: TaxAmounts; strong?: boolean }) {
  return (
    <tr className="border-b border-line/60">
      <th
        scope="row"
        className={cn("py-2 pr-4 text-left font-normal text-muted", strong && "font-medium text-foreground")}
      >
        {label}
      </th>
      <td className="py-2 pr-4 text-right">{formatPaise(amounts.igst)}</td>
      <td className="py-2 pr-4 text-right">{formatPaise(amounts.cgst)}</td>
      <td className="py-2 pr-4 text-right">{formatPaise(amounts.sgst)}</td>
      <td className="py-2 text-right">{formatPaise(amounts.cess)}</td>
    </tr>
  );
}
