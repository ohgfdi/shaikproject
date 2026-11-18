"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { ConcurrentAuditResult, InternalAuditResult, StockAuditResult } from "@/lib/engine/ca-internal-audit";import type { AppealPlan, LitigationPortfolio } from "@/lib/engine/ca-litigation";
  import type { RocResult } from "@/lib/engine/ca-roc-compliance";
import { formatInr } from "@/lib/engine/india-tax";

import { ErrorLine, Method, Money, Warnings, parseAmount as n } from "./ca-result-primitives";

/**
 * CA practice-area panels — the UI surface for the practice modules that had
 * engines but no screen: internal / concurrent / stock audit, litigation,
 * timesheets & billing, document management & client portal, and ITR-U.
 *
 * Every panel POSTs to `/api/ca/compute` and renders the engine's own answer.
 * Money the panel SENDS is RUPEES (the API boundary) and money it RECEIVES is
 * integer PAISE, so every render goes through `formatInr` and never through a
 * bare `/100`.
 */

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function ReportSections({ sections }: { sections: { heading: string; body: string }[] }) {
  if (!sections?.length) return null;
  return (
    <div className="mt-4 space-y-2">
      {sections.map((s) => (
        <details key={s.heading} className="rounded-md border border-line bg-surface-2/30 p-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">{s.heading}</summary>
          <pre className="mt-2 whitespace-pre-wrap text-caption text-muted">{s.body}</pre>
        </details>
      ))}
    </div>
  );
}

