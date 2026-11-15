"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox, Input } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/client/api";
import { formatInr } from "@/lib/engine/india-tax";
import type { TaxInvoice, TimesheetSummary } from "@/lib/engine/practice-timesheets";

import { ErrorLine, Method, Money, n, postCompute, Warnings } from "./ca-practice-panels";

/**
 * Timesheets, WIP and billing panel.
 *
 * One time-record ledger feeds two views: the utilisation / WIP summary and a
 * GST tax invoice for the billable time. Both POST to `/api/ca/compute` with
 * `kind: "timesheets"`; the panel sends RUPEES and renders the PAISE it gets
 * back through `formatInr`.
 */

interface TimeRow {
  id: string;
  staffId: string;
  staffName: string;
  engagementId: string;
  clientName: string;
  date: string;
  hours: string;
  billable: boolean;
  ratePerHour: string;
  notes: string;
}

const BLANK_ROW: TimeRow = {
  id: "T1",
  staffId: "S1",
  staffName: "R. Iyer",
  engagementId: "ENG-1",
  clientName: "Sharma Textiles Pvt Ltd",
  date: "2025-06-01",
  hours: "10",
  billable: true,
  ratePerHour: "2000",
  notes: "Audit fee",
};

/** Parse the "ENG-1=20, ENG-2=40" budget field into a record. */
export function parseBudgets(value: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of value.split(",")) {
    const [key, raw] = part.split("=");
    const hours = Number(raw);
    if (key?.trim() && Number.isFinite(hours) && hours >= 0) out[key.trim()] = hours;
  }
  return out;
}

