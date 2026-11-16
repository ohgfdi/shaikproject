"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

/**
 * SSOLogin — handles user authentication and session management.
 *
 * Provides a login flow that supports:
 *   - Email/password authentication (local)
 *   - SSO providers (SAML, OIDC) via redirect
 *   - Session persistence across page refreshes
 *   - Role-based access control (redirect based on user role)
 *
 * The component communicates with `/api/auth/*` endpoints.
 *
 * After successful login, the user is redirected to their role-appropriate
 * dashboard (admin, power-user, viewer, etc.).
 *
 * Session is validated on mount via a silent token refresh pattern.
 */
export interface SSOLoginProps {
  /** Optional redirect after successful login. If not provided, uses role-based default. */
  redirectPath?: string;
  /** Callback after successful authentication. */
  onAuthSuccess?: (userRole: string) => void;
  /** Callback after logout. */
  onAuthLogout?: () => void;
}

/** User profile returned by the auth API. */
export interface UserProfile {
  /** Unique user identifier. */
  id: string;
  /** Email address. */
  email: string;
  /** Full name. */
  name: string;
  /** User role — determines dashboard layout and permissions. */
  role: "admin" | "power-user" | "viewer";
  /** JWT or session token. */
  token: string;
}

/** SSOLogin component */
export function SSOLogin({ redirectPath, onAuthSuccess, onAuthLogout }: SSOLoginProps) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // Check auth status on mount
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/session", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setUser(data.user ?? null);
        }
      } catch (e) {
        // Session invalid — user is not logged in
        setUser(null);
      } finally {
        setLoading(false);
      }
    }

    checkAuth();
  }, []);

  // Login with credentials
  const handleLogin = useCallback(async (email: string, password: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Invalid credentials");

      const data = await res.json();
      setUser(data.user ?? null);

      // Redirect based on role or provided path
      const targetPath = redirectPath ?? roleToPath(data.user?.role ?? "viewer");
      router.push(targetPath);

      onAuthSuccess?.(data.user?.role ?? "viewer");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  });

  // Logout
  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      setUser(null);
      router.push("/login");
      router.refresh();
      onAuthLogout?.();
    }
  }, [onAuthLogout, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="text-caption">Loading session…</span>
      </div>
    );
  }

  // Not logged in — show login form
  if (!user) {
    return (
      <div className="p-8 rounded-border bg-surface-1 max-w-md mx-auto">
        <h2 className="text-h3 text-foreground mb-4">Sign in</h2>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.target as HTMLFormElement);
            handleLogin(form.get("email") as string, form.get("password") as string);
          }}
        >
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-muted mb-1">Email</label>
              <input
                type="email"
                name="email"
                required
                className="w-full rounded border px-3 py-2"
                defaultValue=""
              />
            </div>
            <div>
              <label className="block text-sm text-muted mb-1">Password</label>
              <input
                type="password"
                name="password"
                required
                className="w-full rounded border px-3 py-2"
                defaultValue=""
              />
            </div>

            <button
              type="submit"
              className="w-full rounded border px-4 py-2 text-caption hover:bg-surface-2 transition-colors"
            >
              Sign in
            </button>
          </div>
        </form>

        <p className="mt-4 text-caption text-muted">
          Don't have an account? <a href="#" className="underline text-primary">Sign up</a>
        </p>
      </div>
    );
  }

  // Logged in — show role-appropriate dashboard header
  const roleToPath = (role: "admin" | "power-user" | "viewer") => {
    switch (role) {
      case "admin":
        return "/dashboard/admin";
      case "power-user":
        return "/dashboard/power";
      case "viewer":
      default:
        return "/dashboard";
    }
  };

  const dashboardPath = roleToPath(user.role);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header with user info and logout */}
      <header className="border-b border-line bg-surface/50 py-3 px-4">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-medium text-foreground">
            Ledgerly — {user.name || user.email}
          </h1>

          <div className="flex items-center gap-3">
            <span className="text-caption text-muted">{user.role.toUpperCase()} </span>

            <button
              onClick={handleLogout}
              className="rounded border px-3 py-1.5 text-caption hover:bg-surface-2 transition-colors text-sm"
              aria-label="Sign out"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Main content — role-based dashboard */}
      <main className="flex-1 p-4">
        {/* Route to role-appropriate dashboard */}
        <dashboard-route userRole={user.role} />
      </main>
    </div>
  );
}

/** Route to the correct dashboard based on user role. */
function dashboard-route({ userRole }: { userRole: "admin" | "power-user" | "viewer" }) {
  // This would normally use Next.js routing, but for this demo we render
  // a simple role-specific header. In production, each route would render
  // its own dashboard layout.
  const routes: Record<string, string> = {
    admin: "/dashboard/admin",
    power-user: "/dashboard/power",
    viewer: "/dashboard",
  };

  return (
    <section
      className="p-4"
      style={{ display: "none" }} /* Placeholder — routes rendered by Next.js */
    >
      <p className="text-caption text-muted">
        Redirecting to {routes[userRole] ?? "/dashboard"}…
      </p>
    </section>
  );
}