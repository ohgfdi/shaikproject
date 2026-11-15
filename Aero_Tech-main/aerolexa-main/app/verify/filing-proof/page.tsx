"use client";

import { CheckCircle2, CircleAlert, CircleHelp, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/primitives";

interface ProofCheck {
  id: string;
  label: string;
  ok: boolean | null;
  detail: string;
}

interface ProofVerification {
  ok: boolean;
  checks: ProofCheck[];
  bundleDigest: string | null;
}

/**
 * Public verifier: paste a filing proof bundle (or an export envelope with a
 * `bundleDigest`) and this page recomputes the hashes. No account, no database
 * read — the evidence travels with the document.
 */
export default function VerifyFilingProofPage() {
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState<ProofVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/filing-proof/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ledgerly-verify": "1" },
        body: raw,
      });
      const data = (await response.json()) as ProofVerification & { error?: string };
      if (data.error) {
        setError(data.error);
        return;
      }
      setResult(data);
    } catch {
      setError("Could not reach the verifier. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent">
          <ShieldCheck aria-hidden className="size-5" />
        </span>
        <div>
          <h1 className="text-h2 text-foreground">Verify a filing proof</h1>
          <p className="mt-1 text-sm text-muted">
            Paste the proof bundle stored by the firm — or an export envelope{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5 text-caption">{`{ "proof": …, "bundleDigest": … }`}</code>{" "}
            — to recompute its SHA-256 digests. This checks the evidence itself; it does not query the firm&apos;s
            database.
          </p>
        </div>
      </div>

      <Card className="mt-6">
        <CardContent className="flex flex-col gap-3">
          <label htmlFor="proof" className="text-sm font-medium text-foreground">
            Proof bundle (JSON)
          </label>
          <textarea
            id="proof"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            rows={14}
            spellCheck={false}
            className="w-full rounded-md border border-border bg-surface-1 p-3 font-mono text-caption text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            placeholder='{ "proof": { "version": 1, ... }, "bundleDigest": "…" }'
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-caption text-muted">
              Verification runs in this deployment. Nothing is stored or logged from the pasted document.
            </p>
            <Button onClick={() => void verify()} disabled={busy || raw.trim().length === 0}>
              {busy ? "Verifying…" : "Verify proof"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="mt-4 border-critical/40">
          <CardContent className="flex items-start gap-2 text-sm text-critical">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className="mt-4">
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-h3 text-foreground">
                {result.ok ? (
                  <CheckCircle2 aria-hidden className="size-5 text-success" />
                ) : (
                  <CircleAlert aria-hidden className="size-5 text-critical" />
                )}
                {result.ok ? "Proof verified" : "Proof did not verify"}
              </h2>
              <span className="text-caption text-muted">{result.checks.length} checks</span>
            </div>
            <ul className="flex flex-col gap-2">
              {result.checks.map((check) => (
                <li key={check.id} className="rounded-md border border-border px-3 py-2">
                  <div className="flex items-start gap-2">
                    {check.ok === true ? (
                      <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                    ) : check.ok === false ? (
                      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
                    ) : (
                      <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{check.label}</p>
                      <p className="text-caption text-muted">{check.detail}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {result.bundleDigest && (
              <div>
                <p className="text-caption font-medium text-foreground">Recomputed bundle digest</p>
                <code className="mt-1 block break-all rounded-md bg-surface-2 p-2 font-mono text-caption text-muted">
                  {result.bundleDigest}
                </code>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
