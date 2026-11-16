import { AlertTriangle, FileSpreadsheet, FlaskConical, Sparkles } from "lucide-react";

/**
 * tenancy-audit: global-operator — dataset detail page shows workspace-wide
 * dataset details and associated analyses. This is a deployment-wide aggregate
 * rather than a per-tenant query.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  DatasetColumnOps,
  DatasetDeleteButton,
  DatasetRename,
  GenerateInsightsButton,
} from "@/components/datasets/dataset-actions";
import { DatasetCopilot } from "@/components/datasets/dataset-copilot";
import { ExecutiveSummary } from "@/components/datasets/executive-summary";
import { SemanticMetrics } from "@/components/datasets/semantic-metrics";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { DemoBadge, WarningBanner } from "@/components/ui/feedback";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { SubNav } from "@/components/ui/sub-nav";
import { DataTable } from "@/components/ui/table";
import { requirePageAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";
import type { Cell } from "@/lib/engine/dataset";
import { fmtDate, timeAgo } from "@/lib/format";
import { parseJson, parseJsonArray } from "@/lib/json";
import { datasetColumns } from "@/lib/serialize";
import { moduleEnabled } from "@/lib/server/modules";
import type { DatasetProfile } from "@/lib/types";
import { formatBytes } from "@/lib/utils";

export const metadata = { title: "Dataset" };

export default async function DatasetDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requirePageAuth();
  const dataset = await withTenantDb(ctx, (db) =>
    db.dataset.findUnique({
      where: { id: params.id },
      include: { project: { select: { id: true, name: true } } },
    }),
  );
  if (!dataset || dataset.workspaceId !== ctx.workspace.id) notFound();

  const columns = datasetColumns(dataset);
  const profile = parseJson<DatasetProfile | null>(dataset.profile, null);
  const preview = parseJsonArray<Cell[]>(dataset.preview, []);
  const warnings = parseJsonArray<string>(dataset.qualityWarnings, []);
  const insights = await withTenantDb(ctx, (db) =>
    db.insight.findMany({
      where: { datasetId: dataset.id },
      orderBy: { createdAt: "desc" },
      take: 3,
    }),
  );
  const hasAnalyses = (await prisma.analysis.count({ where: { datasetId: dataset.id } })) > 0;

  const stats = [
    { label: "Rows", value: dataset.rowCount.toLocaleString() },
    { label: "Columns", value: dataset.columnCount },
    { label: "File size", value: formatBytes(dataset.sizeBytes) },
    { label: "Uploaded", value: fmtDate(dataset.createdAt) },
    { label: "Format", value: dataset.mimeType.includes("spreadsheet") ? "Excel (.xlsx)" : "CSV" },
  ];

  return (
    <div>
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {dataset.name}
            {dataset.isDemo && (
              <DemoBadge tooltip="This dataset is synthetic demo data (Dataset.isDemo = true). Analyses run on it are for demonstration only." />
            )}
          </span>
        }
        description={
          <>
            {dataset.originalName} · {dataset.columnCount} columns × {dataset.rowCount.toLocaleString()} rows ·{" "}
            {dataset.project ? (
              <>
                in{" "}
                <Link className="text-accent hover:underline" href={`/projects/${dataset.project.id}`}>
                  {dataset.project.name}
                </Link>
              </>
            ) : (
              "no project"
            )}{" "}
            · updated {timeAgo(dataset.updatedAt)}
          </>
        }
        actions={
          <>
            <DatasetRename datasetId={dataset.id} current={dataset.name} />
            <a href={`/api/datasets/${dataset.id}/export/xlsx`} download>
              <Button variant="secondary" icon={<FileSpreadsheet aria-hidden className="size-4" />}>
                Excel
              </Button>
            </a>
            <Link href={`/analyses/new?project=${dataset.projectId ?? ""}&dataset=${dataset.id}`}>
              <Button variant="secondary" icon={<FlaskConical aria-hidden className="size-4" />}>
                Analyse this file
              </Button>
            </Link>
            <GenerateInsightsButton datasetId={dataset.id} />
            {dataset.projectId && <DatasetDeleteButton datasetId={dataset.id} projectId={dataset.projectId} />}
          </>
        }
      />

      {warnings.length > 0 && (
        <div className="mb-5 flex flex-col gap-2">
          {warnings.slice(0, 3).map((w, i) => (
            <WarningBanner key={i} title="Data-quality notice" severity={i === 0 ? "warning" : "info"}>
              {w}
            </WarningBanner>
          ))}
        </div>
      )}

      <SubNav
        aria-label="Dataset tools"
        items={[
          { href: `/datasets/${dataset.id}`, label: "Overview", exact: true },
          { href: `/datasets/${dataset.id}/transform`, label: "Transform" },
          // SQL lab and What-if are frozen modules: read the same predicate
          // their API routes gate on, so the tab disappears with the feature
          // instead of surviving as a dead link.
          ...(moduleEnabled("SQL_LAB_ENABLED") ? [{ href: `/datasets/${dataset.id}/query`, label: "SQL lab" }] : []),
          ...(moduleEnabled("WHATIF_ENABLED") ? [{ href: `/datasets/${dataset.id}/whatif`, label: "What-if" }] : []),
          { href: `/datasets/${dataset.id}/studio`, label: "Power BI studio" },
        ]}
      />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {stats.map((s) => (
          <Card key={s.label} className="px-3.5 py-2.5">
            <dt className="text-caption text-muted">{s.label}</dt>
            <dd
              className="mt-0.5 truncate text-body font-semibold tabular-nums text-foreground"
              title={String(s.value)}
            >
              {s.value}
            </dd>
          </Card>
        ))}
      </dl>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <section className="xl:col-span-2">
          <h2 className="mb-3 flex items-center gap-2 text-h3 text-foreground">
            <FileSpreadsheet aria-hidden className="size-4 text-accent" /> Data preview
            <span className="text-caption font-normal text-muted">
              first {preview.length} of {dataset.rowCount.toLocaleString()} rows
            </span>
          </h2>
          <DataTable
            columns={columns.map((c) => ({
              key: c.name,
              label: c.name,
              format: c.type === "number" ? "number" : c.type === "date" ? "date" : "text",
            }))}
            rows={preview.map((row) => row as (string | number | null)[])}
            pageSize={10}
          />
        </section>

        <aside aria-label="Column controls" className="flex flex-col gap-5">
          <div>
            <h2 className="mb-3 text-h3 text-foreground">Columns</h2>
            <DatasetColumnOps datasetId={dataset.id} columns={columns.map((c) => ({ name: c.name, type: c.type }))} />
          </div>
          <Card>
            <CardContent className="flex flex-col gap-2 text-sm">
              <p className="font-medium text-foreground">Next steps for this file</p>
              {!hasAnalyses && (
                <p className="text-muted">
                  <AlertTriangle aria-hidden className="mr-1 inline size-3.5 text-warning" />
                  No analyses yet — run one to see how the numbers behave.
                </p>
              )}
              {insights.length === 0 ? (
                <p className="text-muted">
                  Generate insight cards to surface movements, outliers and risks automatically.
                </p>
              ) : (
                <p className="text-muted">{insights.length} insight card(s) already generated.</p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>

      {insights.length > 0 && (
        <section className="mt-6" aria-label="Recent insights">
          <h2 className="mb-3 flex items-center gap-2 text-h3 text-foreground">
            <Sparkles aria-hidden className="size-4 text-amber" /> Generated insights
          </h2>
          <ul className="flex flex-wrap gap-2">
            {insights.map((i) => (
              <li key={i.id}>
                <Badge variant={i.severity === "critical" ? "critical" : i.severity === "warning" ? "warning" : "info"}>
                  {i.title}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="mt-8 text-caption text-muted">
        <p>
          Profile covers {profile?.analyzedRows?.toLocaleString() ?? dataset.rowCount.toLocaleString()} rows
          {profile?.sampled ? " (sampled)" : ""} · duplicate rows {profile?.duplicateRows?.toLocaleString() ?? 0}.
        </p>
      </div>

      <section className="mt-6" aria-label="Copilot and governed analytics">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <DatasetCopilot datasetId={dataset.id} />
          <SemanticMetrics datasetId={dataset.id} />
        </div>
        <div className="mt-6">
          <ExecutiveSummary datasetId={dataset.id} />
        </div>
      </section>
    </div>
  );
}
