"use client";

import { IndianRupee, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { PracticeEconomics } from "@/lib/server/practice-economics";

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function fmtDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? dateFmt.format(date) : iso;
}

function money(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/**
 * Practice economics: what is unbilled, what has been invoiced, and what is
 * late. Every figure comes from recorded time entries and issued invoices —
 * nothing is a utilisation estimate.
 */
export function PracticeEconomicsPanel() {
  const [economics, setEconomics] = useState<PracticeEconomics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState<string | null>(null);
  const [payRef, setPayRef] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    engagementId: "",
    workDate: new Date().toISOString().slice(0, 10),
    minutes: "60",
    rate: "2500",
    narrative: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ economics: PracticeEconomics }>("/api/organization/practice/economics");
      setEconomics(data.economics);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const logTime = useCallback(async () => {
    if (!form.engagementId) {
      setError("Choose the client this time belongs to.");
      return;
    }
    setBusy("time");
    setError(null);
    try {
      await api("/api/organization/practice/time-entries", {
        method: "POST",
        body: JSON.stringify({
          engagementId: form.engagementId,
          workDate: form.workDate,
          minutes: Number(form.minutes),
          ratePerHourMinor: Math.round(Number(form.rate) * 100),
          narrative: form.narrative || null,
        }),
      });
      setNotice("Time recorded. It now counts towards unbilled WIP.");
      setForm((current) => ({ ...current, minutes: "60", narrative: "" }));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [form, load]);

  const raiseInvoice = useCallback(
    async (engagementId: string) => {
      setBusy(engagementId);
      setError(null);
      try {
        const data = await api<{ invoice: { number: string; totalMinor: number } }>(
          "/api/organization/practice/invoices",
          { method: "POST", body: JSON.stringify({ engagementId, creditDays: 15, gstRatePct: 18 }) },
        );
        setNotice(`Invoice ${data.invoice.number} raised for ${money(data.invoice.totalMinor)}.`);
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const settle = useCallback(
    async (invoiceId: string, action: "paid" | "void") => {
      setBusy(invoiceId);
      setError(null);
      try {
        const reference = payRef[invoiceId]?.trim() ?? "";
        await api(`/api/organization/practice/invoices/${invoiceId}`, {
          method: "PATCH",
          body: JSON.stringify(
            action === "paid"
              ? { action, reference, method: "manual" }
              : { action, reason: reference || "Withdrawn by the firm" },
          ),
        });
        setNotice(action === "paid" ? "Payment recorded; outstanding has been reduced." : "Invoice voided; its time is unbilled again.");
        setPayOpen(null);
        setPayRef((current) => ({ ...current, [invoiceId]: "" }));
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [payRef, load],
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <IndianRupee className="h-4 w-4" /> Practice economics
        </h2>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      </div>

      {notice ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {economics ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Unbilled WIP</p>
                <p className="mt-1 text-2xl font-semibold">{money(economics.totals.unbilledMinor)}</p>
                <p className="text-xs text-muted-foreground">
                  {(economics.totals.unbilledMinutes / 60).toFixed(1)} h recorded, not yet invoiced
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Invoiced</p>
                <p className="mt-1 text-2xl font-semibold">{money(economics.totals.invoicedMinor)}</p>
                <p className="text-xs text-muted-foreground">{economics.invoices.length} client invoice(s)</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Outstanding</p>
                <p className="mt-1 text-2xl font-semibold">{money(economics.totals.outstandingMinor)}</p>
                <p className="text-xs text-muted-foreground">Issued and not yet paid</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Collected</p>
                <p className="mt-1 text-2xl font-semibold">{money(economics.totals.collectedMinor)}</p>
                <p className="text-xs text-muted-foreground">Settled against client invoices</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Overdue invoices</p>
                <p
                  className={
                    "mt-1 text-2xl font-semibold " +
                    (economics.totals.overdueInvoiceMinor > 0 ? "text-destructive" : "")
                  }
                >
                  {money(economics.totals.overdueInvoiceMinor)}
                </p>
                <p className="text-xs text-muted-foreground">Past their due date</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Client</th>
                      <th className="px-3 py-2">Unbilled</th>
                      <th className="px-3 py-2">Outstanding</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {economics.clients.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-3 py-4 text-muted-foreground">
                          No time recorded yet. Log the first hour below.
                        </td>
                      </tr>
                    ) : (
                      economics.clients.map((client) => (
                        <tr key={client.engagementId} className="border-t">
                          <td className="px-3 py-2">{client.engagementName || client.engagementId}</td>
                          <td className="px-3 py-2">{money(client.unbilledMinor)}</td>
                          <td className="px-3 py-2">
                            {money(client.outstandingMinor)}
                            {client.overdueMinor > 0 ? (
                              <Badge variant="critical" className="ml-2">
                                {money(client.overdueMinor)} late
                              </Badge>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              size="xs"
                              variant="secondary"
                              disabled={client.unbilledMinor <= 0 || busy === client.engagementId}
                              onClick={() => void raiseInvoice(client.engagementId)}
                            >
                              {busy === client.engagementId ? "Raising…" : "Raise invoice"}
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">WIP age</th>
                      <th className="px-3 py-2">Hours</th>
                      <th className="px-3 py-2">Unbilled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {economics.aging.map((bucket) => (
                      <tr key={bucket.bucket} className="border-t">
                        <td className="px-3 py-2">{bucket.bucket} days</td>
                        <td className="px-3 py-2">{(bucket.minutes / 60).toFixed(1)}</td>
                        <td className="px-3 py-2">{money(bucket.unbilledMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {economics.invoices.length > 0 ? (
                  <div className="border-t px-3 py-2">
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Receivables aging
                    </p>
                    <table className="w-full text-xs">
                      <tbody>
                        {economics.invoiceAging.map((row) => (
                          <tr key={row.bucket}>
                            <td className="py-0.5 text-muted-foreground">{row.bucket}</td>
                            <td className="py-0.5 text-right">{row.invoices}</td>
                            <td className="py-0.5 text-right">{money(row.outstandingMinor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mb-1 mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Recent invoices
                    </p>
                    <ul className="space-y-1 text-xs">
                      {economics.invoices.slice(0, 4).map((invoice) => (
                        <li key={invoice.id} className="space-y-1 border-t pt-1 first:border-t-0 first:pt-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              {invoice.number} · due {fmtDate(invoice.dueDate)}
                            </span>
                            <span
                              className={
                                invoice.status === "paid"
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : invoice.daysOverdue > 0
                                    ? "text-destructive"
                                    : "text-muted-foreground"
                              }
                            >
                              {money(invoice.totalMinor)}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-1">
                            <span className="text-muted-foreground">
                              {invoice.status === "paid"
                                ? `Paid ${fmtDate(invoice.paidOn ?? invoice.dueDate)}`
                                : invoice.status === "void"
                                  ? "Void"
                                  : invoice.daysOverdue > 0
                                    ? `${invoice.daysOverdue} days late`
                                    : "Not due yet"}
                            </span>
                            {invoice.status === "issued" ? (
                              payOpen === invoice.id ? (
                                <span className="flex items-center gap-1">
                                  <input
                                    className="h-7 w-32 rounded-md border bg-background px-2 text-xs"
                                    placeholder="UTR / cheque"
                                    value={payRef[invoice.id] ?? ""}
                                    onChange={(event) =>
                                      setPayRef((current) => ({ ...current, [invoice.id]: event.target.value }))
                                    }
                                  />
                                  <Button
                                    size="xs"
                                    disabled={busy === invoice.id || (payRef[invoice.id] ?? "").trim().length < 3}
                                    onClick={() => void settle(invoice.id, "paid")}
                                  >
                                    Save
                                  </Button>
                                  <Button size="xs" variant="ghost" onClick={() => setPayOpen(null)}>
                                    Cancel
                                  </Button>
                                </span>
                              ) : (
                                <span className="flex items-center gap-1">
                                  <Button size="xs" variant="secondary" onClick={() => setPayOpen(invoice.id)}>
                                    Mark paid
                                  </Button>
                                  <Button size="xs" variant="ghost" onClick={() => void settle(invoice.id, "void")}>
                                    Void
                                  </Button>
                                </span>
                              )
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="flex flex-wrap items-end gap-3 p-4">
              <Field label="Client" className="min-w-[220px] flex-1">
                <Select
                  value={form.engagementId}
                  onChange={(event) => setForm((current) => ({ ...current, engagementId: event.target.value }))}
                  placeholder="Choose a client"
                  options={economics.clients.map((client) => ({
                    value: client.engagementId,
                    label: client.engagementName || client.engagementId,
                  }))}
                />
              </Field>
              <Field label="Date">
                <Input
                  type="date"
                  value={form.workDate}
                  onChange={(event) => setForm((current) => ({ ...current, workDate: event.target.value }))}
                />
              </Field>
              <Field label="Minutes">
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={form.minutes}
                  onChange={(event) => setForm((current) => ({ ...current, minutes: event.target.value }))}
                />
              </Field>
              <Field label="Rate ₹/hour">
                <Input
                  type="number"
                  min={0}
                  value={form.rate}
                  onChange={(event) => setForm((current) => ({ ...current, rate: event.target.value }))}
                />
              </Field>
              <Field label="Narrative" className="min-w-[200px] flex-1">
                <Input
                  value={form.narrative}
                  onChange={(event) => setForm((current) => ({ ...current, narrative: event.target.value }))}
                  placeholder="GSTR-3B reconciliation"
                />
              </Field>
              <Button onClick={() => void logTime()} disabled={busy === "time" || !form.engagementId}>
                {busy === "time" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
                Log time
              </Button>
            </CardContent>
          </Card>
        </>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading practice economics…</p>
      ) : null}
    </section>
  );
}
