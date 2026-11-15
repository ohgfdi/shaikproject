"use client";

import { AlertTriangle, Play, RotateCcw, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, CardContent, type BadgeVariant } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { TdsReconciliation, TdsVerdict } from "@/lib/engine/tds-credit-recon";

/**
 * 26AS / AIS credit reconciliation workspace.
 *
 * Contract: POST /api/ca/tds-credit-recon. The engine parses both exports and
 * decides every verdict; this component only supplies the text and renders the
 * response. Nothing is persisted — client tax data stays in this tab.
 */

const SAMPLE_STATEMENT = `TAN,Deductor Name,Section,Financial Year,Quarter,Date,Amount Paid,TDS Deducted,TDS Deposited
ABCD12345E,"Alpha Traders Pvt Ltd",194C,2026-27,Q1,15/07/2026,"1,00,000","1,000","1,000"
WXYZ98765Q,Beta Logistics LLP,194C,2026-27,Q2,12/10/2026,"2,00,000","2,000","2,000"
PQRS45678T,Gamma Estates,194I,2026-27,Q2,05/09/2026,"5,00,000","5,000","5,000"`;

const SAMPLE_BOOKS = `TAN,Section,Quarter,Date,Amount Paid,TDS Deducted
ABCD12345E,194C,Q1,2026-07-15,"1,00,000","1,000"
WXYZ98765Q,194C,Q2,2026-10-12,"2,00,000","1,800"
LMNO11223Z,194J,Q2,2026-09-20,"50,000","500"`;

const VERDICT_VARIANT: Record<TdsVerdict, BadgeVariant> = {
  matched: "success",
  "amount-mismatch": "warning",
  "missing-in-books": "info",
  "missing-in-statement": "critical",
  "duplicate-statement": "outline",
  "duplicate-books": "outline",
};

const VERDICT_LABEL: Record<TdsVerdict, string> = {
  matched: "Matched",
  "amount-mismatch": "Amount mismatch",
  "missing-in-books": "Not in books",
  "missing-in-statement": "Not in 26AS",
  "duplicate-statement": "Duplicate statement",
  "duplicate-books": "Duplicate books",
};

interface ReconResponse {
  reconciliation: TdsReconciliation;
  statement: { count: number; warnings: string[] };
  books: { count: number; warnings: string[] };
}

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function money(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "—";
  return `₹${inr.format(paise / 100)}`;
}

