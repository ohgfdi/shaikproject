"use client";

import { Check, Copy, Link2, Loader2, Share2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Publish & share control for dashboards / reports / presentations.
 *
 * Toggling to "public" reveals a read-only link at /apps/<shareToken>
 * (no login required). "workspace" keeps the artifact private to the
 * workspace. The public link is only created after an OWNER opts in.
 */
export function PublishButton({
  kind,
  artifactId,
  initialAccessMode = "workspace",
  initialShareToken,
  initialPublishedAt,
}: {
  kind: string;
  artifactId: string;
  initialAccessMode?: string;
  initialShareToken?: string | null;
  initialPublishedAt?: string | null;
}) {
  const [accessMode, setAccessMode] = useState(initialAccessMode);
  const [shareToken, setShareToken] = useState<string | null>(initialShareToken ?? null);
  const [publishedAt, setPublishedAt] = useState<string | null>(initialPublishedAt ?? null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPublic = accessMode === "public";

  const shareUrl = useMemo(() => {
    if (!isPublic || !shareToken) return null;
    const base = window.location.origin;
    return `${base}/apps/${shareToken}?type=${kind}`;
  }, [isPublic, shareToken, kind]);

  async function togglePublic() {
    setBusy(true);
    setError(null);
    try {
      const next = isPublic ? "workspace" : "public";
      const res = await fetch(`/api/${kind}s/${artifactId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessMode: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? "Only the project owner can publish. Publishing failed.");
        setBusy(false);
        return;
      }
      const data = (await res.json()) as {
        accessMode: string;
        shareToken: string | null;
        shareUrl: string | null;
      };
      setAccessMode(data.accessMode);
      setShareToken(data.shareToken);
      setPublishedAt(data.shareToken ? new Date().toISOString() : null);
    } catch {
      setError("Publishing failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy the link.");
    }
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button onClick={togglePublic} disabled={busy} variant="secondary" size="sm">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Share2 className="size-4" />}
          {isPublic ? "Make workspace-only" : "Publish link"}
        </Button>
        {isPublic && shareUrl && (
          <Button onClick={copyLink} variant="secondary" size="sm">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        )}
      </div>

      {isPublic && shareUrl && (
        <span className="flex items-center gap-1 text-caption text-muted">
          <Link2 className="size-3" />
          Anyone with this link can view the published snapshot. Published{" "}
          {publishedAt ? new Date(publishedAt).toLocaleDateString() : "recently"}.
        </span>
      )}

      {error && <span className="text-caption text-danger">{error}</span>}
    </div>
  );
}