async function postCompute<T>(body: unknown): Promise<T> {
  return api<T>("/api/ca/compute", { method: "POST", body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// Internal audit
// ---------------------------------------------------------------------------

const COSO_COMPONENTS = [
  { key: "control-environment", label: "Control environment" },
  { key: "risk-assessment", label: "Risk assessment" },
  { key: "control-activities", label: "Control activities" },
  { key: "information-and-communication", label: "Information & communication" },
  { key: "monitoring-activities", label: "Monitoring activities" },
] as const;

const RATINGS = [
  { value: "effective", label: "Effective" },
  { value: "adequate", label: "Adequate" },
  { value: "needs-improvement", label: "Needs improvement" },
  { value: "ineffective", label: "Ineffective" },
];

const RISK_RATINGS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const TESTING_METHODS = [
  { value: "inquiry", label: "Inquiry" },
  { value: "observation", label: "Observation" },
  { value: "inspection", label: "Inspection" },
  { value: "reperformance", label: "Reperformance" },
  { value: "walkthrough", label: "Walkthrough" },
];

interface CosoRating {
  design: string;
  operating: string;
  method: string;
}

interface InternalAuditFinding {
  id: string;
  findingTitle: string;
  processArea: string;
  cosoComponent: string;
  riskRating: string;
  criteria: string;
  condition: string;
  cause: string;
  effect: string;
  recommendation: string;
  targetDate: string;
}

const BLANK_FINDING: Omit<InternalAuditFinding, "id"> = {
  findingTitle: "",
  processArea: "procure-to-pay",
  cosoComponent: "control-activities",
  riskRating: "high",
  criteria: "",
  condition: "",
  cause: "",
  effect: "",
  recommendation: "",
  targetDate: "",
};

function InternalAuditPanel() {
  const [entityName, setEntityName] = useState("Sharma Textiles Pvt Ltd");
  const [fiscalYear, setFiscalYear] = useState("2025-26");
  const [materiality, setMateriality] = useState("500000");
  const [riskRating, setRiskRating] = useState("medium");
  const [scope, setScope] = useState("procure-to-pay, payroll");
  const [ratings, setRatings] = useState<Record<string, CosoRating>>(
    Object.fromEntries(
      COSO_COMPONENTS.map((c) => [c.key, { design: "adequate", operating: "adequate", method: "inquiry" }]),
    ),
  );
  const [findings, setFindings] = useState<InternalAuditFinding[]>([
    {
      ...BLANK_FINDING,
      id: "ISS-1",
      findingTitle: "Three-way match not evidenced",
      condition: "GRN reference missing on 12 of 40 vouchers.",
      criteria: "Policy requires a three-way match before payment.",
      cause: "Manual matching under time pressure.",
      effect: "Risk of payment for goods not received.",
      recommendation: "Block payment until the match is evidenced.",
      targetDate: "2026-03-31",
    },
  ]);
  const [result, setResult] = useState<InternalAuditResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateFinding = (i: number, patch: Partial<InternalAuditFinding>) =>
    setFindings(findings.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ internalAudit: InternalAuditResult }>({
        kind: "internal-audit",
        op: {
          op: "assess",
          plan: {
            engagementName: `Internal audit ${fiscalYear}`,
            entityName,
            fiscalYear,
            auditObjective: "Assess the design and operating effectiveness of the in-scope processes.",
            scopeIn: scope
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            materiality: n(materiality),
            riskRating,
            cosoComponents: COSO_COMPONENTS.map((c) => ({
              component: c.key,
              description: c.label,
              designRating: ratings[c.key]?.design ?? "adequate",
              operatingRating: ratings[c.key]?.operating ?? "adequate",
              evidenceMethod: ratings[c.key]?.method ?? "inquiry",
            })),
            issues: findings.map((f) => ({
              id: f.id,
              findingTitle: f.findingTitle || "Untitled finding",
              processArea: f.processArea,
              cosoComponent: f.cosoComponent,
              riskRating: f.riskRating,
              description: f.condition || "Not recorded",
              criteria: f.criteria || "Not recorded",
              condition: f.condition || "Not recorded",
              cause: f.cause || "Not recorded",
              effect: f.effect || "Not recorded",
              recommendation: f.recommendation || "Not recorded",
              status: "open",
              raisedBy: "Workspace user",
              raisedAt: new Date().toISOString().slice(0, 10),
              targetDate: f.targetDate || null,
            })),
          },
        },
      });
      setResult(res.internalAudit);
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
        <CardTitle>Internal audit — COSO assessment</CardTitle>
        <CardDescription>
          Rate design and operating effectiveness across the five COSO components and raise findings. The engagement
          rating is the worst component rating; overdue items are computed against today&apos;s date.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Input label="Entity" value={entityName} onChange={(e) => setEntityName(e.target.value)} />
          <Input label="Fiscal year" value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} />
          <Input
            label="Materiality (₹)"
            inputMode="decimal"
            value={materiality}
            onChange={(e) => setMateriality(e.target.value)}
          />
          <Select
            label="Engagement risk"
            value={riskRating}
            onChange={(e) => setRiskRating(e.target.value)}
            options={RISK_RATINGS.slice(0, 3)}
          />
        </div>
        <Input label="In scope (comma separated)" value={scope} onChange={(e) => setScope(e.target.value)} />

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-caption uppercase tracking-wide text-muted">
                <th className="py-1">COSO component</th>
                <th className="py-1">Design</th>
                <th className="py-1">Operating</th>
                <th className="py-1">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {COSO_COMPONENTS.map((c) => (
                <tr key={c.key} className="border-t border-line/60">
                  <td className="py-1.5 pr-3">{c.label}</td>
                  <td className="py-1 pr-3">
                    <Select
                      label=""
                      value={ratings[c.key]?.design}
                      onChange={(e) =>
                        setRatings({ ...ratings, [c.key]: { ...ratings[c.key]!, design: e.target.value } })
                      }
                      options={RATINGS}
                      aria-label={`${c.label} design rating`}
                    />
                  </td>
                  <td className="py-1 pr-3">
                    <Select
                      label=""
                      value={ratings[c.key]?.operating}
                      onChange={(e) =>
                        setRatings({ ...ratings, [c.key]: { ...ratings[c.key]!, operating: e.target.value } })
                      }
                      options={RATINGS}
                      aria-label={`${c.label} operating rating`}
                    />
                  </td>
                  <td className="py-1">
                    <Select
                      label=""
                      value={ratings[c.key]?.method}
                      onChange={(e) =>
                        setRatings({ ...ratings, [c.key]: { ...ratings[c.key]!, method: e.target.value } })
                      }
                      options={TESTING_METHODS}
                      aria-label={`${c.label} evidence method`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-3">
          {findings.map((f, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line bg-surface-2/30 p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input label="Id" value={f.id} onChange={(e) => updateFinding(i, { id: e.target.value })} />
                <Input
                  label="Finding"
                  value={f.findingTitle}
                  onChange={(e) => updateFinding(i, { findingTitle: e.target.value })}
                />
                <Input
                  label="Process area"
                  value={f.processArea}
                  onChange={(e) => updateFinding(i, { processArea: e.target.value })}
                />
                <Select
                  label="Risk"
                  value={f.riskRating}
                  onChange={(e) => updateFinding(i, { riskRating: e.target.value })}
                  options={RISK_RATINGS}
                />
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Textarea
                  rows={2}
                  label="Criteria"
                  value={f.criteria}
                  onChange={(e) => updateFinding(i, { criteria: e.target.value })}
                />
                <Textarea
                  rows={2}
                  label="Condition"
                  value={f.condition}
                  onChange={(e) => updateFinding(i, { condition: e.target.value })}
                />
                <Textarea
                  rows={2}
                  label="Cause"
                  value={f.cause}
                  onChange={(e) => updateFinding(i, { cause: e.target.value })}
                />
                <Textarea
                  rows={2}
                  label="Effect"
                  value={f.effect}
                  onChange={(e) => updateFinding(i, { effect: e.target.value })}
                />
                <Textarea
                  rows={2}
                  label="Recommendation"
                  value={f.recommendation}
                  onChange={(e) => updateFinding(i, { recommendation: e.target.value })}
                />
                <Input
                  label="Target date"
                  type="date"
                  value={f.targetDate}
                  onChange={(e) => updateFinding(i, { targetDate: e.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setFindings(findings.filter((_, j) => j !== i))}
              >
                Remove finding
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              setFindings([...findings, { ...BLANK_FINDING, id: `ISS-${findings.length + 1}`, targetDate: "" }])
            }
          >
            + Finding
          </Button>
        </div>

        <Button type="button" onClick={run} loading={busy}>
          Assess internal audit
        </Button>
        <ErrorLine message={error} />

        {result ? (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full border border-line px-3 py-1 text-sm">
                Overall: <strong>{result.overallRating}</strong>
              </span>
              <span className="text-caption text-muted">
                {result.openIssues.length} open · {result.overdueIssues.length} overdue ·{" "}
                {result.highRiskFindings.length} high risk
              </span>
              <span className={`text-caption ${result.reportReady ? "text-emerald-600" : "text-amber-600"}`}>
                {result.reportReady ? "Report ready" : "Report not ready"}
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Component</th>
                  <th className="py-1">Design</th>
                  <th className="py-1">Operating</th>
                  <th className="py-1">Overall</th>
                </tr>
              </thead>
              <tbody>
                {result.cosoSummary.map((c) => (
                  <tr key={c.component} className="border-t border-line/60">
                    <td className="py-1.5">{c.component}</td>
                    <td className="py-1.5">{c.design}</td>
                    <td className="py-1.5">{c.operating}</td>
                    <td className={`py-1.5 ${c.overall === "effective" ? "text-emerald-600" : "text-amber-600"}`}>
                      {c.overall}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.openIssues.length ? (
              <ul className="space-y-1 text-caption text-muted">
                {result.openIssues.map((i) => (
                  <li key={i.id}>
                    <strong className="text-foreground">{i.id}</strong> {i.findingTitle} — {i.riskRating}
                    {i.targetDate ? ` (due ${i.targetDate})` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            <ReportSections sections={result.reportSections} />
            <Method steps={result.methodology} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Concurrent audit
// ---------------------------------------------------------------------------

interface ConcurrentObservationRow {
  ref: string;
  area: string;
  description: string;
  category: string;
  severity: string;
  correctiveAction: string;
  status: string;
}

interface PrudentialRow {
  limitName: string;
  regulatoryLimit: string;
  actualExposure: string;
}

function ConcurrentAuditPanel() {
  const [branchCode, setBranchCode] = useState("BR-014");
  const [branchName, setBranchName] = useState("Pune Camp");
  const [period, setPeriod] = useState({ from: "2025-04-01", to: "2025-06-30" });
  const [manager, setManager] = useState("S. Kulkarni");
  const [transactionsTested, setTransactionsTested] = useState("50");
  const [amountTested, setAmountTested] = useState("2500000");
  const [limits, setLimits] = useState<PrudentialRow[]>([
    { limitName: "Single borrower exposure", regulatoryLimit: "10000000", actualExposure: "12000000" },
  ]);
  const [observations, setObservations] = useState<ConcurrentObservationRow[]>([
    {
      ref: "OBS-1",
      area: "KYC",
      description: "Two accounts opened without a PAN copy",
      category: "compliance",
      severity: "critical",
      correctiveAction: "Obtain the PAN copies",
      status: "open",
    },
  ]);
  const [result, setResult] = useState<ConcurrentAuditResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ concurrentAudit: ConcurrentAuditResult }>({
        kind: "concurrent-audit",
        op: {
          op: "assess",
          branch: {
            branchCode,
            branchName,
            centerHead: "Zonal Office",
            branchManager: manager,
            examinationPeriod: period,
            transactionsTested: Math.round(n(transactionsTested)),
            transactionsTestedAmount: n(amountTested),
            kycSampleTested: 0,
            amlAlertReviewed: 0,
            interestCalculationTested: 0,
            prudentialLimitChecks: limits.map((l) => ({
              limitName: l.limitName,
              regulatoryLimit: n(l.regulatoryLimit),
              actualExposure: n(l.actualExposure),
              description: l.limitName,
            })),
            observations: observations.map((o) => ({
              ref: o.ref,
              area: o.area,
              description: o.description,
              category: o.category,
              severity: o.severity,
              correctiveAction: o.correctiveAction,
              status: o.status,
              detectedBy: "Workspace user",
              detectedOn: new Date().toISOString().slice(0, 10),
            })),
            concurrentAuditor: "Workspace user",
            auditReportDate: new Date().toISOString().slice(0, 10),
          },
        },
      });
      setResult(res.concurrentAudit);
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
        <CardTitle>Concurrent audit — branch examination</CardTitle>
        <CardDescription>
          Sample testing, observation scoring and prudential-limit reconciliation. A critical open observation blocks
          report sign-off; a breach is exposure above the limit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Input label="Branch code" value={branchCode} onChange={(e) => setBranchCode(e.target.value)} />
          <Input label="Branch name" value={branchName} onChange={(e) => setBranchName(e.target.value)} />
          <Input label="Branch manager" value={manager} onChange={(e) => setManager(e.target.value)} />
          <Input
            label="Transactions tested"
            inputMode="numeric"
            value={transactionsTested}
            onChange={(e) => setTransactionsTested(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Input
            label="Period from"
            type="date"
            value={period.from}
            onChange={(e) => setPeriod({ ...period, from: e.target.value })}
          />
          <Input
            label="Period to"
            type="date"
            value={period.to}
            onChange={(e) => setPeriod({ ...period, to: e.target.value })}
          />
          <Input
            label="Amount tested (₹)"
            inputMode="decimal"
            value={amountTested}
            onChange={(e) => setAmountTested(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Prudential limits</p>
          {limits.map((l, i) => (
            <div key={i} className="grid grid-cols-3 gap-2 rounded-md border border-line bg-surface-2/30 p-2">
              <Input
                label="Limit"
                value={l.limitName}
                onChange={(e) => setLimits(limits.map((x, j) => (j === i ? { ...x, limitName: e.target.value } : x)))}
              />
              <Input
                label="Regulatory limit (₹)"
                inputMode="decimal"
                value={l.regulatoryLimit}
                onChange={(e) =>
                  setLimits(limits.map((x, j) => (j === i ? { ...x, regulatoryLimit: e.target.value } : x)))
                }
              />
              <Input
                label="Actual exposure (₹)"
                inputMode="decimal"
                value={l.actualExposure}
                onChange={(e) =>
                  setLimits(limits.map((x, j) => (j === i ? { ...x, actualExposure: e.target.value } : x)))
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setLimits([...limits, { limitName: "", regulatoryLimit: "0", actualExposure: "0" }])}
          >
            + Limit
          </Button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Observations</p>
          {observations.map((o, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line bg-surface-2/30 p-2">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input
                  label="Ref"
                  value={o.ref}
                  onChange={(e) =>
                    setObservations(observations.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)))
                  }
                />
                <Input
                  label="Area"
                  value={o.area}
                  onChange={(e) =>
                    setObservations(observations.map((x, j) => (j === i ? { ...x, area: e.target.value } : x)))
                  }
                />
                <Select
                  label="Category"
                  value={o.category}
                  onChange={(e) =>
                    setObservations(observations.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)))
                  }
                  options={[
                    { value: "compliance", label: "Compliance" },
                    { value: "accounting", label: "Accounting" },
                    { value: "operational", label: "Operational" },
                    { value: "fraud-risk", label: "Fraud risk" },
                    { value: "customer-service", label: "Customer service" },
                  ]}
                />
                <Select
                  label="Severity"
                  value={o.severity}
                  onChange={(e) =>
                    setObservations(observations.map((x, j) => (j === i ? { ...x, severity: e.target.value } : x)))
                  }
                  options={[
                    { value: "minor", label: "Minor" },
                    { value: "major", label: "Major" },
                    { value: "critical", label: "Critical" },
                  ]}
                />
              </div>
              <Input
                label="Observation"
                value={o.description}
                onChange={(e) =>
                  setObservations(observations.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
                }
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Corrective action"
                  value={o.correctiveAction}
                  onChange={(e) =>
                    setObservations(
                      observations.map((x, j) => (j === i ? { ...x, correctiveAction: e.target.value } : x)),
                    )
                  }
                />
                <Select
                  label="Status"
                  value={o.status}
                  onChange={(e) =>
                    setObservations(observations.map((x, j) => (j === i ? { ...x, status: e.target.value } : x)))
                  }
                  options={[
                    { value: "open", label: "Open" },
                    { value: "closed", label: "Closed" },
                  ]}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setObservations(observations.filter((_, j) => j !== i))}
              >
                Remove observation
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              setObservations([
                ...observations,
                {
                  ref: `OBS-${observations.length + 1}`,
                  area: "",
                  description: "",
                  category: "compliance",
                  severity: "minor",
                  correctiveAction: "",
                  status: "open",
                },
              ])
            }
          >
            + Observation
          </Button>
        </div>

        <Button type="button" onClick={run} loading={busy}>
          Assess branch
        </Button>
        <ErrorLine message={error} />

        {result ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="rounded-full border border-line px-3 py-1">
                {result.totalObservations} observations · {result.bySeverity.critical} critical
              </span>
              <span className={result.quarterlyReportReady ? "text-emerald-600" : "text-amber-600"}>
                {result.quarterlyReportReady
                  ? "Ready to sign off"
                  : `${result.openCritical.length} open critical item(s) block sign-off`}
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Prudential limit</th>
                  <th className="py-1 text-right">Limit</th>
                  <th className="py-1 text-right">Exposure</th>
                  <th className="py-1 text-right">Headroom</th>
                </tr>
              </thead>
              <tbody>
                {result.branch.prudentialLimitChecks.map((l) => (
                  <tr key={l.limitName} className="border-t border-line/60">
                    <td className="py-1.5">{l.limitName}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatInr(l.regulatoryLimit)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatInr(l.actualExposure)}</td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${l.breached ? "text-amber-600" : "text-emerald-600"}`}
                    >
                      {formatInr(l.headroom)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ReportSections sections={result.reportSections} />
            <Method steps={result.methodology} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Stock audit
// ---------------------------------------------------------------------------

interface StockAreaRow {
  areaCode: string;
  areaName: string;
  expectedQuantity: string;
  bookValue: string;
  countedQuantity: string;
  countedValue: string;
  verifiedBy: string;
}

function StockAuditPanel() {
  const [entityName, setEntityName] = useState("Sharma Textiles Pvt Ltd");
  const [location, setLocation] = useState("Bhiwandi warehouse");
  const [stockDate, setStockDate] = useState("2026-03-31");
  const [scope, setScope] = useState("full-physical");
  const [materiality, setMateriality] = useState("10000");
  const [highValue, setHighValue] = useState("50000");
  const [areas, setAreas] = useState<StockAreaRow[]>([
    {
      areaCode: "A1",
      areaName: "Yarn store",
      expectedQuantity: "100",
      bookValue: "100000",
      countedQuantity: "95",
      countedValue: "95000",
      verifiedBy: "R. Iyer",
    },
    {
      areaCode: "A2",
      areaName: "Finished goods",
      expectedQuantity: "50",
      bookValue: "50000",
      countedQuantity: "50",
      countedValue: "50000",
      verifiedBy: "R. Iyer",
    },
  ]);
  const [result, setResult] = useState<StockAuditResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<StockAreaRow>) =>
    setAreas(areas.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ stockAudit: StockAuditResult }>({
        kind: "stock-audit",
        op: {
          op: "assess",
          plan: {
            entityName,
            location,
            stockDate,
            countingTeamLead: "R. Iyer",
            countingTeamMembers: ["A. Rao"],
            bookStockValue: areas.reduce((s, a) => s + n(a.bookValue), 0),
            bookStockQuantity: areas.reduce((s, a) => s + Math.round(n(a.expectedQuantity)), 0),
            scope,
            materiality: n(materiality),
            highValueItemThreshold: n(highValue),
            areas: areas.map((a) => ({
              areaCode: a.areaCode,
              areaName: a.areaName,
              expectedQuantity: Math.round(n(a.expectedQuantity)),
              bookValue: n(a.bookValue),
              countedQuantity: a.countedQuantity === "" ? null : Math.round(n(a.countedQuantity)),
              countedValue: a.countedValue === "" ? null : n(a.countedValue),
              countedBy: "A. Rao",
              countedAt: stockDate,
              verifiedBy: a.verifiedBy || null,
              verifiedAt: stockDate,
            })),
          },
        },
      });
      setResult(res.stockAudit);
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
        <CardTitle>Stock audit — physical verification</CardTitle>
        <CardDescription>
          Reconcile counted stock to book stock area by area. Variance is counted − book, and it is material when the
          absolute variance exceeds the materiality you set.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Input label="Entity" value={entityName} onChange={(e) => setEntityName(e.target.value)} />
          <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
          <Input label="Stock date" type="date" value={stockDate} onChange={(e) => setStockDate(e.target.value)} />
          <Select
            label="Scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            options={[
              { value: "full-physical", label: "Full physical" },
              { value: "cycle-count", label: "Cycle count" },
              { value: "test-count", label: "Test count" },
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input
            label="Materiality (₹)"
            inputMode="decimal"
            value={materiality}
            onChange={(e) => setMateriality(e.target.value)}
          />
          <Input
            label="High-value item threshold (₹)"
            inputMode="decimal"
            value={highValue}
            onChange={(e) => setHighValue(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          {areas.map((a, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line bg-surface-2/30 p-2">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input label="Area code" value={a.areaCode} onChange={(e) => update(i, { areaCode: e.target.value })} />
                <Input label="Area name" value={a.areaName} onChange={(e) => update(i, { areaName: e.target.value })} />
                <Input
                  label="Expected qty"
                  inputMode="numeric"
                  value={a.expectedQuantity}
                  onChange={(e) => update(i, { expectedQuantity: e.target.value })}
                />
                <Input
                  label="Book value (₹)"
                  inputMode="decimal"
                  value={a.bookValue}
                  onChange={(e) => update(i, { bookValue: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Input
                  label="Counted qty"
                  inputMode="numeric"
                  value={a.countedQuantity}
                  onChange={(e) => update(i, { countedQuantity: e.target.value })}
                />
                <Input
                  label="Counted value (₹)"
                  inputMode="decimal"
                  value={a.countedValue}
                  onChange={(e) => update(i, { countedValue: e.target.value })}
                />
                <Input
                  label="Verified by"
                  value={a.verifiedBy}
                  onChange={(e) => update(i, { verifiedBy: e.target.value })}
                />
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAreas(areas.filter((_, j) => j !== i))}>
                Remove area
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              setAreas([
                ...areas,
                {
                  areaCode: `A${areas.length + 1}`,
                  areaName: "",
                  expectedQuantity: "0",
                  bookValue: "0",
                  countedQuantity: "",
                  countedValue: "",
                  verifiedBy: "",
                },
              ])
            }
          >
            + Area
          </Button>
        </div>

        <Button type="button" onClick={run} loading={busy}>
          Reconcile stock
        </Button>
        <ErrorLine message={error} />

        {result ? (
          <div className="space-y-2">
            <Money label="Book value" value={result.totalBookValueMinor} />
            <Money label="Counted value" value={result.totalCountedValueMinor ?? 0} />
            <Money
              label="Variance"
              value={result.totalVarianceValueMinor ?? 0}
              tone={result.materialVariance ? "warn" : "ok"}
            />
            <p className="text-caption text-muted">
              Variance {result.variancePct ?? 0}% of book value ·{" "}
              {result.materialVariance ? "above materiality" : "within materiality"} ·{" "}
              {result.reportReady ? "report ready" : "counting incomplete"}
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Area</th>
                  <th className="py-1 text-right">Book qty</th>
                  <th className="py-1 text-right">Counted</th>
                  <th className="py-1 text-right">Variance</th>
                </tr>
              </thead>
              <tbody>
                {result.areasWithVariance.map((a) => (
                  <tr key={a.areaCode} className="border-t border-line/60">
                    <td className="py-1.5">
                      {a.areaCode} <span className="text-caption text-muted">{a.areaName}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{a.expectedQuantity}</td>
                    <td className="py-1.5 text-right tabular-nums">{a.countedQuantity ?? "—"}</td>
                    <td className="py-1.5 text-right tabular-nums text-amber-600">
                      {a.varianceQuantity ?? 0} / {formatInr(a.varianceValueMinor ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ReportSections sections={result.reportSections} />
            <Method steps={result.methodology} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ROC compliance
// ---------------------------------------------------------------------------

interface RocFilingRow {
  formType: string;
  dueDate: string;
  status: "upcoming" | "due" | "overdue";
  daysToDue: number;
}

export function RocCompliancePanel() {
  const [cin, setCin] = useState("ABCD1234AF");
  const [companyType, setCompanyType] = useState<"private-limited" | "public-limited" | "one-person" | "section-8" | "llp">("private-limited");
  const [financialYearEnd, setFinancialYearEnd] = useState("2025-03-31");
  const [agmDate, setAgmDate] = useState("");
  const [filings, setFilings] = useState<RocFilingRow[]>([
    { formType: "AOC-4 (financial statements)", dueDate: "", status: "upcoming", daysToDue: 0 },
    { formType: "MGT-7 (annual return)", dueDate: "", status: "upcoming", daysToDue: 0 },
    { formType: "DIR-3 KYC (annual)", dueDate: "", status: "upcoming", daysToDue: 0 },
    { formType: "D&O declaration", dueDate: "", status: "upcoming", daysToDue: 0 },
  ]);
  const [charges, setCharges] = useState<{ dateOfCreation: string; amount: number; securedDebts: number; asset: string }[]>([]);
  const [directors, setDirectors] = useState<{ name: string; din: string; kycStatus: "done" | "pending" }[]>([]);
  const [result, setResult] = useState<RocResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ rocCompliance: RocResult }>({
        kind: "roc-compliance",
        op: {
          op: "build",
          cin,
          companyType,
          financialYearEnd,
          agmDate: agmDate || undefined,
          charges: charges.map((c) => ({
            dateOfCreation: c.dateOfCreation,
            amount: c.amount,
            securedDebts: c.securedDebts,
            asset: c.asset,
          })),
          directors: directors.map((d) => ({
            name: d.name,
            din: d.din,
            kycStatus: d.kycStatus,
          })),
        },
      });
      setResult(res.rocCompliance);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const updateFilings = (updates: Partial<RocFilingRow>[]) =>
    setFilings(filings.map((f, i) => i < updates.length ? { ...f, ...updates[i] } : f));

  const _updateCharges = (newCharges: { dateOfCreation: string; amount: number; securedDebts: number; asset: string }[]) =>
    setCharges(newCharges);

  const updateDirectors = (newDirectors: { name: string; din: string; kycStatus: "done" | "pending" }[]) =>
    setDirectors(newDirectors);

  return (
    <Card>
      <CardHeader>
        <CardTitle>ROC/MCA compliance</CardTitle>
        <CardDescription>
          Build the company-type-specific annual filing calendar from financial year end and events supplied. Surface
          AOC-4, MGT-7, DIR-3 KYC, charges and director KYC status with due dates and status.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Input label="CIN" value={cin} onChange={(e) => setCin(e.target.value)} />
          <Select
            label="Company type"
            value={companyType}
            onChange={(e) => setCompanyType(e.target.value as "private-limited" | "public-limited" | "one-person" | "section-8" | "llp")}
            options={[
              { value: "private-limited", label: "Private limited" },
              { value: "public-limited", label: "Public limited" },
              { value: "one-person", label: "One-person" },
              { value: "section-8", label: "Section 8" },
              { value: "llp", label: "LLP" },
            ]}
          />
          <Input
            label="Financial year end"
            type="date"
            value={financialYearEnd}
            onChange={(e) => setFinancialYearEnd(e.target.value)}
          />
          <Input
            label="AGM date (optional)"
            value={agmDate}
            onChange={(e) => setAgmDate(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Filing calendar</p>
          {filings.map((f, i) => (
            <div key={i} className="rounded-md border border-line bg-surface-2/30 p-2">
              <div className="grid grid-cols-3 gap-2">
                <Input
                  label="Form type"
                  value={f.formType}
                  onChange={(e) => updateFilings([...filings.slice(0, i), { ...f, formType: e.target.value }, ...filings.slice(i + 1)])}
                />
                <Input
                  label="Due date"
                  type="date"
                  value={f.dueDate}
                  onChange={(e) => updateFilings([...filings.slice(0, i), { ...f, dueDate: e.target.value }, ...filings.slice(i + 1)])}
                />
                <Select
                  label="Status"
                  value={f.status}
                  onChange={(e) => updateFilings([...filings.slice(0, i), { ...f, status: e.target.value as "upcoming" | "due" | "overdue" }, ...filings.slice(i + 1)])}
                  options={[
                    { value: "upcoming", label: "Upcoming" },
                    { value: "due", label: "Due" },
                    { value: "overdue", label: "Overdue" },
                  ]}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => updateFilings([...filings.slice(0, i), { ...f, status: "overdue" as const }, ...filings.slice(i + 1)])}
              >
                Overdue
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => updateFilings([...filings.slice(0, i), { ...f, status: "due" as const }, ...filings.slice(i + 1)])}
              >
                Due
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => updateFilings([...filings.slice(0, i), { ...f, status: "upcoming" as const }, ...filings.slice(i + 1)])}
              >
                Upcoming
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setFilings([...filings, { formType: "AOC-4 (financial statements)", dueDate: "", status: "upcoming", daysToDue: 0 }])}
          >
            + Filing
          </Button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Charges</p>
          {charges.length === 0 ? (
            <p className="text-caption text-muted">No charges recorded. Add charges below.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Date of creation</th>
                  <th className="py-1">Amount (₹)</th>
                  <th className="py-1">Secured debts (₹)</th>
                  <th className="py-1">Asset</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c, i) => (
                  <tr key={i} className="border-t border-line/60">
                    <td className="py-1.5">{c.dateOfCreation}</td>
                    <td className="py-1.5 tabular-nums">{formatInr(c.amount)}</td>
                    <td className="py-1.5 tabular-nums">{formatInr(c.securedDebts)}</td>
                    <td className="py-1.5">{c.asset}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setCharges([...charges, { dateOfCreation: "", amount: 0, securedDebts: 0, asset: "" }])}
          >
            + Charge
          </Button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Directors</p>
          {directors.length === 0 ? (
            <p className="text-caption text-muted">No directors recorded. Add directors below.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Name</th>
                  <th className="py-1">DIN</th>
                  <th className="py-1">KYC status</th>
                </tr>
              </thead>
              <tbody>
                {directors.map((d, i) => (
                  <tr key={i} className="border-t border-line/60">
                    <td className="py-1.5">{d.name}</td>
                    <td className="py-1.5">{d.din}</td>
                    <td className="py-1.5">
                      <Select
                        value={d.kycStatus}
                        onChange={(e) => updateDirectors([...directors.slice(0, i), { ...d, kycStatus: e.target.value as "done" | "pending" }, ...directors.slice(i + 1)])}
                        options={[
                          { value: "done", label: "Done" },
                          { value: "pending", label: "Pending" },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setDirectors([...directors, { name: "", din: "", kycStatus: "pending" }])}
          >
            + Director
          </Button>
        </div>

        <Button type="button" onClick={run} loading={busy}>
          Build ROC compliance
        </Button>
        <ErrorLine message={error} />

        {result ? (
          <div className="space-y-4">
            <h4 className="mt-4 text-sm font-medium text-foreground">Filings</h4>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Form type</th>
                  <th className="py-1">Due date</th>
                  <th className="py-1">Status</th>
                  <th className="py-1 text-right">Days to due</th>
                </tr>
              </thead>
              <tbody>
                {result.filings.map((f) => (
                  <tr key={f.formType} className="border-t border-line/60">
                    <td className="py-1.5">{f.formType}</td>
                    <td className="py-1.5">{f.dueDate}</td>
                    <td className="py-1.5">
                      {f.status}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {f.daysToDue}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4 className="mt-4 text-sm font-medium text-foreground">Charges</h4>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Date of creation</th>
                  <th className="py-1">Amount (₹)</th>
                  <th className="py-1">Secured debts (₹)</th>
                  <th className="py-1">Asset</th>
                </tr>
              </thead>
              <tbody>
                {result.charges.map((c) => (
                  <tr key={c.dateOfCreation} className="border-t border-line/60">
                    <td className="py-1.5">{c.dateOfCreation}</td>
                    <td className="py-1.5 tabular-nums">{formatInr(c.amount)}</td>
                    <td className="py-1.5 tabular-nums">{formatInr(c.securedDebts)}</td>
                    <td className="py-1.5">{c.asset}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4 className="mt-4 text-sm font-medium text-foreground">Directors</h4>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-muted">
                  <th className="py-1">Name</th>
                  <th className="py-1">DIN</th>
                  <th className="py-1">KYC status</th>
                </tr>
              </thead>
              <tbody>
                {result.directors.map((d) => (
                  <tr key={d.din} className="border-t border-line/60">
                    <td className="py-1.5">{d.name}</td>
                    <td className="py-1.5">{d.din}</td>
                    <td className="py-1.5">{d.kycStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Method steps={result.methodology} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Litigation & appeals
// ---------------------------------------------------------------------------

const FORUMS = [
  { value: "ao", label: "Assessing Officer" },
  { value: "cit-appeals", label: "CIT(A) / NFAC" },
  { value: "itat", label: "ITAT" },
  { value: "high-court", label: "High Court" },
];

interface PortfolioRow {
  matterId: string;
  clientName: string;
  forum: string;
  taxEffect: string;
  servedDate: string;
  limitationDays: string;
  filingDate: string;
  status: string;
}

function LitigationPanel() {
  const [matter, setMatter] = useState({
    matterId: "LIT-001",
    clientName: "Sharma Textiles Pvt Ltd",
    pan: "AAAAA0000A",
    assessmentYear: "2023-24",
    orderBy: "ao",
    orderReference: "AO/DEL/2025/11",
    orderDate: "2025-04-10",
    servedDate: "2025-04-15",
    taxEffect: "300000",
    disputedTax: "300000",
    filingDate: "",
  });
  const [grounds, setGrounds] = useState("Disallowance u/s 40(a)(ia) without appreciating the proviso");
  const [plan, setPlan] = useState<AppealPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [matters, setMatters] = useState<PortfolioRow[]>([
    {
      matterId: "M1",
      clientName: "Alpha Textiles",
      forum: "cit-appeals",
      taxEffect: "100000",
      servedDate: "2025-05-01",
      limitationDays: "30",
      filingDate: "2025-05-20",
      status: "not-filed",
    },
  ]);
  const [portfolio, setPortfolio] = useState<LitigationPortfolio | null>(null);
  const [portfolioBusy, setPortfolioBusy] = useState(false);

  async function runPlan() {
    setBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ appealPlan: AppealPlan }>({
        kind: "litigation",
        op: {
          op: "plan-appeal",
          matter: {
            ...matter,
            taxEffect: n(matter.taxEffect),
            disputedTax: matter.disputedTax === "" ? undefined : n(matter.disputedTax),
            filingDate: matter.filingDate === "" ? undefined : matter.filingDate,
            grounds: grounds
              .split("\n")
              .map((g) => g.trim())
              .filter(Boolean),
          },
        },
      });
      setPlan(res.appealPlan);
    } catch (err) {
      setPlan(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runPortfolio() {
    setPortfolioBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ litigationPortfolio: LitigationPortfolio }>({
        kind: "litigation",
        op: {
          op: "portfolio",
          matters: matters.map((m) => ({
            matterId: m.matterId,
            clientName: m.clientName,
            forum: m.forum,
            taxEffect: n(m.taxEffect),
            servedDate: m.servedDate,
            limitationDays: Math.round(n(m.limitationDays)),
            filingDate: m.filingDate,
            status: m.status,
          })),
        },
      });
      setPortfolio(res.litigationPortfolio);
    } catch (err) {
      setPortfolio(null);
      setError(errorMessage(err));
    } finally {
      setPortfolioBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Appeal planner</CardTitle>
          <CardDescription>
            Limitation runs from the date of SERVICE of the order, not the order date. The fee is priced against the
            default slab table and the stay deposit at 20% of the disputed demand — both are caller-owned policy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Input
              label="Matter id"
              value={matter.matterId}
              onChange={(e) => setMatter({ ...matter, matterId: e.target.value })}
            />
            <Input
              label="Client"
              value={matter.clientName}
              onChange={(e) => setMatter({ ...matter, clientName: e.target.value })}
            />
            <Input label="PAN" value={matter.pan} onChange={(e) => setMatter({ ...matter, pan: e.target.value })} />
            <Input
              label="Assessment year"
              value={matter.assessmentYear}
              onChange={(e) => setMatter({ ...matter, assessmentYear: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Select
              label="Order passed by"
              value={matter.orderBy}
              onChange={(e) => setMatter({ ...matter, orderBy: e.target.value })}
              options={FORUMS}
            />
            <Input
              label="Order reference"
              value={matter.orderReference}
              onChange={(e) => setMatter({ ...matter, orderReference: e.target.value })}
            />
            <Input
              label="Order date"
              type="date"
              value={matter.orderDate}
              onChange={(e) => setMatter({ ...matter, orderDate: e.target.value })}
            />
            <Input
              label="Served date"
              type="date"
              value={matter.servedDate}
              onChange={(e) => setMatter({ ...matter, servedDate: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Input
              label="Tax effect (₹)"
              inputMode="decimal"
              value={matter.taxEffect}
              onChange={(e) => setMatter({ ...matter, taxEffect: e.target.value })}
            />
            <Input
              label="Disputed tax (₹)"
              inputMode="decimal"
              value={matter.disputedTax}
              onChange={(e) => setMatter({ ...matter, disputedTax: e.target.value })}
            />
            <Input
              label="Proposed filing date"
              type="date"
              value={matter.filingDate}
              onChange={(e) => setMatter({ ...matter, filingDate: e.target.value })}
            />
          </div>
          <Textarea
            rows={3}
            label="Grounds of appeal (one per line)"
            value={grounds}
            onChange={(e) => setGrounds(e.target.value)}
          />
          <Button type="button" onClick={runPlan} loading={busy}>
            Plan the appeal
          </Button>
          <ErrorLine message={error} />

          {plan ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="rounded-full border border-line px-3 py-1">
                  Next forum: <strong>{plan.nextRoute?.to ?? "none"}</strong>
                </span>
                <span className="text-caption text-muted">
                  Limitation {plan.limitation.limitationDays} days → expiry {plan.limitation.expiryDate}
                </span>
                <span className={plan.limitation.withinLimitation ? "text-emerald-600" : "text-amber-600"}>
                  {plan.limitation.withinLimitation
                    ? `${plan.limitation.daysRemaining} day(s) left`
                    : `${plan.limitation.delayDays} day(s) late — condonation needed`}
                </span>
              </div>
              <Money label="Filing fee" value={plan.feeMinor} tone={plan.feeMinor > 0 ? "warn" : "ok"} />
              <Money label="Stay deposit (20% of disputed demand)" value={plan.stayDepositMinor} />
              <Money label="Tax effect at stake" value={plan.taxEffectMinor} />
              <div>
                <p className="text-sm font-medium text-foreground">Appeal ladder from this order</p>
                <ul className="mt-1 space-y-1 text-caption text-muted">
                  {plan.ladder.map((l) => (
                    <li key={l.to}>
                      → {l.to} · {l.limitationDays} days · {l.statute}
                      {l.feeApplies ? " · fee" : " · no fee"}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">Filing checklist</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-caption text-muted">
                  {plan.checklist.map((c: string) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
              <Warnings items={plan.warnings} />
              <Method steps={plan.methodology} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Limitation portfolio</CardTitle>
          <CardDescription>
            Which unfiled matters are barred by limitation, and which are about to be. Already-filed matters are never
            reported as at risk.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            {matters.map((m, i) => (
              <div
                key={i}
                className="grid grid-cols-2 gap-2 rounded-md border border-line bg-surface-2/30 p-2 sm:grid-cols-4"
              >
                <Input
                  label="Id"
                  value={m.matterId}
                  onChange={(e) =>
                    setMatters(matters.map((x, j) => (j === i ? { ...x, matterId: e.target.value } : x)))
                  }
                />
                <Input
                  label="Client"
                  value={m.clientName}
                  onChange={(e) =>
                    setMatters(matters.map((x, j) => (j === i ? { ...x, clientName: e.target.value } : x)))
                  }
                />
                <Select
                  label="Forum"
                  value={m.forum}
                  onChange={(e) => setMatters(matters.map((x, j) => (j === i ? { ...x, forum: e.target.value } : x)))}
                  options={FORUMS}
                />
                <Input
                  label="Tax effect (₹)"
                  inputMode="decimal"
                  value={m.taxEffect}
                  onChange={(e) =>
                    setMatters(matters.map((x, j) => (j === i ? { ...x, taxEffect: e.target.value } : x)))
                  }
                />
                <Input
                  label="Served"
                  type="date"
                  value={m.servedDate}
                  onChange={(e) =>
                    setMatters(matters.map((x, j) => (j === i ? { ...x, servedDate: e.target.value } : x)))
                  }
                />
                <Input
                  label="Limitation days"
                  inputMode="numeric"
                  value={m.limitationDays}
                  onChange={(e) =>
                    setMatters(matters.map((x, j) => (j === i ? { ...x, limitationDays: e.target.value } : x)))
                  }
                />
                <Input
                  label="Filing date"
                  type="date"
                  value={m.filingDate}
                  onChange={(e) =>
                    setMatters(matters.map((x, j) => (j === i ? { ...x, filingDate: e.target.value } : x)))
                  }
                />
                <Select
                  label="Status"
                  value={m.status}
                  onChange={(e) => setMatters(matters.map((x, j) => (j === i ? { ...x, status: e.target.value } : x)))}
                  options={[
                    { value: "not-filed", label: "Not filed" },
                    { value: "filed", label: "Filed" },
                    { value: "heard", label: "Heard" },
                    { value: "disposed", label: "Disposed" },
                  ]}
                />
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                setMatters([
                  ...matters,
                  {
                    matterId: `M${matters.length + 1}`,
                    clientName: "",
                    forum: "cit-appeals",
                    taxEffect: "0",
                    servedDate: "2025-05-01",
                    limitationDays: "30",
                    filingDate: "2025-05-20",
                    status: "not-filed",
                  },
                ])
              }
            >
              + Matter
            </Button>
          </div>
          <Button type="button" onClick={runPortfolio} loading={portfolioBusy}>
            Check limitation risk
          </Button>
          {portfolio ? (
            <div className="space-y-2 text-sm">
              <p className="text-caption text-muted">
                {portfolio.totalMatters} matters · {portfolio.filedCount} filed · tax effect{" "}
                {formatInr(portfolio.totalTaxEffectMinor)}
              </p>
              {portfolio.atRisk.length ? (
                <div className="rounded-md border border-danger/40 bg-danger/10 p-3">
                  <p className="text-sm font-medium text-danger">Barred by limitation</p>
                  <ul className="mt-1 space-y-1 text-caption">
                    {portfolio.atRisk.map((m) => (
                      <li key={m.matterId}>
                        {m.matterId} ({m.clientName}) — expiry {m.expiryDate}, {m.delayDays} day(s) late
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-caption text-emerald-600">No unfiled matter is barred.</p>
              )}
              {portfolio.dueSoon.length ? (
                <div>
                  <p className="text-sm font-medium text-foreground">Due soon</p>
                  <ul className="mt-1 space-y-1 text-caption text-muted">
                    {portfolio.dueSoon.map((m) => (
                      <li key={m.matterId}>
                        {m.matterId} ({m.clientName}) — expiry {m.expiryDate}, {m.daysRemaining} day(s) left
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <Method steps={portfolio.methodology} />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// The kit below is shared with the sibling practice-area panels so every screen
// renders money and errors the same way.
export { InternalAuditPanel, ConcurrentAuditPanel, StockAuditPanel, LitigationPanel };
export { ErrorLine, Method, Money, ReportSections, Warnings, n, postCompute };
