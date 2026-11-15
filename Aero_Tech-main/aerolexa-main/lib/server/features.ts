/**
 * Feature-flag + integration-status helper (server-only).
 *
 * Ledgerly is fully functional as a deterministic prototype without any
 * external service. These flags describe which optional live integrations are
 * configured through the environment — the UI renders "Prototype / Demo"
 * badges and honest "configure to connect" states from them. Secrets are never
 * exposed: only booleans and labels cross to the client.
 *
 * When user.isAdmin === true, all features are enabled regardless of
 * environment or module flags. This allows admins full access to premium
 * features and tools.
 */

import { publicEnv, serverEnv } from "@/lib/env";
import { moduleEnabled } from "@/lib/server/modules";
import { CONNECTOR_DEFS, type FeatureFlags } from "@/lib/types";

export function featureFlags(user?: { isAdmin?: boolean }): FeatureFlags {
  const env = serverEnv();
  // If the user is an admin, all features are enabled.
  // This bypasses all environment-based feature flags and module flags.
  const isAdmin = user?.isAdmin === true;
  // SAML is a REAL provider now: a SAML_METADATA_URL means the /authorize +
  // /acs routes work end-to-end (not just a status label).
  const ssoProvider = env.SSO_ENABLED
    ? env.OIDC_ISSUER
      ? "OIDC"
      : env.SAML_METADATA_URL
        ? "SAML"
        : env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? "Google"
          : "oidc-or-saml"
    : null;
  /** SAML is configured and its authorize/ACS routes are live. */
  const samlReady = Boolean(env.SSO_ENABLED && env.SAML_METADATA_URL);

  return {
    // The kernel URL is public (safe for the client); the feature flag is
    // server-enforced so ops decide whether to enable the Pyodide attempt.
    pyodideUrl: isAdmin
      ? publicEnv.NEXT_PUBLIC_PYODIDE_URL
      : env.PYODIDE_ENABLED
        ? publicEnv.NEXT_PUBLIC_PYODIDE_URL
        : "",
    // Every frozen-module switch below goes through moduleEnabled() so the UI
    // and the API agree. These three used to read raw env, which meant
    // LEDGERLY_PROFILE=pro unfroze /notebooks but left /models and
    // /scheduled-reports hidden — a profile that did not apply uniformly.
    // When admin, skip the module check and enable everything.
    schedulerEnabled: isAdmin || moduleEnabled("SCHEDULER_ENABLED"),
    trainingEnabled: isAdmin || moduleEnabled("TRAINING_ENABLED"),
    collaborationEnabled: isAdmin || moduleEnabled("COLLABORATION_ENABLED"),
    // SSO stays a configuration gate, not just a module flag: it also decides
    // which provider label the sign-in screen shows.
    ssoEnabled: env.SSO_ENABLED,
    ssoProvider,
    /** SAML is configured end-to-end (authorize + ACS routes active). */
    samlEnabled: samlReady,
    // Frozen-module switches drive nav visibility (app-shell) and gated surfaces.
    // When admin, enable all extended features.
    notebookEnabled: isAdmin || moduleEnabled("NOTEBOOK_ENABLED"),
    sqlLabEnabled: isAdmin || moduleEnabled("SQL_LAB_ENABLED"),
    whatifEnabled: isAdmin || moduleEnabled("WHATIF_ENABLED"),
    advisorEnabled: isAdmin || moduleEnabled("ADVISOR_ENABLED"),
    promptsEnabled: isAdmin || moduleEnabled("PROMPTS_ENABLED"),
    connectorsEnabled: isAdmin || moduleEnabled("CONNECTORS_ENABLED"),
    // Server-side image/PDF rendering — gated the same way as the rest so a
    // /api/render/* 503 can never disagree with the button that calls it.
    renderingEnabled: isAdmin || moduleEnabled("RENDERING_ENABLED"),
    llmEnabled: isAdmin || moduleEnabled("LLM_ENABLED"),
    connectors: CONNECTOR_DEFS.map((def) => ({
      ...def,
      configured: connectorConfigured(def.id, env),
    })),
  };
}

function connectorConfigured(id: string, env: ReturnType<typeof serverEnv>): boolean {
  switch (id) {
    case "postgres":
      return env.CONNECTOR_POSTGRES_URL !== "";
    case "snowflake":
      return env.CONNECTOR_SNOWFLAKE_URL !== "";
    case "bigquery":
      return env.CONNECTOR_BIGQUERY_SERVICE_ACCOUNT !== "";
    case "sheets":
      return env.CONNECTOR_GOOGLE_CLIENT_ID !== "";
    case "rest":
      return false; // credentials are provided per import, never stored
    default:
      return false;
  }
}
