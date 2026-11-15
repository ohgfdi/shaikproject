"use client";

import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  Database,
  Eye,
  FileDown,
  FileText,
  Lightbulb,
  List,
  Plus,
  Save,
  ShieldCheck,
  Table2,
  Trash2,
  Type,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { ChartRenderer } from "@/components/charts/chart";
import { InsightCardView } from "@/components/insight/insight-card";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Badge, Card, type BadgeVariant } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/client/api";
import { chartSpecDrillCategories, chartSpecDrillThrough } from "@/lib/engine/drill-through";
import { REPORT_SECTION_PRESETS } from "@/lib/templates";
import type { ReportSectionSource } from "@/lib/types";
import type { AnalysisResult, ChartSpec, InsightCard, ReportSection, TableSpec } from "@/lib/types";
import { cn, uid } from "@/lib/utils";

export interface ReportEditorProps {
  reportId: string;
  title: string;
  projectId: string | null;
  initialSections: ReportSection[];
  version: number;
  analyses: { id: string; title: string; kind: string; result: AnalysisResult | null }[];
  insights: InsightCard[];
  numStyle?: "comma" | "dot" | "plain";
}

const KIND_META: Record<ReportSection["kind"], { label: string; icon: LucideIcon; badge: BadgeVariant }> = {
  text: { label: "Text", icon: Type, badge: "default" },
  chart: { label: "Chart", icon: BarChart3, badge: "accent" },
  insight: { label: "Insight", icon: Lightbulb, badge: "info" },
  table: { label: "Table", icon: Table2, badge: "default" },
};

const SOURCE_LABEL: Record<Exclude<ReportSectionSource["kind"], "manual" | "awaiting">, string> = {
  dataset: "Dataset",
  profile: "Dataset profile",
  analysis: "Analysis",
  insight: "Insight",
};

/** Honest provenance / evidence-status tag shown on every section. */
function SourceTag({ source }: { source?: ReportSectionSource }) {
  if (!source) return null;
  if (source.kind === "awaiting") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-caption text-[#B85C22] dark:text-[#F5A878]">
        <CircleAlert aria-hidden className="size-3" />
        Awaiting evidence{source.label ? ` — ${source.label}` : ""}
      </span>
    );
  }
  if (source.kind === "manual") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-caption text-muted">
        <FileText aria-hidden className="size-3" />
        Editorial section
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-caption text-accent-strong dark:text-[#7FC6C8]">
      <ShieldCheck aria-hidden className="size-3" />
      Computed from {SOURCE_LABEL[source.kind] ?? source.kind}: {source.label ?? "—"}
    </span>
  );
}