export function TdsCreditWorkspace() {
  const [statementText, setStatementText] = useState("");
  const [booksText, setBooksText] = useState("");
  const [source, setSource] = useState("26AS");
  const [tolerance, setTolerance] = useState("1");
  const [result, setResult] = useState<ReconResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await api<ReconResponse>("/api/ca/tds-credit-recon", {
        method: "POST",
        body: JSON.stringify({
          statementText,
          booksText,
          statementSource: source,
          tolerance: Number(tolerance) || 0,
        }),
      });
      setResult(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStatementText("");
    setBooksText("");
    setResult(null);
    setError(null);
  }

  const recon = result?.reconciliation;

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={run} className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">Portal statement (26AS / AIS)</h2>
              <Field label="Source" className="w-32">
                <Select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  options={[
                    { value: "26AS", label: "26AS" },
                    { value: "AIS", label: "AIS" },
                    { value: "TRACES", label: "TRACES" },
                  ]}
                />
              </Field>
            </div>
            <Field
              label="Statement export"
              helper="CSV with a TAN and TDS column, or a JSON export (TRACES deductors/entries and AIS shapes are recognised)."
            >
              <Textarea
                value={statementText}
                onChange={(e) => setStatementText(e.target.value)}
                placeholder="Paste the 26AS/AIS export here…"
                className="min-h-52 font-mono text-xs"
                spellCheck={false}
              />
            </Field>
            <Button type="button" size="sm" variant="ghost" onClick={() => setStatementText(SAMPLE_STATEMENT)}>
              Load sample statement
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Books extract (TDS receivable)</h2>
            <Field
              label="Books rows"
              helper="Same header-compatible CSV: TAN, Section, Quarter, Date, Amount Paid, TDS Deducted (rupees)."
            >
              <Textarea
                value={booksText}
                onChange={(e) => setBooksText(e.target.value)}
                placeholder="Paste the client's TDS receivable extract here…"
                className="min-h-52 font-mono text-xs"
                spellCheck={false}
              />
            </Field>
            <Button type="button" size="sm" variant="ghost" onClick={() => setBooksText(SAMPLE_BOOKS)}>
              Load sample books
            </Button>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-end gap-3 lg:col-span-2">
          <Field label="Tolerance (₹ per row)" className="w-44" helper="Exact-match threshold; default ₹1.">
            <Input value={tolerance} onChange={(e) => setTolerance(e.target.value)} inputMode="decimal" />
          </Field>
          <Button type="submit" disabled={loading || !statementText.trim()}>
            <Play aria-hidden className="size-4" /> {loading ? "Reconciling…" : "Reconcile"}
          </Button>
          <Button type="button" variant="ghost" onClick={reset}>
            <RotateCcw aria-hidden className="size-4" /> Clear
          </Button>
          <p className="text-caption text-muted">Nothing is saved — client tax data stays in this tab.</p>
        </div>
      </form>

      {error && <p className="text-sm text-danger">{error}</p>}

      {result && recon && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Statement TDS" value={money(recon.totals.statementTds)} hint={`${result.statement.count} rows`} />
            <Stat label="Books TDS" value={money(recon.totals.booksTds)} hint={`${result.books.count} rows`} />
            <Stat
              label="Not in books"
              value={money(recon.totals.unclaimedTds)}
              hint="credit not claimed"
              tone="info"
            />
            <Stat
              label="Unsupported claim"
              value={money(recon.totals.unsupportedTds)}
              hint="not in 26AS/AIS"
              tone="critical"
            />
            <Stat
              label="Net difference"
              value={money(recon.totals.netDifference)}
              hint="books − statement"
              tone={recon.totals.netDifference === 0 ? "success" : "warning"}
            />
          </div>

          {(recon.warnings.length > 0 || result.statement.warnings.length > 0 || result.books.warnings.length > 0) && (
            <Card>
              <CardContent className="space-y-1.5">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <AlertTriangle aria-hidden className="size-4 text-[#B85C22]" /> What needs attention
                </h2>
                {[...recon.warnings, ...result.statement.warnings, ...result.books.warnings].map((warning, index) => (
                  <p key={index} className="text-caption text-muted">
                    • {warning}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[62rem] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-caption text-muted uppercase">
                      <th className="px-3 py-2 font-medium">Deductor</th>
                      <th className="px-3 py-2 font-medium">Section</th>
                      <th className="px-3 py-2 font-medium">Quarter</th>
                      <th className="px-3 py-2 text-right font-medium">Statement TDS</th>
                      <th className="px-3 py-2 text-right font-medium">Books TDS</th>
                      <th className="px-3 py-2 text-right font-medium">Difference</th>
                      <th className="px-3 py-2 font-medium">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recon.rows.map((credit, index) => (
                      <tr key={`${credit.key}-${index}`} className="border-b border-line/70 align-top">
                        <td className="px-3 py-3">
                          <span className="block font-medium text-foreground">
                            {credit.deductorName ?? "Unknown deductor"}
                          </span>
                          <span className="block font-mono text-caption text-muted">{credit.tan}</span>
                          {credit.notes.length > 0 && (
                            <span className="mt-0.5 block text-caption text-muted">{credit.notes.join(" ")}</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-muted">{credit.section}</td>
                        <td className="px-3 py-3 text-muted">{credit.quarter ?? "—"}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{money(credit.statement?.tds)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{money(credit.books?.tds)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{money(credit.difference)}</td>
                        <td className="px-3 py-3">
                          <Badge variant={VERDICT_VARIANT[credit.verdict]}>{VERDICT_LABEL[credit.verdict]}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-1.5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <ShieldCheck aria-hidden className="size-4" /> Methodology
              </h2>
              {recon.methodology.map((line, index) => (
                <p key={index} className="text-caption text-muted">
                  {index + 1}. {line}
                </p>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "info" | "critical" | "warning" | "success";
}) {
  const border =
    tone === "critical"
      ? "border-[#E8637A]/40"
      : tone === "warning"
        ? "border-[#F08A5D]/40"
        : tone === "success"
          ? "border-emerald/40"
          : tone === "info"
            ? "border-[#3D9BE9]/40"
            : "border-line";
  return (
    <Card className={border}>
      <CardContent className="space-y-1">
        <p className="text-caption text-muted uppercase">{label}</p>
        <p className="text-lg font-semibold text-foreground tabular-nums">{value}</p>
        {hint && <p className="text-caption text-muted">{hint}</p>}
      </CardContent>
    </Card>
  );
}
