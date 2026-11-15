"use client";

import { CalendarClock, Clock, Play, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { DemoBadge, ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { CRON_PRESETS, type ScheduledReportView } from "@/lib/types";

export interface ReportOption {
  id: string;
  title: string;
  projectName: string | null;
}

export function ScheduledPanel({ reports, schedulerEnabled }: { reports: ReportOption[]; schedulerEnabled: boolean }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [schedules, setSchedules] = useState<ScheduledReportView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [reportId, setReportId] = useState("");
  const [cron, setCron] = useState<string>(CRON_PRESETS[0]?.cron ?? "0 9 * * *");
  const [recipients, setRecipients] = useState("");
  const [runningId, setRunningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ schedules: ScheduledReportView[] }>("/api/scheduled-reports");
      setSchedules(data.schedules);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const data = await api<{ schedule: ScheduledReportView }>("/api/scheduled-reports", {
        method: "POST",
        body: JSON.stringify({
          name,
          cron,
          reportId,
          recipients: recipients
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean),
        }),
      });
      toast({
        title: "Schedule created",
        message: "The report will run on its cron and be exported locally.",
        type: "success",
      });
      setCreating(false);
      setName("");
      setRecipients("");
      await load();
      void data;
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: ScheduledReportView) => {
    try {
      await api(`/api/scheduled-reports/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) });
      toast({ title: s.enabled ? "Schedule paused" : "Schedule resumed", type: "success" });
      await load();
    } catch (err) {
      toast({ title: "Could not update schedule", message: errorMessage(err), type: "error" });
    }
  };

  const runNow = async (s: ScheduledReportView) => {
    setRunningId(s.id);
    try {
      const data = await api<{ message: string; outputUrl: string | null }>(`/api/scheduled-reports/${s.id}/run`, {
        method: "POST",
      });
      toast({
        title: data.outputUrl ? "Report generated" : "Run issue",
        message: data.message,
        type: data.outputUrl ? "success" : "error",
      });
      await load();
    } catch (err) {
      toast({ title: "Run failed", message: errorMessage(err), type: "error" });
    } finally {
      setRunningId(null);
    }
  };

  const remove = async (s: ScheduledReportView) => {
    const ok = await confirm({
      title: `Delete schedule “${s.name}”?`,
      message: "The schedule and its filters will be removed; already generated reports stay.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/api/scheduled-reports/${s.id}`, { method: "DELETE" });
      toast({ title: "Schedule deleted", type: "success" });
      await load();
    } catch (err) {
      toast({ title: "Could not delete schedule", message: errorMessage(err), type: "error" });
    }
  };

  return (
    <section aria-label="Scheduled reports">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-h2 text-foreground">Scheduled reports</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Re-run a report template on a cron schedule. Each run generates the prototype HTML export locally; when
            recipients are set and a mail transport is configured they are delivered too.
          </p>
        </div>
        <DemoBadge tooltip="Scheduled email delivery requires SMTP config; exports always generate locally. Scheduler process runs when SCHEDULER_ENABLED=true." />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => setCreating(true)} icon={<Plus aria-hidden className="size-4" />}>
          Add schedule
        </Button>
        {schedules?.length ? (
          <Badge variant={schedulerEnabled ? "success" : "outline"} className="self-center">
            <Clock aria-hidden className="size-3" /> scheduler {schedulerEnabled ? "enabled" : "off (run manually)"}
          </Badge>
        ) : null}
      </div>
      {!schedulerEnabled && schedules?.length ? (
        <p className="mt-2 text-caption text-muted">
          SCHEDULER_ENABLED=false — schedules are stored and can be previewed with “Run now”. Start{" "}
          <code className="rounded bg-surface-2 px-1">npm run scheduler</code> to let them fire automatically.
        </p>
      ) : null}

      {error && (
        <ErrorMessage title="Could not load schedules" message={error} onRetry={() => void load()} className="mt-4" />
      )}
      {!schedules && !error && (
        <div className="mt-4">
          <LoadingSkeleton rows={1} />
        </div>
      )}

      {schedules && schedules.length === 0 && (
        <Card className="mt-4">
          <EmptyState
            icon={CalendarClock}
            title="No schedules yet"
            description="Automate recurring reporting — pick a report template and a cron."
            action={
              <Button onClick={() => setCreating(true)} icon={<Plus aria-hidden className="size-4" />}>
                Add schedule
              </Button>
            }
          />
        </Card>
      )}

      {schedules && schedules.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {schedules.map((s) => (
            <li key={s.id}>
              <Card className="flex flex-wrap items-center gap-3 p-4">
                <span
                  aria-hidden
                  className="flex size-9 items-center justify-center rounded-md bg-[#F08A5D]/15 text-[#B85C22] dark:text-[#F5A878]"
                >
                  <CalendarClock className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                    {s.name}
                    <Badge variant={s.enabled ? "success" : "outline"}>{s.enabled ? "active" : "paused"}</Badge>
                    {s.lastRunStatus === "ok" && <Badge variant="accent">last run ok</Badge>}
                    {s.lastRunStatus === "error" && <Badge variant="critical">last run failed</Badge>}
                  </p>
                  <p className="text-caption text-muted">
                    {s.reportName ?? "report"} {s.projectName ? `· ${s.projectName}` : ""} ·{" "}
                    <code className="rounded bg-surface-2 px-1">{s.cron}</code>
                  </p>
                  <p className="mt-0.5 text-caption text-muted">
                    {s.nextRunAt ? `Next: ${new Date(s.nextRunAt).toLocaleString()}` : "No next run"} · recipients:{" "}
                    {s.recipients.length ? s.recipients.join(", ") : "none (local export only)"}
                  </p>
                  {s.lastRunMessage && <p className="mt-0.5 text-caption text-muted">{s.lastRunMessage}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {s.lastRunOutputUrl && (
                    <Link href={s.lastRunOutputUrl} target="_blank" rel="noreferrer">
                      <Button variant="secondary" size="sm">
                        Open latest
                      </Button>
                    </Link>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void runNow(s)}
                    loading={runningId === s.id}
                    icon={<Play aria-hidden className="size-3.5" />}
                  >
                    Run now
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void toggle(s)}>
                    {s.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button variant="ghost" size="sm" aria-label="Delete schedule" onClick={() => void remove(s)}>
                    <Trash2 aria-hidden className="size-4 text-muted hover:text-danger" />
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Add a schedule"
        description="Choose the report template and how often Ledgerly should regenerate it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} loading={busy}>
              Create schedule
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {formError && <ErrorMessage title="Could not create the schedule" message={formError} />}
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Weekly board pack"
              className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Report template</span>
            <select
              value={reportId}
              onChange={(e) => setReportId(e.target.value)}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="">Choose…</option>
              {reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} {r.projectName ? `(${r.projectName})` : ""}
                </option>
              ))}
            </select>
            {reports.length === 0 && (
              <span className="mt-1 block text-caption text-muted">Draft a report in Report Studio first.</span>
            )}
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Schedule</span>
            <select
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              {CRON_PRESETS.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label} — {p.desc}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-caption text-muted">
              Cron: <code className="rounded bg-surface-2 px-1">{cron}</code> (minute hour day-of-month month
              day-of-week)
            </span>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">
              Recipient emails (comma-separated, optional)
            </span>
            <input
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="ceo@company.com, finance@company.com"
              className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
            <span className="mt-1 block text-caption text-muted">
              Prototype mail transport prints a preview — no external email account needed.
            </span>
          </label>
        </div>
      </Dialog>
    </section>
  );
}
