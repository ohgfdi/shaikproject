"use client";

import { CheckCircle2, ClipboardCheck, CircleDot, Loader2, Plus, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DueDateDrift } from "@/components/compliance/due-date-drift";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type {
  AvailableObligation,
  FilingRunView,
} from "@/lib/server/filing-runs";

/**
 * Filing execution board: every statutory obligation the firm has started,
 * grouped by stage, with the acknowledgement that closes it. The calendar
 * shows what is due; this screen shows what is being done about it.
 */
const STAGES = [
  { id: "computed", label: "Computed", hint: "Not started" },
  { id: "prepared", label: "Prepared", hint: "Return ready" },
  { id: "reviewed", label: "Reviewed", hint: "Second pair of eyes" },
  { id: "client-approved", label: "Client approved", hint: "Approval on record" },
  { id: "filed", label: "Filed", hint: "Submitted" },
  { id: "acknowledged", label: "Acknowledged", hint: "ARN/SRN recorded" },
] as const;

type Stage = (typeof STAGES)[number]["id"];

const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES.map((s) => [s.id, s.label]));

function nextStage(stage: string): Stage | null {
  const index = STAGES.findIndex((s) => s.id === stage);
  const next = index >= 0 ? STAGES[index + 1] : undefined;
  return next ? next.id : null;
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function fmtDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? dateFmt.format(date) : iso;
}

