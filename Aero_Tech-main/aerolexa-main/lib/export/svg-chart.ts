import type { ChartSpec, KpiCard } from "@/lib/types";

const TEAL = "#5AA8AA";
const AMBER = "#FFB400";
const TEXT = "#4B5563";
const GRID = "#E5E7EB";

/**
 * Deterministic SVG renderer for a chart spec — used by the printable export
 * routes so PDF/HTML exports carry real visuals without a browser canvas.
 * Kinds without an SVG renderer fall back to a labelled data table.
 */
export function chartToSvg(spec: ChartSpec, width = 720, height = 300): string {
  switch (spec.kind) {
    case "kpi":
      return kpiToSvg(spec.kpis ?? [], width);
    case "line":
    case "area":
      return xySvg(spec, width, height, spec.kind === "area");
    case "bar":
    case "stacked-bar":
    case "histogram":
      return barSvg(spec, width, height);
    case "donut":
      return donutSvg(spec, width, height);
    default:
      return fallbackTableSvg(spec, width);
  }
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtV(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return Math.abs(v) >= 1e6
    ? `${(v / 1e6).toFixed(1)}M`
    : Math.abs(v) >= 1e3
      ? `${(v / 1e3).toFixed(1)}K`
      : Number.isInteger(v)
        ? String(v)
        : v.toFixed(1);
}

function baseSvg(title: string, width: number, height: number, inner: string, subtitle?: string): string {
  const titleH = subtitle ? 46 : 32;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + titleH}" viewBox="0 0 ${width} ${height + titleH}" role="img" aria-label="${esc(title)}">`,
  ];
  parts.push(
    `<text x="0" y="16" font-family="system-ui" font-size="15" font-weight="600" fill="#111827">${esc(title)}</text>`,
  );
  if (subtitle)
    parts.push(`<text x="0" y="33" font-family="system-ui" font-size="11" fill="${TEXT}">${esc(subtitle)}</text>`);
  parts.push(`<g transform="translate(0,${titleH})">${inner}</g>`);
  parts.push("</svg>");
  return parts.join("");
}

function xySvg(spec: ChartSpec, width: number, height: number, area: boolean): string {
  const series = spec.series;
  const all = series.flatMap((s) => (s.data ?? []).filter((v): v is number => v !== null && v !== undefined));
  if (all.length === 0) return fallbackTableSvg(spec, width);
  const minV = Math.min(0, ...all);
  const maxV = Math.max(...all);
  const span = maxV - minV || 1;
  const padL = 46;
  const padR = 10;
  const padT = 10;
  const padB = 26;
  const cats = spec.categories ?? series[0]?.data?.map((_, i) => String(i + 1)) ?? [];
  const n = Math.max(cats.length, 2);
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const y = (v: number) => padT + ((maxV - v) / span) * plotH;
  const x = (i: number) => padL + (i / (n - 1)) * plotW;

  let g = "";
  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    const v = minV + tick * span;
    const yy = y(v);
    g += `<line x1="${padL}" x2="${width - padR}" y1="${yy}" y2="${yy}" stroke="${GRID}" stroke-dasharray="3 3"/><text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" fill="${TEXT}">${fmtV(v)}</text>`;
  }
  const color = (s: { color?: string }, i: number) => s.color ?? (i === 0 ? TEAL : AMBER);

  series.forEach((s, si) => {
    const pts = (s.data ?? [])
      .map((v, i) => (v === null || v === undefined ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean);
    if (pts.length < 2) return;
    if (area) {
      const firstX = pts[0]?.split(",")[0] ?? padL;
      const lastX = pts[pts.length - 1]?.split(",")[0] ?? width - padR;
      g += `<polygon points="${firstX},${padT + plotH} ${pts.join(" ")} ${lastX},${padT + plotH}" fill="${color(s, si)}" opacity="0.12"/>`;
    }
    g += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color(s, si)}" stroke-width="2.2"/>`;
  });

  // category ticks
  const step = Math.ceil(n / Math.max(1, Math.floor(width / 90)));
  cats.forEach((c, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    g += `<text x="${x(i).toFixed(1)}" y="${padT + plotH + 15}" text-anchor="middle" font-size="10" fill="${TEXT}">${esc(String(c))}</text>`;
  });

  if (spec.series.length > 1) {
    const lx = padL;
    const ly = padT + 4;
    spec.series.forEach((s, si) => {
      g += `<rect x="${lx + si * 110}" y="${ly}" width="10" height="10" rx="2" fill="${color(s, si)}"/><text x="${lx + si * 110 + 14}" y="${ly + 9}" font-size="10" fill="${TEXT}">${esc(s.name)}</text>`;
    });
  }
  return baseSvg(spec.title, width, height, g, spec.subtitle);
}

