"use client";

import {
  ArrowRight,
  BarChart3,
  FileSpreadsheet,
  FlaskConical,
  LayoutDashboard,
  MessageSquareText,
  PencilRuler,
  Play,
  Plus,
  Presentation,
  Sparkles,
  Trash2,
  UploadCloud,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { activityMeta } from "@/components/activity/activity-meta";
import { InsightCardView } from "@/components/insight/insight-card";
import { ModelsTab } from "@/components/models/models-tab";
import { NotebookTab } from "@/components/notebook/notebook-tab";
import { ModelPanel } from "@/components/projects/model-panel";
import { TeamTab } from "@/components/team/team-tab";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { DemoBadge, ErrorMessage } from "@/components/ui/feedback";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/tabs";
import { api, errorMessage } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";
import type { InsightCard } from "@/lib/types";

export interface HubDataset {
  id: string;
  name: string;
  originalName: string;
  rowCount: number;
  columnCount: number;
  isDemo: boolean;
  createdAt: string;
  warnings: number;
  columns: { name: string; type: string }[];
}

export interface HubAnalysis {
  id: string;
  title: string;
  kind: string;
  datasetName: string | null;
  createdAt: string;
  quickFindings: string[];
}

export interface HubArtifact {
  id: string;
  title: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
  version?: number;
}

export interface HubProject {
  id: string;
  name: string;
  description: string | null;
  company: string | null;
  industry: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface HubProps {
  project: HubProject;
  datasets: HubDataset[];
  analyses: HubAnalysis[];
  insights: InsightCard[];
  dashboards: HubArtifact[];
  reports: HubArtifact[];
  presentations: HubArtifact[];
  activity: { id: string; type: string; message: string; createdAt: string }[];
  counts: Record<string, number>;
  /** WS1: server-side Python kernel flag (optional — defaults false). */
  serverPythonEnabled?: boolean;
  /** WS4: real-time collaboration flag (optional — defaults false). */
  collaborationEnabled?: boolean;
  /** Frozen-module switch: hides the Notebooks tab when the module is off. */
  notebookEnabled?: boolean;
  /** The current user's project role (drives editor affordances). */
  myRole?: string;
}

export function ProjectHub(props: HubProps) {
  const { project } = props;
  const router = useRouter();
  const search = useSearchParams();
  const initial = search.get("tab");
  const validTabs = [
    "overview",
    "datasets",
    "analyses",
    "insights",
    "dashboards",
    "reports",
    "presentations",
    "notebook",
    "models",
    "model",
    "team",
    "activity",
  ];
  const [tab, setTab] = useState(validTabs.includes(initial ?? "") ? (initial as string) : "overview");
  // ?tab=notebook must not survive the tab being hidden, so fall back to
  // overview when the notebook module is frozen.
  const notebookHidden = props.notebookEnabled === false;
  useEffect(() => {
    if (notebookHidden && tab === "notebook") setTab("overview");
  }, [notebookHidden, tab]);
  const setTabAndUrl = (key: string) => {
    setTab(key);
    router.replace(`/projects/${project.id}?tab=${key}`, { scroll: false });
  };

  const items = [
    { key: "overview", label: "Overview" },
    { key: "datasets", label: "Datasets", count: props.counts.datasets },
    { key: "analyses", label: "Analyses", count: props.counts.analyses },
    { key: "insights", label: "Insights", count: props.counts.insights },
    { key: "dashboards", label: "Dashboards", count: props.counts.dashboards },
    { key: "reports", label: "Reports", count: props.counts.reports },
    { key: "presentations", label: "Presentations", count: props.counts.presentations },
    // Frozen module: the tab disappears with the feature, and the panel below
    // is unreachable because the notebook APIs are gated too.
    ...(props.notebookEnabled === false
      ? []
      : [{ key: "notebook", label: "Notebooks", count: props.counts.notebooks }]),
    { key: "models", label: "Models", count: props.counts.models },
    { key: "model", label: "Model" },
    { key: "team", label: "Team", count: props.counts.team },
    { key: "activity", label: "Activity", count: props.counts.activity },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-h1 text-foreground">{project.name}</h1>
            <Badge variant={project.status === "ARCHIVED" ? "outline" : "success"}>
              {project.status.toLowerCase()}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {project.description ?? "No description"} {project.company ? `· Client: ${project.company}` : ""}{" "}
            {project.industry ? `· Industry: ${project.industry}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push(`/analyses/new?project=${project.id}`)}
            icon={<FlaskConical aria-hidden className="size-4" />}
          >
            Run analysis
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push(`/advisor?project=${project.id}`)}
            icon={<MessageSquareText aria-hidden className="size-4" />}
          >
            Ask advisor
          </Button>
          <ProjectMenu project={project} onDone={() => router.refresh()} />
        </div>
      </div>

      <Tabs items={items} active={tab} onChange={setTabAndUrl}>
        {tab === "overview" && <OverviewTab {...props} onNavigate={setTabAndUrl} />}
        {tab === "datasets" && <DatasetsTab {...props} />}
        {tab === "analyses" && <AnalysesTab {...props} />}
        {tab === "insights" && <InsightsTab {...props} />}
        {tab === "dashboards" && <DashboardsTab {...props} />}
        {tab === "reports" && <ReportsTab {...props} />} {tab === "presentations" && <PresentationsTab {...props} />}
        {tab === "notebook" && (
          <NotebookTab
            projectId={project.id}
            datasets={props.datasets.map((d) => ({ id: d.id, name: d.name, isDemo: d.isDemo }))}
            serverPythonEnabled={props.serverPythonEnabled}
            collaborationEnabled={props.collaborationEnabled}
          />
        )}
        {tab === "models" && <ModelsTab projectId={project.id} datasets={props.datasets} />}
        {tab === "model" && (
          <ModelPanel projectId={project.id} canEdit={props.myRole === "OWNER" || props.myRole === "EDITOR"} />
        )}
        {tab === "team" && <TeamTab projectId={project.id} />}
        {tab === "activity" && <ActivityTab {...props} />}
      </Tabs>
    </div>
  );
}

function ProjectMenu({ project, onDone }: { project: HubProject; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [status, setStatus] = useState(project.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const router = useRouter();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), status }),
      });
      toast({ title: "Project updated", type: "success" });
      setEditing(false);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete project “${project.name}”?`,
      message:
        "All its datasets, analyses, insights, dashboards, reports and presentations will be removed. This cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      toast({ title: "Project deleted", type: "success" });
      router.push("/projects");
      router.refresh();
    } catch (err) {
      toast({ title: "Could not delete project", message: errorMessage(err), type: "error" });
    }
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
        Settings
      </Button>
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Project settings"
        footer={
          <>
            <Button variant="danger" size="sm" onClick={remove} icon={<Trash2 aria-hidden className="size-4" />}>
              Delete
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button onClick={save} loading={busy}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <ErrorMessage title="Could not update" message={error} />}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1.5 block font-medium text-foreground">Project name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1.5 block font-medium text-foreground">Status</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
              >
                {["ACTIVE", "DRAFT", "COMPLETED", "ARCHIVED"].map((s) => (
                  <option key={s} value={s}>
                    {s.toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------

function OverviewTab(props: HubProps & { onNavigate: (key: string) => void }) {
  const { project, datasets, analyses, insights, dashboards, reports, presentations } = props;
  const latestInsight = insights[0];
  const statCards = [
    { label: "Datasets", value: props.counts.datasets, href: "datasets" },
    { label: "Analyses", value: props.counts.analyses, href: "analyses" },
    { label: "Insights", value: props.counts.insights, href: "insights" },
    { label: "Dashboards", value: props.counts.dashboards, href: "dashboards" },
    { label: "Reports", value: props.counts.reports, href: "reports" },
    { label: "Presentations", value: props.counts.presentations, href: "presentations" },
    { label: "Notebooks", value: props.counts.notebooks, href: "notebook" },
    { label: "Models", value: props.counts.models, href: "models" },
    { label: "Team", value: props.counts.team, href: "team" },
  ];
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <section className="xl:col-span-2">
        <h2 className="mb-3 text-h3 text-foreground">Getting the most out of this project</h2>
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <StepCard
            done={datasets.length > 0}
            step={1}
            title="Upload your dataset"
            body={
              datasets.length
                ? `“${datasets[0]?.name}” ready — ${datasets[0]?.rowCount.toLocaleString()} rows.`
                : "CSV or Excel. Ledgerly profiles it instantly."
            }
            onSelect={() => props.onNavigate("datasets")}
          />
          <StepCard
            done={analyses.length > 0}
            step={2}
            title="Run analyses"
            body={
              analyses.length
                ? `${analyses.length} analysis run(s) in the lab.`
                : "EDA, trends, KPIs, correlations, forecasts, cohorts…"
            }
            onSelect={() => props.onNavigate("analyses")}
          />
          <StepCard
            done={insights.length > 0}
            step={3}
            title="Generate insights"
            body={
              insights.length
                ? "Insight cards ready with evidence."
                : "Auto-detected findings with severity and evidence."
            }
            onSelect={() => props.onNavigate("insights")}
          />
          <StepCard
            done={dashboards.length > 0}
            step={4}
            title="Build the dashboard"
            body={dashboards.length ? "Dashboard saved." : "Drag in KPIs, charts and insight widgets."}
            onSelect={() => props.onNavigate("dashboards")}
          />
          <StepCard
            done={reports.length > 0}
            step={5}
            title="Draft the report"
            body={reports.length ? "Report drafted." : "Executive structure pre-populated from your data."}
            onSelect={() => props.onNavigate("reports")}
          />
          <StepCard
            done={presentations.length > 0}
            step={6}
            title="Prepare the board deck"
            body={presentations.length ? "Presentation saved." : "9-slide outline, ready to edit and export."}
            onSelect={() => props.onNavigate("presentations")}
          />
        </ol>

        <h2 className="mb-3 mt-7 text-h3 text-foreground">Latest dataset</h2>
        {datasets.length === 0 ? (
          <Card>
            <EmptyState
              icon={FileSpreadsheet}
              title="No dataset yet"
              description="Upload the file that should drive this project."
            />
          </Card>
        ) : (
          <DatasetRow dataset={datasets[0]!} projectId={project.id} />
        )}
      </section>

      <aside aria-label="Project summary" className="flex flex-col gap-4">
        <Card>
          <CardContent className="grid grid-cols-3 gap-3">
            {statCards.map((s) => (
              <div key={s.label}>
                <p className="text-caption text-muted">{s.label}</p>
                <p className="text-h3 tabular-nums text-foreground">{s.value}</p>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="mb-2 text-sm font-medium text-foreground">Meta</p>
            <dl className="space-y-1.5 text-sm">
              <Row k="Created" v={timeAgo(project.createdAt)} />
              <Row k="Last updated" v={timeAgo(project.updatedAt)} />
              {project.company && <Row k="Client / company" v={project.company} />}
              {project.industry && <Row k="Industry" v={project.industry} />}
            </dl>
          </CardContent>
        </Card>
        {latestInsight && (
          <div>
            <h2 className="mb-2 text-h3 text-foreground">Latest insight</h2>
            <InsightCardView insight={latestInsight} />
          </div>
        )}
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right font-medium text-foreground">{v}</dd>
    </div>
  );
}

function StepCard({
  done,
  step,
  title,
  body,
  onSelect,
}: {
  done: boolean;
  step: number;
  title: string;
  body: string;
  onSelect: () => void;
}) {
  return (
    <li>
      <button onClick={onSelect} className="card flex h-full w-full gap-3 p-4 text-left hover:shadow-pop">
        <span
          className={
            done
              ? "flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"
              : "flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted ring-1 ring-line"
          }
        >
          {done ? <Play aria-hidden className="size-3.5 rotate-45" /> : step}
        </span>
        <span>
          <span className="block font-medium text-foreground">{title}</span>
          <span className="mt-0.5 block text-sm text-muted">{body}</span>
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------

function DatasetRow({ dataset, projectId }: { dataset: HubDataset; projectId: string }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium text-foreground">{dataset.name}</p>
            {dataset.isDemo && (
              <DemoBadge compact tooltip="This is synthetic demo data — labelled clearly, never mistaken for real." />
            )}
          </div>
          <p className="mt-0.5 text-caption text-muted">
            {dataset.rowCount.toLocaleString()} rows · {dataset.columnCount} columns · {timeAgo(dataset.createdAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/analyses/new?project=${projectId}&dataset=${dataset.id}`}>
            <Button size="sm" variant="secondary" icon={<FlaskConical aria-hidden className="size-3.5" />}>
              Analyse
            </Button>
          </Link>
          <Link href={`/datasets/${dataset.id}`}>
            <Button size="sm" icon={<ArrowRight aria-hidden className="size-3.5" />}>
              Open
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ListFooter({ shown, total, href }: { shown: number; total: number | undefined; href: string }) {
  if (total === undefined || shown >= total) return null;
  return (
    <p className="mt-3 text-caption text-muted">
      Showing first {shown} of {total} ·{" "}
      <Link href={href} className="font-medium text-accent hover:underline">
        Show all
      </Link>
    </p>
  );
}

// ---------------------------------------------------------------------------

function DatasetsTab(props: HubProps) {
  const router = useRouter();
  const { datasets, project } = props;
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [makingDemo, setMakingDemo] = useState(false);
  const [leftDatasetId, setLeftDatasetId] = useState(datasets[0]?.id ?? "");
  const [rightDatasetId, setRightDatasetId] = useState(datasets[1]?.id ?? "");
  const [leftColumn, setLeftColumn] = useState(datasets[0]?.columns[0]?.name ?? "");
  const [rightColumn, setRightColumn] = useState(datasets[1]?.columns[0]?.name ?? "");
  const [mappingMessage, setMappingMessage] = useState<string | null>(null);
  const leftDataset = datasets.find((dataset) => dataset.id === leftDatasetId);
  const rightDataset = datasets.find((dataset) => dataset.id === rightDatasetId);

  const saveMapping = async () => {
    setMappingMessage(null);
    try {
      const response = await api<{ validation: { warnings: string[] } }>(`/api/projects/${project.id}/joins`, {
        method: "POST",
        body: JSON.stringify({ leftDatasetId, leftColumn, rightDatasetId, rightColumn }),
      });
      setMappingMessage(
        response.validation.warnings.length
          ? response.validation.warnings.join(" ")
          : "Join mapping saved. Keys look compatible.",
      );
    } catch (err) {
      setMappingMessage(errorMessage(err));
    }
  };

  const upload = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("projectId", project.id);
      fd.append("file", file);
      const res = await api<{ datasetId: string }>("/api/upload", { method: "POST", body: fd });
      toast({ title: "Dataset uploaded & profiled", type: "success" });
      router.push(`/datasets/${res.datasetId}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setUploading(false);
    }
  };

  const demo = async () => {
    setMakingDemo(true);
    try {
      const res = await api<{ datasetId: string; name: string }>(`/api/projects/${project.id}/demo`, {
        method: "POST",
      });
      toast({
        title: "Demo / synthetic dataset added",
        message: `${res.name} — clearly labelled as demo data.`,
        type: "info",
      });
      router.push(`/datasets/${res.datasetId}`);
      router.refresh();
    } catch (err) {
      toast({ title: "Could not create demo dataset", message: errorMessage(err), type: "error" });
    } finally {
      setMakingDemo(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          aria-label="Upload a CSV or Excel dataset"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <Button
          onClick={() => inputRef.current?.click()}
          loading={uploading}
          icon={<UploadCloud aria-hidden className="size-4" />}
        >
          Upload CSV / XLSX
        </Button>
        <Button
          variant="secondary"
          onClick={demo}
          loading={makingDemo}
          icon={<Sparkles aria-hidden className="size-4" />}
        >
          Add labelled demo dataset
        </Button>
      </div>
      {error && (
        <ErrorMessage
          title="Upload failed"
          message={error}
          howToFix="Use a .csv, .xlsx or text-layer .pdf under 100 MB and try again."
          className="mb-4"
        />
      )}

      {datasets.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileSpreadsheet}
            title="No datasets yet"
            description="Upload the CSV or Excel file this project should analyse — or add a clearly-labelled synthetic demo to explore the UI."
            action={<Button onClick={() => inputRef.current?.click()}>Upload your dataset</Button>}
          />
        </Card>
      ) : (
        <>
          {datasets.length > 1 && (
            <Card className="mb-4 p-4">
              <p className="font-medium text-foreground">Map a join key</p>
              <p className="mt-1 text-sm text-muted">
                Declare how two project datasets relate. Ledgerly warns about type mismatches and unmatched keys.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-5 md:items-end">
                <select
                  aria-label="Left join dataset"
                  value={leftDatasetId}
                  onChange={(event) => {
                    setLeftDatasetId(event.target.value);
                    setLeftColumn(
                      datasets.find((dataset) => dataset.id === event.target.value)?.columns[0]?.name ?? "",
                    );
                  }}
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm"
                >
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Left join column"
                  value={leftColumn}
                  onChange={(event) => setLeftColumn(event.target.value)}
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm"
                >
                  {(leftDataset?.columns ?? []).map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name} ({column.type})
                    </option>
                  ))}
                </select>
                <span className="text-center text-sm text-muted">equals</span>
                <select
                  aria-label="Right join dataset"
                  value={rightDatasetId}
                  onChange={(event) => {
                    setRightDatasetId(event.target.value);
                    setRightColumn(
                      datasets.find((dataset) => dataset.id === event.target.value)?.columns[0]?.name ?? "",
                    );
                  }}
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm"
                >
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Right join column"
                  value={rightColumn}
                  onChange={(event) => setRightColumn(event.target.value)}
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm"
                >
                  {(rightDataset?.columns ?? []).map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name} ({column.type})
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Button size="sm" onClick={() => void saveMapping()}>
                  Save join mapping
                </Button>
                {mappingMessage && (
                  <span className="text-sm text-muted" role="status">
                    {mappingMessage}
                  </span>
                )}
              </div>
            </Card>
          )}
          <ul className="flex flex-col gap-3">
            {datasets.map((d) => (
              <li key={d.id}>
                <DatasetRow dataset={d} projectId={project.id} />
              </li>
            ))}
          </ul>
          <ListFooter
            shown={datasets.length}
            total={props.counts.datasets}
            href={`/projects/${project.id}?tab=datasets&all=1`}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AnalysesTab(props: HubProps) {
  const router = useRouter();
  const { analyses, project } = props;
  return (
    <div>
      <div className="mb-4">
        <Link href={`/analyses/new?project=${project.id}`}>
          <Button icon={<Plus aria-hidden className="size-4" />}>New analysis</Button>
        </Link>
      </div>
      {analyses.length === 0 ? (
        <Card>
          <EmptyState
            icon={FlaskConical}
            title="Run your first analysis"
            description="Pick an analysis type and Ledgerly computes it against the uploaded dataset — with a full 'How was this calculated?' breakdown."
            action={
              <Link href={`/analyses/new?project=${project.id}`}>
                <Button>Start in the Analysis Lab</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {analyses.map((a) => (
              <li key={a.id}>
                <Card className="p-3.5">
                  <div className="flex items-center gap-3">
                    <Link href={`/analyses/${a.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                      <span
                        aria-hidden
                        className="flex size-9 items-center justify-center rounded-md bg-[#7C5CFF]/12 text-[#7C5CFF]"
                      >
                        <FlaskConical className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground hover:text-accent">{a.title}</span>
                        <span className="block truncate text-caption text-muted">
                          {a.kind} · {a.datasetName ?? "dataset"} · {timeAgo(a.createdAt)}
                        </span>
                      </span>
                    </Link>
                    <DeleteButton
                      path={`/api/analyses/${a.id}`}
                      label="Delete analysis"
                      onDone={() => router.refresh()}
                    />
                  </div>
                  {a.quickFindings[0] && <p className="mt-1.5 pl-12 text-caption text-muted">“{a.quickFindings[0]}”</p>}
                </Card>
              </li>
            ))}
          </ul>
          <ListFooter
            shown={analyses.length}
            total={props.counts.analyses}
            href={`/projects/${project.id}?tab=analyses&all=1`}
          />
        </>
      )}
    </div>
  );
}

function DeleteButton({ path, label, onDone }: { path: string; label: string; onDone: () => void }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={async () => {
        const ok = await confirm({
          title: `${label}?`,
          message: "This cannot be undone.",
          confirmLabel: "Delete",
        });
        if (!ok) return;
        try {
          await api(path, { method: "DELETE" });
          toast({ title: "Deleted", type: "success" });
          onDone();
        } catch (err) {
          toast({ title: "Could not delete", message: errorMessage(err), type: "error" });
        }
      }}
    >
      <Trash2 aria-hidden className="size-4 text-muted hover:text-danger" />
    </Button>
  );
}

// ---------------------------------------------------------------------------

function InsightsTab(props: HubProps) {
  const router = useRouter();
  const { insights, datasets, project: _project } = props;
  const { toast } = useToast();
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = datasets.find((d) => d.id === pick);

  const generate = async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/datasets/${pick}/insights`, { method: "POST" });
      toast({ title: "Insights generated", type: "success" });
      setPick(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeInsight = async (id: string) => {
    try {
      await api(`/api/insights/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      toast({ title: "Could not remove insight", message: errorMessage(err), type: "error" });
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          icon={<Sparkles aria-hidden className="size-4" />}
          onClick={() => setPick(datasets[0]?.id ?? "")}
          disabled={datasets.length === 0}
          title={datasets.length === 0 ? "Upload a dataset first" : undefined}
        >
          Generate insights for a dataset
        </Button>
        {datasets.length > 0 && datasets.length <= 1 && (
          <p className="text-caption text-muted">
            Scans {datasets[0]?.name} for movements, correlations, outliers and risks.
          </p>
        )}
      </div>
      {insights.length === 0 && (
        <Card>
          <EmptyState
            icon={Sparkles}
            title="No insights yet"
            description="Run the insight engine on one of this project's datasets to surface evidence-backed findings."
            action={
              datasets.length ? (
                <Button onClick={() => setPick(datasets[0]?.id ?? "")}>Generate insights</Button>
              ) : undefined
            }
          />
        </Card>
      )}
      <ul className="flex flex-col gap-3">
        {insights.map((i) => (
          <li key={i.id}>
            <InsightCardView insight={i} onDelete={() => void removeInsight(i.id!)} />
          </li>
        ))}
      </ul>
      <ListFooter
        shown={insights.length}
        total={props.counts.insights}
        href={`/projects/${props.project.id}?tab=insights&all=1`}
      />

      <Dialog
        open={pick !== null}
        onClose={() => setPick(null)}
        title="Generate insights"
        description="Ledgerly scans the dataset with deterministic rules and creates evidence-backed insight cards."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPick(null)}>
              Cancel
            </Button>
            <Button
              onClick={generate}
              loading={busy}
              disabled={!chosen}
              icon={<Sparkles aria-hidden className="size-4" />}
            >
              Scan & generate
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <ErrorMessage title="Generation failed" message={error} />}
          <label className="text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Dataset</span>
            <select
              value={pick ?? ""}
              onChange={(e) => setPick(e.target.value)}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.rowCount.toLocaleString()} rows)
                </option>
              ))}
            </select>
          </label>
          {chosen?.isDemo && (
            <DemoBadge tooltip="This dataset is synthetic demo data — the insights below are for UI demonstration only." />
          )}
        </div>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DashboardsTab(props: HubProps) {
  const router = useRouter();
  const { dashboards, project } = props;
  return (
    <GenericList
      kind="dashboards"
      projectId={project.id}
      items={dashboards}
      createHref={`/dashboards/new?project=${project.id}`}
      createLabel="New dashboard"
      icon={LayoutDashboard}
      color="#58B368"
      emptyTitle="No dashboards yet"
      emptyBody="Build a canvas of KPI, chart, insight and text widgets driven by this project's analyses."
      onDone={() => router.refresh()}
      total={props.counts.dashboards}
      allHref={`/projects/${project.id}?tab=dashboards&all=1`}
    />
  );
}

function ReportsTab(props: HubProps) {
  const router = useRouter();
  const { reports, project } = props;
  return (
    <GenericList
      kind="reports"
      projectId={project.id}
      items={reports}
      createHref={`/reports/new?project=${project.id}`}
      createLabel="New report"
      icon={PencilRuler}
      color="#F08A5D"
      emptyTitle="No reports yet"
      emptyBody="Draft an executive report with the standard structure pre-populated from your data."
      onDone={() => router.refresh()}
      total={props.counts.reports}
      allHref={`/projects/${project.id}?tab=reports&all=1`}
    />
  );
}

function PresentationsTab(props: HubProps) {
  const router = useRouter();
  const { presentations, project } = props;
  return (
    <GenericList
      kind="presentations"
      projectId={project.id}
      items={presentations}
      createHref={`/presentations/new?project=${project.id}`}
      createLabel="New presentation"
      icon={Presentation}
      color="#E8637A"
      emptyTitle="No presentations yet"
      emptyBody="Start from the 9-slide board outline and make it yours."
      onDone={() => router.refresh()}
      total={props.counts.presentations}
      allHref={`/projects/${project.id}?tab=presentations&all=1`}
    />
  );
}

function GenericList({
  kind,
  projectId: _projectId,
  items,
  createHref,
  createLabel,
  icon: Icon,
  color,
  emptyTitle,
  emptyBody,
  onDone: _onDone,
  total,
  allHref,
}: {
  kind: string;
  projectId: string;
  items: HubArtifact[];
  createHref: string;
  createLabel: string;
  icon: typeof BarChart3;
  color: string;
  emptyTitle: string;
  emptyBody: string;
  onDone: () => void;
  total?: number;
  allHref?: string;
}) {
  return (
    <div>
      <div className="mb-4">
        <Link href={createHref}>
          <Button icon={<Plus aria-hidden className="size-4" />}>{createLabel}</Button>
        </Link>
      </div>
      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Icon}
            title={emptyTitle}
            description={emptyBody}
            action={
              <Link href={createHref}>
                <Button>{createLabel}</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((a) => (
              <li key={a.id}>
                <Link href={`/${kind}/${a.id}`} className="card flex h-full flex-col p-4 hover:shadow-pop">
                  <span
                    aria-hidden
                    className="flex size-9 items-center justify-center rounded-md"
                    style={{ backgroundColor: `${color}22`, color }}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="mt-2.5 line-clamp-2 font-medium text-foreground">{a.title}</span>
                  {a.description && <span className="mt-1 line-clamp-1 text-caption text-muted">{a.description}</span>}
                  <span className="mt-auto pt-2 text-caption text-muted">
                    Updated {timeAgo(a.updatedAt)}
                    {a.version ? ` · v${a.version}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {total !== undefined && allHref && <ListFooter shown={items.length} total={total} href={allHref} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ActivityTab(props: HubProps) {
  const { activity } = props;
  if (activity.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={BarChart3}
          title="No activity yet"
          description="Actions in this project (uploads, analyses, exports) will be logged here in chronological order."
        />
      </Card>
    );
  }
  return (
    <Card>
      <ol className="thin-scroll max-h-[540px] divide-y divide-line overflow-y-auto">
        {activity.map((a) => {
          const meta = activityMeta(a.type);
          const Icon = meta.icon;
          return (
            <li key={a.id} className="flex items-start gap-3 px-4 py-3">
              <span
                aria-hidden
                className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md"
                style={{ backgroundColor: meta.bg, color: meta.color }}
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 text-sm">
                <p className="text-foreground">{a.message}</p>
                <p className="text-caption text-muted">
                  {a.type.replace(/_/g, " ").toLowerCase()} · {timeAgo(a.createdAt)}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