function TimesheetsPanel() {
  const [rows, setRows] = useState<TimeRow[]>([
    { ...BLANK_ROW },
    { ...BLANK_ROW, id: "T2", date: "2025-06-05", hours: "5" },
    {
      ...BLANK_ROW,
      id: "T3",
      staffId: "S2",
      staffName: "A. Rao",
      date: "2025-06-06",
      hours: "4",
      billable: false,
      notes: "Admin",
    },
  ]);
  const [target, setTarget] = useState("70");
  const [asOfDate, setAsOfDate] = useState("2025-06-30");
  const [budgets, setBudgets] = useState("ENG-1=20");
  const [summary, setSummary] = useState<TimesheetSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [invoiceHeader, setInvoiceHeader] = useState({
    invoiceNumber: "INV/2025-26/014",
    invoiceDate: "2025-06-30",
    supplierName: "Iyer & Co., Chartered Accountants",
    supplierGstin: "27AAAAA0000A1Z5",
    supplierStateCode: "27",
    clientName: "Sharma Textiles Pvt Ltd",
    clientGstin: "27BBBBB1111B1Z5",
    placeOfSupplyStateCode: "27",
    discountPct: "10",
  });
  const [invoice, setInvoice] = useState<TaxInvoice | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);

  const update = (i: number, patch: Partial<TimeRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const payloadEntries = () =>
    rows.map((r) => ({
      id: r.id,
      staffId: r.staffId,
      staffName: r.staffName,
      engagementId: r.engagementId,
      clientName: r.clientName,
      date: r.date,
      hours: n(r.hours),
      billable: r.billable,
      ratePerHour: n(r.ratePerHour),
      notes: r.notes || null,
    }));

  async function runSummary() {
    setBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ timesheets: TimesheetSummary }>({
        kind: "timesheets",
        op: {
          op: "summarise",
          entries: payloadEntries(),
          budgets: parseBudgets(budgets),
          targetUtilisationPct: n(target),
          asOfDate,
        },
      });
      setSummary(res.timesheets);
    } catch (err) {
      setSummary(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runInvoice() {
    setInvoiceBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ invoice: TaxInvoice }>({
        kind: "timesheets",
        op: {
          op: "invoice",
          invoiceNumber: invoiceHeader.invoiceNumber,
          invoiceDate: invoiceHeader.invoiceDate,
          supplierName: invoiceHeader.supplierName,
          supplierGstin: invoiceHeader.supplierGstin,
          supplierStateCode: invoiceHeader.supplierStateCode,
          clientName: invoiceHeader.clientName,
          clientGstin: invoiceHeader.clientGstin || null,
          placeOfSupplyStateCode: invoiceHeader.placeOfSupplyStateCode,
          entries: payloadEntries(),
          discountPct: n(invoiceHeader.discountPct),
        },
      });
      setInvoice(res.invoice);
    } catch (err) {
      setInvoice(null);
      setError(errorMessage(err));
    } finally {
      setInvoiceBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Time records</CardTitle>
          <CardDescription>
            Billable time is valued at hours × rate, rounded per entry. Non-billable time is counted for utilisation but
            never invoiced.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.map((r, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line bg-surface-2/30 p-2">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input label="Id" value={r.id} onChange={(e) => update(i, { id: e.target.value })} />
                <Input label="Staff id" value={r.staffId} onChange={(e) => update(i, { staffId: e.target.value })} />
                <Input
                  label="Staff name"
                  value={r.staffName}
                  onChange={(e) => update(i, { staffName: e.target.value })}
                />
                <Input
                  label="Engagement"
                  value={r.engagementId}
                  onChange={(e) => update(i, { engagementId: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input
                  label="Client"
                  value={r.clientName}
                  onChange={(e) => update(i, { clientName: e.target.value })}
                />
                <Input label="Date" type="date" value={r.date} onChange={(e) => update(i, { date: e.target.value })} />
                <Input
                  label="Hours"
                  inputMode="decimal"
                  value={r.hours}
                  onChange={(e) => update(i, { hours: e.target.value })}
                />
                <Input
                  label="Rate (₹/hour)"
                  inputMode="decimal"
                  value={r.ratePerHour}
                  onChange={(e) => update(i, { ratePerHour: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 items-end gap-2">
                <Input label="Narration" value={r.notes} onChange={(e) => update(i, { notes: e.target.value })} />
                <Checkbox label="Billable" checked={r.billable} onChange={(v) => update(i, { billable: v })} />
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                Remove time
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setRows([...rows, { ...BLANK_ROW, id: `T${rows.length + 1}` }])}
          >
            + Time record
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Utilisation &amp; WIP</CardTitle>
          <CardDescription>
            Staff utilisation against the practice target, engagement WIP, and unbilled time aged in 30-day buckets.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <Input
              label="Target utilisation %"
              inputMode="decimal"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <Input label="As at date" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
            <Input label="Budgets (ENG=hours)" value={budgets} onChange={(e) => setBudgets(e.target.value)} />
          </div>
          <Button type="button" onClick={runSummary} loading={busy}>
            Summarise time
          </Button>
          <ErrorLine message={error} />

          {summary ? (
            <div className="space-y-3">
              <p className="text-caption text-muted">
                {summary.totals.entries} records · {summary.totals.totalHours} hours ({summary.totals.billableHours}{" "}
                billable, {summary.totals.nonBillableHours} non-billable) · utilisation {summary.totals.utilisationPct}%
                · WIP {formatInr(summary.totals.wipValueMinor)}
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-caption uppercase tracking-wide text-muted">
                    <th className="py-1">Staff</th>
                    <th className="py-1 text-right">Hours</th>
                    <th className="py-1 text-right">Billable</th>
                    <th className="py-1 text-right">Utilisation</th>
                    <th className="py-1 text-right">WIP</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byStaff.map((s) => (
                    <tr key={s.staffId} className="border-t border-line/60">
                      <td className="py-1.5">
                        {s.staffName} <span className="text-caption text-muted">({s.staffId})</span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{s.totalHours}</td>
                      <td className="py-1.5 text-right tabular-nums">{s.billableHours}</td>
                      <td
                        className={`py-1.5 text-right tabular-nums ${s.belowTarget ? "text-amber-600" : "text-emerald-600"}`}
                      >
                        {s.utilisationPct}%
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{formatInr(s.wipValueMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-caption uppercase tracking-wide text-muted">
                    <th className="py-1">Engagement</th>
                    <th className="py-1 text-right">Hours</th>
                    <th className="py-1 text-right">Budget used</th>
                    <th className="py-1 text-right">WIP</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byEngagement.map((e) => (
                    <tr key={e.engagementId} className="border-t border-line/60">
                      <td className="py-1.5">
                        {e.engagementId} <span className="text-caption text-muted">{e.clientName}</span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{e.totalHours}</td>
                      <td className={`py-1.5 text-right tabular-nums ${e.overBudget ? "text-amber-600" : ""}`}>
                        {e.budgetUsedPct === null ? "—" : `${e.budgetUsedPct}%`}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{formatInr(e.wipValueMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div>
                <p className="text-sm font-medium text-foreground">Unbilled time by age</p>
                <ul className="mt-1 space-y-1 text-caption text-muted">
                  {summary.wipAgeing.map((b) => (
                    <li key={b.bucket}>
                      {b.bucket} days: {b.hours} hours · {formatInr(b.valueMinor)}
                    </li>
                  ))}
                </ul>
              </div>
              <Warnings items={summary.belowTarget.map((s: string) => `${s} is under the utilisation target.`)} />
              <Method steps={summary.methodology} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tax invoice from billable time</CardTitle>
          <CardDescription>
            Fee → discount → CGST/SGST or IGST depending on the place of supply against the supplier&apos;s state → the
            client&apos;s s.194J deduction → net receivable.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Input
              label="Invoice no."
              value={invoiceHeader.invoiceNumber}
              onChange={(e) => setInvoiceHeader({ ...invoiceHeader, invoiceNumber: e.target.value })}
            />
            <Input
              label="Invoice date"
              type="date"
              value={invoiceHeader.invoiceDate}
              onChange={(e) => setInvoiceHeader({ ...invoiceHeader, invoiceDate: e.target.value })}
            />
            <Input
              label="Supplier name"
              value={invoiceHeader.supplierName}
              onChange={(e) => setInvoiceHeader({ ...invoiceHeader, supplierName: e.target.value })}
            />
            <Input
              label="Supplier GSTIN"
              value={invoiceHeader.supplierGstin}
              onChange={(e) => setInvoiceHeader({ ...invoiceHeader, supplierGstin: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Input
              label="Supplier state code"
              value={invoiceHeader.supplierStateCode}
              onChange={(e) => setInvoiceHeader({ ...invoiceHeader, supplierStateCode: e.target.value })}
            />
            <Input
              label="Client name"
              value={invoiceHeader.clientName}
              onChange={(e) => setInvoiceHeader({ ...invoiceHeader, clientName: e.target.value })}
            />
            <Input
              label="Client GSTIN"
              value={invoiceHeader.clientGstin}
              onChange={(e) => setInvoiceHeader({ ...invoiceHeader, clientGstin: e.target.value })}
            />
            <Input
              label="Place of supply"
              value={invoiceHeader.placeOfSupplyStateCode}
              onChange={(e) => setInvoiceHeader({ ...invoiceHeader, placeOfSupplyStateCode: e.target.value })}
            />
          </div>
          <Input
            label="Discount %"
            inputMode="decimal"
            value={invoiceHeader.discountPct}
            onChange={(e) => setInvoiceHeader({ ...invoiceHeader, discountPct: e.target.value })}
          />
          <Button type="button" onClick={runInvoice} loading={invoiceBusy}>
            Build tax invoice
          </Button>

          {invoice ? (
            <div className="space-y-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-caption uppercase tracking-wide text-muted">
                    <th className="py-1">Line</th>
                    <th className="py-1 text-right">Hours</th>
                    <th className="py-1 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lineItems.map((l) => (
                    <tr key={l.description} className="border-t border-line/60">
                      <td className="py-1.5">{l.description}</td>
                      <td className="py-1.5 text-right tabular-nums">{l.hours}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatInr(l.amountMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Money label="Subtotal" value={invoice.subtotalMinor} />
              <Money label={`Discount (${invoice.discountPct}%)`} value={invoice.discountMinor} />
              <Money label="Taxable value" value={invoice.taxableValueMinor} />
              {invoice.interState ? (
                <Money label={`IGST (${invoice.gstRatePct}%)`} value={invoice.igstMinor} />
              ) : (
                <>
                  <Money label={`CGST (${invoice.gstRatePct / 2}%)`} value={invoice.cgstMinor} />
                  <Money label={`SGST (${invoice.gstRatePct / 2}%)`} value={invoice.sgstMinor} />
                </>
              )}
              <Money label="Invoice total" value={invoice.totalMinor} />
              <Money
                label={`TDS u/s ${invoice.tdsSection} (${invoice.tdsRatePct}%, client deducts)`}
                value={invoice.tdsEstimatedMinor}
                tone="warn"
              />
              <Money label="Net receivable" value={invoice.netReceivableMinor} tone="ok" />
              <ul className="space-y-1 text-caption text-muted">
                {invoice.narrative.map((line: string) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <Method steps={invoice.methodology} />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export { TimesheetsPanel };
