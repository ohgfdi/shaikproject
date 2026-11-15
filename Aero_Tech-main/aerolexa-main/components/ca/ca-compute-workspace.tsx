"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/tabs";
import { api, errorMessage } from "@/lib/client/api";
import { formatInr } from "@/lib/engine/india-tax";

import { DocumentsPanel } from "./ca-documents-panel";import { ItrUPanel } from "./ca-itru-panel";
  import { ConcurrentAuditPanel, InternalAuditPanel, LitigationPanel, RocCompliancePanel, StockAuditPanel } from "./ca-practice-panels";
  import { ErrorLine, Method, Money, SampleDataNotice, Warnings, parseAmount as n } from "./ca-result-primitives";
import { TimesheetsPanel } from "./ca-timesheets-panel";

/**
 * CA computation workspace — the UI surface the direct-tax engines never had.
 *
 * Every panel POSTs to `/api/ca/compute` and renders the engine's own
 * methodology. Money the workspace SENDS is RUPEES (the API boundary); money it
 * RECEIVES is engine-specific and is converted here for display:
 *   - the ITR engine works in whole RUPEES      → rendered via `fromRupees()`
 *   - every other engine works in integer PAISE → rendered via `formatInr()`
 * Getting that wrong is a silent 100× error, so each render site names which
 * unit it is showing.
 */

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** The ITR engine (ca-itr-computation) operates in whole rupees. */
const fromRupees = (r: number) => formatInr(Math.round(r * 100));

// ---------------------------------------------------------------------------
// Response shapes (only the fields this UI reads)
// ---------------------------------------------------------------------------

interface ItrResult {
  computation: {
    fy: string;
    regime: string;
    grossTotalIncome: number;
    totalIncomeAfterDeductions: number;
    basicIncome: number;
    taxBeforeRebate: number;
    rebate87A: number;
    taxAfterRebate: number;
    surcharge: number;
    cess: number;
    totalTaxLiability: number;
    prepaidTax: number;
    netTaxPayableOrRefundable: number;
    formType: string;
    computationSteps: string[];
  };
  warnings: string[];
}

interface AdvisoryResult {
  totalTax: number;
  advanceTaxPaid: number;
  installments: { label: string; dueDate: string; targetAmount: number; shortfall: number; interest234C: number }[];
  interest234C: number;
  interest234B: number;
  interest234A: number;
  totalInterestExposure: number;
  payNow: number;
  warnings: string[];
}

interface SalaryResult {
  regimeLabel: string;
  grossSalary17_1: number;
  grossTotalSalary: number;
  exemptUnder10: number;
  standardDeduction: number;
  professionalTax: number;
  taxableSalary: number;
  slip: { section: string; label: string; amount: number; kind?: string }[];
  regimeComparison?: { bestRegimeId: string; bestTax: number; delta: number; note: string } | null;
  methodology: string[];
}

interface HousePropertyResult {
  totalNav: number;
  totalStd30: number;
  totalInterestDeductible: number;
  totalIncomeFromHouseProperty: number;
  totalLossFromHouseProperty: number;
  lossToBeCarriedForwardToNextYear: number;
  properties: {
    id: string;
    nav: number;
    standardDeduction30: number;
    totalDeductionUnder24: number;
    incomeFromHouseProperty: number;
    notes: string[];
  }[];
  methodology: string[];
}

interface CapitalGainsResult {
  totalShortTermCapitalGain: number;
  totalLongTermCapitalGain: number;
  totalCapitalGain: number;
  netStcgAfterSetOff: number;
  netLtcgAfterSetOff: number;
  transactions: {
    id: string;
    grossGain: number;
    shortTerm: boolean;
    specialRate: { section: string; ratePct: number } | null;
    taxAtSpecialRate: number;
    notes: string[];
  }[];
  methodology: string[];
}

// ---------------------------------------------------------------------------
// Shared row-editor helpers
// ---------------------------------------------------------------------------

function RowShell({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <div className="grid grid-cols-2 items-end gap-2 rounded-md border border-line bg-surface-2/30 p-2 sm:grid-cols-4">
      {children}
      <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label="Remove row">
        Remove
      </Button>
    </div>
  );
}