function barSvg(spec: ChartSpec, width: number, height: number): string {
  const cats = spec.categories ?? [];
  const data = spec.series[0]?.data ?? [];
  const values = data.filter((v): v is number => v !== null && v !== undefined);
  if (values.length === 0) return fallbackTableSvg(spec, width);
  const maxV = Math.max(...values, 1);
  const padL = 48;
  const padR = 10;
  const padB = 40;
  const padT = 8;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const n = Math.max(cats.length, 1);
  const bw = Math.min(54, (plotW / n) * 0.68);

  let g = "";
  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    const v = tick * maxV;
    const yy = padT + (1 - tick) * plotH;
    g += `<line x1="${padL}" x2="${width - padR}" y1="${yy}" y2="${yy}" stroke="${GRID}" stroke-dasharray="3 3"/><text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" fill="${TEXT}">${fmtV(v)}</text>`;
  }
  data.forEach((v, i) => {
    if (v === null || v === undefined) return;
    const cx = padL + (i + 0.5) * (plotW / n);
    const h = Math.max(1, (v / maxV) * plotH);
    g += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${TEAL}"/>`;
    const label = String(cats[i] ?? "");
    const short = label.length > 12 ? `${label.slice(0, 11)}…` : label;
    g += `<text x="${cx.toFixed(1)}" y="${padT + plotH + 15}" text-anchor="middle" font-size="10" fill="${TEXT}">${esc(short)}</text>`;
  });
  return baseSvg(spec.title, width, height, g, spec.subtitle);
}

function donutSvg(spec: ChartSpec, width: number, height: number): string {
  const labels = spec.categories ?? spec.series.map((s) => s.name);
  const values = spec.series.map((s) => s.data?.[0] ?? 0);
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = 150;
  const cy = height / 2 + 8;
  const r = Math.min(90, height / 2 - 12);
  const colors = [TEAL, AMBER, "#7C5CFF", "#3D9BE9", "#E8637A", "#58B368", "#F08A5D", "#B08BBB"];
  let acc = -Math.PI / 2;
  let arcs = "";
  let legend = "";
  values.forEach((v, i) => {
    const frac = v / total;
    const a0 = acc;
    const a1 = acc + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const ir = r * 0.68;
    const ix0 = cx + ir * Math.cos(a1);
    const iy0 = cy + ir * Math.sin(a1);
    const ix1 = cx + ir * Math.cos(a0);
    const iy1 = cy + ir * Math.sin(a0);
    if (frac > 0) {
      arcs += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${ix0.toFixed(1)},${iy0.toFixed(1)} A${ir},${ir} 0 ${large} 0 ${ix1.toFixed(1)},${iy1.toFixed(1)} Z" fill="${colors[i % colors.length]}" stroke="white" stroke-width="1"/>`;
    }
    legend += `<rect x="${width - 150}" y="${14 + i * 17}" width="10" height="10" rx="2" fill="${colors[i % colors.length]}"/><text x="${width - 134}" y="${23 + i * 17}" font-size="11" fill="${TEXT}">${esc(String(labels[i] ?? sName(i)))} · ${(frac * 100).toFixed(0)}%</text>`;
    acc = a1;
  });
  arcs += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="15" font-weight="600" fill="#111827">${fmtV(total)}</text>`;
  return baseSvg(spec.title, width, height + 60, `<g>${arcs}${legend}</g>`, spec.subtitle);

  function sName(i: number): string {
    return `Part ${i + 1}`;
  }
}

function kpiToSvg(kpis: KpiCard[], width: number): string {
  const items = kpis.slice(0, 4).map((k, i) => {
    const bw = (width - 3 * 14) / 4;
    const x = i * (bw + 14);
    return `<g><rect x="${x}" y="0" width="${bw}" height="76" rx="6" fill="#F9FAFB" stroke="#E5E7EB"/><text x="${x + 10}" y="20" font-size="11" fill="${TEXT}">${esc(k.label)}</text><text x="${x + 10}" y="50" font-size="18" font-weight="700" fill="#111827">${esc(k.value)}</text>${
      k.deltaPct !== null && k.deltaPct !== undefined
        ? `<text x="${x + 10}" y="68" font-size="11" fill="${k.deltaPct >= 0 ? "#2E7D46" : "#B93A52"}">${k.deltaPct >= 0 ? "▲" : "▼"} ${k.deltaPct.toFixed(1)}%</text>`
        : ""
    }</g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="86" role="img" aria-label="KPI summary">${items.join("")}</svg>`;
}

/**
 * Honest fallback for kinds with no canvas/SVG renderer: a caption plus the
 * real numbers as a labelled table. Exported so the headless-Chromium renderer
 * degrades to exactly the same output instead of an empty frame.
 */
export function fallbackTableSvg(spec: ChartSpec, width = 720): string {
  const rows = (spec.categories ?? []).map((c, i) => {
    const v = spec.series[0]?.data?.[i];
    return `<tr><td style="padding:2px 10px 2px 0;text-align:left">${esc(String(c))}</td><td style="text-align:right;font-weight:600">${v === null || v === undefined ? "—" : fmtV(v as number)}</td></tr>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="24" role="img" aria-label="${esc(spec.title)} (data table export)"><text font-size="12" fill="${TEXT}">${esc(spec.title)} — rendered as a table in exports</text></svg><table style="border-collapse:collapse;width:100%;font-family:system-ui;font-size:12px">${rows.join("")}</table>`;
}