export function ReportEditor(props: ReportEditorProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [title, setTitle] = useState(props.title);
  const [sections, setSections] = useState<ReportSection[]>(props.initialSections);
  const [snapshot, setSnapshot] = useState(() => ({ title: props.title, sections: props.initialSections }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [insertFor, setInsertFor] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showToc, setShowToc] = useState(true);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(props.initialSections[0]?.id ?? null);

  const dirty = title !== snapshot.title || JSON.stringify(sections) !== JSON.stringify(snapshot.sections);

  useEffect(() => {
    setActiveId((cur) => (cur && sections.some((s) => s.id === cur) ? cur : (sections[0]?.id ?? null)));
  }, [sections]);

  // Scroll-spy for the outline: highlight the section currently in view.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = (entry.target as HTMLElement).dataset.sectionId;
          if (id) setActiveId(id);
        }
      },
      { rootMargin: "-100px 0px -65% 0px", threshold: 0 },
    );
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-section-id]"));
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sections.length]);

  const saveRef = useRef<(asVersion: boolean) => Promise<void>>(async () => undefined);
  saveRef.current = (asVersion: boolean) => save(asVersion);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void saveRef.current(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const updateSection = (id: string, patch: Partial<ReportSection>) =>
    setSections((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const removeSection = (id: string) => setSections((ss) => ss.filter((s) => s.id !== id));

  const addSection = (heading?: string) => {
    setSections((ss) => [
      ...ss,
      heading
        ? {
            id: uid("sec"),
            heading,
            kind: "text",
            content: "",
            source: { kind: "awaiting", label: `${heading} is awaiting content` },
          }
        : { id: uid("sec"), heading: "New section", kind: "text", content: "", source: { kind: "manual" } },
    ]);
    setShowAddMenu(false);
  };

  const move = (id: string, dir: -1 | 1) =>
    setSections((ss) => {
      const i = ss.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ss.length) return ss;
      const next = [...ss];
      const [item] = next.splice(i, 1);
      if (!item) return ss;
      next.splice(j, 0, item);
      return next;
    });

  const save = async (asVersion = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ version: number }>(`/api/reports/${props.reportId}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          sections: sections as unknown as Record<string, unknown>[],
          saveVersion: asVersion,
        }),
      });
      setSnapshot({ title: title.trim(), sections });
      toast({
        title: "Report saved",
        message: asVersion ? `Version ${res.version} created.` : "Latest version updated.",
        type: "success",
      });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const wordCount = useMemo(
    () => sections.reduce((acc, s) => acc + s.content.split(/\s+/).filter(Boolean).length, 0),
    [sections],
  );
  const dataBacked = useMemo(
    () => sections.filter((s) => s.source && s.source.kind !== "manual" && s.source.kind !== "awaiting").length,
    [sections],
  );
  const awaitingCount = useMemo(() => sections.filter((s) => s.source?.kind === "awaiting").length, [sections]);

  const sources = useMemo(() => {
    type SourceKind = Exclude<ReportSectionSource["kind"], "manual" | "awaiting">;
    const map = new Map<string, { kind: SourceKind; label?: string; count: number }>();
    for (const s of sections) {
      const src = s.source;
      if (!src || src.kind === "manual" || src.kind === "awaiting") continue;
      const key = `${src.kind}:${src.label ?? src.id ?? s.heading}`;
      const prev = map.get(key);
      if (prev) prev.count += 1;
      else map.set(key, { kind: src.kind, label: src.label, count: 1 });
    }
    return Array.from(map.values());
  }, [sections]);

  return (
    <div>
      {/* World-class document toolbar — title, save state and actions always visible. */}
      <div className="sticky top-14 z-10 -mx-4 border-b border-line bg-surface/90 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="px-4 sm:px-0">
          <div className="flex flex-wrap items-center gap-3">
            <input
              aria-label="Report title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-h1 text-foreground hover:border-line focus:border-line focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
            <span
              aria-live="polite"
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-medium",
                busy
                  ? "border-line bg-surface-2 text-muted"
                  : dirty
                    ? "border-amber/40 bg-amber/10 text-[#B85C22] dark:text-[#F5A878]"
                    : "border-success/40 bg-success/10 text-[#2E7D46] dark:text-[#7ED096]",
              )}
            >
              {busy ? (
                <CheckCircle2 aria-hidden className="size-3.5 animate-pulse" />
              ) : dirty ? (
                <CircleAlert aria-hidden className="size-3.5" />
              ) : (
                <CheckCircle2 aria-hidden className="size-3.5" />
              )}
              {busy ? "Saving…" : dirty ? "Unsaved changes" : `Saved · v${props.version}`}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted">
            <span>
              {sections.length} section{sections.length !== 1 ? "s" : ""} · {wordCount.toLocaleString()} words
            </span>
            <span className={cn("inline-flex items-center gap-1", dataBacked > 0 && "text-accent-strong")}>
              <ShieldCheck aria-hidden className="size-3.5" />
              {dataBacked} data-backed
            </span>
            {awaitingCount > 0 && (
              <button
                onClick={() => {
                  const el = document.querySelector<HTMLElement>(
                    `[data-section-id="${sections.find((s) => s.source?.kind === "awaiting")?.id ?? ""}"]`,
                  );
                  el?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <CircleAlert aria-hidden className="size-3.5" />
                {awaitingCount} awaiting evidence
              </button>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 px-4 sm:px-0">
          <Button
            variant={showToc ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowToc((v) => !v)}
            aria-pressed={showToc}
            icon={<List aria-hidden className="size-4" />}
          >
            Contents
          </Button>
          <Button
            variant={showPreview ? "primary" : "secondary"}
            size="sm"
            onClick={() => setShowPreview((v) => !v)}
            aria-pressed={showPreview}
            icon={<Eye aria-hidden className="size-4" />}
          >
            {showPreview ? "Editing" : "Preview"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSources(true)}
            icon={<Database aria-hidden className="size-4" />}
          >
            Sources
          </Button>
          <div className="mx-1 hidden h-6 w-px bg-line sm:block" aria-hidden />
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => save(true)}
              icon={<Save aria-hidden className="size-4" />}
            >
              Save as version
            </Button>
            <Button size="sm" onClick={() => save(false)} loading={busy} icon={<Save aria-hidden className="size-4" />}>
              Save
            </Button>
            <Link href={`/export/reports/${props.reportId}`} target="_blank">
              <Button variant="secondary" size="sm" icon={<FileDown aria-hidden className="size-4" />}>
                Open printable export
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {error && <ErrorMessage title="Save failed" message={error} className="mb-4 mt-4" />}

      <div className="grid gap-4 pt-4 lg:grid-cols-[240px_1fr]">
        {showToc && (
          <nav
            aria-label="Table of contents"
            className="h-fit rounded-lg border border-line bg-surface p-3 lg:sticky lg:top-[11.75rem]"
          >
            <p className="mb-2 flex items-center justify-between text-caption font-semibold uppercase tracking-wide text-muted">
              Contents
              <button
                onClick={() => setShowToc(false)}
                aria-label="Hide contents"
                className="rounded p-0.5 text-muted hover:text-foreground lg:hidden"
              >
                <X aria-hidden className="size-4" />
              </button>
            </p>
            <ol className="flex flex-col gap-0.5">
              {sections.map((s, i) => {
                const meta = KIND_META[s.kind];
                const Icon = meta.icon;
                const awaiting = s.source?.kind === "awaiting";
                const isActive = activeId === s.id;
                return (
                  <li key={s.id}>
                    <a
                      href={`#section-${s.id}`}
                      aria-current={isActive ? "true" : undefined}
                      className={cn(
                        "flex items-center gap-1.5 rounded px-1.5 py-1 text-sm transition-colors",
                        isActive
                          ? "bg-accent/10 font-medium text-foreground"
                          : "text-muted hover:bg-surface-2 hover:text-foreground",
                      )}
                    >
                      <span className="text-caption tabular-nums text-muted/80">{i + 1}.</span>
                      <Icon
                        aria-hidden
                        className={cn("size-3.5 shrink-0", awaiting ? "text-warning" : "text-accent")}
                      />
                      <span className="truncate">{s.heading}</span>
                    </a>
                  </li>
                );
              })}
              {sections.length === 0 && <li className="px-1.5 py-1 text-sm text-muted">No sections yet.</li>}
            </ol>
          </nav>
        )}

        <ol className="flex flex-col gap-4">
          {sections.map((section, index) => (
            <li key={section.id} id={`section-${section.id}`} data-section-id={section.id} className="scroll-mt-56">
              <Card className="p-4">
                <header className="flex items-center gap-2">
                  <div className="flex flex-col">
                    <button
                      onClick={() => move(section.id, -1)}
                      aria-label="Move section up"
                      className="rounded p-0.5 text-muted hover:text-foreground"
                    >
                      <ArrowUp aria-hidden className="size-3.5" />
                    </button>
                    <button
                      onClick={() => move(section.id, 1)}
                      aria-label="Move section down"
                      className="rounded p-0.5 text-muted hover:text-foreground"
                    >
                      <ArrowDown aria-hidden className="size-3.5" />
                    </button>
                  </div>
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-caption font-semibold tabular-nums text-muted">
                    {index + 1}
                  </span>
                  {showPreview ? (
                    <h2 className="min-w-0 flex-1 text-h3 text-foreground">{section.heading}</h2>
                  ) : (
                    <input
                      aria-label="Section heading"
                      value={section.heading}
                      onChange={(e) => updateSection(section.id, { heading: e.target.value })}
                      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-h3 text-foreground hover:border-line focus:border-line focus:outline-none focus:ring-2 focus:ring-focus/60"
                    />
                  )}
                  <Badge variant={KIND_META[section.kind].badge} className="capitalize">
                    {KIND_META[section.kind].label}
                  </Badge>
                  <button
                    onClick={() => removeSection(section.id)}
                    aria-label="Remove section"
                    className="rounded p-1.5 text-muted hover:text-danger"
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </button>
                </header>

                <div className="mt-3 pl-7">
                  {showPreview ? (
                    <SectionPreview section={section} numStyle={props.numStyle ?? "comma"} />
                  ) : (
                    <>
                      {section.kind === "text" && (
                        <textarea
                          aria-label={`${section.heading} content`}
                          value={section.content}
                          onChange={(e) => updateSection(section.id, { content: e.target.value })}
                          className="min-h-24 w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-focus/60"
                        />
                      )}
                      {section.kind === "chart" && section.chart && (
                        <div>
                          <ChartRenderer spec={section.chart} numStyle={props.numStyle ?? "comma"} height={260} />
                        </div>
                      )}
                      {section.kind === "insight" && section.insight && <InsightCardView insight={section.insight} />}
                      {section.kind === "table" && section.table && (
                        <DataTable
                          columns={section.table.columns}
                          rows={section.table.rows}
                          pageSize={10}
                          numStyle={props.numStyle ?? "comma"}
                        />
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <select
                          aria-label="Section type"
                          value={section.kind}
                          onChange={(e) => updateSection(section.id, { kind: e.target.value as ReportSection["kind"] })}
                          className="h-8 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                        >
                          <option value="text">Text</option>
                          <option value="chart">Chart</option>
                          <option value="insight">Insight card</option>
                          <option value="table">Table</option>
                        </select>
                        {(section.kind === "chart" || section.kind === "insight" || section.kind === "table") && (
                          <Button variant="ghost" size="sm" onClick={() => setInsertFor(section.id)}>
                            Attach from analyses / insights…
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <footer className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/70 pt-3 pl-7">
                  <SourceTag source={section.source} />
                  {section.source?.kind === "awaiting" && (
                    <p className="text-caption text-muted">
                      This section reports exactly what is missing — it never guesses.
                    </p>
                  )}
                </footer>
              </Card>
            </li>
          ))}
          {sections.length === 0 && (
            <li className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
              No sections yet — add one below to start your report.
            </li>
          )}
        </ol>
      </div>

      <div className="relative mt-4">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowAddMenu((v) => !v)}
          aria-expanded={showAddMenu}
          icon={<Plus aria-hidden className="size-4" />}
        >
          Add section
        </Button>
        {showAddMenu && (
          <div className="absolute z-10 mt-1 w-80 rounded-lg border border-line bg-surface p-1.5 shadow-lg">
            <button
              onClick={() => addSection()}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-foreground  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line hover:bg-surface-2"
            >
              <FileText aria-hidden className="size-4 text-muted" />
              Blank section
            </button>
            <p className="px-2.5 pb-1 pt-2 text-caption uppercase tracking-wide text-muted">Standard structure</p>
            {REPORT_SECTION_PRESETS.filter((p) => !sections.some((s) => s.heading === p.heading)).map((p) => (
              <button
                key={p.heading}
                onClick={() => addSection(p.heading)}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-foreground  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line hover:bg-surface-2"
              >
                <CircleAlert aria-hidden className="size-4 text-warning" />
                {p.heading}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 flex items-start gap-2 rounded-md border border-accent/25 bg-accent/5 px-3 py-2.5 text-caption text-muted">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
        <p>
          Honesty guarantee: every figure in this report is computed from the stored sources it cites. No predicted,
          extrapolated or invented numbers — sections without evidence say so explicitly (marked “awaiting evidence”).
        </p>
      </div>

      <InsertDialog
        open={insertFor}
        onClose={() => setInsertFor(null)}
        analyses={props.analyses}
        insights={props.insights}
        onPick={(sectionId, source) => {
          const s = sections.find((x) => x.id === sectionId);
          if (!s) return;
          const sectionSource: ReportSectionSource | undefined =
            source.kind === "insight" && source.insight
              ? { kind: "insight", label: source.insight.title, id: source.insight.id }
              : source.analysis
                ? { kind: "analysis", label: source.analysis.title, id: source.analysis.id }
                : undefined;
          if (source.kind === "insight" && source.insight) {
            updateSection(sectionId, {
              kind: "insight",
              insight: source.insight,
              content: source.insight.title,
              source: sectionSource,
            });
          } else if (source.analysis?.result) {
            if (source.kind === "table" && source.table) {
              updateSection(sectionId, {
                kind: "table",
                table: source.table,
                content: source.analysis.title,
                source: sectionSource,
              });
            } else if (source.chart) {
              updateSection(sectionId, {
                kind: "chart",
                chart: source.chart,
                content: source.analysis.title,
                source: sectionSource,
              });
            }
          }
          setInsertFor(null);
        }}
      />

      <Dialog
        open={showSources}
        onClose={() => setShowSources(false)}
        title="Sources behind this report"
        description="Each figure traces to a stored artifact in this project — nothing is invented."
        size="md"
        footer={
          <Button variant="ghost" onClick={() => setShowSources(false)}>
            Done
          </Button>
        }
      >
        {sources.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            Nothing data-backed yet. Run analyses, generate insights, or attach artifact content to sections and the
            sources appear here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sources.map((src, i) => {
              const Icon = src.kind === "insight" ? Lightbulb : src.kind === "analysis" ? BarChart3 : Database;
              return (
                <li
                  key={`${src.kind}-${i}`}
                  className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2"
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{src.label ?? src.kind}</p>
                    <p className="text-caption text-muted">{SOURCE_LABEL[src.kind] ?? src.kind}</p>
                  </div>
                  <Badge variant="outline">
                    {src.count} section{src.count !== 1 ? "s" : ""}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Dialog>
    </div>
  );
}

/** Read-only rendering of one section, used in preview mode (document style). */
function SectionPreview({ section, numStyle }: { section: ReportSection; numStyle: "comma" | "dot" | "plain" }) {
  // Drill-through (ROADMAP 3.5): a chart section exposes its categories as
  // drill chips — clicking one shows the per-series breakdown for that value
  // from the section's stored snapshot, exactly like the dashboard builder.
  const [drill, setDrill] = useState<ReturnType<typeof chartSpecDrillThrough>>(null);
  const drillValues = section.kind === "chart" && section.chart ? chartSpecDrillCategories(section.chart) : [];
  return (
    <div className="rounded-md border border-line bg-surface px-4 py-3">
      {section.kind === "text" && (
        <div className="flex flex-col gap-2.5">
          {section.content.split(/\n{2,}/).map((para, i) => {
            const isList = para.split("\n").length > 1 && para.split("\n").every((l) => /^\s*[-•] /.test(l));
            if (isList) {
              return (
                <ul key={i} className="list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-foreground">
                  {para.split("\n").map((line, j) => (
                    <li key={j}>{line.replace(/^\s*[-•]\s+/, "")}</li>
                  ))}
                </ul>
              );
            }
            return (
              <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {para}
              </p>
            );
          })}
          {!section.content && <p className="text-sm italic text-muted">This section is empty.</p>}
        </div>
      )}
      {section.kind === "chart" && section.chart && (
        <div>
          <ChartRenderer spec={section.chart} numStyle={numStyle} height={260} />
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
                numStyle={numStyle}
                caption={
                  drill.sampled
                    ? `Sampled — showing ${drill.rows.length} of ${drill.totalRows} rows`
                    : `${drill.totalRows} series value(s) from the section's stored snapshot.`
                }
              />
            </div>
          )}
        </div>
      )}
      {section.kind === "insight" && section.insight && <InsightCardView insight={section.insight} />}
      {section.kind === "table" && section.table && (
        <DataTable columns={section.table.columns} rows={section.table.rows} pageSize={10} numStyle={numStyle} />
      )}
    </div>
  );
}

function InsertDialog({
  open,
  onClose,
  analyses,
  insights,
  onPick,
}: {
  open: string | null; // sectionId to attach into
  onClose: () => void;
  analyses: { id: string; title: string; kind: string; result: AnalysisResult | null }[];
  insights: InsightCard[];
  onPick: (
    sectionId: string,
    source: {
      kind: "insight" | "chart" | "table";
      analysis?: { id: string; title: string; result?: AnalysisResult | null };
      chart?: ChartSpec;
      insight?: InsightCard;
      table?: TableSpec;
    },
  ) => void;
}) {
  const [tab, setTab] = useState<"chart" | "insight" | "table">("chart");
  const [query, setQuery] = useState("");
  const withCharts = analyses.filter((a) => a.result?.charts[0]);
  const withTables = analyses.filter((a) => a.result?.tables?.[0]);
  const sectionId = open;
  const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());

  return (
    <Dialog
      open={open !== null}
      onClose={onClose}
      title="Attach content to this section"
      description="Charts, tables and insights embed live snapshots computed from your stored artifacts — what you attach is exactly what the report shows, and the source is recorded."
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(["chart", "table", "insight"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={cn(
              "rounded-full border px-3 py-1 text-caption",
              tab === t ? "border-accent bg-accent/10 text-foreground" : "border-line text-muted hover:bg-surface-2",
            )}
          >
            {t === "chart"
              ? `Charts (${withCharts.length})`
              : t === "table"
                ? `Tables (${withTables.length})`
                : `Insights (${insights.length})`}
          </button>
        ))}
        <input
          aria-label="Search attachable content"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ml-auto h-8 w-44 rounded-md border border-line bg-surface px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
        />
      </div>
      <div className="thin-scroll max-h-72 overflow-y-auto">
        {tab !== "insight" &&
          analyses
            .filter((a) => (tab === "chart" ? a.result?.charts[0] : a.result?.tables?.[0]))
            .filter((a) => matches(a.title) || matches(a.kind))
            .map((a) => {
              const chart = a.result?.charts[0];
              const table = a.result?.tables?.[0];
              return (
                <button
                  key={a.id}
                  onClick={() =>
                    sectionId &&
                    onPick(
                      sectionId,
                      tab === "chart"
                        ? { kind: "chart", analysis: { id: a.id, title: a.title }, chart: chart ?? undefined }
                        : { kind: "table", analysis: { id: a.id, title: a.title }, table: table ?? undefined },
                    )
                  }
                  className="mb-2 w-full rounded-md border border-line px-3 py-2 text-left hover:border-accent/50  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line hover:bg-surface-2"
                >
                  <span className="block truncate text-sm font-medium text-foreground">{a.title}</span>
                  <span className="block truncate text-caption text-muted">
                    {tab === "chart" ? (chart?.title ?? "chart") : (table?.title ?? "table")} · {a.kind}
                  </span>
                </button>
              );
            })}
        {tab === "insight" &&
          insights
            .filter((i) => matches(i.title))
            .map((i) => (
              <button
                key={i.id}
                onClick={() => sectionId && onPick(sectionId, { kind: "insight", insight: i })}
                className="mb-2 w-full rounded-md border border-line px-3 py-2 text-left hover:border-accent/50  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line hover:bg-surface-2"
              >
                <span className="block truncate text-sm font-medium text-foreground">{i.title}</span>
                <span className="block truncate text-caption text-muted">
                  {i.severity} · {i.confidence}
                </span>
              </button>
            ))}
        {tab === "insight" && insights.length === 0 && (
          <p className="py-6 text-center text-sm text-muted">No insights yet — generate them on a dataset first.</p>
        )}
        {tab !== "insight" &&
          (tab === "chart" ? withCharts : withTables).filter((a) => matches(a.title) || matches(a.kind)).length ===
            0 && (
            <p className="py-6 text-center text-sm text-muted">
              No matching {tab === "chart" ? "charts" : "tables"} — run the relevant analysis first.
            </p>
          )}
      </div>
    </Dialog>
  );
}
