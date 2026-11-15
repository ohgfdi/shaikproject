"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox, Input, Textarea } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/client/api";
import type { ItrUValidation, UpdatedReturnResult } from "@/lib/engine/itr-u";

import { ErrorLine, Method, Money, n, postCompute, Warnings } from "./ca-practice-panels";

/**
 * ITR-U (updated return) panel.
 *
 * The window and the s.140B band both run from the END of the relevant
 * assessment year, and the percentage applies to additional tax + interest —
 * not to the tax alone. Every figure the engine returns is in paise.
 */

function ItrUPanel() {
  const [form, setForm] = useState({
    pan: "AAAAA0000A",
    name: "Sharma Textiles Pvt Ltd",
    assessmentYear: "2023-24",
    originalReturnFiledDate: "2024-07-31",
    updatedReturnFilingDate: "2024-12-15",
    originalTotalIncome: "1000000",
    updatedTotalIncome: "1500000",
    taxOnOriginal: "1000",
    taxOnUpdated: "2500",
    interestOnUpdated: "300",
    taxAlreadyPaid: "1000",
  });
  const [flags, setFlags] = useState({
    pendingProceedings: false,
    searchOrSurvey: false,
    reducesReportedIncome: false,
    showsLoss: false,
  });
  const [reasons, setReasons] = useState("Incorrect reporting of interest income");
  const [result, setResult] = useState<UpdatedReturnResult | null>(null);
  const [validation, setValidation] = useState<ItrUValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ updatedReturn: UpdatedReturnResult; validation: ItrUValidation }>({
        kind: "itr-u",
        pan: form.pan,
        name: form.name,
        assessmentYear: form.assessmentYear,
        originalReturnFiledDate: form.originalReturnFiledDate || null,
        updatedReturnFilingDate: form.updatedReturnFilingDate,
        originalTotalIncome: n(form.originalTotalIncome),
        updatedTotalIncome: n(form.updatedTotalIncome),
        taxOnOriginal: n(form.taxOnOriginal),
        taxOnUpdated: n(form.taxOnUpdated),
        interestOnUpdated: n(form.interestOnUpdated),
        taxAlreadyPaid: n(form.taxAlreadyPaid),
        ...flags,
        reasons: reasons
          .split("\n")
          .map((r) => r.trim())
          .filter(Boolean),
      });
      setResult(res.updatedReturn);
      setValidation(res.validation);
    } catch (err) {
      setResult(null);
      setValidation(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>ITR-U — updated return (s.139(8A))</CardTitle>
        <CardDescription>
          The updating window and the s.140B additional tax run from the end of the relevant assessment year. The engine
          reports the band it applied and the blockers your own fact flags raise; eligibility in law stays your call.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Input
            label="PAN"
            value={form.pan}
            onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })}
          />
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input
            label="Assessment year"
            value={form.assessmentYear}
            onChange={(e) => setForm({ ...form, assessmentYear: e.target.value })}
          />
          <Input
            label="Original return filed"
            type="date"
            value={form.originalReturnFiledDate}
            onChange={(e) => setForm({ ...form, originalReturnFiledDate: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Input
            label="Updated return filing date"
            type="date"
            value={form.updatedReturnFilingDate}
            onChange={(e) => setForm({ ...form, updatedReturnFilingDate: e.target.value })}
          />
          <Input
            label="Original total income (₹)"
            inputMode="decimal"
            value={form.originalTotalIncome}
            onChange={(e) => setForm({ ...form, originalTotalIncome: e.target.value })}
          />
          <Input
            label="Updated total income (₹)"
            inputMode="decimal"
            value={form.updatedTotalIncome}
            onChange={(e) => setForm({ ...form, updatedTotalIncome: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Input
            label="Tax on original (₹)"
            inputMode="decimal"
            value={form.taxOnOriginal}
            onChange={(e) => setForm({ ...form, taxOnOriginal: e.target.value })}
          />
          <Input
            label="Tax on updated (₹)"
            inputMode="decimal"
            value={form.taxOnUpdated}
            onChange={(e) => setForm({ ...form, taxOnUpdated: e.target.value })}
          />
          <Input
            label="Interest on updated (₹)"
            inputMode="decimal"
            value={form.interestOnUpdated}
            onChange={(e) => setForm({ ...form, interestOnUpdated: e.target.value })}
          />
          <Input
            label="Tax already paid (₹)"
            inputMode="decimal"
            value={form.taxAlreadyPaid}
            onChange={(e) => setForm({ ...form, taxAlreadyPaid: e.target.value })}
          />
        </div>
        <Textarea
          rows={2}
          label="Reasons for updating (one per line)"
          value={reasons}
          onChange={(e) => setReasons(e.target.value)}
        />
        <div className="flex flex-wrap gap-4">
          <Checkbox
            label="Assessment / reassessment pending"
            checked={flags.pendingProceedings}
            onChange={(v) => setFlags({ ...flags, pendingProceedings: v })}
          />
          <Checkbox
            label="Search or survey"
            checked={flags.searchOrSurvey}
            onChange={(v) => setFlags({ ...flags, searchOrSurvey: v })}
          />
          <Checkbox
            label="Reduces reported income / seeks refund"
            checked={flags.reducesReportedIncome}
            onChange={(v) => setFlags({ ...flags, reducesReportedIncome: v })}
          />
          <Checkbox
            label="Shows or increases a loss"
            checked={flags.showsLoss}
            onChange={(v) => setFlags({ ...flags, showsLoss: v })}
          />
        </div>

        <Button type="button" onClick={run} loading={busy}>
          Compute the updated return
        </Button>
        <ErrorLine message={error} />

        {result ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="rounded-full border border-line px-3 py-1">
                s.140B band:{" "}
                <strong>{result.bandRatePct === null ? "outside the window" : `${result.bandRatePct}%`}</strong>
              </span>
              <span className="text-caption text-muted">
                AY ended {result.endOfAssessmentYear} · filed {result.monthsElapsed} whole month(s) later
              </span>
              <span className={result.eligible ? "text-emerald-600" : "text-amber-600"}>
                {result.eligible ? "No blocker raised by the supplied facts" : `${result.blockers.length} blocker(s)`}
              </span>
            </div>
            <Money label="Additional income" value={result.additionalIncomeMinor} />
            <Money label="Additional tax on that income" value={result.additionalTaxOnIncomeMinor} />
            <Money label="Interest on the updated figures" value={result.interestOnUpdatedMinor} />
            <Money label="Base for the s.140B charge" value={result.baseForAdditionalTaxMinor} />
            <Money label="s.140B additional tax" value={result.additionalTax140BMinor} tone="warn" />
            <Money label="Total liability" value={result.totalLiabilityMinor} />
            <Money label="Tax already paid" value={result.taxAlreadyPaidMinor} />
            <Money
              label="Net payable"
              value={result.netPayableMinor}
              tone={result.netPayableMinor > 0 ? "warn" : "ok"}
            />
            <Warnings items={result.blockers} />
            <ul className="space-y-1 text-caption text-muted">
              {result.breakdown.map((line: string) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {validation ? <Warnings items={[...validation.errors, ...validation.warnings]} /> : null}
            <details className="rounded-md border border-line bg-surface-2/40 p-3">
              <summary className="cursor-pointer text-sm font-medium text-foreground">ITR-U payload</summary>
              <pre className="mt-2 max-h-80 overflow-auto text-caption text-muted">
                {JSON.stringify(result.payload, null, 2)}
              </pre>
            </details>
            <Method steps={result.methodology} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export { ItrUPanel };
