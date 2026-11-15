"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/client/api";

function VerifyForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"checking" | "ok" | "error" | "idle">(token ? "checking" : "idle");
  const [message, setMessage] = useState<string | null>(null);
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!token || state !== "checking") return;
    let cancelled = false;
    api("/api/auth/verify", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => {
        if (cancelled) return;
        setState("ok");
        setTimeout(() => router.push("/onboarding"), 900);
      })
      .catch((err) => {
        if (cancelled) return;
        setState("error");
        setMessage(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token, state, router]);

  const resend = async () => {
    setMessage(null);
    try {
      await api("/api/auth/resend", { method: "POST", body: JSON.stringify({ email }) });
      setState("idle");
      setMessage("A fresh verification link is on its way. Check your inbox.");
    } catch (err) {
      setMessage(errorMessage(err));
    }
  };

  return (
    <AuthShell
      title="Verify your email"
      subtitle="One click and you're in."
      footer={
        <Link href="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      {state === "checking" && (
        <div className="flex items-center gap-3 text-sm text-muted">
          <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-line border-t-accent" />
          Verifying your email…
        </div>
      )}
      {state === "ok" && (
        <div className="rounded-md border border-success/40 bg-success/10 p-4 text-sm">
          <p className="font-medium text-foreground">Email verified ✓</p>
          <p className="mt-1 text-muted">Taking you to onboarding…</p>
        </div>
      )}
      {(state === "error" || state === "idle") && (
        <div className="flex flex-col gap-4">
          {message && <ErrorMessage title="Verification issue" message={message} className="mb-1" />}
          {state === "error" && (
            <div className="flex flex-col gap-3">
              <Input
                label="Resend to email"
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
              <Button variant="secondary" onClick={resend}>
                Resend verification link
              </Button>
              <p className="text-caption text-muted">
                No email visible? In development, verification links print to the server console.
              </p>
            </div>
          )}
        </div>
      )}
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyForm />
    </Suspense>
  );
}
