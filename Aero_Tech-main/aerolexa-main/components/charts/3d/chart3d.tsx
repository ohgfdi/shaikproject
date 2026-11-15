"use client";

import dynamic from "next/dynamic";
import { Component, useEffect, useState, type ReactNode } from "react";

import { supportsWebGL } from "@/lib/scene/webgl-support";
import type { ChartSpec } from "@/lib/types";

const LiveChart3D = dynamic(() => import("./live"), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

/** Kinds the 3D engine can render today. Everything else stays on the 2D engine. */
export function supports3D(spec: ChartSpec): boolean {
  return (
    spec.kind === "bar" ||
    spec.kind === "stacked-bar" ||
    spec.kind === "histogram" ||
    spec.kind === "line" ||
    spec.kind === "area" ||
    spec.kind === "scatter" ||
    spec.kind === "donut" ||
    spec.kind === "heatmap" ||
    spec.kind === "decomposition-tree" ||
    spec.kind === "key-influencers"
  );
}

interface Chart3DProps {
  spec: ChartSpec;
  height?: number;
  /** Rendered when WebGL is unavailable or the scene throws. */
  fallback?: ReactNode;
}

/**
 * Stylized 3D chart. The heavy scene is lazy-loaded (client only) so the 3D
 * runtime never inflates the shared first-load bundle; without WebGL the caller
 * gets its `fallback` (normally the 2D chart) instead.
 */
export function Chart3D({ spec, height = 300, fallback = null }: Chart3DProps) {
  const [webgl, setWebgl] = useState<boolean | null>(null);

  useEffect(() => {
    setWebgl(supportsWebGL());
  }, []);

  if (webgl === null) {
    return (
      <div style={{ height }} className="flex items-center justify-center">
        <ChartSkeleton />
      </div>
    );
  }

  if (!webgl) return <>{fallback}</>;

  return (
    <ChartErrorBoundary fallback={fallback}>
      <LiveChart3D spec={spec} height={height} />
    </ChartErrorBoundary>
  );
}

export function ChartSkeleton() {
  return (
    <div aria-hidden className="flex items-center justify-center gap-2 text-caption text-muted/50">
      <span className="size-8 animate-pulse rounded-full bg-surface-2" />
      Preparing 3D view…
    </div>
  );
}

class ChartErrorBoundary extends Component<{ fallback?: ReactNode; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    // 3D failed → silently degrade to the 2D chart rather than crash the page.
  }

  render() {
    if (this.state.failed) return <>{this.props.fallback}</>;
    return this.props.children;
  }
}