export function FilingBoard({ initialRuns = [] }: { initialRuns?: FilingRunView[] }) {
  const [runs, setRuns] = useState<FilingRunView[]>(initialRuns);
  const [available, setAvailable] = useState<AvailableObligation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState("");
  const [ackRefs, setAckRefs] = useState<Record<string, string>>({});
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ runs: FilingRunView[]; available: AvailableObligation[] }>(
        "/api/organization/compliance/filings",
      );
      setRuns(data.runs);
      setAvailable(data.available);
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

  const grouped = useMemo(() => {
    const map = new Map<string, FilingRunView[]>();
    for (const stage of STAGES) map.set(stage.id, []);
    for (const run of runs) {
      const bucket = map.get(run.stage);
      if (bucket) bucket.push(run);
      else map.set(run.stage, [run]);
    }
    return map;
  }, [runs]);

  const createRun = useCallback(async () => {
    if (!selected) return;
    const [engagementId, taskId] = selected.split("::");
    setBusyId("create");
    setError(null);
    try {
      await api("/api/organization/compliance/filings", {
        method: "POST",
        body: JSON.stringify({ engagementId, taskId }),
      });
      setNotice("Obligation added to the filing board.");
      setSelected("");
      setCreating(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }, [selected, load]);

  const submitRun = useCallback(
    async (run: FilingRunView) => {
      setBusyId(run.id);
      setError(null);
      try {
        await api(`/api/organization/compliance/filings/${run.id}`, {
          method: "PATCH",
          body: JSON.stringify({ action: "submit" }),
        });
        setNotice(`${run.title} was submitted; the portal acknowledgement is recorded on the run.`);
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const verifyRun = useCallback(
    async (run: FilingRunView) => {
      setVerifyingId(run.id);
      setError(null);
      try {
        const result = await api<{
          verification: { verificationStatus: string; note: string; provider: string };
        }>(`/api/organization/compliance/filings/${run.id}/verify`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        const status = result.verification.verificationStatus;
        setNotice(
          status === "verified"
            ? `${run.title}: ${result.verification.note}`
            : status === "defective"
              ? `${run.title} is defective: ${result.verification.note}`
              : `${run.title}: ${result.verification.note}`,
        );
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setVerifyingId(null);
      }
    },
    [load],
  );

  const openDueSoon = useCallback(async () => {
    setBusyId("open-due-soon");
    setError(null);
    try {
      const result = await api<{ opened: number; remaining: number }>(
        "/api/organization/compliance/filings",
        { method: "POST", body: JSON.stringify({ action: "open-due-soon" }) },
      );
      setNotice(
        result.opened === 0
          ? "No uncovered obligation is due in the next 14 days."
          : `Opened ${result.opened} run(s)${result.remaining > 0 ? `; ${result.remaining} more still available` : ""}.`,
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }, []);

  const bulkAdvance = useCallback(
    async (stage: Stage) => {
      setBusyId("bulk");
      setError(null);
      try {
        const result = await api<{ updated: number; failed: { runId: string; message: string }[] }>(
          "/api/organization/compliance/filings/bulk",
          {
            method: "POST",
            body: JSON.stringify({ action: "advance", runIds: selectedIds, stage }),
          },
        );
        setNotice(
          `${result.updated} run(s) moved to ${STAGE_LABEL[stage] ?? stage}` +
            (result.failed.length > 0 ? `; ${result.failed.length} refused (${result.failed[0]?.message ?? ""})` : "."),
        );
        setSelectedIds([]);
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [selectedIds, load],
  );

  const advance = useCallback(
    async (run: FilingRunView, stage: Stage) => {
      setBusyId(run.id);
      setError(null);
      try {
        await api(`/api/organization/compliance/filings/${run.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            action: "advance",
            stage,
            acknowledgementReference: ackRefs[run.id]?.trim() || null,
          }),
        });
        setNotice(`${run.title} moved to ${STAGE_LABEL[stage] ?? stage}.`);
        setAckRefs((current) => ({ ...current, [run.id]: "" }));
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [ackRefs, load],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="default">{runs.length} runs</Badge>
          <Badge variant="warning">{available.length} obligations not started</Badge>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            disabled={busyId === "open-due-soon"}
            onClick={() => void openDueSoon()}
          >
            {busyId === "open-due-soon" ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <ClipboardCheck className="mr-1.5 h-4 w-4" />
            )}
            Open due-soon
          </Button>
          <Button variant="secondary" onClick={() => setCreating((v) => !v)}>
            <Plus className="mr-1.5 h-4 w-4" /> Add obligation
          </Button>
        </div>
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

      <DueDateDrift onChanged={load} />

      {selectedIds.length > 0 ? (
        <Card className="border-accent/40 bg-accent/5">
          <CardContent className="flex flex-wrap items-center gap-2 p-3">
            <Badge variant="default">{selectedIds.length} selected</Badge>
            <Button
              size="sm"
              variant="secondary"
              disabled={busyId === "bulk"}
              onClick={() => void bulkAdvance("prepared")}
            >
              Mark prepared
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busyId === "bulk"}
              onClick={() => void bulkAdvance("reviewed")}
            >
              Mark reviewed
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
              Clear
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Each run keeps its own role gate; refused runs are reported, not hidden.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {creating ? (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <label className="min-w-[320px] flex-1 text-sm">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Open obligation</span>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">Choose a client obligation…</option>
                {available.map((item) => (
                  <option key={`${item.engagementId}::${item.taskId}`} value={`${item.engagementId}::${item.taskId}`}>
                    {item.engagementName} — {item.title} (due {fmtDate(item.dueDate)})
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={createRun} disabled={!selected || busyId === "create"}>
              {busyId === "create" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Open run
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 overflow-x-auto lg:grid-cols-3 xl:grid-cols-6">
        {STAGES.map((stage) => {
          const items = grouped.get(stage.id) ?? [];
          return (
            <section key={stage.id} className="min-w-[220px] rounded-lg border bg-muted/20">
              <header className="border-b px-3 py-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide">{stage.label}</h3>
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">{stage.hint}</p>
              </header>
              <div className="space-y-2 p-2">
                {items.length === 0 ? (
                  <p className="px-1 py-4 text-center text-xs text-muted-foreground">Nothing here.</p>
                ) : (
                  items.map((run) => {
                    const next = nextStage(run.stage);
                    const needsAck = next === "acknowledged";
                    return (
                      <Card key={run.id} className="shadow-none">
                        <CardContent className="space-y-2 p-3">
                          <div className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1 h-3.5 w-3.5"
                              aria-label={`Select ${run.title}`}
                              checked={selectedIds.includes(run.id)}
                              onChange={() => toggleSelected(run.id)}
                            />
                            <div className="min-w-0">
                              <p className="text-sm font-medium leading-tight">{run.title}</p>
                              <p className="text-xs text-muted-foreground">{run.engagementName}</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            <Badge variant={run.dueDate < new Date().toISOString().slice(0, 10) ? "critical" : "outline"}>
                              Due {fmtDate(run.dueDate)}
                            </Badge>
                            <Badge variant="default">{run.authority}</Badge>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {run.assigneeName ? `Owner: ${run.assigneeName}` : "Unassigned"}
                          </p>
                          {run.acknowledgementReference ? (
                            <p className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                              <ShieldCheck className="h-3.5 w-3.5" /> {run.acknowledgementReference}
                            </p>
                          ) : null}
                          {run.verificationStatus === "defective" ? (
                            <Badge variant="critical">Portal says defective</Badge>
                          ) : run.verificationStatus === "verified" ? (
                            <Badge variant="success">Verified with portal</Badge>
                          ) : run.verificationStatus === "unverifiable" ? (
                            <Badge variant="outline">Unverified — provider offline</Badge>
                          ) : null}
                          {run.proofDigest ? (
                            <a
                              href={`/api/organization/compliance/filings/${run.id}/proof`}
                              download={`filing-proof-${run.id}.json`}
                              className="text-[11px] text-accent underline underline-offset-2"
                            >
                              Download proof bundle
                            </a>
                          ) : null}
                          {run.clientApprovalDigest ? (
                            <a
                              href={`/api/organization/compliance/filings/${run.id}/approval-receipt`}
                              download={`client-approval-${run.id}.json`}
                              className="text-[11px] text-accent underline underline-offset-2"
                            >
                              Client approval receipt
                            </a>
                          ) : null}
                          {run.stage === "filed" ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              className="w-full"
                              disabled={verifyingId === run.id}
                              onClick={() => void verifyRun(run)}
                            >
                              {verifyingId === run.id ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              Verify with portal
                            </Button>
                          ) : null}
                          {needsAck ? (
                            <input
                              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                              placeholder="ARN / SRN"
                              value={ackRefs[run.id] ?? ""}
                              onChange={(event) =>
                                setAckRefs((current) => ({ ...current, [run.id]: event.target.value }))
                              }
                            />
                          ) : null}
                          {next === "filed" ? (
                            <Button
                              size="sm"
                              className="w-full"
                              disabled={busyId === run.id}
                              onClick={() => void submitRun(run)}
                            >
                              {busyId === run.id ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              Submit to portal
                            </Button>
                          ) : next ? (
                            <Button
                              size="sm"
                              variant={next === "acknowledged" ? "primary" : "secondary"}
                              className="w-full"
                              disabled={busyId === run.id}
                              onClick={() => void advance(run, next)}
                            >
                              {busyId === run.id ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : next === "acknowledged" ? (
                                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                              ) : (
                                <CircleDot className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              {STAGE_LABEL[next]}
                            </Button>
                          ) : (
                            <p className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Complete
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
