"use client";

import { FileText, X } from "lucide-react";
import { useState } from "react";

import { renderSpec } from "@/components/charts/chart";
import { Badge, Card } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/table";
import { chartSpecDrillCategories, chartSpecDrillThrough } from "@/lib/engine/drill-through";
import type { ViewerTierInfo } from "@/lib/scene/viewer-tier";
import type { ReportSection } from "@/lib/types";

/**
 * Read-only published-report renderer for /apps/[shareToken].
 *
 * Sections carry their provenance tags so readers can see exactly which
 * dataset / analysis / insight produced each number — nothing fabricated.
 *
 * Viewer-tier hardening (S10): chart sections render 3D only when the
 * viewer's measured tier allows it; otherwise the honest 2D fallback.
 */
export function PublishedReportView({
  app,
  viewerTier,
}: {
  app: { title: string; sections: ReportSection[]; publishedAt?: string | null };
  viewerTier?: ViewerTierInfo | null;
}) {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <div className="mb-1 flex items-center gap-2">
          <h1 className="text-h2 font-medium text-foreground">{app.title}</h1>
          <Badge variant="info">
            <FileText className="mr-1 size-3" /> Published report
          </Badge>
          <Badge variant="outline">Public link</Badge>
        </div>
        <p className="text-caption text-muted">
          {app.publishedAt ? `Published ${new Date(app.publishedAt).toLocaleDateString()}` : "Published"}
          {" · "}
          Every section is tagged with its data source.
        </p>
      </div>

      {app.sections.length === 0 && (
        <Card className="p-6 text-center text-caption text-muted">This published report has no sections.</Card>
      )}

      <div className="flex flex-col gap-4">
        {app.sections.map((section) => (
          <SectionCard key={section.id} section={section} viewerTier={viewerTier} />
        ))}
      </div>
    </div>
  );
}

function SectionCard({ section, viewerTier }: { section: ReportSection; viewerTier?: ViewerTierInfo | null }) {
  const sourceLabel = provenance(section);
  // Drill-through on published reports (ROADMAP 3.5): read-only, snapshot-
  // derived detail — the same per-series breakdown the editor preview shows.
  const [drill, setDrill] = useState<ReturnType<typeof chartSpecDrillThrough>>(null);
  const drillValues = section.kind === "chart" && section.chart ? chartSpecDrillCategories(section.chart) : [];
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-h3 text-foreground">{section.heading}</h3>
        {sourceLabel && <Badge variant="outline">{sourceLabel}</Badge>}
      </div>

      {section.kind === "text" && section.content && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{section.content}</p>
      )}

      {section.kind === "chart" && section.chart && (
        <div className="mt-1">
          {section.chartTitle && <p className="mb-1 text-caption text-muted">{section.chartTitle}</p>}
          {renderSpec(section.chart, "comma", 260, viewerTier?.webgl && viewerTier.tier !== "flat" ? "3d" : "2d")}
          {drillValues.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-2">
              <span className="text-caption text-muted">Drill through:</span>
              {drillValues.map((v) => (
                <button
                  key={v}
                  onClick={() => setDrill(chartSpecDrillThrough(section.chart!, v, section.heading))}
                  title={`Drill through to the per-series detail for “${v}”`}
                  className="max-w-32 truncate rounded-full border border-line px-2 py-0.5 text-caption text-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-foreground"
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          {drill && (
            <div className="mt-2 rounded-md border border-line bg-surface-2 p-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-caption font-medium text-foreground">
                  Detail — {drill.column} = {drill.value}
                </p>
                <button
                  onClick={() => setDrill(null)}
                  aria-label="Close drill-through detail"
                  className="rounded p-0.5 text-muted hover:text-foreground"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </div>
              <DataTable
                columns={drill.columns}
                rows={drill.rows}
                pageSize={8}
                caption={`${drill.totalRows} series value(s) from the published snapshot.`}
              />
            </div>
          )}
        </div>
      )}

      {section.kind === "insight" && section.insight && (
        <div className="rounded-md border border-line bg-surface p-3">
          <p className="text-sm font-medium text-foreground">{section.insight.title}</p>
          {section.insight.businessImplication && (
            <p className="mt-2 text-sm text-muted">{section.insight.businessImplication}</p>
          )}
        </div>
      )}

      {section.kind === "table" && section.table && (
        <DataTable
          columns={section.table.columns.map((c) => ({
            key: c.key,
            label: c.label,
            format: c.format === "number" ? "number" : c.format === "date" ? "date" : "text",
          }))}
          rows={section.table.rows}
          pageSize={10}
        />
      )}
    </Card>
  );
}

function provenance(section: ReportSection): string | null {
  if (section.source?.kind === "awaiting") return "Awaiting evidence";
  if (section.source?.kind === "manual") return "Product notes";
  if (!section.source?.label) return section.source?.kind ?? null;
  return `${section.source.kind}: ${section.source.label}`;
}
