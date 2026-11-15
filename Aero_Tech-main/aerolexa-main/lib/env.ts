import { z } from "zod";

import { isNextBuild } from "@/lib/build-phase";
import { isValidRsaPublicKey } from "@/lib/engine/filing/crypto";
import { CredentialMissingError } from "@/lib/engine/filing/errors";

/**
 * Typed environment access. All values are validated once at startup; a
 * misconfigured deployment fails fast with a readable message instead of
 * misbehaving at runtime. Only reference secrets through this module — never
 * read `process.env` directly in feature code.
 *
 * Prefixes: NEXT_PUBLIC_* are inlined into the client bundle (only ever
 * non-secret values), everything else is server-only.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

/** Treat an empty .env value as "unset" so the default applies. */
const optionalInt = (min: number, max: number, def: number) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(min).max(max).default(def));

/** Optional non-negative price; blank means "price not configured". */
const optionalPrice = () =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().nonnegative().optional());

const serverSchemaBase = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters — generate with: openssl rand -hex 32"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  AUTH_REQUIRE_EMAIL_VERIFY: bool(false),
  MAIL_TRANSPORT: z.enum(["console", "smtp"]).default("console"),
  MAIL_FROM: z.string().default("Ledgerly <no-reply@example.com>"),
  // SMTP transport (production email). Required only when MAIL_TRANSPORT=smtp
  // (enforced by superRefine below — a misconfigured deployment fails fast at
  // boot, never at first signup). Port 587 + STARTTLS is the common provider
  // default; set SMTP_SECURE=true for port 465 (implicit TLS).
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_SECURE: bool(false),
  /**
   * SMS transport (compliance reminders, engagement notifications).
   * `console` prints the message to the server log and reports it as NOT
   * delivered; `twilio` sends through the Twilio REST API. Selected transport
   * credentials are enforced at boot by the superRefine below.
   */
  SMS_TRANSPORT: z.enum(["console", "twilio"]).default("console"),
  TWILIO_ACCOUNT_SID: z.string().optional().default(""),
  TWILIO_AUTH_TOKEN: z.string().optional().default(""),
  /** Sender number in E.164 (e.g. +919876543210) or an alphanumeric sender ID. */
  TWILIO_FROM: z.string().optional().default(""),
  /**
   * Escape hatch for production-like-but-not-public environments (a staging
   * box, an internal demo, the zero-config `docker compose up` profile).
   *
   * When false (the default) a `NODE_ENV=production` boot REFUSES the dev
   * transports below, because each one silently exposes real users: console
   * mail prints verification/password-reset links to the server log, and
   * console OTP prints sign-in codes. `next start` and the shipped Docker
   * images all run under NODE_ENV=production, so this gate is what stops a
   * half-configured instance from going live. Set true only when you have
   * weighed the exposure.
   */
  ALLOW_INSECURE_PROD_TRANSPORTS: bool(false),
  // Phone/OTP auth (Band 3.1). With WHATSAPP_ENABLED=false (default) OTP codes
  // print to the server console (dev/test transport). Point these at a WhatsApp
  // Business Cloud API phone number + approved OTP template to deliver codes
  // over WhatsApp in production. Credentials are env-only, never in the DB.
  WHATSAPP_ENABLED: bool(false),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().optional().default(""),
  WHATSAPP_OTP_TEMPLATE: z.string().default("aerolexa_otp_login"),
  // Monetization (Band 4.2). When unset, the Razorpay rail is "not
  // configured" — checkout routes fail with a readable message and the manual
  // (offline transfer) rail remains available. Secrets are env-only.
  RAZORPAY_KEY_ID: z.string().optional().default(""),
  RAZORPAY_KEY_SECRET: z.string().optional().default(""),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(""),
  /**
   * Xero OAuth app (developer.xero.com). Instance-level client credentials;
   * each connected tenant's refresh token lives encrypted in its Connector row.
   * XERO_REDIRECT_URI must match the app's registered redirect exactly and
   * defaults to <NEXT_PUBLIC_APP_URL>/api/integrations/xero/callback.
   */
  XERO_CLIENT_ID: z.string().optional().default(""),
  XERO_CLIENT_SECRET: z.string().optional().default(""),
  XERO_REDIRECT_URI: z.string().optional().default(""),
  DATA_DIR: z.string().default("data"),
  DATASET_ANALYSIS_LIMIT: z.coerce.number().int().min(100).max(5_000_000).default(50_000),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(500 * 1024 * 1024)
    .default(100 * 1024 * 1024),
  /**
   * Hard cap on a JSON request body (bytes). JSON requests carry config and
   * parameters — never file uploads (those are multipart and bounded by
   * MAX_UPLOAD_BYTES) — so an unbounded or chunked body must not be buffered
   * into memory. readJsonBody enforces this both from Content-Length and while
   * streaming, and answers 413 when exceeded.
   */
  MAX_JSON_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(50 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  AI_MODE: z.enum(["demo"]).default("demo"),
  // Extended modules (prototype-grade feature flags)
  //
  // Product focus (see README “Product focus”): the core flow is
  // upload → profile → validated analyses → insights → reports/presentations.
  // The modules below are frozen behind flags that default to OFF; each one
  // keeps its routes, pages and tests green so it can be re-enabled with a
  // single env change. E2E/journey tests set AEROLEXA_ENABLED_MODULES=all.
  NOTEBOOK_ENABLED: bool(false),
  SQL_LAB_ENABLED: bool(false),
  TRAINING_ENABLED: bool(false), // frozen prototype trainer (real train/val/test split + held-out metrics)
  WHATIF_ENABLED: bool(false),
  CONNECTORS_ENABLED: bool(false),
  SCHEDULER_ENABLED: bool(false),
  /** Durable job-queue worker (ROADMAP 5.4): drains JobQueue with retries/backoff. */
  JOB_WORKER_ENABLED: bool(false),
  /** Notification digest (ROADMAP 7.3): email each user's unread notifications in one bundle. */
  DIGEST_ENABLED: bool(false),
  COLLABORATION_ENABLED: bool(false),
  SSO_ENABLED: bool(false),
  PROMPTS_ENABLED: bool(false),
  ADVISOR_ENABLED: bool(false),
  /** Server-side image/PDF rendering of dashboards, reports and widgets. */
  RENDERING_ENABLED: bool(false),
  /** LLM-backed features (copilot, NL→code, chart & query recommendations). */
  LLM_ENABLED: bool(false),
  // Advanced analytics modules (elite tier). Frozen by default like the rest,
  // so a cold install keeps the core flow and an operator opts in per module.
  DISTRIBUTED_ENABLED: bool(false),
  STREAMING_ENABLED: bool(false),
  DEEP_LEARNING_ENABLED: bool(false),
  NLP_ENABLED: bool(false),
  FEATURE_STORE_ENABLED: bool(false),
  REAL_TIME_SERVING_ENABLED: bool(false),
  HTE_ENABLED: bool(false),
  IV_CALCULUS_ENABLED: bool(false),
  GEOSPATIAL_ENABLED: bool(false),
  /** "all" re-enables every frozen module in one switch (used by E2E/journey tests). */
  LEDGERLY_ENABLED_MODULES: z.string().optional().default(""),
  /**
   * Pre-rename alias for LEDGERLY_ENABLED_MODULES. Deprecated but still read —
   * see resolveBrandEnv() below, which prefers the new name and warns once.
   */
  AEROLEXA_ENABLED_MODULES: z.string().optional().default(""),
  /**
   * Deployment profile — who this instance is for, in one switch:
   *   core (default) = the frozen-module status quo; pro = the full analyst
   *   toolkit (SQL Lab, notebook, connectors, scheduler, what-if, training,
   *   advisor, prompts); all = pro + SSO + collaboration.
   * An explicit LEDGERLY_ENABLED_MODULES list keeps precedence over this.
   */
  LEDGERLY_PROFILE: z.enum(["", "core", "pro", "all"]).optional().default(""),
  /** Pre-rename alias for LEDGERLY_PROFILE. Deprecated but still read. */
  AEROLEXA_PROFILE: z.enum(["", "core", "pro", "all"]).optional().default(""),
  /**
   * Pre-rename alias for DATA_DIR-tier storage settings. Deprecated but still
   * read so an existing deployment upgrades without editing its .env.
   */
  AEROLEXA_STORAGE: z.string().optional().default(""),
  /** Server-enforced gate on the notebook's Pyodide kernel (frozen with the notebook module). */
  PYODIDE_ENABLED: bool(false),
  /**
   * Real server-side Python (Pyodide wasm in a worker thread): numpy, pandas,
   * scipy, scikit-learn, statsmodels and matplotlib execute on the server with
   * no filesystem or network access from cells. Opt-in: first boot loads the
   * wasm runtime (~2.5 s warm) and downloads package wheels once.
   */
  PYODIDE_SERVER_ENABLED: bool(false),
  OIDC_ISSUER: z.string().optional().default(""),
  OIDC_CLIENT_ID: z.string().optional().default(""),
  OIDC_CLIENT_SECRET: z.string().optional().default(""),
  SAML_METADATA_URL: z.string().optional().default(""),
  // NextAuth (SSO) — Google OAuth provider. Leave NEXTAUTH_SECRET blank to
  // reuse AUTH_SECRET; NEXTAUTH_URL defaults to the request origin in dev.
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  NEXTAUTH_SECRET: z.string().optional().default(""),
  NEXTAUTH_URL: z.string().optional().default(""),
  CONNECTOR_POSTGRES_URL: z.string().optional().default(""),
  CONNECTOR_SNOWFLAKE_URL: z.string().optional().default(""),
  CONNECTOR_BIGQUERY_SERVICE_ACCOUNT: z.string().optional().default(""),
  CONNECTOR_GOOGLE_CLIENT_ID: z.string().optional().default(""),
  /** Row cap for SQL-lab results and notebook %rows. */
  DATASET_QUERY_LIMIT: z.coerce.number().int().min(100).max(1_000_000).default(5000),
  /**
   * Run SQL Lab queries on the real DuckDB engine (worker-thread + wasm).
   * When the engine cannot initialize the request fails with an explicit
   * ENGINE_UNAVAILABLE error instead of silently returning weaker results.
   * Set SQL_PROTOTYPE_FALLBACK=true to opt into the legacy deterministic
   * parser (clearly labelled as degraded) for read-only SELECTs only.
   */
  DUCKDB_ENABLED: bool(true),
  /**
   * Opt-in escape hatch: when DuckDB cannot initialize, run read-only SELECTs
   * on the deterministic prototype parser and label the result as degraded.
   * Off by default so production never silently downgrades query results.
   */
  SQL_PROTOTYPE_FALLBACK: bool(false),
  /**
   * Legacy embedding credentials. These no longer select a chat model —
   * every generation call goes through lib/ai/provider.ts (Anthropic).
   * EMBEDDING_PROVIDER=openai reads LLM_API_KEY/LLM_BASE_URL when its own
   * EMBEDDING_* variables are absent; OLLAMA_URL is the local embedding host.
   * Remove these once the embedding path has its own dedicated credentials.
   */
  LLM_API_KEY: z.string().optional().default(""),
  LLM_BASE_URL: z.string().optional().default(""),
  OLLAMA_URL: z.string().optional().default("http://localhost:11434"),
  /**
   * Anthropic (Claude) — the only chat/generation provider. Keys are
   * server-only and must never be logged or exposed to a client bundle.
   * Model IDs are configuration, never hardcoded in feature code; both are
   * required when a key is present (superRefine below enforces it).
   */
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  AI_MODEL_MAIN: z.string().optional().default(""),
  AI_MODEL_FAST: z.string().optional().default(""),
  /** Per-request timeout for Anthropic calls (ms). */
  AI_TIMEOUT_MS: optionalInt(1_000, 600_000, 60_000),
  /** Retries after the first attempt for transient failures (429/5xx/timeouts). */
  AI_MAX_RETRIES: optionalInt(0, 5, 2),
  /** Base for exponential backoff between retries (ms). */
  AI_RETRY_BASE_DELAY_MS: optionalInt(0, 10_000, 500),
  /**
   * Optional USD price per million tokens, used only to report cost. Leave
   * unset when the contracted price is unknown: costUsd is then null rather
   * than a fabricated estimate. Cache rates are separate because Anthropic
   * bills cache reads/writes differently from fresh input.
   */
  AI_COST_MAIN_INPUT_PER_MTOK: optionalPrice(),
  AI_COST_MAIN_OUTPUT_PER_MTOK: optionalPrice(),
  AI_COST_MAIN_CACHE_READ_PER_MTOK: optionalPrice(),
  AI_COST_MAIN_CACHE_WRITE_PER_MTOK: optionalPrice(),
  AI_COST_FAST_INPUT_PER_MTOK: optionalPrice(),
  AI_COST_FAST_OUTPUT_PER_MTOK: optionalPrice(),
  AI_COST_FAST_CACHE_READ_PER_MTOK: optionalPrice(),
  AI_COST_FAST_CACHE_WRITE_PER_MTOK: optionalPrice(),
  /**
   * Books assistant (Phase 2). The global flag is the operator kill switch;
   * the organization flag is the per-tenant opt-in (default OFF, fail closed).
   * Limits are enforced per run, not per model call.
   */
  ASSISTANT_ENABLED: bool(true),
  ASSISTANT_ORGANIZATION_DEFAULT_ENABLED: bool(false),
  ASSISTANT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(20).default(8),
  ASSISTANT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(50_000).default(8_000),
  ASSISTANT_MAX_WALL_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  ASSISTANT_MAX_COST_USD: z.coerce.number().nonnegative().max(100).default(0.5),
  ASSISTANT_MAX_QUESTION_CHARS: z.coerce.number().int().min(100).max(10_000).default(2_000),
  ASSISTANT_USER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(6),
  ASSISTANT_ORG_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),
  ASSISTANT_LOG_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  // Google Custom Search JSON API for the copilot's live web search.
  // Create a Programmable Search Engine (cx) at
  // https://programmablesearchengine.google.com/ and an API key at
  // https://developers.google.com/custom-search/v1/overview. When both are
  // set, the copilot searches Google directly; otherwise it falls back to a
  // free, key-less DuckDuckGo lookup so web search still works out of the box.
  GOOGLE_CSE_API_KEY: z.string().optional().default(""),
  GOOGLE_CSE_ENGINE_ID: z.string().optional().default(""),
  /** Max web results the copilot pulls and can cite. */
  SEARCH_RESULT_LIMIT: z.coerce.number().int().min(1).max(20).default(5),
  // -------------------------------------------------------------------------
  // Government-portal filing execution (docs/gst-portal-execution.md).
  // The FilingGateway layer is what actually transmits campaigns to GSTN IRP
  // (IRN generation) and income-tax e-filing. Three providers exist:
  //   reference  (default) — deterministic local IRN hash, no network, no
  //              claim of transmission. Backwards-compatible with the legacy
  //              gst-portal-integration behaviour.
  //   simulation — deterministic in-process portal simulator speaking the same
  //              response envelope as GSTN; the whole lifecycle works offline
  //              and in tests without a portal.
  //   live       — real HTTPS round-trips. Requires the credential set for the
  //              active channel below; a live deployment missing a credential
  //              FAILS FAST at boot (superRefine), never at filing time.
  // Secrets are env-only, never stored in the DB.
  FILING_GATEWAY: z.enum(["", "reference", "simulation", "live"]).optional().default(""),
  /** Which portal channel a submission targets. "irp-irn" = GSTN IRP IRN generation. */
  FILING_CHANNEL: z.enum(["", "irp-irn", "efiling-return", "efiling-audit"]).optional().default("irp-irn"),
  /**
   * IRP base host. GSTN production runs einvoice1..einvoice6.gst.gov.in (one
   * partition per taxpayer); the NIC sandbox is https://einv-apisandbox.nic.in.
   */
  FILING_IRP_BASE_URL: z.string().optional().default("https://einvoice1.gst.gov.in"),
  /** Token path for the auth handshake (v1.04 is the current NIC prefix). */
  FILING_IRP_AUTH_PATH: z.string().optional().default("/eivital/v1.04/auth"),
  /**
   * IRN-generation path. The durable mechanics (RSA/AES envelope, AuthToken,
   * once-token, response decryption) are implemented in
   * lib/engine/filing/irp.ts; a deployment confirms the current version prefix
   * against the GSTN "GSP IRP API" guide at enable time and sets it here.
   */
  FILING_IRP_ENDPOINT_PATH: z.string().optional().default("/eicore/v1.03/Invoice"),
  // GSTN IRP credentials (live irp-irn). The portal username/password are the
  // grant in the auth handshake; the client id/secret identify the API app.
  FILING_GSTIN: z.string().optional().default(""),
  FILING_IRP_CLIENT_ID: z.string().optional().default(""),
  FILING_IRP_CLIENT_SECRET: z.string().optional().default(""),
  FILING_IRP_PORTAL_USER: z.string().optional().default(""),
  FILING_IRP_PORTAL_PASSWORD: z.string().optional().default(""),
  //
  // PEM of the IRP's RSA public key. The auth envelope is encrypted to it, so
  // live irp-irn cannot build a request without it. Paste the PEM on ONE line
  // with \n escapes; it is normalised at use. (Direct taxpayer-API onboarding
  // mails this key; a GSP-mediated deployment gets it from the GSP.)
  FILING_IRP_PUBLIC_KEY: z.string().optional().default(""),
  // Optional fixed 32-byte base64 AppKey; a fresh one is minted per auth
  // round-trip when unset. Optional GSP-level signature headers are only used
  // for GSP-mediated access, never for a direct taxpayer API.
  FILING_IRP_APP_KEY: z.string().optional().default(""),
  FILING_IRP_GSP_AUTH_TOKEN: z.string().optional().default(""),
  FILING_IRP_GSP_AUTH_SIGNATURE: z.string().optional().default(""),
  // Income-tax e-filing (live efiling-return / efiling-audit). The ERI flow is
  // session-based: username/password select a password grant at the token
  // endpoint; leave them blank for a client_credentials grant.
  FILING_EFILING_TOKEN_URL: z.string().optional().default(""),
  FILING_EFILING_SUBMIT_URL: z.string().optional().default(""),
  FILING_EFILING_CLIENT_ID: z.string().optional().default(""),
  FILING_EFILING_CLIENT_SECRET: z.string().optional().default(""),
  FILING_EFILING_USERNAME: z.string().optional().default(""),
  FILING_EFILING_PASSWORD: z.string().optional().default(""),
  // ERI response field paths: comma-separated dotted paths, first present wins.
  // Override these to match the ERI registration pack without a code change
  // (e.g. FILING_EFILING_ACK_NUMBER_FIELD="response.ack.num,ackNo").
  FILING_EFILING_TOKEN_FIELD: z.string().optional().default(""),
  FILING_EFILING_ACK_NUMBER_FIELD: z.string().optional().default(""),
  FILING_EFILING_ACK_DATE_FIELD: z.string().optional().default(""),
  FILING_EFILING_STATUS_FIELD: z.string().optional().default(""),
  FILING_EFILING_ERROR_CODE_FIELD: z.string().optional().default(""),
  FILING_EFILING_ERROR_MESSAGE_FIELD: z.string().optional().default(""),
  /** Key the ITR JSON is wrapped under in the submit body; "" posts it raw. */
  FILING_EFILING_SUBMIT_BODY_KEY: z.string().optional().default("json"),
  // -------------------------------------------------------------------------
  // Remote DSC signing service (CSP bridge / eSign / HSM gateway). The app
  // never holds the DSC private key: it posts the SHA-256 digest to this URL
  // and the signing service returns a PKCS#1 v1.5 RSA/SHA-256 signature.
  // Required for live `efiling-audit`, where the return must be DSC-signed.
  // -------------------------------------------------------------------------
  FILING_SIGNING_URL: z.string().optional().default(""),
  FILING_SIGNING_TOKEN: z.string().optional().default(""),
  /** DSC user / registration number on the signing service. */
  FILING_SIGNING_USER: z.string().optional().default(""),
  /** Certificate serial (hex) the signing service should sign with. */
  FILING_SIGNING_CERT_SERIAL: z.string().optional().default(""),
  /** Public certificate (PEM) used to VERIFY detached signatures offline. */
  FILING_SIGNING_CERT_PEM: z.string().optional().default(""),
  FILING_SIGNING_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(20_000),
  /** Upper bound for a single portal round-trip; transport retries are bounded separately. */
  FILING_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(20_000),
  // Scheduled live-filing credential monitor: the scheduler tick runs the
  // credential preflight and alerts firm admins when the live handshake stops
  // working, so a revoked/rotated credential surfaces BEFORE a due date rather
  // than on one. No-op unless FILING_GATEWAY=live.
  FILING_CREDENTIAL_MONITOR_ENABLED: bool(true),
  /** Minutes between repeat alerts while the live handshake keeps failing. */
  FILING_CREDENTIAL_ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(5).max(10_080).default(360),
  /**
   * Minutes between preflight PROBES. The scheduler ticks every 60s, but a
   * portal auth round-trip every minute is needless and rate-limit bait, so the
   * monitor re-checks at most this often (independent of the alert cooldown).
   */
  FILING_CREDENTIAL_CHECK_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(10_080).default(60),
  // -------------------------------------------------------------------------
  // Workspace RAG embeddings (semantic search dense channel).
  // Unset provider (default) keeps the deterministic LSA/TF-IDF hybrid — no
  // network dependency, no data leaves the machine. "openai" = any
  // OpenAI-compatible /embeddings endpoint (vLLM, LM Studio, LiteLLM…);
  // "ollama" = the local Ollama /api/embed. EMBEDDING_MODEL is required when
  // a provider is selected (boot-time cross-field check below).
  // -------------------------------------------------------------------------
  EMBEDDING_PROVIDER: z.enum(["", "openai", "ollama"]).optional().default(""),
  EMBEDDING_MODEL: z.string().optional().default(""),
  EMBEDDING_BASE_URL: z.string().optional().default(""),
  EMBEDDING_API_KEY: z.string().optional().default(""),
  // In tests we point at a scratch DB without a .env file
  NODE_ENV: z.string().default("development"),
});

