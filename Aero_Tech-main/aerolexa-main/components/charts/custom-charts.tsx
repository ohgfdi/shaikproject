"use client";

import { CHART } from "@/components/ui/theme";
import { Tilt } from "@/components/ui/tilt";
import { fmtNumber, fmtSignedPct } from "@/lib/format";
import type { ChartSpec, KpiCard } from "@/lib/types";
import type { NumberFormatSetting } from "@/lib/types";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
   KPI cards
-------------------------------------------------------------------------- */

export function KpiGrid({ kpis, numStyle: _numStyle }: { kpis: KpiCard[]; numStyle: NumberFormatSetting }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {kpis.map((kpi, i) => (
        <Tilt key={`${kpi.label}-${i}`} max={6} className="card px-4 py-3 transition-colors hover:border-accent/30">
          <p className="text-caption font-medium text-muted">{kpi.label}</p>
          <p className="mt-1 text-h2 tabular-nums text-foreground">{kpi.value}</p>
          <div className="mt-1 flex items-center gap-2">
            {kpi.deltaPct !== null && kpi.deltaPct !== undefined && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-1.5 py-0.5 text-caption font-semibold tabular-nums",
                  kpi.deltaPct > 0.5 && "bg-[#58B368]/15 text-[#2E7D46] dark:text-[#7ED096]",
                  kpi.deltaPct < -0.5 && "bg-[#E8637A]/15 text-[#B93A52] dark:text-[#F08A9B]",
                  kpi.deltaPct >= -0.5 && kpi.deltaPct <= 0.5 && "bg-surface-2 text-muted",
                )}
              >
                <span aria-hidden className="mr-0.5">
                  {kpi.deltaPct > 0.5 ? "▲" : kpi.deltaPct < -0.5 ? "▼" : "▬"}
                </span>
                {fmtSignedPct(kpi.deltaPct)}
              </span>
            )}
            {kpi.deltaLabel && <span className="text-caption text-muted">{kpi.deltaLabel}</span>}
            {kpi.hint && <span className="ml-auto text-caption text-muted">{kpi.hint}</span>}
          </div>
          {kpi.spark && kpi.spark.length > 1 && <Sparkline values={kpi.spark} />}
        </Tilt>
      ))}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 240;
  const h = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - 3 - ((v - min) / span) * (h - 6)}`)
    .join(" ");
  return (
    <svg aria-hidden viewBox={`0 0 ${w} ${h}`} className="mt-1.5 h-9 w-full" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={CHART.teal} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   Heatmap (div-grid based, colour communicates magnitude with text labels too)
--------------------------------------------------------------------------- */

export function HeatmapChart({ spec, numStyle }: { spec: ChartSpec; numStyle: NumberFormatSetting }) {
  const rows = spec.rowLabels ?? [];
  const cols = spec.categories ?? [];
  const data = spec.series[0]?.data ?? [];
  const values = data.filter((v): v is number => v !== null && v !== undefined);
  const domain = values.length ? Math.max(1, Math.max(...values.map(Math.abs))) : 1;
  const text = rows.length && cols.length ? `${rows[0]}…${rows[rows.length - 1]} by ${cols.join(", ")}` : "";

  return (
    <div>
      <div role="img" aria-label={`Heatmap: ${text}`} className="thin-scroll overflow-x-auto">
        <div className="min-w-[480px]">
          <div className="grid" style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(52px, 1fr))` }}>
            <div />
            {cols.map((c) => (
              <div key={c} className="px-1 pb-1 text-center text-caption text-muted">
                {c}
              </div>
            ))}
            {rows.map((rowLabel, ri) => (
              <>
                <div key={`l-${ri}`} className="flex items-center pr-2 text-caption text-muted">
                  <span className="truncate" title={rowLabel}>
                    {rowLabel}
                  </span>
                </div>
                {cols.map((col, ci) => {
                  const idx = ri * cols.length + ci;
                  const raw = data[idx];
                  const value = raw === null || raw === undefined ? null : (raw as number);
                  const isRetention = spec.title.toLowerCase().includes("retention");
                  const alpha = value === null ? 0.04 : Math.min(1, Math.abs(value) / domain);
                  const positive = (value ?? 0) >= 0;
                  const color = isRetention
                    ? `rgba(90,168,170,${0.12 + alpha * 0.85})`
                    : positive
                      ? `rgba(90,168,170,${0.1 + alpha * 0.85})`
                      : `rgba(232,99,122,${0.1 + alpha * 0.85})`;
                  return (
                    <div
                      key={`c-${ri}-${ci}`}
                      title={`${rowLabel} · ${col}: ${value === null ? "no data" : fmtNumber(value, { style: numStyle, maximumFractionDigits: 1 })}${isRetention ? "%" : ""}`}
                      className="m-[1px] flex h-8 items-center justify-center rounded-sm text-caption tabular-nums"
                      style={{ backgroundColor: color, color: value !== null && alpha > 0.55 ? "#0A0A0A" : undefined }}
                    >
                      {value === null ? "·" : fmtNumber(value, { style: numStyle, maximumFractionDigits: 1 })}
                    </div>
                  );
                })}
              </>
            ))}
          </div>
        </div>
      </div>
      <p className="sr-only">
        {rows
          .map(
            (r, ri) =>
              `${r}: ` +
              cols
                .map((c, ci) => {
                  const v = data[ri * cols.length + ci];
                  return `${c} ${v ?? "no data"}${spec.title.toLowerCase().includes("retention") ? "%" : ""}`;
                })
                .join(", "),
          )
          .join(". ")}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Funnel
