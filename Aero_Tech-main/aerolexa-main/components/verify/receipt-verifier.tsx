"use client";

import { useState } from "react";

import { Badge, Card, CardContent } from "@/components/ui/primitives";

interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface Result {
  verification: { ok: boolean; checks: Check[]; digest: string | null };
  signatureVerified: boolean | null;
  signatureNote: string;
}

export function ReceiptVerifier() {
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/verify/approval-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      const data = (await response.json()) as Result & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "The receipt could not be read.");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The receipt could not be verified.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <label htmlFor="receipt-json" className="block text-sm font-medium text-foreground">
            Paste the approval receipt JSON
          </label>
          <textarea
            id="receipt-json"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            rows={12}
            spellCheck={false}
            placeholder={'{ "version": 3, "run": { … }, "approval": { … }, "digest": "…" }'}
            className="w-full rounded-md border border-line bg-surface-2 p-3 font-mono text-caption text-foreground outline-none focus:ring-2 focus:ring-accent/40"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void verify()}
              disabled={busy || raw.trim() === ""}
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify receipt"}
            </button>
            <span className="text-caption text-muted">
              Nothing is stored. Verification recomputes the digest locally on the server.
            </span>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={result.verification.ok ? "success" : "critical"}>
                {result.verification.ok ? "Receipt verified" : "Receipt failed verification"}
              </Badge>
              {result.verification.digest && (
                <code className="break-all text-caption text-muted">SHA-256 {result.verification.digest}</code>
              )}
            </div>

            <ul className="space-y-2">
              {result.verification.checks.map((check) => (
                <li key={check.id} className="flex gap-2 text-sm">
                  <Badge variant={check.ok ? "success" : "critical"}>{check.ok ? "pass" : "fail"}</Badge>
                  <span className="min-w-0">
                    <span className="block text-foreground">{check.label}</span>
                    <span className="block text-caption text-muted">{check.detail}</span>
                  </span>
                </li>
              ))}
            </ul>

            <p className="text-caption text-muted">{result.signatureNote}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