// Cross-field validation: MAIL_TRANSPORT=smtp without connection details is a
// boot-time configuration error (the repo rule: fail fast, fail readable).
// superRefine returns a NEW schema — it must be ASSIGNED, calling it as a
// statement validates nothing.
const serverSchema = serverSchemaBase.superRefine((env, ctx) => {
  // Model IDs are deployment configuration, never hardcoded. If Claude is
  // enabled, both tiers must be named explicitly so a request can never be
  // sent with an empty model string.
  if (env.ANTHROPIC_API_KEY) {
    if (!env.AI_MODEL_MAIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AI_MODEL_MAIN"],
        message: "AI_MODEL_MAIN is required when ANTHROPIC_API_KEY is set.",
      });
    }
    if (!env.AI_MODEL_FAST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AI_MODEL_FAST"],
        message: "AI_MODEL_FAST is required when ANTHROPIC_API_KEY is set.",
      });
    }
  }

  if (env.MAIL_TRANSPORT === "smtp" && !env.SMTP_HOST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SMTP_HOST"],
      message: "MAIL_TRANSPORT=smtp requires SMTP_HOST (and usually SMTP_USER/SMTP_PASS).",
    });
  }
  if (env.SMS_TRANSPORT === "twilio") {
    const required = [
      ["TWILIO_ACCOUNT_SID", env.TWILIO_ACCOUNT_SID],
      ["TWILIO_AUTH_TOKEN", env.TWILIO_AUTH_TOKEN],
      ["TWILIO_FROM", env.TWILIO_FROM],
    ] as const;
    for (const [key, value] of required) {
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `SMS_TRANSPORT=twilio requires ${key} — otherwise compliance reminders fail at the first deadline.`,
        });
      }
    }
  }
  if (env.EMBEDDING_PROVIDER !== "" && !env.EMBEDDING_MODEL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["EMBEDDING_MODEL"],
      message:
        "EMBEDDING_PROVIDER is set but EMBEDDING_MODEL is empty — name the embedding model to use (e.g. text-embedding-3-small or nomic-embed-text).",
    });
  }
  if (env.EMBEDDING_PROVIDER === "openai" && !env.EMBEDDING_API_KEY && !env.LLM_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["EMBEDDING_API_KEY"],
      message: "EMBEDDING_PROVIDER=openai requires EMBEDDING_API_KEY (or share the LLM_API_KEY).",
    });
  }
  // Production safety gates (launch readiness). `next start`, the Docker
  // images and the hosted runbook all run NODE_ENV=production, so these are the
  // last line of defence against shipping a prototype transport to real users.
  // Fail fast at boot with a readable message (repo rule) — never at first
  // signup or first login — unless the operator explicitly accepts the risk.
  //
  // `next build` runs under NODE_ENV=production too and imports every route to
  // collect page data, but a build host is not a deployment (the Docker builder
  // stage carries no production secrets at all). Serving is where these gates
  // belong, so the build phase is exempt.
  if (env.NODE_ENV === "production" && !env.ALLOW_INSECURE_PROD_TRANSPORTS && !isNextBuild()) {
    if (env.MAIL_TRANSPORT !== "smtp") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MAIL_TRANSPORT"],
        message:
          'MAIL_TRANSPORT must be "smtp" when NODE_ENV=production — the console ' +
          "transport prints email-verification and password-reset links to the " +
          "server log, which would let anyone reading the log take over accounts. " +
          "Set MAIL_TRANSPORT=smtp (and SMTP_*), or set " +
          "ALLOW_INSECURE_PROD_TRANSPORTS=true to accept the risk.",
      });
    }
    if (!env.AUTH_REQUIRE_EMAIL_VERIFY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_REQUIRE_EMAIL_VERIFY"],
        message:
          "AUTH_REQUIRE_EMAIL_VERIFY must be true when NODE_ENV=production — " +
          "otherwise anyone can register an address they do not control. Set it " +
          "true, or set ALLOW_INSECURE_PROD_TRANSPORTS=true to accept the risk.",
      });
    }
  }
  // FILING_GATEWAY=live without the full credential set for the active channel
  // is a boot-time configuration error — never submit half-configured to a
  // government portal (repo rule: fail fast, fail readable).
  if (env.FILING_GATEWAY === "live") {
    const channel = env.FILING_CHANNEL || "irp-irn";
    if (channel === "irp-irn") {
      const missing = [
        ["FILING_GSTIN", env.FILING_GSTIN],
        ["FILING_IRP_CLIENT_ID", env.FILING_IRP_CLIENT_ID],
        ["FILING_IRP_CLIENT_SECRET", env.FILING_IRP_CLIENT_SECRET],
        ["FILING_IRP_BASE_URL", env.FILING_IRP_BASE_URL],
        ["FILING_IRP_AUTH_PATH", env.FILING_IRP_AUTH_PATH],
        ["FILING_IRP_ENDPOINT_PATH", env.FILING_IRP_ENDPOINT_PATH],
        ["FILING_IRP_PUBLIC_KEY", env.FILING_IRP_PUBLIC_KEY],
        ["FILING_IRP_PORTAL_USER", env.FILING_IRP_PORTAL_USER],
        ["FILING_IRP_PORTAL_PASSWORD", env.FILING_IRP_PORTAL_PASSWORD],
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
      if (missing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["FILING_GATEWAY"],
          message: `FILING_GATEWAY=live with FILING_CHANNEL=${channel} requires ${missing.join(", ")}. Provide GSTN GSP credentials or switch to simulation/reference (see docs/gst-portal-execution.md).`,
        });
      }
      // A present-but-malformed public key is a boot-time fault: the auth
      // envelope cannot be built, so fail closed now rather than at filing time.
      if (env.FILING_IRP_PUBLIC_KEY && !isValidRsaPublicKey(env.FILING_IRP_PUBLIC_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["FILING_IRP_PUBLIC_KEY"],
          message:
            "FILING_IRP_PUBLIC_KEY is set but is not a valid RSA public key (PEM). " +
            "Paste the IRP's public key on ONE line with \\n escapes.",
        });
      }
    } else {
      const missing = [
        ["FILING_EFILING_TOKEN_URL", env.FILING_EFILING_TOKEN_URL],
        ["FILING_EFILING_SUBMIT_URL", env.FILING_EFILING_SUBMIT_URL],
        ["FILING_EFILING_CLIENT_ID", env.FILING_EFILING_CLIENT_ID],
        ["FILING_EFILING_CLIENT_SECRET", env.FILING_EFILING_CLIENT_SECRET],
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
      if (missing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["FILING_GATEWAY"],
          message: `FILING_GATEWAY=live with FILING_CHANNEL=${channel} requires ${missing.join(", ")}. Provide e-filing API credentials or switch to simulation/reference.`,
        });
      }
      // efiling-audit is the DSC-signed channel. Without a signing service the
      // gateway would send an unsigned audit return — refuse at boot instead.
      if (channel === "efiling-audit") {
        const signingMissing = [
          ["FILING_SIGNING_URL", env.FILING_SIGNING_URL],
          ["FILING_SIGNING_TOKEN", env.FILING_SIGNING_TOKEN],
          ["FILING_SIGNING_USER", env.FILING_SIGNING_USER],
          ["FILING_SIGNING_CERT_SERIAL", env.FILING_SIGNING_CERT_SERIAL],
        ]
          .filter(([, value]) => !value)
          .map(([name]) => name);
        if (signingMissing.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["FILING_SIGNING_URL"],
            message: `FILING_CHANNEL=efiling-audit requires a DSC signing service: set ${signingMissing.join(", ")} (see docs/filing-go-live-runbook.md).`,
          });
        }
      }
    }
  }
});

