"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

/**
 * SSOLogin — handles user authentication and session management.
 *
 * Provides a login flow that supports:
 *   - Email/password authentication (local)
 *   - SSO providers (SAML, OIDC) via redirect
 *     - Google (OIDC)
 *     - Azure AD (OIDC)
 *     - Generic OIDC provider
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

/** OAuth2 login parameters for SSO providers. */
export interface SSOLoginParams {
  /** The provider name (google, azure, oidc). */
  provider: "google" | "azure" | "oidc";
  /** The URL to redirect to after authentication. */
  redirectUri?: string;
  /** Optional state parameter for CSRF protection. */
  state?: string;
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

  // Login with credentials (email/password)
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

  // SSO login with provider
  const handleSSOLogin = useCallback(async (params: SSOLoginParams) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/auth/login/${params.provider}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        redirect: "follow",
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message ?? "SSO login failed");
      }

      // Provider will redirect the user's browser; we just initiate it
      onAuthSuccess?.(params.provider !== "azure" ? "power-user" : "admin");
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
            handleLogin(
              form.get("email") as string,
              form.get("password") as string
            );
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

        {/* SSO Provider Buttons */}
        <div className="mt-4 space-y-2">
          {/* Google SSO */}
          <button
            onClick={() => handleSSOLogin({ provider: "google" })}
            className="w-full rounded border px-4 py-2 text-caption hover:bg-surface-2 transition-colors flex items-center gap-2"
            aria-label="Sign in with Google"
          >
            <svg
              className="size-5"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M22.177 11.377c-.397.397-1.037.397-1.434 0L12 14.032 5.605 7.637a.997.997 0 0 0-1.433 0C3.157 8.262 2.512 9.817 2.017 11.258l4.267 4.268a.998.998 0 0 0 1.433 0c.536-1.532.068-3.026-1.12-3.958m6.871-7.784a7.027 7.027 0 1 0-2.144-4.066 7.028 7.028 0 0 0 2.144 4.066zM12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z" />
            </svg>
            Google
          </button>

          {/* Azure AD SSO */}
          <button
            onClick={() => handleSSOLogin({ provider: "azure" })}
            className="w-full rounded border px-4 py-2 text-caption hover:bg-surface-2 transition-colors flex items-center gap-2"
            aria-label="Sign in with Azure AD"
          >
            <svg
              className="size-5"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M19.72 5.78a3.5 3.5 0 0 0-2.58-.88l-2.13 3.08a3.5 3.5 0 0 0 0 3.35l2.13 3.08c.36.52.06 1.01-.46 1.35a4.002 4.002 0 0 1-2.95.76H7.53a4.002 4.002 0 0 1-2.95-.76c-.5-.33-.77-.83-.46-1.35l2.13-3.08a3.5 3.5 0 0 0 0-3.35l-2.13-3.08zM12 17.26a5.25 5.25 0 1 1 0-10.5 5.25 5.25 0 0 1 0 10.5zm-1.75-6.75a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM12 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12z" />
            </svg>
            Azure AD
          </button>

          {/* Generic OIDC */}
          <button
            onClick={() => handleSSOLogin({ provider: "oidc" })}
            className="w-full rounded border px-4 py-2 text-caption hover:bg-surface-2 transition-colors flex items-center gap-2"
            aria-label="Sign in with OIDC"
          >
            <svg
              className="size-5"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 13c-3.87 0-7 3.13-7 7 0 3.87 3.13 7 7 7 3.87 0 7-3.13 7-7 0-3.87-3.13-7-7-7z" />
              <path d="M17 18l-1.42-2.83M7 21l-1.42-2.83M3 12l1.42 2.83M7 3v9m3-3v9m5.66-3.34a2.5 2.5 0 1 1 1.79 4.24l-.71.71a2.5 2.5 0 0 1-3.54 0l-.71-.71a2.5 2.5 0 0 1 0-3.54l.71-.71a2.5 2.5 0 0 1 3.54 0z" />
            </svg>
            OIDC
          </button>
        </div>

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