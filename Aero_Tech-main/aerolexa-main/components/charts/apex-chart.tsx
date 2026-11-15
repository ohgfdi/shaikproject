"use client";

import type { ApexOptions } from "apexcharts";
import dynamic from "next/dynamic";
import { useMemo, useState, useEffect } from "react";

import { CHART_PALETTE, chartTextColor, isDarkTheme } from "@/components/ui/theme";
import { fmtAxis } from "@/lib/format";
import type { ChartSpec } from "@/lib/types";
import type { NumberFormatSetting } from "@/lib/types";

const Apex = dynamic(() => import("react-apexcharts"), { ssr: false, loading: () => null });

const APEX_KINDS = new Set([
  "line",
  "area",
  "bar",
  "stacked-bar",
  "donut",
  "scatter",
  "histogram",
  "box",
  "heatmap",
  "funnel",
  "waterfall",
]);

export function usesApex(spec: ChartSpec): boolean {
  return APEX_KINDS.has(spec.kind);
}

type ApexChartProps = {
  spec: ChartSpec;
  height?: number;
  numStyle: NumberFormatSetting;
  onLoad?: () => void;
  onError?: (error: Error) => void;
};

export function ApexChart({ spec, height = 300, numStyle, onLoad, onError }: ApexChartProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setIsError(true), 10000);
    return () => clearTimeout(timeout);
  }, [spec]);

  useEffect(() => {
    if (isLoaded && onLoad) {
      onLoad();
    }
  }, [isLoaded, onLoad]);

  const options = useMemo<ApexOptions>(() => buildOptions(spec, numStyle), [spec, numStyle]);
  const series = useMemo<ApexOptions["series"]>(() => buildSeries(spec), [spec]);

  const summary = useMemo(() => {
    const first = spec.series[0];
    const parts = [spec.title];
    if (spec.categories?.length && first?.data?.length) {
      const last = first.data[first.data.length - 1];
      parts.push(`Range: ${spec.categories.length} categories; latest value ${last ?? "n/a"}.`);
    } else if (first?.data?.length) {
      parts.push(`Series with ${first.data.length} data points.`);
    } else if (first?.points?.length) {
      parts.push(`Scatter with ${first.points.length} points.`);
    }
    return parts.join(" ");
  }, [spec]);

  if (isError) {
    onError?.(new Error("Failed to load chart"));
    return <p className="text-muted text-sm">Chart failed to load</p>;
  }

  if (!isLoaded) {
    return (
      <div className="h-[300px] flex items-center justify-center text-muted/50" aria-live="polite">
        <div aria-hidden className="size-12 animate-pulse rounded-full bg-surface-2" />
        <span className="text-caption">Loading chart…</span>
      </div>
    );
  }

  return (
    <div role="img" aria-label={summary} className="w-full">
      <Apex
        type={apexType(spec.kind)}
        options={options}
        series={series}
        height={height}
        width="100%"
        onLoad={() => setIsLoaded(true)}
        onError={(err: Error) => {
          setIsError(true);
          onError?.(err);
        }}
      />
    </div>
  );
}

function apexType(kind: ChartSpec["kind"]): "line" | "area" | "bar" | "donut" | "scatter" | "boxPlot" {
  switch (kind) {
    case "line":
      return "line";
    case "area":
      return "area";
    case "bar":
    case "stacked-bar":
    case "histogram":
      return "bar";
    case "donut":
      return "donut";
    case "scatter":
      return "scatter";
    case "box":
      return "boxPlot";
    default:
      return "line";
  }
}

function buildSeries(spec: ChartSpec): ApexOptions["series"] {
  if (spec.kind === "donut") {
    return spec.series.map((s) => s.data?.[0] ?? 0);
  }
  if (spec.kind === "scatter") {
    // group points by cluster label so the legend communicates segments
    const groups = new Map<string, { x: number; y: number }[]>();
    for (const s of spec.series) {
      for (const p of s.points ?? []) {
        const label = p.label ?? s.name;
        const arr = groups.get(label) ?? [];
        arr.push({ x: p.x, y: p.y });
        groups.set(label, arr);
      }
    }
    const names = [...groups.keys()];
    return names.map((name, i) => ({
      name: `Cluster ${name}`,
      data: groups.get(name) ?? [],
      color:
        CHART_PALETTE[(parseInt(name, 10) - 1 + CHART_PALETTE.length) % CHART_PALETTE.length] ??
        CHART_PALETTE[i % CHART_PALETTE.length],
    }));
  }
  return spec.series.map((s, i) => ({
    name: s.name,
    data: s.box ?? s.data ?? [],
    color: s.color ?? CHART_PALETTE[i % CHART_PALETTE.length],
    ...(s.name === "Forecast" ? { dashArray: 6 } : {}),
  }));
}

