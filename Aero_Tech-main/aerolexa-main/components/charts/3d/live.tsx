"use client";

import type { ChartSpec } from "@/lib/types";

import { BarChart3D } from "./bars";
import { DecompositionTree3DChart } from "./decomposition-tree";
import { DonutChart3D } from "./donut";
import { HeatmapChart3D } from "./heatmap3d";
import { KeyInfluencers3DChart } from "./key-influencers";
import { LineAreaChart3D } from "./line-area";
import { ScatterChart3D } from "./scatter";
import { WhatIfScene3D } from "./whatif";

/** Kinds → 3D chart. Called only when `supports3D` returned true. */
export default function LiveChart3D({ spec, height }: { spec: ChartSpec; height: number }) {
  switch (spec.kind) {
    case "bar":
    case "stacked-bar":
    case "histogram":
      return <BarChart3D spec={spec} height={height} />;
    case "line":
    case "area":
      return <LineAreaChart3D spec={spec} height={height} />;
    case "scatter":
      return <ScatterChart3D spec={spec} height={height} />;
    case "donut":
      return <DonutChart3D spec={spec} height={height} />;
    case "heatmap":
      return <HeatmapChart3D spec={spec} height={height} />;
    case "decomposition-tree":
      return spec.aiTree ? <DecompositionTree3DChart tree={spec.aiTree} height={height} /> : null;
    case "key-influencers":
      return spec.aiInfluencers ? <KeyInfluencers3DChart result={spec.aiInfluencers} height={height} /> : null;
    default:
      // What-if (S5c): the crossover scene hangs off the spec via `aiWhatIf`
      // (a computed WhatIfResult), so published dashboards/reports can carry
      // it like any other chart spec.
      return spec.aiWhatIf ? <WhatIfScene3D result={spec.aiWhatIf} height={height} /> : null;
  }
}
