import { ArrowLeft, CheckCircle2, FlaskConical } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - analysis detail page is a deployment-wide aggregate operation
import { notFound } from "next/navigation";

import { VersionsPanel } from "@/components/analyses/versions-panel";
import { CalcExplainer, StatChips } from "@/components/charts/chart";
import { ChartGallery } from "@/components/charts/chart-gallery";
import { CommentsPanel } from "@/components/comments/comments-panel";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { DemoBadge, ErrorMessage, WarningBanner } from "@/components/ui/feedback";
import { Badge } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/table";
import { getAuth, requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { timeAgo, fmtNumber } from "@/lib/format";
import { analysisResult } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const params = await props.params;
  // Resolve existence + ownership before any content streams: notFound()
  // thrown here produces a true 404 status, even in Next dev.
  const ctx = await getAuth();
  const analysis = await prisma.analysis.findUnique({
    where: { id: params.id },
    select: { workspaceId: true, result: true },
  });
  if (!ctx || !analysis || analysis.workspaceId !== ctx.workspace.id) notFound();
  return { title: analysisResult(analysis)?.title ?? "Analysis" };
}

export default async function AnalysisDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requirePageAuth();
  const analysis = await prisma.analysis.findUnique({
    where: { id: params.id },
    include: {
      dataset: { select: { id: true, name: true, rowCount: true, isDemo: true } },
      project: { select: { id: true, name: true } },
    },
  });
  if (!analysis || analysis.workspaceId !== ctx.workspace.id) notFound();

  const result = analysisResult(analysis);
  if (!result) {
    return (
      <div>
        <PageHeader title="Analysis result unavailable" />
        <ErrorMessage
          message="The stored result could not be read."
          howToFix="Re-run the analysis from the Analysis Lab."
          onRetry={undefined}
        />
      </div>
    );
  }

  // Forecast runs a real ETS/ARIMA model family selected by AICc on the
  // user's own history (oracle-tested vs statsmodels) — "Calculated". Cohort
  // retention keeps the honest-labelling badge.
  const isDemoLogic = analysis.kind === "cohort";

  return (
    <div>
      <Link
        href={analysis.project ? `/projects/${analysis.project.id}?tab=analyses` : "/projects"}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Back to {analysis.project?.name ?? "projects"}
      </Link>

      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {result.title}
            {isDemoLogic && (
              <DemoBadge tooltip="Cohort retention is computed with deterministic statistical methods over your data — but it is a descriptive projection, not a causal model." />
            )}
            {analysis.dataset?.isDemo && <Badge variant="amber">Demo / Synthetic data</Badge>}
          </span>
        }
        description={
          <>
            {analysis.kind} analysis · dataset{" "}
            <Link className="text-accent hover:underline" href={`/datasets/${analysis.dataset?.id}`}>
              {analysis.dataset?.name ?? "deleted"}
            </Link>{" "}
            · run {timeAgo(analysis.createdAt)}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {analysis.project && (
              <Link href={`/analyses/new?project=${analysis.project.id}&dataset=${analysis.datasetId}`}>
                <Button variant="secondary" size="sm" icon={<FlaskConical aria-hidden className="size-4" />}>
                  Re-run / tweak
                </Button>
              </Link>
            )}
            <CalcExplainer result={result} />
          </div>
        }
      />

      {result.quickFindings && result.quickFindings.length > 0 && (
        <ul className="mb-5 flex flex-col gap-2">
          {result.quickFindings.map((f, i) => (
            <li key={i} className="flex items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm">
              <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
              <span className="text-foreground">{f}</span>
            </li>
          ))}
        </ul>
      )}

      {result.scope.sampled && (
        <WarningBanner
          title={`Analysed the first ${fmtNumber(result.scope.rowsUsed, { maximumFractionDigits: 0 })} of ${fmtNumber(result.scope.totalRows, { maximumFractionDigits: 0 })} rows`}
          severity="info"
        >
          Very large datasets are analysed on a clearly-labelled sample to protect performance. Upload a subset for
          full-coverage numbers.
        </WarningBanner>
      )}

      {result.stats && <StatChips stats={result.stats} />}

      <ChartGallery charts={result.charts} />

      {result.tables?.map((table, i) => (
        <section key={`${table.title}-${i}`} aria-label={table.title} className="mt-5">
          <DataTable columns={table.columns} rows={table.rows} caption={table.title} pageSize={20} maxHeight={420} />
        </section>
      ))}

      <div className="mt-6 rounded-md border border-line bg-surface p-4 text-sm text-muted">
        <p className="font-medium text-foreground">Coverage & scope</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5">
          {result.configHuman.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
          {result.scope.filters.map((f, i) => (
            <li key={`f${i}`}>
              Filter: {f.column} = “{f.value}”
            </li>
          ))}
        </ul>
      </div>

      <VersionsPanel analysisId={analysis.id} />

      <CommentsPanel targetType="analysis" targetId={analysis.id} currentUserId={ctx.user.id} />
    </div>
  );
}
