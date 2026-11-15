"use client";

import { Eye, FileDown, MonitorPlay, Plus, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ChartRenderer } from "@/components/charts/chart";
import { InsightCardView } from "@/components/insight/insight-card";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Card, Badge } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { AnalysisResult, InsightCard, PresentationSlide } from "@/lib/types";
import { uid } from "@/lib/utils";
import { cn } from "@/lib/utils";

export interface PresentationEditorProps {
  presentationId: string;
  title: string;
  projectId: string | null;
  initialSlides: PresentationSlide[];
  analyses: { id: string; title: string; result: AnalysisResult | null }[];
  insights: InsightCard[];
}

export function PresentationEditor(props: PresentationEditorProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [title, setTitle] = useState(props.title);
  const [slides, setSlides] = useState<PresentationSlide[]>(props.initialSlides);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PresentationSlide | null>(null);
  const [attachFor, setAttachFor] = useState<string | null>(null);

  const update = (id: string, patch: Partial<PresentationSlide>) =>
    setSlides((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const remove = (id: string) => setSlides((ss) => ss.filter((s) => s.id !== id));

  const addSlide = () =>
    setSlides((ss) => [
      ...ss,
      { id: uid("slide"), title: "New slide", layout: "bullets", bullets: ["Point one"], notes: "" },
    ]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/presentations/${props.presentationId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: title.trim(), slides: slides as unknown as Record<string, unknown>[] }),
      });
      toast({ title: "Presentation saved", type: "success" });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && <ErrorMessage title="Save failed" message={error} className="mb-4" />}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <input
            aria-label="Presentation title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full max-w-lg rounded-md border border-line bg-surface px-2.5 py-1.5 text-h1 text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
          />
          <p className="mt-1 text-caption text-muted">
            {slides.length} slides · board outline — edit freely, attach charts & insights, export to HTML/PDF
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={addSlide} icon={<Plus aria-hidden className="size-4" />}>
            Add slide
          </Button>
          <Button size="sm" onClick={save} loading={busy} icon={<Save aria-hidden className="size-4" />}>
            Save deck
          </Button>
          <Link href={`/export/presentations/${props.presentationId}`} target="_blank">
            <Button variant="secondary" size="sm" icon={<FileDown aria-hidden className="size-4" />}>
              Generate presentation (HTML/PDF)
            </Button>
          </Link>
        </div>
      </div>

      <ol className="flex flex-col gap-3">
        {slides.map((slide, i) => (
          <li key={slide.id}>
            <Card className="p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <Badge variant="outline">Slide {i + 1}</Badge>
                  <input
                    aria-label={`Slide ${i + 1} title`}
                    value={slide.title}
                    onChange={(e) => update(slide.id, { title: e.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-h3 hover:border-line focus:border-line focus:outline-none focus:ring-2 focus:ring-focus/60"
                  />
                </p>
                <div className="flex items-center gap-1">
                  <select
                    aria-label="Slide layout"
                    value={slide.layout}
                    onChange={(e) => update(slide.id, { layout: e.target.value as PresentationSlide["layout"] })}
                    className="h-8 rounded-md border border-line bg-surface px-2 text-caption focus:outline-none focus:ring-2 focus:ring-focus/60"
                  >
                    {(["title", "bullets", "split", "chart", "quote", "insight"] as const).map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPreview(slide)}
                    icon={<Eye aria-hidden className="size-4" />}
                  >
                    Preview
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(slide.id)} aria-label="Remove slide">
                    <Trash2 aria-hidden className="size-4 text-muted hover:text-danger" />
                  </Button>
                </div>
              </div>

              <div className="mt-3 flex flex-col gap-2">
                {slide.chart && (
                  <div className="rounded border border-line p-2">
                    <ChartRenderer spec={slide.chart} bare height={180} />
                  </div>
                )}
                {slide.insight && <InsightCardView insight={slide.insight} />}
                <label className="text-sm">
                  <span className="mb-1 flex items-center justify-between text-caption font-medium text-muted">
                    Bullet points (one per line)
                    {(slide.layout === "chart" || slide.layout === "insight" || slide.layout === "split") && (
                      <button
                        className="font-medium text-accent hover:underline"
                        onClick={() => setAttachFor(slide.id)}
                        type="button"
                      >
                        {slide.chart || slide.insight ? "Change attachment…" : "Attach chart / insight…"}
                      </button>
                    )}
                  </span>
                  <textarea
                    aria-label={`Slide ${i + 1} bullets`}
                    value={slide.bullets.join("\n")}
                    onChange={(e) => update(slide.id, { bullets: e.target.value.split("\n") })}
                    rows={Math.min(6, Math.max(2, slide.bullets.length))}
                    className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-focus/60"
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-caption font-medium text-muted">Speaker notes</span>
                  <textarea
                    aria-label={`Slide ${i + 1} speaker notes`}
                    value={slide.notes ?? ""}
                    onChange={(e) => update(slide.id, { notes: e.target.value })}
                    rows={2}
                    className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm text-muted focus:outline-none focus:ring-2 focus:ring-focus/60"
                    placeholder="Notes for the presenter — shown in exports."
                  />
                </label>
              </div>
            </Card>
          </li>
        ))}
      </ol>

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title="Slide preview"
        size="lg"
        footer={
          <Button variant="ghost" onClick={() => setPreview(null)}>
            Close
          </Button>
        }
      >
        {preview && <SlidePreviewCard slide={preview} />}
      </Dialog>

      <AttachDialog
        slideId={attachFor}
        onClose={() => setAttachFor(null)}
        analyses={props.analyses}
        insights={props.insights}
        onAttach={(id, payload) => {
          update(id, payload);
          setAttachFor(null);
        }}
      />
    </div>
  );
}

