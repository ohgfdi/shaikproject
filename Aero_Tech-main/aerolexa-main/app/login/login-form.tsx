"use client";

import { KeyRound, Smartphone } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useState } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";

type Mode = "password" | "phone";

export function LoginForm({ ssoEnabled }: { ssoEnabled: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>("password");

  // Password sign-in state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);

  // Second factor: password success returns a short-lived challenge, not a session.
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);

  // Phone/OTP sign-in state (Band 3.1)
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  const next = params.get("next");
  const destination = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setUnverified(false);
    setLoading(true);
    try {
      const result = await api<{ mfaRequired?: boolean; challenge?: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (result.mfaRequired && result.challenge) {
        setMfaChallenge(result.challenge);
        setMfaCode("");
        setMfaError(null);
        return;
      }
      router.push(destination);
      router.refresh();
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "EMAIL_UNVERIFIED") {
        setUnverified(true);
      }
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const verifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaChallenge) return;
    setMfaError(null);
    setMfaLoading(true);
    try {
      await api("/api/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ challenge: mfaChallenge, code: mfaCode }),
      });
      router.push(destination);
      router.refresh();
    } catch (err) {
      setMfaError(errorMessage(err));
    } finally {
      setMfaLoading(false);
    }
  };

  const requestOtp = async () => {
    setOtpError(null);
    setOtpLoading(true);
    try {
      await api("/api/auth/phone/request", { method: "POST", body: JSON.stringify({ phone }) });
      setOtpSent(true);
    } catch (err) {
      setOtpError(errorMessage(err));
    } finally {
      setOtpLoading(false);
    }
  };

  const verifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setOtpError(null);
    setOtpLoading(true);
    try {
      await api("/api/auth/phone/verify", { method: "POST", body: JSON.stringify({ phone, code: otp }) });
      router.push(destination);
      router.refresh();
    } catch (err) {
      setOtpError(errorMessage(err));
    } finally {
      setOtpLoading(false);
    }
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your analytics workspace."
      footer={
        <>
          New to Ledgerly?{" "}
          <Link href="/signup" className="font-medium text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      {/* Sign-in method switch — password stays the default; OTP is one tab away. */}
      <div
        className="mb-4 grid grid-cols-2 gap-1 rounded-md border border-line bg-surface p-1"
        role="tablist"
        aria-label="Sign-in method"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "password"}
          onClick={() => {
            setMode("password");
            setOtpError(null);
          }}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm font-medium transition-colors",
            mode === "password" ? "bg-accent/10 text-foreground" : "text-muted hover:text-foreground",
          )}
        >
          <KeyRound aria-hidden className="size-4" />
          Password
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "phone"}
          onClick={() => {
            setMode("phone");
            setError(null);
          }}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm font-medium transition-colors",
            mode === "phone" ? "bg-accent/10 text-foreground" : "text-muted hover:text-foreground",
          )}
        >
          <Smartphone aria-hidden className="size-4" />
          Phone OTP
        </button>
      </div>

      {mode === "password" ? (
        mfaChallenge ? (
          <>
            {mfaError && <ErrorMessage title="Two-factor verification" message={mfaError} className="mb-4" />}
            <form onSubmit={verifyMfa} className="flex flex-col gap-4" noValidate>
              <p className="text-sm text-muted">
                Enter the 6-digit code from your authenticator app. You can also use one of your saved recovery
                codes.
              </p>
              <Input
                label="Authentication code"
                id="mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.trim())}
                placeholder="123456 or xxxx-xxxx"
                autoFocus
              />
              <Button type="submit" loading={mfaLoading} className="w-full">
                Verify &amp; sign in
              </Button>
              <button
                type="button"
                onClick={() => {
                  setMfaChallenge(null);
                  setMfaCode("");
                  setMfaError(null);
                  setPassword("");
                }}
                className="text-caption text-accent hover:underline"
              >
                Use a different account
              </button>
            </form>
          </>
        ) : (
        <>
          {error && <ErrorMessage title="Unable to sign in" message={error} className="mb-4" />}
          {unverified && (
            <ErrorMessage
              title="Email not verified"
              message="Check your inbox for the verification link."
              howToFix="We can resend it on the verification page — or ask for a new link below."
              className="mb-4"
            />
          )}
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <Input
              label="Email"
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
            <Input
              label="Password"
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
            <div className="flex justify-end">
              <Link href="/forgot-password" className="text-caption text-accent hover:underline">
                Forgot password?
              </Link>
            </div>
            <Button type="submit" loading={loading} className="w-full">
              Sign in
            </Button>
          </form>
        </>
        )
      ) : (
        <>
          {otpError && <ErrorMessage title="Phone sign-in" message={otpError} className="mb-4" />}
          {!otpSent ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void requestOtp();
              }}
              className="flex flex-col gap-4"
              noValidate
            >
              <Input
                label="Mobile number"
                id="phone"
                type="tel"
                autoComplete="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 98765 43210"
                helper="Indian mobile numbers. We text a 6-digit code — valid for 5 minutes."
              />
              <Button type="submit" loading={otpLoading} className="w-full">
                Send code
              </Button>
            </form>
          ) : (
            <form onSubmit={verifyOtp} className="flex flex-col gap-4" noValidate>
              <p className="text-sm text-muted">
                Code sent to <span className="font-medium text-foreground">{phone}</span>
              </p>
              <Input
                label="6-digit code"
                id="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="••••••"
              />
              <Button type="submit" loading={otpLoading} className="w-full">
                Verify &amp; sign in
              </Button>
              <button
                type="button"
                onClick={() => {
                  setOtpSent(false);
                  setOtp("");
                }}
                className="text-caption text-accent hover:underline"
              >
                Use a different number
              </button>
            </form>
          )}
        </>
      )}

      {ssoEnabled && (
        <>
          <div className="my-4 flex items-center gap-3 text-caption text-muted" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            loading={ssoLoading}
            onClick={() => {
              setSsoLoading(true);
              void signIn("google", { callbackUrl: destination });
            }}
          >
            Continue with Google
          </Button>
        </>
      )}
    </AuthShell>
  );
}
