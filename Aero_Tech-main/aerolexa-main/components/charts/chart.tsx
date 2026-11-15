"use client";

import { FileQuestion } from "lucide-react";
import { useState } from "react";

import { Chart3D, supports3D } from "@/components/charts/3d/chart3d";
import { ApexChart } from "@/components/charts/apex-chart";
import { FunnelChart, HeatmapChart, KpiGrid, WaterfallChart } from "@/components/charts/custom-charts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Card } from "@/components/ui/primitives";
import type { AnalysisResult, ChartSpec, NumberFormatSetting } from "@/lib/types";

/** Chart engine preference. `auto` = 3D when it helps, otherwise 2D. */
export type ChartVariant = "auto" | "2d" | "3d";

/** Render any chart spec produced by the engine or the studio. */
export function ChartRenderer({
  spec,
  numStyle = "comma",
  height = 300,
  bare = false,
  variant = "auto",
}: {
  spec: ChartSpec;
  numStyle?: NumberFormatSetting;
  height?: number;
  bare?: boolean;
  variant?: ChartVariant;
}) {
  const body = renderSpec(spec, numStyle, height, variant);
  if (bare) return body;

  return (
    <figure className="w-full">
      <figcaption className="mb-2">
        <p className="text-h3 text-foreground">{spec.title}</p>
        {spec.subtitle && <p className="mt-0.5 text-caption text-muted">{spec.subtitle}</p>}
        {spec.placeholderNote && (
          <p className="mt-1 inline-flex items-center gap-1 rounded border border-line bg-surface-2 px-2 py-0.5 text-caption text-muted">
            {spec.placeholderNote}
          </p>
        )}
      </figcaption>
      {body}
    </figure>
  );
}

export function renderSpec(
  spec: ChartSpec,
  numStyle: NumberFormatSetting,
  height = 300,
  variant: ChartVariant = "auto",
) {
  switch (spec.kind) {
    case "kpi":
      return <KpiGrid kpis={spec.kpis ?? []} numStyle={numStyle} />;
    case "heatmap":
      return <HeatmapChart spec={spec} numStyle={numStyle} />;
    case "funnel":
      return <FunnelChart spec={spec} numStyle={numStyle} />;
    case "waterfall":
      return <WaterfallChart spec={spec} numStyle={numStyle} />;
    default: {
      const apex = <ApexChart spec={spec} height={height} numStyle={numStyle} />;
      const explicit3D = variant === "3d";
      const can3D = supports3D(spec) && (explicit3D || (height ?? 300) >= 200);
      return can3D ? <Chart3D spec={spec} height={height} fallback={apex} /> : apex;
    }
  }
}

/** "How was this calculated?" — transparency dialog referencing exact columns & math. */
export function CalcExplainer({
  result,
  label = "How was this calculated?",
}: {
  result: AnalysisResult;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        icon={<FileQuestion aria-hidden className="size-4" />}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="How was this calculated?"
        description="Transparency note — every number can be traced to the exact columns and steps below."
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        }
      >
        <div className="flex flex-col gap-5 text-sm">
          <section aria-labelledby="calc-inputs">
            <h4 id="calc-inputs" className="text-sm font-semibold text-foreground">
              Inputs used
            </h4>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              {result.configHuman.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="calc-method">
            <h4 id="calc-method" className="text-sm font-semibold text-foreground">
              Methodology
            </h4>
            <p className="mt-1 text-muted">{result.methodology.method}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              {result.methodology.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ul>
          </section>

          {result.methodology.assumptions.length > 0 && (
            <section aria-labelledby="calc-assumptions">
              <h4 id="calc-assumptions" className="text-sm font-semibold text-foreground">
                Assumptions
              </h4>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                {result.methodology.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </section>
          )}

          {result.qualityWarnings.length > 0 && (
            <section aria-labelledby="calc-warnings" className="rounded border border-warning/40 bg-warning/5 p-3">
              <h4 id="calc-warnings" className="text-sm font-semibold text-foreground">
                Data-quality warnings
              </h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
                {result.qualityWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </Dialog>
    </>
  );
}

/** Stat summary chips used on analysis result pages. */
export function StatChips({ stats }: { stats: { label: string; value: string; hint?: string }[] }) {
  if (!stats || stats.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
      {stats.map((s) => (
        <Card key={s.label} className="px-3.5 py-2.5">
          <p className="text-caption text-muted">{s.label}</p>
          <p className="mt-0.5 truncate text-body font-semibold tabular-nums text-foreground" title={s.value}>
            {s.value}
          </p>
          {s.hint && <p className="text-caption text-muted">{s.hint}</p>}
        </Card>
      ))}
    </div>
  );
}