function AddRow({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button type="button" variant="secondary" size="sm" onClick={onClick}>
      + {label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Panel 1 — Income tax computation (ITR + advance-tax advisory)
// ---------------------------------------------------------------------------

const HEAD_FIELDS: {
  key: "salary" | "houseProperty" | "businessProfession" | "capitalGains" | "otherSources";
  label: string;
}[] = [
  { key: "salary", label: "Salary" },
  { key: "houseProperty", label: "House property" },
  { key: "businessProfession", label: "Business / profession" },
  { key: "capitalGains", label: "Capital gains" },
  { key: "otherSources", label: "Other sources" },
];

const DEDUCTION_FIELDS: {
  key: "section80C" | "section80D" | "section80E" | "section80G" | "section80TTA";
  label: string;
}[] = [
  { key: "section80C", label: "80C" },
  { key: "section80D", label: "80D" },
  { key: "section80E", label: "80E" },
  { key: "section80G", label: "80G" },
  { key: "section80TTA", label: "80TTA" },
];

function TaxPanel() {
  const [fy, setFy] = useState("2025-26");
  const [regime, setRegime] = useState<"new" | "old">("new");
  const [heads, setHeads] = useState<Record<string, string>>({
    salary: "1200000",
    houseProperty: "0",
    businessProfession: "0",
    capitalGains: "0",
    otherSources: "60000",
  });
  const [deductions, setDeductions] = useState<Record<string, string>>({
    section80C: "150000",
    section80D: "25000",
    section80E: "0",
    section80G: "0",
    section80TTA: "10000",
  });
  const [prepaid, setPrepaid] = useState({ tds: "0", advanceTax: "0", selfAssessment: "0" });
  const [referenceDate, setReferenceDate] = useState("2026-03-31");
  const [itr, setItr] = useState<ItrResult | null>(null);
  const [advisory, setAdvisory] = useState<AdvisoryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const itrRes = await api<{ itr: ItrResult }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "itr",
          fy,
          assesseeType: "individual",
          residentialStatus: "resident",
          incomeHeads: Object.fromEntries(HEAD_FIELDS.map((f) => [f.key, n(heads[f.key] ?? "0")] as const)),
          deductions: Object.fromEntries(DEDUCTION_FIELDS.map((f) => [f.key, n(deductions[f.key] ?? "0")] as const)),
          prepaidTax: {
            tds: n(prepaid.tds),
            tcs: 0,
            advanceTax: n(prepaid.advanceTax),
            selfAssessment: n(prepaid.selfAssessment),
            demands: 0,
          },
          formType: "ITR-1",
        }),
      });
      setItr(itrRes.itr);

      // Bridge: feed the ITR rupee liability into the paise advisory engine.
      const advisoryRes = await api<{ advanceTaxAdvisory: AdvisoryResult }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "advance-tax-advisory",
          fy,
          clientName: "Client",
          regimeId: regime,
          totalTax: itrRes.itr.computation.totalTaxLiability,
          advanceTaxPaid: n(prepaid.advanceTax),
          referenceDate,
        }),
      });
      setAdvisory(advisoryRes.advanceTaxAdvisory);
    } catch (err) {
      setItr(null);
      setAdvisory(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Income-tax computation</CardTitle>
          <CardDescription>
            Income heads and Chapter VI-A deductions. The ITR engine applies its default new regime; the advisory uses
            the regime you pick.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Input label="Financial year" value={fy} onChange={(e) => setFy(e.target.value)} />
            <Select
              label="Advance-tax regime"
              value={regime}
              onChange={(e) => setRegime(e.target.value as "new" | "old")}
              options={[
                { value: "new", label: "New" },
                { value: "old", label: "Old" },
              ]}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {HEAD_FIELDS.map((f) => (
              <Input
                key={f.key}
                label={f.label}
                inputMode="decimal"
                value={heads[f.key] ?? ""}
                onChange={(e) => setHeads({ ...heads, [f.key]: e.target.value })}
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {DEDUCTION_FIELDS.map((f) => (
              <Input
                key={f.key}
                label={f.label}
                inputMode="decimal"
                value={deductions[f.key] ?? ""}
                onChange={(e) => setDeductions({ ...deductions, [f.key]: e.target.value })}
              />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Input
              label="TDS"
              inputMode="decimal"
              value={prepaid.tds}
              onChange={(e) => setPrepaid({ ...prepaid, tds: e.target.value })}
            />
            <Input
              label="Advance tax paid"
              inputMode="decimal"
              value={prepaid.advanceTax}
              onChange={(e) => setPrepaid({ ...prepaid, advanceTax: e.target.value })}
            />
            <Input
              label="Self-assessment paid"
              inputMode="decimal"
              value={prepaid.selfAssessment}
              onChange={(e) => setPrepaid({ ...prepaid, selfAssessment: e.target.value })}
            />
          </div>
          <Input
            label="Advance-tax reference date"
            type="date"
            value={referenceDate}
            onChange={(e) => setReferenceDate(e.target.value)}
          />
          <Button type="button" onClick={run} loading={busy}>
            Compute tax
          </Button>
          <ErrorLine message={error} />
        </CardContent>
      </Card>

      <div className="space-y-6">
        {itr ? (
          <Card>
            <CardHeader>
              <CardTitle>ITR computation ({itr.computation.formType})</CardTitle>
              <CardDescription>Amounts in rupees, as the ITR engine returns them.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-sm">
                <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
                  <span className="text-muted">Gross total income</span>
                  <span className="tabular-nums font-medium">{fromRupees(itr.computation.grossTotalIncome)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
                  <span className="text-muted">Income after loss set-off</span>
                  <span className="tabular-nums font-medium">
                    {fromRupees(itr.computation.totalIncomeAfterDeductions)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
                  <span className="text-muted">Basic income</span>
                  <span className="tabular-nums font-medium">{fromRupees(itr.computation.basicIncome)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
                  <span className="text-muted">Tax before rebate</span>
                  <span className="tabular-nums font-medium">{fromRupees(itr.computation.taxBeforeRebate)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
                  <span className="text-muted">Rebate u/s 87A</span>
                  <span className="tabular-nums font-medium">−{fromRupees(itr.computation.rebate87A)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
                  <span className="text-muted">Cess</span>
                  <span className="tabular-nums font-medium">{fromRupees(itr.computation.cess)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
                  <span className="text-muted">Total tax liability</span>
                  <span className="tabular-nums font-semibold">{fromRupees(itr.computation.totalTaxLiability)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-1.5">
                  <span className="text-muted">
                    {itr.computation.netTaxPayableOrRefundable >= 0 ? "Net payable" : "Refund due"}
                  </span>
                  <span className="tabular-nums font-semibold">
                    {fromRupees(Math.abs(itr.computation.netTaxPayableOrRefundable))}
                  </span>
                </div>
              </div>
              <Method steps={itr.computation.computationSteps} />
              <Warnings items={itr.warnings} />
            </CardContent>
          </Card>
        ) : null}

        {advisory ? (
          <Card>
            <CardHeader>
              <CardTitle>Advance-tax position</CardTitle>
              <CardDescription>Instalment shortfalls and interest u/s 234B/234C/234A (integer paise).</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <Money label="Total tax assessed" value={advisory.totalTax} />
                <Money
                  label="Interest u/s 234B"
                  value={advisory.interest234B}
                  tone={advisory.interest234B > 0 ? "warn" : undefined}
                />
                <Money
                  label="Interest u/s 234C"
                  value={advisory.interest234C}
                  tone={advisory.interest234C > 0 ? "warn" : undefined}
                />
                <Money
                  label="Interest u/s 234A"
                  value={advisory.interest234A}
                  tone={advisory.interest234A > 0 ? "warn" : undefined}
                />
                <Money
                  label="Total interest exposure"
                  value={advisory.totalInterestExposure}
                  tone={advisory.totalInterestExposure > 0 ? "warn" : "ok"}
                />
                <Money label="Pay now to stop 234B" value={advisory.payNow} />
              </div>
              <table className="mt-4 w-full text-sm">
                <thead>
                  <tr className="text-left text-caption uppercase tracking-wide text-muted">
                    <th className="py-1">Instalment</th>
                    <th className="py-1">Due</th>
                    <th className="py-1 text-right">Target</th>
                    <th className="py-1 text-right">Shortfall</th>
                    <th className="py-1 text-right">234C</th>
                  </tr>
                </thead>
                <tbody>
                  {advisory.installments.map((i) => (
                    <tr key={i.label} className="border-t border-line/60">
                      <td className="py-1.5">{i.label}</td>
                      <td className="py-1.5">{i.dueDate}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatInr(i.targetAmount)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatInr(i.shortfall)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatInr(i.interest234C)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Warnings items={advisory.warnings} />
            </CardContent>
          </Card>
        ) : null}

        <RocCompliancePanel />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel 2 — Salary head
// ---------------------------------------------------------------------------

interface SalaryRow {
  label: string;
  amount: string;
  countsForSalary: boolean;
}

function SalaryPanel() {
  const [ay, setAy] = useState("2025-26");
  const [regimeId, setRegimeId] = useState<"new" | "old">("new");
  const [rows, setRows] = useState<SalaryRow[]>([
    { label: "Basic", amount: "600000", countsForSalary: true },
    { label: "HRA", amount: "240000", countsForSalary: true },
  ]);
  const [hraExempt, setHraExempt] = useState("120000");
  const [professionalTax, setProfessionalTax] = useState("2400");
  const [compare, setCompare] = useState(false);
  const [result, setResult] = useState<SalaryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ salaryHead: SalaryResult }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "income-head-salary",
          ay,
          regimeId,
          components: rows.map((r) => ({ label: r.label, amount: n(r.amount), countsForSalary: r.countsForSalary })),
          allowances: { hraExempt: n(hraExempt), professionalTax: n(professionalTax) },
          compareRegimes: compare,
        }),
      });
      setResult(res.salaryHead);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Salary head u/s 17</CardTitle>
          <CardDescription>Components, perquisites, exemptions u/s 10 and the s16 deductions.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Input label="Assessment year" value={ay} onChange={(e) => setAy(e.target.value)} />
            <Select
              label="Regime"
              value={regimeId}
              onChange={(e) => setRegimeId(e.target.value as "new" | "old")}
              options={[
                { value: "new", label: "New" },
                { value: "old", label: "Old" },
              ]}
            />
          </div>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <RowShell key={i} onRemove={() => setRows(rows.filter((_, j) => j !== i))}>
                <Input
                  label="Component"
                  value={r.label}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                />
                <Input
                  label="Amount"
                  inputMode="decimal"
                  value={r.amount}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                />
                <Checkbox
                  label="Counts for salary"
                  checked={r.countsForSalary}
                  onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, countsForSalary: v } : x)))}
                />
              </RowShell>
            ))}
            <AddRow
              label="Component"
              onClick={() => setRows([...rows, { label: "", amount: "0", countsForSalary: true }])}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              label="HRA exemption u/s 10(13A)"
              inputMode="decimal"
              value={hraExempt}
              onChange={(e) => setHraExempt(e.target.value)}
            />
            <Input
              label="Professional tax u/s 16(iii)"
              inputMode="decimal"
              value={professionalTax}
              onChange={(e) => setProfessionalTax(e.target.value)}
            />
          </div>
          <Checkbox label="Compare old vs new regime on salary alone" checked={compare} onChange={setCompare} />
          <Button type="button" onClick={run} loading={busy}>
            Compute salary
          </Button>
          <ErrorLine message={error} />
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>Taxable salary — {result.regimeLabel}</CardTitle>
            <CardDescription>Integer paise.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <Money label="Gross salary u/s 17(1)" value={result.grossSalary17_1} />
              <Money label="Gross total salary" value={result.grossTotalSalary} />
              <Money label="Less: exemptions u/s 10" value={-result.exemptUnder10} />
              <Money label="Less: standard deduction u/s 16(ia)" value={-result.standardDeduction} />
              <Money label="Less: professional tax u/s 16(iii)" value={-result.professionalTax} />
              <Money label="Taxable salary" value={result.taxableSalary} tone="ok" />
            </div>
            {result.regimeComparison ? (
              <p className="mt-4 rounded-md border border-line bg-surface-2/40 p-3 text-sm text-muted">
                Best regime on salary alone:{" "}
                <strong className="text-foreground">{result.regimeComparison.bestRegimeId}</strong> — tax{" "}
                {formatInr(result.regimeComparison.bestTax)} (saving {formatInr(result.regimeComparison.delta)}).{" "}
                {result.regimeComparison.note}
              </p>
            ) : null}
            <Method steps={result.methodology} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel 3 — House property
// ---------------------------------------------------------------------------

interface PropertyRow {
  id: string;
  status: "let-out" | "self-occupied" | "deemed-let-out" | "part-self-occupied-part-let-out";
  municipalValue: string;
  fairRent: string;
  rentReceived: string;
  municipalTaxPaid: string;
  interestOnHousingLoan: string;
}

const BLANK_PROPERTY: PropertyRow = {
  id: "HP-1",
  status: "let-out",
  municipalValue: "0",
  fairRent: "0",
  rentReceived: "0",
  municipalTaxPaid: "0",
  interestOnHousingLoan: "0",
};

function HousePropertyPanel() {
  const [ay, setAy] = useState("2025-26");
  const [rows, setRows] = useState<PropertyRow[]>([{ ...BLANK_PROPERTY }]);
  const [result, setResult] = useState<HousePropertyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ houseProperty: HousePropertyResult }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "house-property",
          ay,
          regimeLabel: "individual",
          properties: rows.map((r) => ({
            id: r.id,
            status: r.status,
            municipalValue: n(r.municipalValue),
            fairRent: n(r.fairRent),
            rentReceived: n(r.rentReceived),
            municipalTaxPaid: n(r.municipalTaxPaid),
            interestOnHousingLoan: n(r.interestOnHousingLoan),
          })),
        }),
      });
      setResult(res.houseProperty);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>House property</CardTitle>
          <CardDescription>
            NAV, the 30% deduction u/s 24(a) and interest u/s 24(b), aggregated per property with the loss discipline.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input label="Assessment year" value={ay} onChange={(e) => setAy(e.target.value)} />
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="space-y-2 rounded-md border border-line bg-surface-2/30 p-2">
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Property id"
                    value={r.id}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))}
                  />
                  <Select
                    label="Status"
                    value={r.status}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, j) => (j === i ? { ...x, status: e.target.value as PropertyRow["status"] } : x)),
                      )
                    }
                    options={[
                      { value: "let-out", label: "Let out" },
                      { value: "self-occupied", label: "Self occupied" },
                      { value: "deemed-let-out", label: "Deemed let out" },
                      { value: "part-self-occupied-part-let-out", label: "Part self / part let" },
                    ]}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Municipal value"
                    inputMode="decimal"
                    value={r.municipalValue}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, municipalValue: e.target.value } : x)))
                    }
                  />
                  <Input
                    label="Fair rent"
                    inputMode="decimal"
                    value={r.fairRent}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, fairRent: e.target.value } : x)))}
                  />
                  <Input
                    label="Rent received"
                    inputMode="decimal"
                    value={r.rentReceived}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, rentReceived: e.target.value } : x)))
                    }
                  />
                  <Input
                    label="Municipal tax paid"
                    inputMode="decimal"
                    value={r.municipalTaxPaid}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, municipalTaxPaid: e.target.value } : x)))
                    }
                  />
                  <Input
                    label="Interest u/s 24(b)"
                    inputMode="decimal"
                    value={r.interestOnHousingLoan}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, interestOnHousingLoan: e.target.value } : x)))
                    }
                  />
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  Remove property
                </Button>
              </div>
            ))}
            <AddRow
              label="Property"
              onClick={() => setRows([...rows, { ...BLANK_PROPERTY, id: `HP-${rows.length + 1}` }])}
            />
          </div>
          <Button type="button" onClick={run} loading={busy}>
            Compute house property
          </Button>
          <ErrorLine message={error} />
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>Income from house property</CardTitle>
            <CardDescription>Integer paise.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <Money label="Aggregate NAV" value={result.totalNav} />
              <Money label="30% standard deduction" value={-result.totalStd30} />
              <Money label="Interest deductible u/s 24(b)" value={-result.totalInterestDeductible} />
              <Money
                label="Income from house property"
                value={result.totalIncomeFromHouseProperty}
                tone={result.totalLossFromHouseProperty > 0 ? "warn" : "ok"}
              />
              {result.lossToBeCarriedForwardToNextYear > 0 ? (
                <Money label="Loss carried forward" value={result.lossToBeCarriedForwardToNextYear} tone="warn" />
              ) : null}
            </div>
            <ul className="mt-4 space-y-1 text-caption text-muted">
              {result.properties.map((p) => (
                <li key={p.id}>
                  <strong className="text-foreground">{p.id}</strong>: NAV {formatInr(p.nav)}; 24(a){" "}
                  {formatInr(p.standardDeduction30)}; 24(b) {formatInr(p.totalDeductionUnder24)}; income{" "}
                  {formatInr(p.incomeFromHouseProperty)}.
                  {p.notes.length ? <span className="block">{p.notes.join(" ")}</span> : null}
                </li>
              ))}
            </ul>
            <Method steps={result.methodology} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel 4 — Capital gains
