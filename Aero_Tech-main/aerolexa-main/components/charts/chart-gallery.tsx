"use client";

import { ChartRenderer } from "@/components/charts/chart";
import { Card } from "@/components/ui/primitives";
import type { ChartSpec } from "@/lib/types";

interface ChartGalleryProps {
  charts: ChartSpec[];
}

export function ChartGallery({ charts }: ChartGalleryProps) {
  return (
    <div className="mt-5 flex flex-col gap-5">
      {charts.map((chart, i) => (
        <Card key={`${chart.title}-${i}`} className="p-4">
          <ChartRenderer spec={chart} />
        </Card>
      ))}
    </div>
  );
}
