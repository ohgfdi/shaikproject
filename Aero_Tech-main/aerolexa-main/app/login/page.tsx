import { Suspense } from "react";

import { featureFlags } from "@/lib/server/features";

import { LoginForm } from "./login-form";

export default function LoginPage() {
  // SSO is env-configured; only surface the Google button when the provider is
  // actually wired (SSO_ENABLED + GOOGLE_CLIENT_ID/SECRET).
  const ssoEnabled = featureFlags({ isAdmin: false }).ssoProvider === "Google";
  return (
    <Suspense>
      <LoginForm ssoEnabled={ssoEnabled} />
    </Suspense>
  );
}