// ---------------------------------------------------------------------------

const ASSET_CLASSES = [
  "listed-equity-shares",
  "equity-oriented-mutual-fund",
  "listed-debt-securities",
  "unlisted-shares",
  "immovable-property",
  "movable-property",
  "gold-bonds",
  "other",
] as const;

type AssetClassValue = (typeof ASSET_CLASSES)[number];

interface CgRow {
  id: string;
  assetClass: AssetClassValue;
  acquisitionDate: string;
  transferDate: string;
  saleProceeds: string;
  costOfAcquisition: string;
  longTerm: boolean;
  sttPaid: boolean;
}

const BLANK_CG: CgRow = {
  id: "CG-1",
  assetClass: "listed-equity-shares",
  acquisitionDate: "2021-05-01",
  transferDate: "2025-08-01",
  saleProceeds: "500000",
  costOfAcquisition: "200000",
  longTerm: true,
  sttPaid: true,
};

function CapitalGainsPanel() {
  const [ay, setAy] = useState("2025-26");
  const [rows, setRows] = useState<CgRow[]>([{ ...BLANK_CG }]);
  const [result, setResult] = useState<CapitalGainsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ capitalGains: CapitalGainsResult }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "capital-gains",
          ay,
          regimeLabel: "individual",
          transactions: rows.map((r) => ({
            id: r.id,
            assetClass: r.assetClass,
            acquisitionDate: r.acquisitionDate,
            transferDate: r.transferDate,
            saleProceeds: n(r.saleProceeds),
            costOfAcquisition: n(r.costOfAcquisition),
            holding: {
              acquisitionDate: r.acquisitionDate,
              transferDate: r.transferDate,
              daysHeld: daysBetween(r.acquisitionDate, r.transferDate),
              longTerm: r.longTerm,
            },
            sttPaid: r.sttPaid,
          })),
        }),
      });
      setResult(res.capitalGains);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Capital gains</CardTitle>
          <CardDescription>
            Per-transaction cost basis, holding classification and the special-rate routing (111A/112A defaults,
            override-able).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input label="Assessment year" value={ay} onChange={(e) => setAy(e.target.value)} />
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="space-y-2 rounded-md border border-line bg-surface-2/30 p-2">
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Transaction id"
                    value={r.id}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))}
                  />
                  <Select
                    label="Asset class"
                    value={r.assetClass}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, j) => (j === i ? { ...x, assetClass: e.target.value as AssetClassValue } : x)),
                      )
                    }
                    options={ASSET_CLASSES.map((c) => ({ value: c, label: c }))}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Acquired"
                    type="date"
                    value={r.acquisitionDate}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, acquisitionDate: e.target.value } : x)))
                    }
                  />
                  <Input
                    label="Transferred"
                    type="date"
                    value={r.transferDate}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, transferDate: e.target.value } : x)))
                    }
                  />
                  <Input
                    label="Sale proceeds"
                    inputMode="decimal"
                    value={r.saleProceeds}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, saleProceeds: e.target.value } : x)))
                    }
                  />
                  <Input
                    label="Cost of acquisition"
                    inputMode="decimal"
                    value={r.costOfAcquisition}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, costOfAcquisition: e.target.value } : x)))
                    }
                  />
                </div>
                <div className="flex flex-wrap gap-4">
                  <Checkbox
                    label="Long term"
                    checked={r.longTerm}
                    onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, longTerm: v } : x)))}
                  />
                  <Checkbox
                    label="STT paid"
                    checked={r.sttPaid}
                    onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, sttPaid: v } : x)))}
                  />
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  Remove transaction
                </Button>
              </div>
            ))}
            <AddRow
              label="Transaction"
              onClick={() => setRows([...rows, { ...BLANK_CG, id: `CG-${rows.length + 1}` }])}
            />
          </div>
          <Button type="button" onClick={run} loading={busy}>
            Compute capital gains
          </Button>
          <ErrorLine message={error} />
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>Capital-gains summary</CardTitle>
            <CardDescription>Integer paise.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <Money label="Total STCG" value={result.totalShortTermCapitalGain} />
              <Money label="Total LTCG" value={result.totalLongTermCapitalGain} />
              <Money label="Net STCG after set-off" value={result.netStcgAfterSetOff} />
              <Money label="Net LTCG after set-off" value={result.netLtcgAfterSetOff} />
              <Money label="Total capital gain" value={result.totalCapitalGain} tone="ok" />
            </div>
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Txn</th>
                  <th className="py-1">Gain</th>
                  <th className="py-1">Class</th>
                  <th className="py-1 text-right">Special-rate tax</th>
                </tr>
              </thead>
              <tbody>
                {result.transactions.map((t) => (
                  <tr key={t.id} className="border-t border-line/60">
                    <td className="py-1.5">{t.id}</td>
                    <td className="py-1.5 tabular-nums">{formatInr(t.grossGain)}</td>
                    <td className="py-1.5">
                      {t.specialRate
                        ? `${t.specialRate.section} @ ${t.specialRate.ratePct}%`
                        : t.shortTerm
                          ? "STCG"
                          : "LTCG"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {t.specialRate ? formatInr(t.taxAtSpecialRate) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Method steps={result.methodology} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** Whole days between two yyyy-mm-dd dates (0 when either is invalid/inverted). */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Panel 5 — TDS suite (section matrix, challan reconciliation, penalty exposure)
// ---------------------------------------------------------------------------

interface TdsSectionDef {
  section: string;
  label: string;
  natureOfPayment: string;
  defaultRatePct: number;
  thresholdMinor: number;
  isTcs: boolean;
  form: string;
  notes: string[];
}

interface TdsReconEntry {
  challan: { bsrCode: string; challanSerial: string; dateOfDeposit: string };
  challanAmount: number;
  bankAmount: number | null;
  difference: number | null;
  status: string;
  remarks: string | null;
}

interface TdsExposureItem {
  id: string;
  section: string;
  reason: string;
  payeeName: string;
  amount: number;
  months: number;
}

interface TdsExposureResult {
  totalExposure: number;
  totalInterest: number;
  totalFees: number;
  exposures: TdsExposureItem[];
  warnings: string[];
}

interface ChallanRow {
  bsrCode: string;
  challanSerial: string;
  dateOfDeposit: string;
  amount: string;
}

interface BankRow {
  date: string;
  amount: string;
  ref: string;
}

interface ExposureRow {
  id: string;
  section: string;
  payeeName: string;
  baseAmount: string;
  taxShouldBe: string;
  taxActual: string;
  deductibleDate: string;
  deductedDate: string;
}

const BLANK_CHALLAN: ChallanRow = {
  bsrCode: "0001234",
  challanSerial: "00001",
  dateOfDeposit: "2025-07-07",
  amount: "10000",
};
const BLANK_BANK: BankRow = { date: "2025-07-08", amount: "10000", ref: "UTR1" };
const BLANK_EXPOSURE: ExposureRow = {
  id: "E1",
  section: "194J",
  payeeName: "Vendor",
  baseAmount: "100000",
  taxShouldBe: "10000",
  taxActual: "0",
  deductibleDate: "2025-04-15",
  deductedDate: "2025-06-15",
};

function SectionLookup() {
  const [section, setSection] = useState("194C");
  const [form, setForm] = useState("");
  const [defs, setDefs] = useState<TdsSectionDef[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ sections: TdsSectionDef[] }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "tds-section",
          ...(section ? { section } : {}),
          ...(form ? { form } : {}),
        }),
      });
      setDefs(res.sections);
    } catch (err) {
      setDefs(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Section applicability matrix</CardTitle>
        <CardDescription>
          Nature of payment, default rate, threshold, return form and the 15G/15H &amp; LDC flags for a section.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Input label="Section code" value={section} onChange={(e) => setSection(e.target.value)} placeholder="194C" />
          <Select
            label="Or list a return form"
            value={form}
            onChange={(e) => setForm(e.target.value)}
            options={[
              { value: "", label: "—" },
              { value: "24Q", label: "24Q (salary)" },
              { value: "26Q", label: "26Q (non-salary)" },
              { value: "27Q", label: "27Q (non-resident)" },
              { value: "NIL", label: "NIL" },
            ]}
          />
        </div>
        <Button type="button" onClick={run} loading={busy}>
          Look up
        </Button>
        <ErrorLine message={error} />
        {defs ? (
          defs.length === 0 ? (
            <p className="text-sm text-muted">No section matched.</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-auto">
              {defs.slice(0, 100).map((d) => (
                <div
                  key={`${d.section}-${d.label}`}
                  className="rounded-md border border-line bg-surface-2/30 p-2 text-sm"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <strong className="text-foreground">
                      {d.section} — {d.label}
                    </strong>
                    <span className="shrink-0 text-muted">
                      {d.isTcs ? "TCS" : "TDS"} · {d.form}
                    </span>
                  </div>
                  <p className="text-caption text-muted">{d.natureOfPayment}</p>
                  <p className="text-caption text-muted">
                    Rate {d.defaultRatePct}% · Threshold {d.thresholdMinor ? formatInr(d.thresholdMinor) : "none"}
                  </p>
                </div>
              ))}
              {defs.length > 100 ? (
                <p className="text-caption text-muted">Showing the first 100 of {defs.length} sections.</p>
              ) : null}
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function ChallanRecon() {
  const [challans, setChallans] = useState<ChallanRow[]>([{ ...BLANK_CHALLAN }]);
  const [bank, setBank] = useState<BankRow[]>([{ ...BLANK_BANK }]);
  const [result, setResult] = useState<TdsReconEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ reconciliation: TdsReconEntry[] }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "tds-challan-recon",
          challans: challans.map((c) => ({
            bsrCode: c.bsrCode,
            challanSerial: c.challanSerial,
            dateOfDeposit: c.dateOfDeposit,
            amount: n(c.amount),
          })),
          bankStatement: bank.map((b) => ({ date: b.date, amount: n(b.amount), ref: b.ref })),
        }),
      });
      setResult(res.reconciliation);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Challan ↔ bank reconciliation</CardTitle>
        <CardDescription>
          Map each TDS challan to its bank credit and surface a short or excess credit (§201 exposure).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <p className="text-caption font-medium uppercase tracking-wide text-muted">Challans</p>
          {challans.map((c, i) => (
            <RowShell key={i} onRemove={() => setChallans(challans.filter((_, j) => j !== i))}>
              <Input
                label="BSR code"
                value={c.bsrCode}
                onChange={(e) => setChallans(challans.map((x, j) => (j === i ? { ...x, bsrCode: e.target.value } : x)))}
              />
              <Input
                label="Serial"
                value={c.challanSerial}
                onChange={(e) =>
                  setChallans(challans.map((x, j) => (j === i ? { ...x, challanSerial: e.target.value } : x)))
                }
              />
              <Input
                label="Deposit date"
                type="date"
                value={c.dateOfDeposit}
                onChange={(e) =>
                  setChallans(challans.map((x, j) => (j === i ? { ...x, dateOfDeposit: e.target.value } : x)))
                }
              />
              <Input
                label="Amount"
                inputMode="decimal"
                value={c.amount}
                onChange={(e) => setChallans(challans.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              />
            </RowShell>
          ))}
          <AddRow label="Challan" onClick={() => setChallans([...challans, { ...BLANK_CHALLAN }])} />
        </div>
        <div className="space-y-2">
          <p className="text-caption font-medium uppercase tracking-wide text-muted">Bank credits</p>
          {bank.map((b, i) => (
            <RowShell key={i} onRemove={() => setBank(bank.filter((_, j) => j !== i))}>
              <Input
                label="Date"
                type="date"
                value={b.date}
                onChange={(e) => setBank(bank.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
              />
              <Input
                label="Amount"
                inputMode="decimal"
                value={b.amount}
                onChange={(e) => setBank(bank.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              />
              <Input
                label="Reference"
                value={b.ref}
                onChange={(e) => setBank(bank.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)))}
              />
            </RowShell>
          ))}
          <AddRow label="Bank credit" onClick={() => setBank([...bank, { ...BLANK_BANK }])} />
        </div>
        <Button type="button" onClick={run} loading={busy}>
          Reconcile
        </Button>
        <ErrorLine message={error} />
        {result ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-caption uppercase tracking-wide text-muted">
                <th className="py-1">Challan</th>
                <th className="py-1 text-right">Challan ₹</th>
                <th className="py-1 text-right">Bank ₹</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {result.map((r) => (
                <tr key={`${r.challan.bsrCode}-${r.challan.challanSerial}`} className="border-t border-line/60">
                  <td className="py-1.5">
                    {r.challan.bsrCode}/{r.challan.challanSerial}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{formatInr(r.challanAmount)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.bankAmount === null ? "—" : formatInr(r.bankAmount)}
                  </td>
                  <td className={`py-1.5 ${r.status === "matched" ? "text-emerald-600" : "text-amber-600"}`}>
                    {r.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ExposurePanel() {
  const [tan, setTan] = useState("MUMA12345A");
  const [dueDate, setDueDate] = useState("2025-07-31");
  const [rows, setRows] = useState<ExposureRow[]>([{ ...BLANK_EXPOSURE }]);
  const [result, setResult] = useState<TdsExposureResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ tdsExposure: TdsExposureResult }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "tds-penalty-exposure",
          params: { tan, returnFilingDueDate: dueDate },
          events: rows.map((r) => ({
            id: r.id,
            section: r.section,
            payeeName: r.payeeName,
            baseAmount: n(r.baseAmount),
            taxShouldBe: n(r.taxShouldBe),
            taxActual: n(r.taxActual),
            deductibleDate: r.deductibleDate,
            deductedDate: r.deductedDate || undefined,
          })),
        }),
      });
      setResult(res.tdsExposure);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Penalty &amp; interest exposure</CardTitle>
        <CardDescription>
          Interest u/s 201(1A) (late deduction 1%, late deposit 1.5%) and fees u/s 234E / 271Q — caller-supplied dates,
          integer paise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Input label="Deductor TAN" value={tan} onChange={(e) => setTan(e.target.value)} />
          <Input
            label="Return filing due date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line bg-surface-2/30 p-2">
              <div className="grid grid-cols-3 gap-2">
                <Input
                  label="Id"
                  value={r.id}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))}
                />
                <Input
                  label="Section"
                  value={r.section}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, section: e.target.value } : x)))}
                />
                <Input
                  label="Payee"
                  value={r.payeeName}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, payeeName: e.target.value } : x)))}
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Input
                  label="Base amount"
                  inputMode="decimal"
                  value={r.baseAmount}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, baseAmount: e.target.value } : x)))}
                />
                <Input
                  label="Tax should be"
                  inputMode="decimal"
                  value={r.taxShouldBe}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, taxShouldBe: e.target.value } : x)))}
                />
                <Input
                  label="Tax actual"
                  inputMode="decimal"
                  value={r.taxActual}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, taxActual: e.target.value } : x)))}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Deductible date"
                  type="date"
                  value={r.deductibleDate}
                  onChange={(e) =>
                    setRows(rows.map((x, j) => (j === i ? { ...x, deductibleDate: e.target.value } : x)))
                  }
                />
                <Input
                  label="Deducted date"
                  type="date"
                  value={r.deductedDate}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, deductedDate: e.target.value } : x)))}
                />
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                Remove event
              </Button>
            </div>
          ))}
          <AddRow label="Event" onClick={() => setRows([...rows, { ...BLANK_EXPOSURE, id: `E${rows.length + 1}` }])} />
        </div>
        <Button type="button" onClick={run} loading={busy}>
          Compute exposure
        </Button>
        <ErrorLine message={error} />
        {result ? (
          <div>
            <div className="space-y-1">
              <Money
                label="Interest u/s 201(1A)"
                value={result.totalInterest}
                tone={result.totalInterest > 0 ? "warn" : "ok"}
              />
              <Money
                label="Fees u/s 234E / 271Q"
                value={result.totalFees}
                tone={result.totalFees > 0 ? "warn" : undefined}
              />
              <Money
                label="Total exposure"
                value={result.totalExposure}
                tone={result.totalExposure > 0 ? "warn" : "ok"}
              />
            </div>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Section</th>
                  <th className="py-1">Reason</th>
                  <th className="py-1">Payee</th>
                  <th className="py-1 text-right">Months</th>
                  <th className="py-1 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {result.exposures.map((e) => (
                  <tr key={e.id} className="border-t border-line/60">
                    <td className="py-1.5">{e.section}</td>
                    <td className="py-1.5">{e.reason}</td>
                    <td className="py-1.5">{e.payeeName}</td>
                    <td className="py-1.5 text-right tabular-nums">{e.months}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatInr(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Warnings items={result.warnings} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel — TDS threshold tracking & time of deduction (tds-threshold-engine)
// ---------------------------------------------------------------------------

interface ThresholdOutcome {
  eventId: string;
  section: string;
  amount: number;
  effectiveDeductibleDate: string;
  deductibleDateSource: string;
  thresholdCrossed: boolean;
  cumulativeAfter: number;
  threshold: number;
  tdsApplicable: boolean;
  reasonIfNotApplicable: string | null;
  panMissingConsequence: string | null;
}

interface ThresholdSummary {
  totalEvents: number;
  eventsWithTds: number;
  eventsWithoutTds: number;
  totalTdsComputed: number;
  sectionsWithTds: string[];
}

interface ThresholdRow {
  id: string;
  section: string;
  deducteePan: string;
  deducteeType: string;
  amount: string;
  dateOfPayment: string;
  dateOfCredit: string;
  hasPan: boolean;
}

const BLANK_THRESHOLD: ThresholdRow = {
  id: "P1",
  section: "194C",
  deducteePan: "AAAAA0000A",
  deducteeType: "company",
  amount: "80000",
  dateOfPayment: "2025-05-15",
  dateOfCredit: "2025-05-10",
  hasPan: true,
};

function ThresholdPanel() {
  const [rows, setRows] = useState<ThresholdRow[]>([
    { ...BLANK_THRESHOLD },
    { ...BLANK_THRESHOLD, id: "P2", amount: "30000", dateOfPayment: "2025-06-15", dateOfCredit: "2025-06-10" },
  ]);
  const [perDeductee, setPerDeductee] = useState(true);
  const [carryOver, setCarryOver] = useState("");
  const [outcomes, setOutcomes] = useState<ThresholdOutcome[] | null>(null);
  const [summary, setSummary] = useState<ThresholdSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<ThresholdRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const co = n(carryOver);
      const res = await api<{ outcomes: ThresholdOutcome[]; summary: ThresholdSummary }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "tds-threshold",
          perDeducteeTracking: perDeductee,
          events: rows.map((r) => ({
            id: r.id,
            section: r.section,
            deducteePan: r.deducteePan,
            deducteeType: r.deducteeType,
            amount: n(r.amount),
            dateOfPayment: r.dateOfPayment,
            dateOfCredit: r.dateOfCredit,
            hasPan: r.hasPan,
          })),
          ...(co > 0
            ? {
                carryOver: rows.map((r) => ({
                  section: r.section,
                  deducteePan: r.deducteePan,
                  cumulative: co,
                  threshold: n(r.amount),
                })),
              }
            : {}),
        }),
      });
      setOutcomes(res.outcomes);
      setSummary(res.summary);
    } catch (err) {
      setOutcomes(null);
      setSummary(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Threshold tracking &amp; time of deduction</CardTitle>
        <CardDescription>
          Aggregate-threshold carry-over for the FY and the &ldquo;earlier of payment and credit&rdquo; rule. Amounts
          are entered in rupees; the engine answers in integer paise, and the threshold it applied is shown on every
          line.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line bg-surface-2/30 p-2">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input label="Id" value={r.id} onChange={(e) => update(i, { id: e.target.value })} />
                <Input label="Section" value={r.section} onChange={(e) => update(i, { section: e.target.value })} />
                <Input
                  label="Deductee PAN"
                  value={r.deducteePan}
                  onChange={(e) => update(i, { deducteePan: e.target.value })}
                />
                <Select
                  label="Deductee type"
                  value={r.deducteeType}
                  onChange={(e) => update(i, { deducteeType: e.target.value })}
                  options={[
                    { value: "company", label: "Company" },
                    { value: "firm", label: "Firm" },
                    { value: "individual", label: "Individual" },
                    { value: "huf", label: "HUF" },
                    { value: "bank", label: "Bank / NSB" },
                    { value: "non-resident", label: "Non-resident" },
                  ]}
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Input
                  label="Amount"
                  inputMode="decimal"
                  value={r.amount}
                  onChange={(e) => update(i, { amount: e.target.value })}
                />
                <Input
                  label="Date of payment"
                  type="date"
                  value={r.dateOfPayment}
                  onChange={(e) => update(i, { dateOfPayment: e.target.value })}
                />
                <Input
                  label="Date of credit"
                  type="date"
                  value={r.dateOfCredit}
                  onChange={(e) => update(i, { dateOfCredit: e.target.value })}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Checkbox label="Valid PAN" checked={r.hasPan} onChange={(v) => update(i, { hasPan: v })} />
                <Button type="button" variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  Remove payment
                </Button>
              </div>
            </div>
          ))}
          <AddRow
            label="Payment"
            onClick={() => setRows([...rows, { ...BLANK_THRESHOLD, id: `P${rows.length + 1}` }])}
          />
        </div>
        <div className="grid grid-cols-2 items-end gap-2">
          <Input
            label="Carry-over (₹, optional)"
            inputMode="decimal"
            value={carryOver}
            onChange={(e) => setCarryOver(e.target.value)}
            placeholder="aggregate already paid this FY"
          />
          <Checkbox label="Track per deductee PAN" checked={perDeductee} onChange={setPerDeductee} />
        </div>
        <Button type="button" onClick={run} loading={busy}>
          Evaluate thresholds
        </Button>
        <ErrorLine message={error} />
        {outcomes ? (
          <div>
            {summary ? (
              <div className="space-y-1">
                <Money
                  label="Payments with TDS"
                  value={summary.totalTdsComputed}
                  tone={summary.totalTdsComputed > 0 ? "warn" : "ok"}
                />
                <p className="text-caption text-muted">
                  {summary.eventsWithTds} of {summary.totalEvents} payments are liable; sections with TDS:{" "}
                  {summary.sectionsWithTds.join(", ") || "none"}.
                </p>
              </div>
            ) : null}
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Id</th>
                  <th className="py-1">Section</th>
                  <th className="py-1">Deductible date</th>
                  <th className="py-1 text-right">Cumulative</th>
                  <th className="py-1 text-right">TDS</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.map((o) => (
                  <tr key={o.eventId} className="border-t border-line/60">
                    <td className="py-1.5">{o.eventId}</td>
                    <td className="py-1.5">{o.section}</td>
                    <td className="py-1.5">
                      {o.effectiveDeductibleDate}{" "}
                      <span className="text-caption text-muted">({o.deductibleDateSource})</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatInr(o.cumulativeAfter)}</td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${o.tdsApplicable ? "text-amber-600" : "text-muted"}`}
                    >
                      {o.tdsApplicable ? "Yes" : "No"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-caption text-muted">
              Threshold applied on the first payment: {outcomes[0] ? formatInr(outcomes[0].threshold) : "—"}.
            </p>
            <ul className="mt-2 space-y-1 text-caption text-muted">
              {outcomes
                .filter((o) => o.reasonIfNotApplicable)
                .map((o) => (
                  <li key={`r-${o.eventId}`}>
                    <strong className="text-foreground">{o.eventId}:</strong> {o.reasonIfNotApplicable}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel — TDS/TCS computation & statement summary (ca-tds-computation)
// ---------------------------------------------------------------------------

interface TdsComputationResult {
  sections: { section: string; aggregateCumulative: number; totalTax: number }[];
  statementSummary: {
    formType: string;
    totalParties: number;
    totalTax: number;
    totalDeposited: number;
    totalPendingDeposit: number;
  };
  warnings: string[];
  methodology: string[];
}

function TdsComputationPanel() {
  const [payerPan, setPayerPan] = useState("AAAAA1111A");
  const [ay, setAy] = useState("2026-27");
  const [rows, setRows] = useState([
    {
      section: "194C",
      payeeName: "Vendor A",
      payeePan: "AAAAA0000A",
      amount: "100000",
      rate: "2",
      threshold: "100000",
      dateOfPayment: "2025-05-31",
      dateOfDeduction: "2025-05-10",
      deposited: true,
    },
  ]);
  const [result, setResult] = useState<TdsComputationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<(typeof rows)[number]>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ tds: TdsComputationResult }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "tds-computation",
          payerPan,
          assessmentYear: ay,
          transactions: rows.map((r) => ({
            section: r.section,
            payeeName: r.payeeName,
            payeePan: r.payeePan,
            amount: n(r.amount),
            rate: n(r.rate),
            threshold: n(r.threshold),
            dateOfPayment: r.dateOfPayment,
            dateOfDeduction: r.dateOfDeduction,
            deposited: r.deposited,
            challan: "",
          })),
        }),
      });
      setResult(res.tds);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>TDS/TCS computation &amp; statement summary</CardTitle>
        <CardDescription>
          Per-section rate × amount, threshold crossing against the running aggregate, 201/234E interest on the dates
          supplied, and the return form the sections map to. This engine is rupee-native — its figures are shown in ₹
          directly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Input label="Deductor PAN" value={payerPan} onChange={(e) => setPayerPan(e.target.value)} />
          <Input label="Assessment year" value={ay} onChange={(e) => setAy(e.target.value)} />
        </div>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <RowShell key={i} onRemove={() => setRows(rows.filter((_, j) => j !== i))}>
              <Input label="Section" value={r.section} onChange={(e) => update(i, { section: e.target.value })} />
              <Input label="Payee" value={r.payeeName} onChange={(e) => update(i, { payeeName: e.target.value })} />
              <Input
                label="Amount ₹"
                inputMode="decimal"
                value={r.amount}
                onChange={(e) => update(i, { amount: e.target.value })}
              />
              <Input
                label="Rate %"
                inputMode="decimal"
                value={r.rate}
                onChange={(e) => update(i, { rate: e.target.value })}
              />
              <Input
                label="Threshold ₹"
                inputMode="decimal"
                value={r.threshold}
                onChange={(e) => update(i, { threshold: e.target.value })}
              />
              <Input
                label="Payment date"
                type="date"
                value={r.dateOfPayment}
                onChange={(e) => update(i, { dateOfPayment: e.target.value })}
              />
              <Input
                label="Deduction date"
                type="date"
                value={r.dateOfDeduction}
                onChange={(e) => update(i, { dateOfDeduction: e.target.value })}
              />
              <Checkbox label="Deposited" checked={r.deposited} onChange={(v) => update(i, { deposited: v })} />
            </RowShell>
          ))}
          <AddRow
            label="Transaction"
            onClick={() =>
              setRows([
                ...rows,
                { ...rows[0]!, payeeName: `Payee ${rows.length + 1}`, payeePan: `PAN${rows.length + 1}` },
              ])
            }
          />
        </div>
        <Button type="button" onClick={run} loading={busy}>
          Compute TDS
        </Button>
        <ErrorLine message={error} />
        {result ? (
          <div>
            <div className="space-y-1">
              <Money label="Total tax" value={result.statementSummary.totalTax * 100} tone="warn" />
              <Money label="Deposited" value={result.statementSummary.totalDeposited * 100} tone="ok" />
              <Money
                label="Pending deposit"
                value={result.statementSummary.totalPendingDeposit * 100}
                tone={result.statementSummary.totalPendingDeposit > 0 ? "warn" : "ok"}
              />
              <p className="text-caption text-muted">
                Form {result.statementSummary.formType} · {result.statementSummary.totalParties} payees
              </p>
            </div>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Section</th>
                  <th className="py-1 text-right">Aggregate ₹</th>
                  <th className="py-1 text-right">Tax ₹</th>
                </tr>
              </thead>
              <tbody>
                {result.sections.map((s) => (
                  <tr key={s.section} className="border-t border-line/60">
                    <td className="py-1.5">{s.section}</td>
                    <td className="py-1.5 text-right tabular-nums">{fromRupees(s.aggregateCumulative)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fromRupees(s.totalTax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Warnings items={result.warnings} />
            <Method steps={result.methodology} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel — LDC / Form 15G-15H coverage (tds-ldc-form15g)
// ---------------------------------------------------------------------------

function LdcPanel() {
  const [formType, setFormType] = useState<"15G" | "15H">("15G");
  const [pan, setPan] = useState("AAAAA0000A");
  const [age, setAge] = useState("40");
  const [sections, setSections] = useState("194A");
  const [amountLimit, setAmountLimit] = useState("100000");
  const [validFrom, setValidFrom] = useState("2025-04-10");
  const [validUntil, setValidUntil] = useState("2026-03-31");
  const [issues, setIssues] = useState<{ valid: boolean; issues: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const limit = n(amountLimit);
      const res = await api<{ form15Validation: { valid: boolean; issues: string[] } }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "tds-ldc",
          op: "validate-form15",
          declaration: {
            formType,
            deducteePan: pan,
            age: Math.round(n(age)),
            declarationDate: validFrom,
            sections: sections
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            ...(limit > 0 ? { amountLimit: limit } : {}),
            validFrom,
            validUntil,
          },
        }),
      });
      setIssues(res.form15Validation);
    } catch (err) {
      setIssues(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Form 15G/15H declaration check</CardTitle>
        <CardDescription>
          The form type must match the declarant&rsquo;s age (15G below 60, 15H for senior citizens), the window must
          sit inside the FY, and the sections must be ones that allow a declaration.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Select
            label="Form"
            value={formType}
            onChange={(e) => setFormType(e.target.value as "15G" | "15H")}
            options={[
              { value: "15G", label: "15G" },
              { value: "15H", label: "15H" },
            ]}
          />
          <Input label="Deductee PAN" value={pan} onChange={(e) => setPan(e.target.value)} />
          <Input label="Age" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} />
          <Input label="Sections (comma-separated)" value={sections} onChange={(e) => setSections(e.target.value)} />
          <Input
            label="Amount limit ₹"
            inputMode="decimal"
            value={amountLimit}
            onChange={(e) => setAmountLimit(e.target.value)}
          />
          <Input label="Valid from" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          <Input label="Valid until" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </div>
        <Button type="button" onClick={run} loading={busy}>
          Validate declaration
        </Button>
        <ErrorLine message={error} />
        {issues ? (
          <div>
            <Money label="Amount limit applied" value={n(amountLimit) * 100} />
            <p className={`mt-2 text-sm font-medium ${issues.valid ? "text-emerald-600" : "text-amber-600"}`}>
              {issues.valid ? "Valid on its face." : `${issues.issues.length} issue(s) found:`}
            </p>
            <Warnings items={issues.issues} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel — Form 16 / 16A certificates (tds-form16-generator)
// ---------------------------------------------------------------------------

interface Form16PartAResult {
  totalSalaryPaid: number;
  totalTdsDeducted: number;
  totalTdsDeposited: number;
  quarters: { quarter: string; totalSalaryPaid: number; totalTdsDeducted: number }[];
}

interface Form16PartBResult {
  taxComputation: {
    totalIncome: number;
    taxOnTotalIncome: number;
    rebate87A: number;
    cess: number;
    totalTaxLiability: number;
  };
}

function Form16Panel() {
  const [op, setOp] = useState<"16" | "16A">("16");
  const [deductorTan, setDeductorTan] = useState("MUMA12345A");
  const [deductorName, setDeductorName] = useState("Acme Pvt Ltd");
  const [deducteePan, setDeducteePan] = useState("AAAAA0000A");
  const [deducteeName, setDeducteeName] = useState("Ramesh Kumar");
  const [fy, setFy] = useState("2025-26");
  const [ay, setAy] = useState("2026-27");
  const [entries, setEntries] = useState([
    {
      id: "e1",
      quarter: "Q1",
      section: "194C",
      dateOfPayment: "2025-05-31",
      grossAmount: "500000",
      tdsAmount: "50000",
    },
  ]);
  const [totalSalary, setTotalSalary] = useState("1150000");
  const [chapterVIA, setChapterVIA] = useState("225000");
  const [tdsDeducted, setTdsDeducted] = useState("115000");
  const [partA, setPartA] = useState<Form16PartAResult | null>(null);
  const [partB, setPartB] = useState<Form16PartBResult | null>(null);
  const [form16A, setForm16A] = useState<{
    totalAmount: number;
    totalTdsDeducted: number;
    sections: { section: string }[];
  } | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; issues: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<(typeof entries)[number]>) =>
    setEntries(entries.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const mapped = entries.map((e) => ({
        id: e.id,
        quarter: e.quarter,
        section: e.section,
        dateOfPayment: e.dateOfPayment,
        grossAmount: n(e.grossAmount),
        tdsAmount: n(e.tdsAmount),
      }));
      const salaryEntries = mapped.map((e) => ({
        id: e.id,
        quarter: e.quarter,
        dateOfPayment: e.dateOfPayment,
        grossAmount: e.grossAmount,
        tdsAmount: e.tdsAmount,
      }));
      const nonSalaryEntries = mapped.map((e) => ({
        id: e.id,
        section: e.section,
        grossAmount: e.grossAmount,
        tdsAmount: e.tdsAmount,
      }));
      if (op === "16") {
        const res = await api<{
          partA: Form16PartAResult;
          partB: Form16PartBResult;
          validation: { valid: boolean; issues: string[] };
        }>("/api/ca/compute", {
          method: "POST",
          body: JSON.stringify({
            kind: "tds-form16",
            op: "16",
            deductorTan,
            deductorName,
            deducteePan,
            deducteeName,
            fy,
            assessmentYear: ay,
            salaryEntries,
            salary: { totalSalary: n(totalSalary) },
            chapterVIA: { totalChapterVIA: n(chapterVIA) },
            tdsDeducted: n(tdsDeducted),
          }),
        });
        setPartA(res.partA);
        setPartB(res.partB);
        setForm16A(null);
        setValidation(res.validation);
      } else {
        const res = await api<{
          form16A: { totalAmount: number; totalTdsDeducted: number; sections: { section: string }[] };
          validation: { valid: boolean; issues: string[] };
        }>("/api/ca/compute", {
          method: "POST",
          body: JSON.stringify({
            kind: "tds-form16",
            op: "16A",
            deductorTan,
            deductorName,
            deducteePan,
            deducteeName,
            fy,
            assessmentYear: ay,
            nonSalaryEntries,
          }),
        });
        setForm16A(res.form16A);
        setPartA(null);
        setPartB(null);
        setValidation(res.validation);
      }
    } catch (err) {
      setPartA(null);
      setPartB(null);
      setForm16A(null);
      setValidation(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Form 16 / 16A certificates</CardTitle>
        <CardDescription>
          Part A quarterly aggregation, Part B tax under the old regime, and the 16A grouping by section — the
          certificate DATA the utility consumes (no PDF is generated). All money crosses in rupees and is computed in
          paise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Select
            label="Certificate"
            value={op}
            onChange={(e) => setOp(e.target.value as "16" | "16A")}
            options={[
              { value: "16", label: "Form 16 (salary)" },
              { value: "16A", label: "Form 16A (non-salary)" },
            ]}
          />
          <Input label="Deductor TAN" value={deductorTan} onChange={(e) => setDeductorTan(e.target.value)} />
          <Input label="Deductor name" value={deductorName} onChange={(e) => setDeductorName(e.target.value)} />
          <Input label="Deductee PAN" value={deducteePan} onChange={(e) => setDeducteePan(e.target.value)} />
          <Input label="Deductee name" value={deducteeName} onChange={(e) => setDeducteeName(e.target.value)} />
          <Input label="FY" value={fy} onChange={(e) => setFy(e.target.value)} />
          <Input label="Assessment year" value={ay} onChange={(e) => setAy(e.target.value)} />
        </div>
        <div className="space-y-2">
          <p className="text-caption font-medium uppercase tracking-wide text-muted">
            {op === "16" ? "Salary entries (per quarter)" : "Non-salary entries (per section)"}
          </p>
          {entries.map((e, i) => (
            <RowShell key={i} onRemove={() => setEntries(entries.filter((_, j) => j !== i))}>
              <Input label="Id" value={e.id} onChange={(ev) => update(i, { id: ev.target.value })} />
              {op === "16" ? (
                <Input label="Quarter" value={e.quarter} onChange={(ev) => update(i, { quarter: ev.target.value })} />
              ) : (
                <Input label="Section" value={e.section} onChange={(ev) => update(i, { section: ev.target.value })} />
              )}
              <Input
                label="Payment date"
                type="date"
                value={e.dateOfPayment}
                onChange={(ev) => update(i, { dateOfPayment: ev.target.value })}
              />
              <Input
                label="Gross amount ₹"
                inputMode="decimal"
                value={e.grossAmount}
                onChange={(ev) => update(i, { grossAmount: ev.target.value })}
              />
              <Input
                label="TDS ₹"
                inputMode="decimal"
                value={e.tdsAmount}
                onChange={(ev) => update(i, { tdsAmount: ev.target.value })}
              />
            </RowShell>
          ))}
          <AddRow
            label="Entry"
            onClick={() => setEntries([...entries, { ...entries[0]!, id: `e${entries.length + 1}` }])}
          />
        </div>
        {op === "16" ? (
          <div className="grid grid-cols-3 gap-2">
            <Input
              label="Total salary ₹"
              inputMode="decimal"
              value={totalSalary}
              onChange={(e) => setTotalSalary(e.target.value)}
            />
            <Input
              label="Chapter VI-A ₹"
              inputMode="decimal"
              value={chapterVIA}
              onChange={(e) => setChapterVIA(e.target.value)}
            />
            <Input
              label="TDS deducted ₹"
              inputMode="decimal"
              value={tdsDeducted}
              onChange={(e) => setTdsDeducted(e.target.value)}
            />
          </div>
        ) : null}
        <Button type="button" onClick={run} loading={busy}>
          Build certificate
        </Button>
        <ErrorLine message={error} />
        {partA && partB ? (
          <div>
            <Money label="Part A — salary paid" value={partA.totalSalaryPaid} />
            <Money label="Part A — TDS deducted" value={partA.totalTdsDeducted} />
            <Money label="Part B — total income" value={partB.taxComputation.totalIncome} />
            <Money label="Part B — tax on total income" value={partB.taxComputation.taxOnTotalIncome} />
            <Money label="Part B — cess" value={partB.taxComputation.cess} />
            <Money label="Part B — total tax liability" value={partB.taxComputation.totalTaxLiability} tone="warn" />
          </div>
        ) : null}
        {form16A ? (
          <div>
            <Money label="Total amount paid" value={form16A.totalAmount} />
            <Money label="Total TDS deducted" value={form16A.totalTdsDeducted} tone="warn" />
            <p className="text-caption text-muted">Sections: {form16A.sections.map((s) => s.section).join(", ")}</p>
          </div>
        ) : null}
        {validation ? <Warnings items={validation.valid ? [] : validation.issues} /> : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel — S.44AB tax-audit determination (ca-tax-audit)
// ---------------------------------------------------------------------------

interface TaxAuditResult {
  fy: string;
  turnoverAnalysis: {
    grossTurnover: number;
    presumptiveTurnover: number;
    exemptTurnover: number;
    turnoverForAuditLimitation: number;
  };
  triggers: { name: string; applies: boolean; note: string }[];
  warnings: string[];
  methodology: string[];
}

function TaxAuditPanel() {
  const [fy, setFy] = useState("2025-26");
  const [entityType, setEntityType] = useState("company");
  const [category, setCategory] = useState("domestic-company");
  const [turnover, setTurnover] = useState("1000000000");
  const [presumptive, setPresumptive] = useState("0");
  const [exempt, setExempt] = useState("0");
  const [booksRequired, setBooksRequired] = useState(true);
  const [professional, setProfessional] = useState(false);
  const [presumptiveOpted, setPresumptiveOpted] = useState(false);
  const [digitalPct, setDigitalPct] = useState("0");
  const [result, setResult] = useState<TaxAuditResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ taxAudit: TaxAuditResult }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "tax-audit",
          fy,
          entityType,
          category,
          turnover: n(turnover),
          presumptiveTurnover: n(presumptive),
          exemptTurnover: n(exempt),
          booksRequired,
          auditedTurnoverFlag: false,
          professionalServices: professional,
          presumptiveOpted,
          digitalReceiptsPct: n(digitalPct),
        }),
      });
      setResult(res.taxAudit);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tax audit under S.44AB</CardTitle>
        <CardDescription>
          Aggregate turnover / gross receipts (including presumptive and exempt amounts) against the commonly referenced
          limitation, plus the presumptive-scheme and profession flags. Figures are rupee-native.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Input label="FY" value={fy} onChange={(e) => setFy(e.target.value)} />
          <Input label="Entity type" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
          <Select
            label="Limitation category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={[
              { value: "domestic-company", label: "Domestic company" },
              { value: "unlisted-company", label: "Unlisted company" },
              { value: "partnership-firm", label: "Partnership firm" },
              { value: "llp", label: "LLP" },
              { value: "hindu-undivided-family", label: "HUF" },
              { value: "resident", label: "Resident individual" },
            ]}
          />
          <Input
            label="Turnover ₹"
            inputMode="decimal"
            value={turnover}
            onChange={(e) => setTurnover(e.target.value)}
          />
          <Input
            label="Presumptive turnover ₹"
            inputMode="decimal"
            value={presumptive}
            onChange={(e) => setPresumptive(e.target.value)}
          />
          <Input
            label="Exempt turnover ₹"
            inputMode="decimal"
            value={exempt}
            onChange={(e) => setExempt(e.target.value)}
          />
          <Input
            label="Digital receipts %"
            inputMode="decimal"
            value={digitalPct}
            onChange={(e) => setDigitalPct(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Checkbox label="Books required" checked={booksRequired} onChange={setBooksRequired} />
          <Checkbox label="Professional services" checked={professional} onChange={setProfessional} />
          <Checkbox label="Presumptive opted" checked={presumptiveOpted} onChange={setPresumptiveOpted} />
        </div>
        <Button type="button" onClick={run} loading={busy}>
          Determine audit
        </Button>
        <ErrorLine message={error} />
        {result ? (
          <div>
            <Money
              label="Turnover for the limitation"
              value={result.turnoverAnalysis.turnoverForAuditLimitation * 100}
            />
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Trigger</th>
                  <th className="py-1">Applies</th>
                </tr>
              </thead>
              <tbody>
                {result.triggers.map((t) => (
                  <tr key={t.name} className="border-t border-line/60 align-top">
                    <td className="py-1.5">
                      <span className="text-foreground">{t.name}</span>
                      <p className="text-caption text-muted">{t.note}</p>
                    </td>
                    <td className={`py-1.5 ${t.applies ? "text-amber-600" : "text-muted"}`}>
                      {t.applies ? "Yes" : "No"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Warnings items={result.warnings} />
            <Method steps={result.methodology} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel — ITR schedule document assembly (itr-schedules)
// ---------------------------------------------------------------------------

function ItrSchedulesPanel() {
  const [formType, setFormType] = useState<"ITR-3" | "ITR-5" | "ITR-6">("ITR-5");
  const [ay, setAy] = useState("2026-27");
  const [entityName, setEntityName] = useState("Partners LLP");
  const [pan, setPan] = useState("AAAPA1234A");
  const [secondary, setSecondary] = useState("150000");
  const [primary, setPrimary] = useState("200000");
  const [grossTotalIncome, setGrossTotalIncome] = useState("200000");
  const [totalTax, setTotalTax] = useState("31200");
  const [xml, setXml] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; errors: string[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which schedule codes this form type requires, and what the two amount fields mean.
  const shape =
    formType === "ITR-5"
      ? {
          required: [{ code: "BP", header: "Business/Profession", label: "Net profit ₹" }],
          secondary: { code: "PMT", header: "Profit sharing", label: "Partner share ₹" },
        }
      : formType === "ITR-6"
        ? {
            required: [{ code: "PLC", header: "Profit & Loss", label: "P&L profit ₹" }],
            secondary: { code: "CYM", header: "Tax computation", label: "Tax per P&L ₹" },
          }
        : { required: [{ code: "BP", header: "Business/Profession", label: "Net profit ₹" }], secondary: null };

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const schedules: Record<string, { header: string; lines: { label: string; amount: number }[] }> = {};
      for (const s of shape.required)
        schedules[s.code] = { header: s.header, lines: [{ label: s.label, amount: n(primary) }] };
      if (shape.secondary)
        schedules[shape.secondary.code] = {
          header: shape.secondary.header,
          lines: [{ label: shape.secondary.label, amount: n(secondary) }],
        };

      const res = await api<{
        itrSchedules: { xml: string; validation: { valid: boolean; errors: string[]; warnings: string[] } | null };
      }>("/api/ca/compute", {
        method: "POST",
        body: JSON.stringify({
          kind: "itr-schedules",
          formType,
          assessmentYear: ay,
          general: { pan, name: entityName },
          schedules,
          income: { "Gross Total Income": n(grossTotalIncome) },
          tax: { "Total Tax Liability": n(totalTax) },
        }),
      });
      setXml(res.itrSchedules.xml);
      setValidation(res.itrSchedules.validation);
    } catch (err) {
      setXml(null);
      setValidation(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>ITR schedule document</CardTitle>
        <CardDescription>
          Assembles the schedule payload and its serialisation for an entity return, and checks the schedules that form
          type requires. Amounts are entered in rupees; the document is built in paise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Select
            label="Form"
            value={formType}
            onChange={(e) => setFormType(e.target.value as "ITR-3" | "ITR-5" | "ITR-6")}
            options={[
              { value: "ITR-3", label: "ITR-3 (business/profession)" },
              { value: "ITR-5", label: "ITR-5 (firm/LLP)" },
              { value: "ITR-6", label: "ITR-6 (company)" },
            ]}
          />
          <Input label="Assessment year" value={ay} onChange={(e) => setAy(e.target.value)} />
          <Input label="PAN" value={pan} onChange={(e) => setPan(e.target.value)} />
          <Input label="Name" value={entityName} onChange={(e) => setEntityName(e.target.value)} />
          <Input
            label={shape.required[0]!.label}
            inputMode="decimal"
            value={primary}
            onChange={(e) => setPrimary(e.target.value)}
          />
          {shape.secondary ? (
            <Input
              label={shape.secondary.label}
              inputMode="decimal"
              value={secondary}
              onChange={(e) => setSecondary(e.target.value)}
            />
          ) : null}
          <Input
            label="Gross total income ₹"
            inputMode="decimal"
            value={grossTotalIncome}
            onChange={(e) => setGrossTotalIncome(e.target.value)}
          />
          <Input
            label="Total tax liability ₹"
            inputMode="decimal"
            value={totalTax}
            onChange={(e) => setTotalTax(e.target.value)}
          />
        </div>
        <Button type="button" onClick={run} loading={busy}>
          Assemble schedules
        </Button>
        <ErrorLine message={error} />
        {validation ? (
          <div>
            <p className={`text-sm font-medium ${validation.valid ? "text-emerald-600" : "text-amber-600"}`}>
              {validation.valid ? "All required schedules present." : `${validation.errors.length} missing/invalid:`}
            </p>
            <Warnings items={[...validation.errors, ...validation.warnings]} />
          </div>
        ) : null}
        {xml ? (
          <details className="rounded-md border border-line bg-surface-2/40 p-3">
            <summary className="cursor-pointer text-sm font-medium text-foreground">Serialised document</summary>
            <pre className="mt-2 max-h-80 overflow-auto text-caption text-muted">{xml}</pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TdsPanel() {
  return (
    <div className="space-y-6">
      <SectionLookup />
      <ThresholdPanel />
      <TdsComputationPanel />
      <LdcPanel />
      <Form16Panel />
      <ChallanRecon />
      <ExposurePanel />
    </div>
  );
}

function AuditPanel() {
  return (
    <div className="space-y-6">
      <TaxAuditPanel />
      <ItrSchedulesPanel />
    </div>
  );
}

function AuditTypesPanel() {
  // The three audit types share one tab: an internal (COSO) audit, a bank
  // concurrent audit, and a physical stock verification.
  return (
    <div className="space-y-6">
      <InternalAuditPanel />
      <ConcurrentAuditPanel />
      <StockAuditPanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace shell
// ---------------------------------------------------------------------------

export function CaComputeWorkspace() {
  const [tab, setTab] = useState("tax");
  return (
    <Tabs
      items={[
        { key: "tax", label: "Income tax & advance tax" },
        { key: "salary", label: "Salary head" },
        { key: "house", label: "House property" },
        { key: "cg", label: "Capital gains" },
        { key: "tds", label: "TDS" },
        { key: "audit", label: "Audit & schedules" },
        { key: "internal-audit", label: "Internal / concurrent / stock audit" },
        { key: "litigation", label: "Litigation & appeals" },
        { key: "timesheets", label: "Timesheets / billing" },
        { key: "documents", label: "Documents & client portal" },
        { key: "itr-u", label: "ITR-U / updated returns" },
      ]}
      active={tab}
      onChange={setTab}
    >
      <SampleDataNotice />
      {tab === "tax" ? <TaxPanel /> : null}
      {tab === "salary" ? <SalaryPanel /> : null}
      {tab === "house" ? <HousePropertyPanel /> : null}
      {tab === "cg" ? <CapitalGainsPanel /> : null}
      {tab === "tds" ? <TdsPanel /> : null}
      {tab === "audit" ? <AuditPanel /> : null}
      {tab === "internal-audit" ? <AuditTypesPanel /> : null}
      {tab === "litigation" ? <LitigationPanel /> : null}
      {tab === "timesheets" ? <TimesheetsPanel /> : null}
      {tab === "documents" ? <DocumentsPanel /> : null}
      {tab === "itr-u" ? <ItrUPanel /> : null}
    </Tabs>
  );
}