function buildOptions(spec: ChartSpec, numStyle: NumberFormatSetting): ApexOptions {
  const fg = chartTextColor();
  const gridColor = isDarkTheme() ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
  const fmt = (v: number) => fmtAxis(v, numStyle);

  const base: ApexOptions = {
    chart: {
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      foreColor: fg,
      toolbar: { show: false },
      zoom: { enabled: false },
      background: "transparent",
      animations: { enabled: true, dynamicAnimation: { enabled: true, speed: 350 } },
    },
    colors: spec.series.map((s, i) => s.color ?? CHART_PALETTE[i % CHART_PALETTE.length]),
    grid: { borderColor: gridColor, strokeDashArray: 4, padding: { left: 8, right: 8 } },
    legend: {
      labels: { colors: fg },
      markers: { size: 5 },
    },
    dataLabels: { enabled: false },
    tooltip: { theme: isDarkTheme() ? "dark" : "light" },
    noData: { text: "No data to chart", align: "center" as const, verticalAlign: "middle" as const },
    xaxis: {
      categories: spec.categories ?? [],
      labels: { rotate: spec.categories && spec.categories.length > 12 ? -35 : 0, hideOverlappingLabels: true },
      title: { text: spec.xLabel ?? "" },
      axisBorder: { color: gridColor },
    },
    yaxis: {
      labels: { formatter: (v: number) => fmt(Number(v)) },
      title: { text: spec.yLabel ?? "" },
    },
  };

  if (spec.kind === "donut") {
    return {
      ...base,
      chart: { ...base.chart, type: "donut" },
      labels: spec.categories ?? spec.series.map((s) => s.name),
      legend: { position: "bottom", labels: { colors: fg } },
      dataLabels: { enabled: true, formatter: (val: number) => `${Math.round(val)}%`, dropShadow: { enabled: false } },
      tooltip: {
        theme: isDarkTheme() ? "dark" : "light",
        y: { formatter: (v: number) => String(v) },
      },
      plotOptions: {
        pie: {
          donut: { size: "68%", labels: { show: true, total: { show: true, label: "Total", color: fg } } },
        },
      },
    };
  }

  if (spec.kind === "box") {
    return {
      ...base,
      chart: { ...base.chart, type: "boxPlot" },
      plotOptions: { boxPlot: { colors: { upper: CHART_PALETTE[0], lower: CHART_PALETTE[0] } } },
      xaxis: { ...base.xaxis },
    };
  }

  if (spec.kind === "scatter") {
    return {
      ...base,
      chart: { ...base.chart, type: "scatter" },
      markers: { size: 4, strokeWidth: 0 },
    };
  }

  if (spec.kind === "heatmap") {
    return {
      ...base,
      chart: { ...base.chart, type: "heatmap" },
      tooltip: { theme: isDarkTheme() ? "dark" : "light" },
      plotOptions: {
        heatmap: {
          enableShades: true,
          colorScale: {
            ranges: [{ from: -1, to: 1, name: "value", color: "rgb(var(--accent))" }],
          },
        },
      },
    };
  }

  if (spec.kind === "funnel") {
    const plotOptions = {
      funnel: {
        strokeWidth: 1,
        neckWidth: "55%",
        neckHeight: "25%",
      },
    } as unknown as ApexOptions["plotOptions"];
    return {
      ...base,
      chart: { ...base.chart, type: "funnel" as never },
      tooltip: { theme: isDarkTheme() ? "dark" : "light" },
      plotOptions,
    };
  }

  if (spec.kind === "waterfall") {
    const plotOptions = {
      waterfall: {
        columnWidth: "60%",
      },
    } as unknown as ApexOptions["plotOptions"];
    return {
      ...base,
      chart: { ...base.chart, type: "waterfall" as never },
      plotOptions,
      tooltip: { theme: isDarkTheme() ? "dark" : "light" },
    };
  }

  return {
    ...base,
    stroke: {
      width: spec.kind === "bar" || spec.kind === "stacked-bar" || spec.kind === "histogram" ? 0 : 2.5,
      curve: spec.kind === "area" || spec.kind === "line" ? "straight" : "smooth",
      dashArray: spec.series.map((s) => (s.name === "Forecast" ? 6 : 0)),
    },
    fill: {
      type: spec.kind === "area" ? "gradient" : "solid",
      opacity: spec.kind === "area" ? 0.25 : 1,
      gradient:
        spec.kind === "area" ? { shadeIntensity: 0.6, opacityFrom: 0.35, opacityTo: 0.04, stops: [0, 95] } : undefined,
    },
    plotOptions: {
      bar: {
        columnWidth: "58%",
        borderRadius: spec.kind === "histogram" ? 0 : 2,
        ...(spec.kind === "stacked-bar" ? { stacked: true } : {}),
      },
    },
    ...(spec.kind === "stacked-bar"
      ? { tooltip: { theme: isDarkTheme() ? "dark" : "light", y: { formatter: (v: number) => fmt(Number(v)) } } }
      : {}),
  };
}