type ServerEnv = z.infer<typeof serverSchema>;

function loadServerEnv(): ServerEnv {
  try {
    return serverSchema.parse(process.env);
  } catch (err) {
    if (err instanceof z.ZodError) {
      // A half-configured live filing deployment fails with the filing error
      // taxonomy (readable, non-retryable CredentialMissingError) instead of
      // the generic env error — the runtime gateway path and the boot path
      // then fail identically. The message format is produced by the
      // FILING_GATEWAY superRefine above (same file), so the parse is stable.
      const filingIssue = err.issues.find((i) => i.path.includes("FILING_GATEWAY") && i.message.includes("requires"));
      if (filingIssue) {
        const channel = /FILING_CHANNEL=(\S+)/.exec(filingIssue.message)?.[1] ?? "irp-irn";
        const missing = /requires (.+?)\./.exec(filingIssue.message)?.[1]?.split(", ") ?? [];
        throw new CredentialMissingError(channel, missing, { provider: "live" });
      }
      // eslint-disable-next-line no-console
      console.error("[env] Invalid server environment configuration:");
      for (const issue of err.issues) {
        // eslint-disable-next-line no-console
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
    }
    const messages =
      err instanceof z.ZodError
        ? err.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")
        : "Unknown validation error";
    throw new Error(
      `Invalid server environment configuration.\n${messages}\nPlease check your .env file and restart the server.`,
    );
  }
}

let cached: ServerEnv | null = null;

/** Server-side env (never import from client code). */
export function serverEnv(): ServerEnv {
  if (!cached) cached = loadServerEnv();
  return cached;
}

/**
 * Renamed-but-still-honoured env vars, as (current, legacy) pairs.
 *
 * The brand rename moved every deployment-facing switch to a `LEDGERLY_*`
 * prefix. Rather than break every existing `.env` on upgrade, both spellings
 * are accepted: the current name wins, and the legacy name is a fallback that
 * warns once so the operator can retire it.
 */
const RENAMED_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  ["LEDGERLY_ENABLED_MODULES", "AEROLEXA_ENABLED_MODULES"],
  ["LEDGERLY_PROFILE", "AEROLEXA_PROFILE"],
];