function SlidePreviewCard({ slide }: { slide: PresentationSlide }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border-t-4 border-accent bg-surface-2/40 px-6 py-8">
        <MonitorPlay aria-hidden className="mb-3 size-6 text-accent" />
        <h3 className="text-[1.6rem] font-semibold leading-tight text-foreground">{slide.title}</h3>
        {slide.bullets.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
            {slide.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        )}
        {slide.chart && (
          <div className="mt-3">
            <ChartRenderer spec={slide.chart} bare height={220} />
          </div>
        )}
        {slide.insight && (
          <div className="mt-3">
            <InsightCardView insight={slide.insight} />
          </div>
        )}
        {slide.notes && (
          <p className="mt-3 border-t border-line pt-2 text-caption italic text-muted">Notes: {slide.notes}</p>
        )}
      </div>
      <p className="text-caption text-muted">
        This is how the slide reads on export — the layout chip maps to the deck structure.
      </p>
    </div>
  );
}

function AttachDialog({
  slideId,
  onClose,
  analyses,
  insights,
  onAttach,
}: {
  slideId: string | null;
  onClose: () => void;
  analyses: { id: string; title: string; result: AnalysisResult | null }[];
  insights: InsightCard[];
  onAttach: (slideId: string, payload: Partial<PresentationSlide>) => void;
}) {
  const charts = analyses.filter((a) => a.result?.charts[0]);
  const [tab, setTab] = useState<"chart" | "insight">("chart");
  return (
    <Dialog
      open={slideId !== null}
      onClose={onClose}
      title="Attach to slide"
      description="Slide layouts can carry one chart or one insight alongside their bullets."
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="mb-3 flex gap-1.5">
        {(["chart", "insight"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={cn(
              "rounded-full border px-3 py-1 text-caption",
              tab === t ? "border-accent bg-accent/10 text-foreground" : "border-line text-muted hover:bg-surface-2",
            )}
          >
            {t === "chart" ? `Charts (${charts.length})` : `Insights (${insights.length})`}
          </button>
        ))}
      </div>
      <div className="thin-scroll max-h-72 overflow-y-auto">
        {tab === "chart" && charts.length === 0 && (
          <p className="py-6 text-center text-sm text-muted">Run an analysis with charts first, then attach it here.</p>
        )}
        {tab === "chart" &&
          charts.map((a) => {
            const chart = a.result?.charts.find((c) => c.kind !== "kpi") ?? a.result?.charts[0];
            if (!chart) return null;
            return (
              <button
                key={a.id}
                onClick={() => slideId && onAttach(slideId, { chart: { ...chart }, layout: "chart", bullets: [] })}
                className="mb-2 w-full rounded-md border border-line px-3 py-2 text-left hover:border-accent/50 hover:bg-surface-2"
              >
                <span className="block truncate text-sm font-medium text-foreground">{a.title}</span>
                <span className="block truncate text-caption text-muted">{chart.title}</span>
              </button>
            );
          })}
        {tab === "insight" && insights.length === 0 && (
          <p className="py-6 text-center text-sm text-muted">Generate insights first.</p>
        )}
        {tab === "insight" &&
          insights.map((i) => (
            <button
              key={i.id}
              onClick={() => slideId && onAttach(slideId, { insight: i, layout: "insight" })}
              className="mb-2 w-full rounded-md border border-line px-3 py-2 text-left hover:border-accent/50 hover:bg-surface-2"
            >
              <span className="block truncate text-sm font-medium text-foreground">{i.title}</span>
              <span className="block truncate text-caption text-muted">
                {i.severity} · {i.confidence}
              </span>
            </button>
          ))}
      </div>
    </Dialog>
  );
}
