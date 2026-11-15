"use client";

import { FileText, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";

type EvidenceLine = string[];

interface SummarySection {
  title: string;
  content: string;
  confidence: number;
  evidence: EvidenceLine;
  dataPoints?: Record<string, unknown>[];
}

interface SummaryResponse {
  datasetId: string;
  datasetName: string;
  generatedAt: string;
  sections: SummarySection[];
  keyFindings: string[];
  recommendations: string[];
  limitations: string[];
  metadata: {
    totalRows: number;
    totalColumns: number;
    timeRange?: { start: string; end: string };
    dataQuality: number;
  };
}

/** Confidence badge — always shows the honest confidence level. */
function ConfidenceBadge({ confidence }: { confidence: number }) {
  const label = confidence >= 0.95 ? "Calculated" : confidence >= 0.8 ? "High confidence" : "Estimated";
  const variant = confidence >= 0.95 ? "success" : confidence >= 0.8 ? "info" : "warning";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium",
        variant === "success" && "bg-[#58B368]/12 text-[#2E7D46] border border-[#58B368]/30 dark:text-[#7ED096]",
        variant === "info" && "bg-[#3D9BE9]/12 text-[#1E6FB5] border border-[#3D9BE9]/30 dark:text-[#6FB8F0]",
        variant === "warning" && "bg-[#F08A5D]/12 text-[#B85C22] border border-[#F08A5D]/30 dark:text-[#F5A878]",
      )}
    >
      {label}
    </span>
  );
}

/**
 * Executive Summary panel — a data-driven boardroom summary.
 * Every claim is computed from the dataset; nothing is predicted.
 */
export function ExecutiveSummary({ datasetId }: { datasetId: string }) {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<SummaryResponse>(`/api/datasets/${datasetId}/summary`, {
        method: "POST",
        body: JSON.stringify({ includeRecommendations: true }),
      });
      setSummary(data);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            Executive Summary
          </CardTitle>
          <CardDescription>
            Evidence-backed business overview computed from your actual data. No predicted numbers.
          </CardDescription>
        </div>
        <Button onClick={generate} disabled={loading} variant="primary" size="sm">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          {loading ? "Computing…" : summary ? "Regenerate" : "Generate"}
        </Button>
      </CardHeader>

      {error && (
        <CardContent>
          <div className="flex items-center gap-2 rounded-lg border border-[#E8637A]/30 bg-[#E8637A]/10 p-3 text-sm text-[#B93A52] dark:text-[#F08A9B]">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            {error}
          </div>
        </CardContent>
      )}

      {!summary && !loading && !error && (
        <CardContent>
          <div className="rounded-lg border border-dashed border-line p-6 text-center">
            <p className="text-sm text-muted">
              Generate a one-page, boardroom-ready summary of this dataset — key metrics, trends, quality, and honest
              limitations — all computed live from your rows.
            </p>
          </div>
        </CardContent>
      )}

      {summary && (
        <CardContent className="space-y-4">
          {/* Key metadata row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetaStat label="Rows" value={summary.metadata.totalRows.toLocaleString()} />
            <MetaStat label="Columns" value={String(summary.metadata.totalColumns)} />
            <MetaStat label="Quality" value={`${(summary.metadata.dataQuality * 100).toFixed(1)}%`} />
            <MetaStat
              label="Time range"
              value={
                summary.metadata.timeRange
                  ? `${summary.metadata.timeRange.start} → ${summary.metadata.timeRange.end}`
                  : "No dates"
              }
            />
          </div>

          {/* Sections */}
          <div className="space-y-3">
            {summary.sections.map((section) => (
              <div key={section.title} className="rounded-lg border border-line bg-surface p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-foreground">{section.title}</h4>
                  <ConfidenceBadge confidence={section.confidence} />
                </div>
                <p className="whitespace-pre-line text-sm leading-relaxed text-muted">{section.content}</p>
                {section.evidence.length > 0 && (
                  <div className="mt-3 border-t border-line pt-2">
                    <p className="mb-1 text-caption font-medium uppercase tracking-wide text-muted">Evidence</p>
                    <ul className="space-y-0.5">
                      {section.evidence.map((e) => (
                        <li key={e} className="text-caption text-muted">
                          • {e}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Key findings */}
          {summary.keyFindings.length > 0 && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
              <p className="mb-2 text-sm font-semibold text-foreground">Key Findings</p>
              <ul className="space-y-1">
                {summary.keyFindings.map((f) => (
                  <li key={f} className="text-sm text-muted">
                    • {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Recommendations */}
          {summary.recommendations.length > 0 && (
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="mb-2 text-sm font-semibold text-foreground">Recommendations</p>
              <ul className="space-y-1">
                {summary.recommendations.map((r) => (
                  <li key={r} className="text-sm text-muted">
                    • {r}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Limitations — honesty matters */}
          {summary.limitations.length > 0 && (
            <div className="rounded-lg border border-[#F08A5D]/30 bg-[#F08A5D]/5 p-4">
              <p className="mb-2 text-sm font-semibold text-foreground">Limitations</p>
              <ul className="space-y-1">
                {summary.limitations.map((l) => (
                  <li key={l} className="text-sm text-muted">
                    • {l}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function MetaStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <p className="text-caption font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 truncate text-h3 text-foreground">{value}</p>
    </div>
  );
}