/**
 * Read a renamed env var, preferring the current name.
 *
 * Returns the effective value plus whether the deprecated spelling was used,
 * so callers (and the boot warning) can act on it.
 */
export function resolveBrandEnv(currentName: string, legacyName: string): { value: string; usedLegacy: boolean } {
  const env = serverEnv() as unknown as Record<string, string | undefined>;
  const current = (env[currentName] ?? "").trim();
  if (current !== "") return { value: current, usedLegacy: false };
  const legacy = (env[legacyName] ?? "").trim();
  if (legacy !== "") return { value: legacy, usedLegacy: true };
  return { value: "", usedLegacy: false };
}

let warnedLegacyEnv = false;

/** Emit one boot-time warning listing any deprecated env vars still in use. */
export function warnLegacyEnvVars(): void {
  if (warnedLegacyEnv) return;
  warnedLegacyEnv = true;
  const stale = RENAMED_ENV_VARS.filter(([, legacy]) => {
    const env = serverEnv() as unknown as Record<string, string | undefined>;
    return (
      (env[legacy] ?? "").trim() !== "" &&
      (env[RENAMED_ENV_VARS.find(([c]) => c === legacy)?.[0] ?? ""] ?? "").trim() === ""
    );
  });
  if (stale.length === 0) return;
  for (const [current, legacy] of stale) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] ${legacy} is deprecated — rename it to ${current}. The old name still works and will be removed in a future release.`,
    );
  }
}

/**
 * Test access to the raw server schema (cross-field superRefine included).
 * lets unit tests validate env combinations without fighting the module
 * cache that makes serverEnv() boot-once.
 */
export const __serverSchemaForTests = serverSchema;

/**
 * Drop the memoized server env so the next `serverEnv()` call re-validates.
 *
 * Test-only: suites that swap `process.env` between cases (see
 * `__tests__/helpers/temp-env.ts`) need the cache cleared on the way in and
 * out, otherwise the first parse freezes the configuration for the whole file
 * and results depend on test order.
 */
export function __resetServerEnvForTests(): void {
  cached = null;
}

// Public env lives in its own client-safe module (see lib/env-public.ts for
// why: this file now pulls node:crypto via the filing primitives, and a browser
// bundle must never follow that edge). Re-exported so existing server-side
// `@/lib/env` imports keep working — CLIENT code must import
// `@/lib/env-public` directly.
import { publicEnv } from "./env-public";
export { publicEnv };
export type { PublicEnv } from "./env-public";

export const isProd = process.env.NODE_ENV === "production";
export const appUrl = () => publicEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