--------------------------------------------------------------------------- */

export function FunnelChart({ spec, numStyle }: { spec: ChartSpec; numStyle: NumberFormatSetting }) {
  const categories = spec.categories ?? [];
  const values = (spec.series[0]?.data ?? []).map((v) => (v === null || v === undefined ? 0 : v));
  const maxVal = Math.max(1, ...values);
  const conversions: (number | null)[] = values.map((v, i) => {
    if (i === 0) return null;
    const prev = values[i - 1] ?? 0;
    return prev > 0 ? (v / prev) * 100 : null;
  });

  return (
    <div role="img" aria-label={`Funnel of ${spec.title}`}>
      <ul className="flex flex-col gap-2">
        {categories.map((label, i) => {
          const value = values[i] ?? 0;
          const conv = conversions[i];
          return (
            <li
              key={label}
              className="group"
              title={`${label}: ${fmtNumber(value, { style: numStyle })} rows${conv !== null ? ` · ${fmtNumber(conv, { style: numStyle, maximumFractionDigits: 1 })}% of previous` : ""}`}
            >
              <div className="flex h-8 items-center overflow-hidden rounded-sm bg-[#5AA8AA]/15">
                <div
                  className="flex h-full items-center bg-[#5AA8AA] px-3"
                  style={{ width: `${Math.max(8, (value / maxVal) * 100)}%`, minWidth: "2.5rem" }}
                />
                <span className="ml-2 text-sm text-foreground">{label}</span>
                <span className="ml-auto mr-2 text-sm font-semibold tabular-nums text-foreground">
                  {fmtNumber(value, { style: numStyle, maximumFractionDigits: 0 })}
                </span>
              </div>
              {conv !== null && (
                <p className="text-caption text-muted">
                  {fmtNumber(conv, { style: numStyle, maximumFractionDigits: 1 })}% of previous step
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Waterfall (SVG) — positive/negative deltas between a start and end total
--------------------------------------------------------------------------- */

export function WaterfallChart({ spec, numStyle }: { spec: ChartSpec; numStyle: NumberFormatSetting }) {
  const labels = spec.categories ?? [];
  const series = spec.series[0];
  const data = series?.data ?? [];
  const totals = new Set(series?.totals ?? []);

  // running total walk
  let running = 0;
  const steps = data.map((d, i) => {
    const isTotal = totals.has(i);
    if (isTotal) {
      running = d ?? running;
      return { label: labels[i] ?? `Step ${i + 1}`, value: d ?? 0, isTotal: true, running };
    }
    running = (running ?? 0) + (d ?? 0);
    return { label: labels[i] ?? `Step ${i + 1}`, value: d ?? 0, isTotal: false, running };
  });
  const minRun = Math.min(0, ...steps.map((s) => s.running));
  const maxRun = Math.max(0, ...steps.map((s) => s.running));
  const span = maxRun - minRun || 1;

  const W = 760;
  const H = 280;
  const padL = 52;
  const padR = 12;
  const padT = 18;
  const padB = 46;
  const n = steps.length || 1;
  const stepW = (W - padL - padR) / n;
  const yOf = (v: number) => padT + ((maxRun - v) / span) * (H - padT - padB);
  const barW = Math.min(stepW * 0.55, 54);

  return (
    <div>
      <svg
        role="img"
        aria-label={`Waterfall chart: ${spec.title}. ${steps.map((s) => `${s.label} ${s.isTotal ? "total" : "delta"} ${s.value}`).join(", ")}`}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
      >
        {[0.25, 0.5, 0.75].map((f) => {
          const y = yOf(minRun + f * span);
          return (
            <line key={f} x1={padL} x2={W - padR} y1={y} y2={y} stroke="rgba(128,128,128,0.15)" strokeDasharray="4 4" />
          );
        })}
        {steps.map((s, i) => {
          const cx = padL + i * stepW + stepW / 2;
          const startY = s.isTotal ? yOf(s.value) : yOf(s.running - s.value);
          const endY = yOf(s.running);
          const yTop = Math.min(startY, endY);
          const h = Math.max(2, Math.abs(endY - startY));
          const positive = s.value >= 0;
          const color = s.isTotal ? CHART.violet : positive ? CHART.teal : CHART.rose;
          return (
            <g key={s.label}>
              <rect x={cx - barW / 2} y={yTop} width={barW} height={h} rx={2} fill={color} opacity={0.9}>
                <title>{`${s.label}: ${s.isTotal ? "Total " : s.value >= 0 ? "+" : ""}${fmtNumber(s.value, { style: numStyle })}`}</title>
              </rect>
              <text
                x={cx}
                y={yTop - 5}
                textAnchor="middle"
                className="fill-current text-caption tabular-nums text-muted"
                fontSize="11"
              >
                {s.isTotal
                  ? ""
                  : `${s.value >= 0 ? "+" : ""}${fmtNumber(s.value, { style: numStyle, maximumFractionDigits: 0 })}`}
              </text>
              <text
                x={cx}
                y={H - 22}
                textAnchor="middle"
                fontSize="11"
                className="fill-current text-muted"
                style={{ overflowWrap: "anywhere" }}
              >
                {s.label.length > 18 ? `${s.label.slice(0, 17)}…` : s.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
