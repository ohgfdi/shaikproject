"use client";

import { BarChart3, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";

interface MetricValue {
  metricId: string;
  metricName: string;
  value: number;
  formattedValue: string;
  confidence: number;
  computedAt: string;
  sampleSize: number;
}

interface MetricsResponse {
  dataset: { id: string; name: string };
  metrics: Array<{
    id: string;
    name: string;
    description: string;
    format: string;
    sourceColumns: string[];
    tags: string[];
  }>;
  values: MetricValue[];
  count: number;
}

function formatMetric(_metricName: string, v: MetricValue): string {
  return v.formattedValue;
}

/**
 * Governed Metrics panel — the semantic layer.
 * Any metric shown here is computed once using a single governed definition
 * so every analysis and report that references it stays consistent.
 */
export function SemanticMetrics({ datasetId }: { datasetId: string }) {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = await api<MetricsResponse>(`/api/datasets/${datasetId}/metrics`);
      setData(d);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  function loadMetrics() {
    if (data && data.values.length > 0) return;
    void load();
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-accent" />
            Governed Metrics
          </CardTitle>
          <CardDescription>
            Semantic layer — shared metric definitions computed consistently from your columns.
          </CardDescription>
        </div>
        <Button
          onClick={data ? load : undefined}
          onMouseEnter={loadMetrics}
          disabled={loading}
          variant="secondary"
          size="sm"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {loading ? "Scanning…" : data ? "Refresh" : "Detect metrics"}
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

      {!data && !loading && !error && (
        <CardContent>
          <div className="rounded-lg border border-dashed border-line p-5 text-center text-sm text-muted">
            Detect automatically which governed metrics your dataset supports — revenue, order count, conversion rate,
            etc. — and see them computed immediately from real rows.
          </div>
        </CardContent>
      )}

      {loading && !data && (
        <CardContent>
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Matching columns to metric definitions…
          </div>
        </CardContent>
      )}

      {data && (
        <CardContent>
          {data.values.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line p-5 text-center text-sm text-muted">
              No governed metrics could be matched to this dataset&apos;s columns. You can still use the raw columns for
              analyses.
            </div>
          ) : (
            <div className="space-y-3">
              {data.values.map((v) => {
                const metric = data.metrics.find((m) => m.id === v.metricId);
                return (
                  <div
                    key={v.metricId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{metric?.name ?? v.metricName}</p>
                      <p className="truncate text-caption text-muted">
                        {metric?.description ?? "Computed from dataset"}
                        {metric && metric.sourceColumns.length > 0 ? ` · ${metric.sourceColumns.join(", ")}` : ""}
                        {v.sampleSize > 0 ? ` · ${v.sampleSize.toLocaleString()} rows` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <ConfidenceDot confidence={v.confidence} />
                      <span className="whitespace-nowrap text-h3 text-foreground">{formatMetric(v.metricName, v)}</span>
                    </div>
                  </div>
                );
              })}

              {data.metrics.length > data.values.length && (
                <p className="text-caption text-muted">
                  {data.metrics.length - data.values.length} more governing definitions available after you add their
                  source columns.
                </p>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function ConfidenceDot({ confidence }: { confidence: number }) {
  return (
    <span
      title={`Confidence: ${(confidence * 100).toFixed(0)}% (real computation)`}
      className={cn(
        "h-2.5 w-2.5 rounded-full",
        confidence >= 0.95 ? "bg-[#58B368]" : confidence >= 0.8 ? "bg-[#3D9BE9]" : "bg-[#F08A5D]",
      )}
    />
  );
}
