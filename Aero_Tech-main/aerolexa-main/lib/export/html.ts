import { chartToSvg } from "@/lib/export/svg-chart";
import type {
  ChartSpec,
  InsightCard,
  PresentationSlide,
  ReportSection,
  ReportSectionSource,
  TableSpec,
} from "@/lib/types";

export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Minimal, safe inline formatting for the plain-text/markdown-ish body content
 * written into report sections: **bold**, *italic*, _italic_ and `code`.
 * Applied AFTER HTML escaping so user text is never treated as markup.
 */
export function inlineMarkdown(value: string): string {
  return esc(value)
    .replace(
      /`([^`]+)`/g,
      '<code style="font-size:0.9em;background:#F3F4F6;padding:1px 4px;border-radius:4px">$1</code>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_([^_]+)_(?![^\w]|$)/g, "$1<em>$2</em>");
}

const isListLine = (line: string): boolean => /^\s*[-•] /.test(line) || /^\s*\d+[.)]\s/.test(line);

function paragraphToHtml(paragraph: string): string {
  const lines = paragraph.split("\n");
  if (lines.length > 1 && lines.every(isListLine)) {
    return `<ul style="margin:0 0 0.9em;padding-left:20px">${lines
      .map(
        (line) =>
          `<li style="margin:0.25em 0">${inlineMarkdown(line.replace(/^\s*[-•]\s+/, "").replace(/^\s*\d+[.)]\s+/, ""))}</li>`,
      )
      .join("")}</ul>`;
  }
  return `<p style="margin:0 0 0.9em">${inlineMarkdown(paragraph).replace(/\n/g, "<br/>")}</p>`;
}

export function htmlForText(content: string): string {
  const paragraphs = content.split(/\n{2,}/);
  return paragraphs
    .filter((p) => p.trim().length > 0)
    .map(paragraphToHtml)
    .join("");
}

export function chartHtml(chart: ChartSpec): string {
  return `<figure style="margin:0.5em 0 1.2em"><figcaption style="font-size:12px;color:#6B7280;margin-bottom:6px">${esc(chart.title)}</figcaption><div>${chartToSvg(chart)}</div></figure>`;
}

export function insightHtml(insight: InsightCard): string {
  const sev = esc(insight.severity);
  const color = sev === "critical" ? "#B91C1C" : sev === "warning" ? "#B45309" : "#1D4ED8";
  return `<div style="border-left:4px solid ${color};background:#F9FAFB;padding:10px 14px;margin:0.5em 0 1.2em">
    <p style="margin:0 0 4px;font-weight:700;font-size:13px">${esc(insight.title)} <span style="color:${color};text-transform:uppercase;font-size:10px;margin-left:6px">${sev}</span></p>
    ${insight.observedChange ? `<p style="margin:0 0 4px;font-size:12px;color:#047857">${esc(insight.observedChange)}</p>` : ""}
    <ul style="margin:0;padding-left:18px">${insight.evidence.map((e) => `<li style="font-size:12px;color:#374151">${esc(e)}</li>`).join("")}</ul>
    ${insight.recommendedNextStep ? `<p style="margin:6px 0 0;font-size:12px;color:#374151"><strong>Next step:</strong> ${esc(insight.recommendedNextStep)}</p>` : ""}
    <p style="margin:4px 0 0;font-size:10px;color:#9CA3AF">confidence: ${esc(insight.confidence)}</p>
  </div>`;
}

export function tableHtml(table: TableSpec): string {
  return `${
    table.title
      ? `<p style="margin:0.5em 0 4px;font-weight:600;font-size:13px;color:#111827">${esc(table.title)}</p>`
      : ""
  }<table style="border-collapse:collapse;width:100%;font-size:12px;margin:0.5em 0 1.2em">
  <thead><tr>${table.columns.map((c) => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #E5E7EB">${esc(c.label)}</th>`).join("")}</tr></thead>
  <tbody>${table.rows
    .slice(0, 50)
    .map(
      (r) =>
        `<tr>${table.columns.map((_c, i) => `<td style="padding:5px 8px;border-bottom:1px solid #F3F4F6;color:#374151">${r[i] === null || r[i] === undefined ? "—" : esc(String(r[i]))}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

const SOURCE_LABELS: Record<ReportSectionSource["kind"], string> = {
  dataset: "Dataset",
  profile: "Dataset profile",
  analysis: "From analysis",
  insight: "From insight",
  manual: "Editorial",
  awaiting: "Awaiting evidence",
};

/** Small provenance tag shown above a section's content in the export. */
export function sectionSourceHtml(source: ReportSectionSource): string {
  const awaiting = source.kind === "awaiting";
  const label = awaiting
    ? (source.label ?? "Awaiting evidence")
    : `${SOURCE_LABELS[source.kind] ?? source.kind}${source.label ? `: ${source.label}` : ""}`;
  const color = awaiting ? "#B45309" : "#5AA8AA";
  const bg = awaiting ? "#FEF3C7" : "#ECF8F8";
  return `<p class="section-source" style="display:inline-block;margin:2px 0 0;padding:2px 10px;border-radius:999px;font-size:11px;color:${color};background:${bg}">${awaiting ? "⏳ " : "● "}${esc(label)}</p>`;
}

export function sectionHtml(section: ReportSection): string {
  const parts = [`<h2 style="font-size:18px;margin:1.4em 0 0.5em;color:#111827">${esc(section.heading)}</h2>`];
  if (section.source) parts.push(sectionSourceHtml(section.source));
  if (section.kind === "chart" && section.chart) {
    parts.push(chartHtml(section.chart));
    if (section.content) parts.push(htmlForText(section.content));
  } else if (section.kind === "insight" && section.insight) {
    parts.push(insightHtml(section.insight));
  } else if (section.kind === "table" && section.table) {
    parts.push(tableHtml(section.table));
  } else {
    parts.push(htmlForText(section.content));
  }
  return parts.join("");
}

export function slideHtml(slide: PresentationSlide): string {
  const accent = esc(slide.accent ?? "#5AA8AA");
  let body = "";
  if (slide.bullets.length) {
    body += `<ul style="margin:0;padding-left:22px">${slide.bullets.map((b) => `<li style="margin:0.5em 0;font-size:15px;color:#374151;line-height:1.5">${esc(b)}</li>`).join("")}</ul>`;
  }
  if (slide.chart) body += chartHtml(slide.chart);
  if (slide.insight) body += insightHtml(slide.insight);
  return `<section style="min-height:180px;border:1px solid #E5E7EB;border-top:6px solid ${accent};border-radius:8px;padding:26px 30px;margin-bottom:26px;break-inside:avoid">
    <h2 style="font-size:24px;margin:0 0 12px;color:#111827">${esc(slide.title)}</h2>${body}
  </section>`;
}

export function exportShell({ title, body, notes }: { title: string; body: string; notes?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; color: #111827; line-height: 1.55; background: #FFFFFF; }
  .doc { max-width: 900px; margin: 0 auto; padding: 48px 40px; }
  .doc-header { border-bottom: 1px solid #E5E7EB; padding-bottom: 18px; margin-bottom: 22px; }
  .doc-kicker { margin: 0 0 6px; font-size: 11.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #5AA8AA; }
  .doc-header h1 { margin: 0 0 4px; font-size: 28px; letter-spacing: -0.02em; line-height: 1.2; }
  .doc-sub { margin: 0; color: #6B7280; font-size: 12.5px; }
  .cover { text-align:center; padding: 60px 0 40px; }
  .cover h1 { font-size: 34px; margin: 0 0 8px; }
  .cover p { color: #6B7280; }
  h1,h2,h3 { line-height: 1.3; }
  svg, table, img { max-width: 100%; }
  .meta-table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin: 0 0 20px; }
  .meta-table th, .meta-table td { text-align: left; padding: 5px 10px; border-bottom: 1px solid #F3F4F6; }
  .meta-table th { color: #6B7280; font-weight: 600; width: 180px; }
  .meta-table td { color: #111827; }
  .toc { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 10px; padding: 16px 22px; margin: 0 0 8px; break-inside: avoid; }
  .toc h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7280; margin: 0 0 10px; }
  .toc ol { margin: 0; padding-left: 0; list-style: none; columns: 2; column-gap: 40px; }
  .toc li { margin: 3px 0; font-size: 13px; break-inside: avoid; }
  .toc a { color: #1D4ED8; text-decoration: none; display: inline-flex; align-items: baseline; gap: 8px; }
  .toc-num { min-width: 20px; font-variant-numeric: tabular-nums; color: #9CA3AF; font-size: 11px; text-align: right; }
  .doc-section { position: relative; break-inside: avoid-page; }
  .sec-number { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; color: #5AA8AA; margin: 0 0 2px; }
  .doc-body section { break-inside: avoid-page; }
  .sources-block { margin-top: 34px; border: 1px solid #E5E7EB; border-left: 4px solid #5AA8AA; border-radius: 10px; background: #F9FAFB; padding: 18px 22px; break-inside: avoid; }
  .sources-block h2 { font-size: 14px; margin: 0 0 6px; color: #111827; }
  .sources-lead { margin: 0 0 10px; font-size: 12.5px; color: #374151; }
  .sources-list { margin: 0; padding-left: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill,minmax(240px,1fr)); gap: 6px 16px; }
  .sources-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; }
  .src-kind { font-variant-caps: all-small-caps; font-weight: 700; letter-spacing: 0.04em; color: #5AA8AA; min-width: 84px; }
  .src-label { color: #111827; }
  .sources-note { margin: 10px 0 0; font-size: 12px; color: #B45309; }
  .sources-empty { margin: 0; font-size: 12.5px; color: #6B7280; font-style: italic; }
  .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #E5E7EB; color: #9CA3AF; font-size: 11px; display: flex; justify-content: space-between; gap: 24px; }
  @page { margin: 18mm 16mm; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page-break { page-break-before: always; }
    .doc { padding: 0; max-width: none; }
    .toc a { color: #111827; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body><main class="doc">${body}${notes ?? ""}</main></body>
</html>`;
}
