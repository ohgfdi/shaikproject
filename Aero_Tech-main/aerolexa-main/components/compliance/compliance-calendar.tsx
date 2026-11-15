"use client";

import { CalendarDays, CheckCircle2, Clock3, Settings2, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge, Card, CardContent, type BadgeVariant } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { ENTITY_KINDS, GST_FREQUENCIES, type ComplianceTaskState } from "@/lib/engine/compliance-calendar";
import type {
  ComplianceCalendarResult,
  ComplianceProfileSeed,
  ComplianceTaskView,
} from "@/lib/server/compliance-calendar";

const STATE_VARIANT: Record<ComplianceTaskState, BadgeVariant> = {
  overdue: "critical",
  "due-soon": "warning",
  upcoming: "default",
  filed: "success",
  waived: "outline",
};

const STATE_LABEL: Record<ComplianceTaskState, string> = {
  overdue: "Overdue",
  "due-soon": "Due ≤30d",
  upcoming: "Upcoming",
  filed: "Filed",
  waived: "Waived",
};

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? dateFmt.format(date) : iso;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The statutory calendar: every client's due dates in one place, with the
 * firm's filed state and a per-client registration profile. Dates are generated
 * (never stored), so a rule update applies immediately.
 */
export function ComplianceCalendarWorkspace() {
  const [calendar, setCalendar] = useState<ComplianceCalendarResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clientId, setClientId] = useState("ALL");
  const [stateFilter, setStateFilter] = useState("ALL");
  const [authority, setAuthority] = useState("ALL");
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupClientId, setSetupClientId] = useState("");
  const [form, setForm] = useState<ComplianceProfileSeed | null>(null);
  const [saving, setSaving] = useState(false);
  const [filing, setFiling] = useState<{ task: ComplianceTaskView; status: "filed" | "waived" } | null>(null);
  const [filedOn, setFiledOn] = useState(todayIso());
  const [reference, setReference] = useState("");
  const [savingTask, setSavingTask] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ calendar: ComplianceCalendarResult }>("/api/organization/compliance");
      setCalendar(data.calendar);
      setSetupClientId((current) => current || data.calendar.clients[0]?.id || "");
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

  useEffect(() => {
    const client = calendar?.clients.find((c) => c.id === setupClientId);
    setForm(client ? { ...client.profile } : null);
  }, [calendar, setupClientId]);

  const authorities = useMemo(() => {
    const set = new Set((calendar?.tasks ?? []).map((t) => t.authority));
    return [...set].sort();
  }, [calendar]);

  const tasks = useMemo(() => {
    return (calendar?.tasks ?? []).filter((task) => {
      if (clientId !== "ALL" && task.clientId !== clientId) return false;
      if (stateFilter !== "ALL" && task.state !== stateFilter) return false;
      if (authority !== "ALL" && task.authority !== authority) return false;
      return true;
    });
  }, [calendar, clientId, stateFilter, authority]);

  const saveProfile = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!form || !setupClientId) return;
      setSaving(true);
      setError(null);
      try {
        await api(`/api/organization/engagements/${setupClientId}/compliance`, {
          method: "PUT",
          body: JSON.stringify(form),
        });
        setNotice("Client registration profile saved. The calendar has been regenerated.");
        setSetupOpen(false);
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setSaving(false);
      }
    },
    [form, setupClientId, load],
  );

  const submitStatus = useCallback(
    async (task: ComplianceTaskView, status: "filed" | "waived" | "pending", payload?: { filedOn?: string; reference?: string }) => {
      setSavingTask(true);
      setError(null);
      try {
        await api(`/api/organization/engagements/${task.clientId}/compliance/status`, {
          method: "POST",
          body: JSON.stringify({
            taskId: task.id,
            status,
            filedOn: payload?.filedOn ?? null,
            reference: payload?.reference?.trim() || null,
          }),
        });
        setNotice(
          status === "filed"
            ? `${task.title} marked filed${payload?.reference ? ` · ${payload.reference}` : ""}.`
            : status === "waived"
              ? `${task.title} marked waived.`
              : `${task.title} reopened.`,
        );
        setFiling(null);
        setReference("");
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setSavingTask(false);
      }
    },
    [load],
  );

  const totals = calendar?.totals;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Stat label="Overdue" value={totals?.overdue ?? 0} tone="critical" hint="past due, not filed" />
        <Stat label="Due ≤30 days" value={totals?.dueSoon ?? 0} tone="warning" hint="this month's chase list" />
        <Stat label="Filed" value={totals?.filed ?? 0} hint="recorded by the firm" />
        <Stat label="Clients" value={totals?.clients ?? 0} hint={`${totals?.unconfigured ?? 0} using defaults`} />
        <Stat label="Waived" value={totals?.waived ?? 0} hint="not applicable / deferred" />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Client" className="min-w-52 flex-1 sm:max-w-xs">
          <Select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            options={[
              { value: "ALL", label: "All clients" },
              ...(calendar?.clients ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </Field>
        <Field label="State" className="w-40">
          <Select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            options={[
              { value: "ALL", label: "All states" },
              ...(Object.keys(STATE_LABEL) as ComplianceTaskState[]).map((s) => ({
                value: s,
                label: STATE_LABEL[s],
              })),
            ]}
          />
        </Field>
        <Field label="Authority" className="w-52">
          <Select
            value={authority}
            onChange={(e) => setAuthority(e.target.value)}
            options={[
              { value: "ALL", label: "All authorities" },
              ...authorities.map((a) => ({ value: a, label: a })),
            ]}
          />
        </Field>
        <Button type="button" variant="secondary" onClick={() => setSetupOpen((v) => !v)}>
          <Settings2 aria-hidden className="size-4" /> Client setup
        </Button>
      </div>

      {notice && (
        <p className="rounded-md border border-emerald/40 bg-emerald/10 px-3 py-2 text-sm text-foreground">{notice}</p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}

      {setupOpen && form && (
        <Card>
          <CardContent>
            <form className="grid gap-3 sm:grid-cols-3" onSubmit={saveProfile}>
              <div className="sm:col-span-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Settings2 aria-hidden className="size-4" /> Registration profile
                </h2>
                <p className="text-caption text-muted">
                  Only obligations implied by this profile are generated. Unconfigured clients use defaults derived
                  from the engagement and are flagged in the list.
                </p>
              </div>
              <Field label="Client">
                <Select
                  value={setupClientId}
                  onChange={(e) => setSetupClientId(e.target.value)}
                  options={(calendar?.clients ?? []).map((c) => ({
                    value: c.id,
                    label: `${c.name}${c.configured ? "" : " (defaults)"}`,
                  }))}
                />
              </Field>
              <Field label="Entity kind">
                <Select
                  value={form.entityKind}
                  onChange={(e) => setForm({ ...form, entityKind: e.target.value as ComplianceProfileSeed["entityKind"] })}
                  options={ENTITY_KINDS.map((k) => ({ value: k, label: k.replaceAll("-", " ") }))}
                />
              </Field>
              <Field label="Financial year" helper="Format: 2025-26">
                <Input
                  value={form.financialYear}
                  onChange={(e) => setForm({ ...form, financialYear: e.target.value })}
                  placeholder="2025-26"
                />
              </Field>
              <Field label="GST frequency">
                <Select
                  value={form.gstFrequency}
                  onChange={(e) =>
                    setForm({ ...form, gstFrequency: e.target.value as ComplianceProfileSeed["gstFrequency"] })
                  }
                  options={GST_FREQUENCIES.map((f) => ({ value: f, label: f }))}
                />
              </Field>
              <Field label="State" helper="For professional tax; blank if not applicable.">
                <Input
                  value={form.state ?? ""}
                  onChange={(e) => setForm({ ...form, state: e.target.value || null })}
                  placeholder="maharashtra"
                />
              </Field>
              <div className="grid gap-1.5 sm:col-span-1">
                <span className="text-caption font-medium text-muted uppercase">Applicability</span>
                {(
                  [
                    ["gstRegistered", "GST registered"],
                    ["tdsDeductor", "TDS deductor"],
                    ["taxAuditApplicable", "Tax audit"],
                    ["transferPricingApplicable", "Transfer pricing"],
                    ["listedCompany", "Listed company"],
                    ["employsStaff", "Employs staff"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      checked={form[key]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="flex items-end gap-2 sm:col-span-3">
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save profile"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setSetupOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="px-4 py-8 text-sm text-muted">Building the firm calendar…</p>
          ) : tasks.length === 0 ? (
            <div className="space-y-1 px-4 py-8">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <CalendarDays aria-hidden className="size-4" /> No obligations match this filter
              </p>
              <p className="text-caption text-muted">
                Configure a client under Client setup, or clear the filters. The calendar is generated from each
                client&apos;s registrations — it does not invent obligations.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[60rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-caption text-muted uppercase">
                    <th className="px-3 py-2 font-medium">Due</th>
                    <th className="px-3 py-2 font-medium">Client</th>
                    <th className="px-3 py-2 font-medium">Obligation</th>
                    <th className="px-3 py-2 font-medium">Period</th>
                    <th className="px-3 py-2 font-medium">Authority</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2 font-medium sr-only">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => {
                    const isClosed = task.state === "filed" || task.state === "waived";
                    return (
                      <tr key={task.id} className="border-b border-line/70 align-top hover:bg-surface-2/40">
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className="flex items-center gap-1 text-foreground">
                            <Clock3 aria-hidden className="size-3.5 text-muted" /> {fmtDate(task.dueDate)}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <span className="block font-medium text-foreground">
                            {task.clientName}
                            {!calendar?.clients.find((c) => c.id === task.clientId)?.configured && (
                              <Badge variant="outline" className="ml-1">
                                defaults
                              </Badge>
                            )}
                          </span>
                          <span className="block text-caption text-muted">{task.engagementCode ?? "No code"}</span>
                        </td>
                        <td className="px-3 py-3">
                          <span className="block text-foreground">{task.title}</span>
                          {task.note && <span className="block text-caption text-muted">{task.note}</span>}
                        </td>
                        <td className="px-3 py-3 text-muted">{task.period}</td>
                        <td className="px-3 py-3 text-muted">{task.authority}</td>
                        <td className="px-3 py-3">
                          <Badge variant={STATE_VARIANT[task.state]}>{STATE_LABEL[task.state]}</Badge>
                          {task.reference && (
                            <span className="mt-1 block font-mono text-caption text-muted">{task.reference}</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right whitespace-nowrap">
                          {isClosed ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={savingTask}
                              onClick={() => void submitStatus(task, "pending")}
                            >
                              Reopen
                            </Button>
                          ) : (
                            <span className="flex flex-wrap justify-end gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={savingTask}
                                onClick={() => {
                                  setFiling({ task, status: "filed" });
                                  setFiledOn(todayIso());
                                  setReference("");
                                }}
                              >
                                <CheckCircle2 aria-hidden className="size-3.5" /> Mark filed
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={savingTask}
                                onClick={() => void submitStatus(task, "waived")}
                              >
                                Waive
                              </Button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {filing && (
        <Card>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CheckCircle2 aria-hidden className="size-4" /> Mark filed · {filing.task.title}
              </h2>
              <Button type="button" size="sm" variant="ghost" onClick={() => setFiling(null)}>
                Cancel
              </Button>
            </div>
            <p className="text-caption text-muted">
              {filing.task.clientName} · {filing.task.period} · due {fmtDate(filing.task.dueDate)}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Filed on">
                <Input type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} />
              </Field>
              <Field label="Acknowledgement / ARN / SRN" className="sm:col-span-2">
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="ARN / acknowledgement number (optional but recommended)"
                />
              </Field>
            </div>
            <Button
              type="button"
              disabled={savingTask}
              onClick={() => void submitStatus(filing.task, filing.status, { filedOn, reference })}
            >
              {savingTask ? "Saving…" : "Confirm filed"}
            </Button>
          </CardContent>
        </Card>
      )}

      <p className="flex items-start gap-2 text-caption text-muted">
        <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        Dates are the central statutory dates for a 31 March year end. Weekend/holiday extension, GST QRMP state groups
        and CBDT/MCA extension notifications are not modelled — always confirm on the portal. Filing state is the
        firm&apos;s record, not a portal acknowledgement.
      </p>
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
  value: number;
  hint?: string;
  tone?: "warning" | "critical";
}) {
  const border =
    tone === "critical"
      ? "border-[#E8637A]/40"
      : tone === "warning"
        ? "border-[#F08A5D]/40"
        : "border-line";
  return (
    <Card className={border}>
      <CardContent className="space-y-1">
        <p className="text-caption text-muted uppercase">{label}</p>
        <p className="text-2xl font-semibold text-foreground tabular-nums">{value}</p>
        {hint && <p className="text-caption text-muted">{hint}</p>}
      </CardContent>
    </Card>
  );
}
