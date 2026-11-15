"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/client/api";

// Client-side preflight, kept in lock-step with the server contract
// (app/api/auth/signup/route.ts). Same inputs → same decision, so the user
// never sees a poster-server 400 that the browser could catch for free; the
// server remains the authority for what the client can't know (taken emails,
// rate limits).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type FieldErrors = Partial<Record<"name" | "email" | "password", string>>;

function preflight(form: { name: string; email: string; password: string }): FieldErrors {
  const problems: FieldErrors = {};
  if (form.name.trim().length < 2) problems.name = "At least 2 characters.";
  if (!EMAIL_RE.test(form.email.trim())) problems.email = "Enter a valid email address.";
  if (form.password.length < 8 || !(/[A-Za-z]/.test(form.password) && /[0-9]/.test(form.password)))
    problems.password = "8+ characters with a letter and a number.";
  return problems;
}

function clearOnEdit(fieldErrors: FieldErrors, key: keyof FieldErrors): FieldErrors {
  if (!fieldErrors[key]) return fieldErrors;
  const { [key]: _drop, ...rest } = fieldErrors;
  return rest;
}

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<"name" | "email" | "password", string>>>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const problems = preflight(form);
    setFieldErrors(problems);

    if (Object.keys(problems).length > 0) return;

    setLoading(true);
    try {
      const { user } = await api<{ user: { email: string; name: string } }>("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify(form),
      });
      if (user) {
        router.push("/onboarding");
      } else {
        router.push("/verify-email");
      }
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Create your workspace"
      subtitle="Go from raw data to boardroom decisions — in minutes."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {error && <ErrorMessage title="Could not create your account" message={error} className="mb-4" />}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Input
          label="Full name"
          id="name"
          autoComplete="name"
          required
          value={form.name}
          error={fieldErrors.name}
          onChange={(e) => {
            setForm((f) => ({ ...f, name: e.target.value }));
            setFieldErrors((fe) => clearOnEdit(fe, "name"));
          }}
          placeholder="Alex Rivera"
        />
        <Input
          label="Work email"
          id="email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          error={fieldErrors.email}
          onChange={(e) => {
            setForm((f) => ({ ...f, email: e.target.value }));
            setFieldErrors((fe) => clearOnEdit(fe, "email"));
          }}
          placeholder="you@company.com"
        />
        <Input
          label="Password"
          id="password"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          error={fieldErrors.password}
          onChange={(e) => {
            setForm((f) => ({ ...f, password: e.target.value }));
            setFieldErrors((fe) => clearOnEdit(fe, "password"));
          }}
          helper="At least 8 characters with a letter and a number."
        />
        <Button type="submit" loading={loading} className="w-full">
          Create account
        </Button>
        <p className="text-caption text-muted">
          By continuing you agree your uploaded data stays private to your workspace. No hard-coded credentials — ever.
        </p>
      </form>
    </AuthShell>
  );
}
