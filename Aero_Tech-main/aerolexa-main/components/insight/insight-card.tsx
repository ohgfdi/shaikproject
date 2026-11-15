"use client";

import { ChevronDown, Eye, FilePlus, FlaskConical, Lightbulb, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { CONFIDENCE_LABEL } from "@/components/ui/theme";
import { api, errorMessage } from "@/lib/client/api";
import type { InsightCard } from "@/lib/types";
import { cn } from "@/lib/utils";

const SEVERITY_LABEL: Record<string, string> = { info: "Info", warning: "Watch", critical: "Critical" };

interface ReportOption {
  id: string;
  title: string;
  projectName?: string;
  updatedAt: string;
}

export function InsightCardView({ insight, onDelete }: { insight: InsightCard; onDelete?: () => void }) {
  const [open, setOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [addToReportOpen, setAddToReportOpen] = useState(false);
  const [reports, setReports] = useState<ReportOption[]>([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [creatingReport, setCreatingReport] = useState(false);
  const { toast } = useToast();
  const severityClass =
    insight.severity === "critical"
      ? "border-l-[3px] border-l-[#E8637A]"
      : insight.severity === "warning"
        ? "border-l-[3px] border-l-[#F08A5D]"
        : "border-l-[3px] border-l-[#3D9BE9]";

  const loadReports = async () => {
    setLoadingReports(true);
    try {
      const res = await api<{ reports: ReportOption[] }>("/api/insights/add-to-report/reports");
      setReports(res.reports);
    } catch (err) {
      toast({ title: "Could not load reports", message: errorMessage(err), type: "error" });
    } finally {
      setLoadingReports(false);
    }
  };

  const handleAddToReport = async (reportId: string) => {
    if (!insight.id) return;
    setCreatingReport(true);
    try {
      await api(`/api/insights/${insight.id}/add-to-report`, {
        method: "POST",
        body: JSON.stringify({ reportId }),
      });
      toast({ title: "Added to report", message: "Insight added as a new section.", type: "success" });
      setAddToReportOpen(false);
    } catch (err) {
      toast({ title: "Could not add to report", message: errorMessage(err), type: "error" });
    } finally {
      setCreatingReport(false);
    }
  };

  const handleCreateNewReport = async () => {
    if (!insight.id) return;
    setCreatingReport(true);
    try {
      const _res = await api<{ reportId: string }>(`/api/insights/${insight.id}/add-to-report`, {
        method: "POST",
        body: JSON.stringify({ createNew: true, title: `Report: ${insight.title}` }),
      });
      toast({ title: "Report created", message: "New report created with this insight.", type: "success" });
      setAddToReportOpen(false);
    } catch (err) {
      toast({ title: "Could not create report", message: errorMessage(err), type: "error" });
    } finally {
      setCreatingReport(false);
    }
  };

  return (
    <>
      <Card className={cn("transition-shadow hover:shadow-pop", severityClass)}>
        <CardContent className="px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant={
                    insight.severity === "critical" ? "critical" : insight.severity === "warning" ? "warning" : "info"
                  }
                >
                  {SEVERITY_LABEL[insight.severity] ?? insight.severity}
                </Badge>
                {insight.confidence === "inferred" && (
                  <Badge variant="amber" className="gap-1">
                    <FlaskConical aria-hidden className="size-3" />
                    Demo logic
                  </Badge>
                )}
              </div>
              <h3 className="mt-1.5 text-body font-semibold leading-snug text-foreground">{insight.title}</h3>
              {insight.observedChange && (
                <p className="mt-0.5 font-mono text-sm tabular-nums text-accent">{insight.observedChange}</p>
              )}
            </div>
            {onDelete && (
              <Button
                variant="ghost"
                size="xs"
                onClick={onDelete}
                aria-label="Delete insight"
                className="text-muted hover:text-danger"
              >
                <Trash2 aria-hidden className="size-3.5" />
              </Button>
            )}
          </div>

          {insight.metric && (
            <p className="mt-2 text-caption text-muted">
              <span className="font-medium text-foreground">Metric:</span> {insight.metric}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted">
            <span title={CONFIDENCE_LABEL[insight.confidence] ?? insight.confidence}>
              Confidence: <span className="font-medium text-foreground">{insight.confidence}</span>
            </span>
            {insight.createdAt && <span>· {new Date(insight.createdAt).toLocaleDateString()}</span>}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setEvidenceOpen(true)}
              icon={<Eye aria-hidden className="size-3.5" />}
            >
              View evidence
            </Button>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => {
                setAddToReportOpen(true);
                loadReports();
              }}
              icon={<FilePlus aria-hidden className="size-3.5" />}
            >
              Add to report
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              Business read
              <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
            </Button>
          </div>

          {open && (
            <div className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3 text-sm sm:grid-cols-3">
              {insight.possibleCause && (
                <p className="text-muted">
                  <span className="font-medium text-foreground">Possible cause:</span> {insight.possibleCause}
                </p>
              )}
              {insight.businessImplication && (
                <p className="text-muted">
                  <span className="font-medium text-foreground">Business implication:</span>{" "}
                  {insight.businessImplication}
                </p>
              )}
              {insight.recommendedNextStep && (
                <p className="text-muted">
                  <span className="font-medium text-foreground">Recommended next step:</span>{" "}
                  {insight.recommendedNextStep}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        title="Evidence behind this insight"
        description="Every card cites the exact columns, values and calculation it was derived from."
        size="md"
        footer={
          <Button variant="secondary" onClick={() => setEvidenceOpen(false)}>
            Close
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded border border-line bg-surface-2/60 px-3 py-2.5">
            <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
            <div>
              <p className="font-medium text-foreground">{insight.title}</p>
              {insight.observedChange && <p className="text-sm tabular-nums text-accent">{insight.observedChange}</p>}
            </div>
          </div>
          <ol className="flex flex-col gap-2">
            {insight.evidence.map((line, i) => (
              <li key={i} className="flex gap-2 text-sm text-muted">
                <span
                  aria-hidden
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-caption font-semibold text-accent"
                >
                  {i + 1}
                </span>
                {line}
              </li>
            ))}
          </ol>
        </div>
      </Dialog>

      <Dialog
        open={addToReportOpen}
        onClose={() => setAddToReportOpen(false)}
        title="Add insight to report"
        description="Choose an existing report or create a new one. The insight will be added as a new section with full provenance."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddToReportOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateNewReport}
              loading={creatingReport}
              icon={<FilePlus aria-hidden className="size-3.5" />}
            >
              Create new report
            </Button>
          </>
        }
      >
        {loadingReports ? (
          <div className="py-6 text-center text-sm text-muted">Loading reports…</div>
        ) : reports.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted">
            No reports yet. Click &ldquo;Create new report&rdquo; to start one with this insight.
          </div>
        ) : (
          <ul className="flex flex-col gap-2 max-h-60 overflow-y-auto">
            {reports.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => handleAddToReport(r.id)}
                  disabled={creatingReport}
                  className="w-full flex items-center justify-between rounded-md border border-line px-3 py-2 text-left hover:border-accent/50 hover:bg-surface-2 disabled:opacity-50"
                >
                  <div>
                    <p className="truncate font-medium text-foreground">{r.title}</p>
                    {r.projectName && (
                      <p className="text-caption text-muted">
                        {r.projectName} · {new Date(r.updatedAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <FilePlus aria-hidden className="size-4 shrink-0 text-accent" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}
