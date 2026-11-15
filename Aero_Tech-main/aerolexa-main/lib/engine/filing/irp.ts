/**
 * LIVE government-portal transports.
 *
 * GstnIrpGateway     — GSTN IRP (einvoice1..6.gst.gov.in) IRN generation, in
 *                      the IRP's real two-step handshake: a hybrid RSA + AES
 *                      token exchange, then an AES-encrypted invoice submit.
 *                      See lib/engine/filing/crypto.ts for the primitives and
 *                      docs/gst-portal-execution.md for the wire detail.
 * ItdEfilingGateway  — income-tax e-filing (ERI): a session/client token is
 *                      minted at the token endpoint, then the return JSON is
 *                      lodged with a bearer token and its acknowledgement
 *                      captured.
 *
 * Both are production-shaped and credential-gated: they talk to a REAL endpoint
 * ONLY when the deployment supplies valid credentials via serverEnv. With no
 * credentials these classes are never constructed (see gateway.ts).
 *
 * What this file commits to for real are the durable mechanics a portal
 * depends on — timeouts, bounded retries with backoff + jitter, idempotent
 * once-tokens, the IRP's RSA/AES envelope, an AuthToken cached for its 360-min
 * life, and ack/IRN capture. The exact version-prefixed paths
 * (/eivital/v1.04/auth, /eicore/v1.03/Invoice) are configurable, because the
 * IRP version a taxpayer is pinned to varies by onboarding.
 */

import { aesDecryptBase64, aesEncryptBase64, createAppKey, rsaEncryptBase64 } from "./crypto";
import { CredentialMissingError, FilingConfigError, PortalRejectionError, PortalTransportError } from "./errors";
import { canonicalJson, onceToken, sha256Hex } from "./signing";
import type {
  EfilingConnectionConfig,
  EfilingFieldMap,
  FilingChannel,
  FilingGateway,
  FilingGatewayHealth,
  FilingPreflightResult,
  FilingReceipt,
  FilingStatus,
  FilingSubmissionRequest,
  GatewayAvailability,
  IrpConnectionConfig,
  ProviderKind,
} from "./types";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/json",
};

/** The IRP AuthToken is valid for 360 minutes; refresh 10 minutes early. */
export const IRP_TOKEN_TTL_MS = 360 * 60 * 1000;
export const IRP_TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

/** Pure backoff schedule: baseMs * 2^attempt, jittered, never over maxMs. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, jitterFraction = 0.15): number {
  if (attempt <= 0) return 0;
  const exponential = baseMs * 2 ** (attempt - 1);
  const jitterRange = exponential * jitterFraction;
  const jitter = jitterRange > 0 ? Math.random() * jitterRange : 0;
  return Math.min(maxMs, exponential + jitter);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** Portal acks (AckNo) arrive as numbers; treat numbers and strings alike. */
function strOrNum(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * True when an endpoint points at a sandbox / pre-production host (no real
 * government filing). Surfaced on preflight so an operator can see at a glance
 * whether a green result was earned against the sandbox or production.
 */
export function isSandboxHost(url: string): boolean {
  return /sandbox|apisandbox|uat|preprod/i.test(url);
}

/**
 * Resolve a dotted JSON path (e.g. "response.ack.num") in a response object.
 * Numbers are stringified so portal acks (often numeric) read back uniformly;
 * a missing path yields null.
 */
export function resolvePathValue(record: Record<string, unknown> | null, path: string): string | null {
  if (!record) return null;
  let cursor: unknown = record;
  for (const part of path.split(".")) {
    const asObj = asRecord(cursor);
    if (!asObj || !(part in asObj)) return null;
    cursor = asObj[part];
  }
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" && Number.isFinite(cursor)) return String(cursor);
  return null;
}

/** First non-null value among ordered candidate paths, else null. */
function resolveField(record: Record<string, unknown> | null, candidates: readonly string[]): string | null {
  for (const path of candidates) {
    const value = resolvePathValue(record, path);
    if (value !== null) return value;
  }
  return null;
}

/** Parse a comma-separated env value into ordered field-path candidates. */
export function parseFieldCandidates(raw: string, fallback: readonly string[]): readonly string[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

/**
 * Default ERI response field paths — the tolerant superset this transport used
 * before the mapping was configurable. A deployment overrides any entry (via
 * FILING_EFILING_*_FIELD) with the exact path from its ERI registration pack.
 */
export const DEFAULT_EFILING_FIELDS: EfilingFieldMap = {
  token: ["access_token", "accessToken", "token", "data.access_token", "data.accessToken", "data.token"],
  ackNumber: ["ackNo", "ack_number", "ackNumber", "data.ackNo", "data.ack_number", "data.ackNumber"],
  ackDate: ["ackDt", "ack_date", "ackDate", "data.ackDt", "data.ack_date", "data.ackDate"],
  status: ["status", "data.status"],
  errorCode: ["error_code", "code", "data.error_code"],
  errorMessage: ["error_msg", "message", "error", "data.error_msg"],
};

interface HttpResult {
  readonly httpStatus: number;
  readonly body: Record<string, unknown> | null;
}

/**
 * Bounded HTTP transport used by both live gateways. Retries ONLY transport
 * faults (timeout/5xx/network); 4xx business rejections surface immediately as
 * PortalRejectionError. The once-token on every submission makes a retried
 * request idempotent from the portal's point of view.
 */
export class FilingTransport {
  constructor(
    private readonly options: {
      readonly timeoutMs: number;
      readonly maxAttempts: number;
      readonly baseMs: number;
      readonly fetchImpl?: FetchLike;
    },
  ) {
    if (options.timeoutMs <= 0)
      throw new FilingConfigError("timeoutMs must be positive", { provider: "live", channel: "transport" });
    if (options.maxAttempts < 1)
      throw new FilingConfigError("maxAttempts must be >= 1", { provider: "live", channel: "transport" });
  }

  private async fetchAttempt(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await (this.options.fetchImpl ?? globalThis.fetch)(input, { ...init, signal: controller.signal });
    } catch (err) {
      const aborted = controller.signal.aborted;
      throw new PortalTransportError(
        aborted
          ? `Portal timed out after ${timeoutMs}ms.`
          : `Portal unreachable (${err instanceof Error ? err.message : "network fault"}).`,
        { provider: "live", channel: "transport", httpStatus: null },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async request(
    method: "GET" | "POST",
    url: string,
    headers: Record<string, string>,
    body: unknown,
    context: { provider: string; channel: FilingChannel; token: string },
  ): Promise<HttpResult> {
    const attemptHeaders = { ...JSON_HEADERS, ...headers };
    const init: RequestInit = {
      method,
      headers: attemptHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    };

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const delay = backoffDelay(attempt - 1, this.options.baseMs, 30_000);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

      let res: Response;
      try {
        res = await this.fetchAttempt(url, init, this.options.timeoutMs);
      } catch (err) {
        const last = attempt === this.options.maxAttempts;
        const errors = err instanceof Error ? err : new Error("network fault");
        if (last) throw errors;
        continue;
      }

      const text = await res.text();
      const parsed = parseJson(text);
      if (res.ok) {
        const record = asRecord(parsed);
        return { httpStatus: res.status, body: record };
      }
      if (res.status >= 500) {
        const last = attempt === this.options.maxAttempts;
        if (last) {
          throw new PortalTransportError(`Portal returned ${res.status} after ${this.options.maxAttempts} attempts.`, {
            provider: context.provider,
            channel: context.channel,
            httpStatus: res.status,
            onceToken: context.token,
          });
        }
        continue;
      }
      // 4xx — a business rejection, never retry.
      const record = asRecord(parsed);
      const detail = record
        ? (str(record, "error_msg") ?? str(record, "message") ?? JSON.stringify(record).slice(0, 200))
        : "";
      throw new PortalRejectionError(
        `Portal rejected the ${context.channel} submission (${res.status}).${detail ? ` ${detail}` : ""}`,
        {
          provider: context.provider,
          channel: context.channel,
          httpStatus: res.status,
          onceToken: context.token,
          portalErrorCode: str(record ?? {}, "error_code") ?? str(record ?? {}, "error"),
        },
      );
    }
    throw new PortalTransportError(`Portal did not answer (${method} ${url}).`, {
      provider: context.provider,
      channel: context.channel,
      onceToken: context.token,
    });
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GSTN IRP (IRN generation) — handshake: auth → encrypted invoice submit
// ---------------------------------------------------------------------------

/**
 * The IRP wraps every response in the same envelope: a `Status` flag plus
 * either a `Data` payload or an `ErrorDetails` array
 * (`[{ ErrorCode, ErrorMessage }]`). Collapse either shape to one nullable
 * detail.
 */
function irpEnvelopeError(
  body: Record<string, unknown> | null,
): { code: string | null; message: string | null } | null {
  if (!body) return null;
  const details = body["ErrorDetails"];
  if (Array.isArray(details) && details.length > 0) {
    const first = asRecord(details[0]);
    if (first) {
      return {
        code: str(first, "ErrorCode") ?? str(first, "error_code") ?? str(first, "Error"),
        message: str(first, "ErrorMessage") ?? str(first, "error_msg") ?? str(first, "Message"),
      };
    }
  }
  const direct = str(body, "error_code") ?? str(body, "error");
  if (direct) {
    return { code: direct, message: str(body, "error_msg") ?? str(body, "message") };
  }
  const status = body["Status"];
  if (status !== undefined && String(status) === "0") {
    return { code: "IRP_STATUS_0", message: str(body, "InfoDtls") ?? "IRP returned Status 0" };
  }
  return null;
}

interface IrpAuth {
  readonly authToken: string;
  readonly sek: string;
  readonly expiresAt: number;
}

interface DecodedIrpResponse {
  readonly irn: string | null;
  readonly ackNumber: string | null;
  readonly ackDate: string | null;
  readonly status: string | null;
}

function decodeIrpData(envelope: Record<string, unknown> | null, sek: string): DecodedIrpResponse {
  const data = envelope ? str(envelope, "Data") : null;
  if (!data) return { irn: null, ackNumber: null, ackDate: null, status: null };
  let decoded: Record<string, unknown> | null = null;
  try {
    decoded = asRecord(JSON.parse(aesDecryptBase64(data, sek)));
  } catch {
    return { irn: null, ackNumber: null, ackDate: null, status: null };
  }
  if (!decoded) return { irn: null, ackNumber: null, ackDate: null, status: null };
  return {
    irn: str(decoded, "Irn") ?? str(decoded, "irn"),
    ackNumber: strOrNum(decoded, "AckNo") ?? strOrNum(decoded, "ackno"),
    ackDate: str(decoded, "AckDt") ?? str(decoded, "ackdt"),
    status: str(decoded, "Status") ?? str(decoded, "irnstatus"),
  };
}

export class GstnIrpGateway implements FilingGateway {
  readonly provider: ProviderKind = "live";
  readonly channel: FilingChannel = "irp-irn";

  /** Cached AuthToken + Sek for the life of the 360-minute token. */
  private auth: IrpAuth | null = null;

  constructor(
    private readonly config: IrpConnectionConfig,
    private readonly transport: Pick<FilingTransport, "request"> = new FilingTransport({
      timeoutMs: config.timeoutMs,
      maxAttempts: 3,
      baseMs: 1_000,
    }),
  ) {
    const required: Array<[string, string | undefined]> = [
      ["irpBaseUrl", config.irpBaseUrl],
      ["authPath", config.authPath],
      ["irpEndpointPath", config.irpEndpointPath],
      ["gstin", config.gstin],
      ["clientId", config.clientId],
      ["clientSecret", config.clientSecret],
      ["portalUser", config.portalUser],
      ["portalPassword", config.portalPassword],
      ["irpPublicKeyPem", config.irpPublicKeyPem],
    ];
    const missing = required.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new CredentialMissingError("irp-irn", missing, { provider: "live" });
    }
  }

  /** Headers every IRP call carries (identity + optional GSP-level signature). */
  private commonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      gstin: this.config.gstin.toUpperCase(),
    };
    if (this.config.gspAuthToken) headers["X-Asp-Auth-Token"] = this.config.gspAuthToken;
    if (this.config.gspAuthSignature) headers["X-Asp-Auth-Signature"] = this.config.gspAuthSignature;
    return headers;
  }

  /**
   * Obtain (or reuse) the IRP AuthToken + Sek. The AppKey is minted here, the
   * auth envelope is RSA-encrypted to the IRP public key, and the returned Sek
   * is decrypted with that AppKey — exactly the handshake in crypto.ts.
   */
  private async ensureAuth(token: string): Promise<IrpAuth> {
    if (this.auth && this.auth.expiresAt - IRP_TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.auth;
    }

    const appKey = this.config.appKey ?? createAppKey();
    const inner = Buffer.from(
      JSON.stringify({
        UserName: this.config.portalUser,
        Password: this.config.portalPassword,
        AppKey: appKey,
        ForceRefreshAccessToken: true,
      }),
      "utf8",
    ).toString("base64");
    const data = rsaEncryptBase64(inner, this.config.irpPublicKeyPem);

    const url = joinUrl(this.config.irpBaseUrl, this.config.authPath);
    const result = await this.transport.request(
      "POST",
      url,
      this.commonHeaders(),
      { Data: data },
      { provider: "live", channel: "irp-irn", token },
    );

    const error = irpEnvelopeError(result.body);
    const payload = asRecord(result.body?.["Data"]);
    if (error || !payload) {
      throw new PortalRejectionError(
        `IRP authentication failed${error?.code ? ` [${error.code}]` : ""}: ${error?.message ?? "no Data in the auth response"}`,
        {
          provider: "live",
          channel: "irp-irn",
          httpStatus: result.httpStatus,
          onceToken: token,
          portalErrorCode: error?.code ?? null,
        },
      );
    }

    const authToken = str(payload, "AuthToken");
    const sekEncrypted = str(payload, "Sek");
    if (!authToken || !sekEncrypted) {
      throw new PortalRejectionError("IRP auth response is missing AuthToken/Sek.", {
        provider: "live",
        channel: "irp-irn",
        httpStatus: result.httpStatus,
        onceToken: token,
      });
    }

    let sek: string;
    try {
      sek = aesDecryptBase64(sekEncrypted, appKey);
    } catch {
      throw new PortalRejectionError(
        "IRP returned a Sek that this AppKey could not decrypt — check that FILING_IRP_PUBLIC_KEY matches the IRP you are calling.",
        { provider: "live", channel: "irp-irn", httpStatus: result.httpStatus, onceToken: token },
      );
    }

    this.auth = { authToken, sek, expiresAt: Date.now() + IRP_TOKEN_TTL_MS };
    return this.auth;
  }

  private async submitPayload(
    request: FilingSubmissionRequest,
    context: { provider: string; channel: FilingChannel; token: string },
  ): Promise<FilingReceipt> {
    const auth = await this.ensureAuth(request.token);
    const canonical = JSON.stringify(request.payload);
    const digest = sha256Hex(canonical);
    const envelope = aesEncryptBase64(canonical, auth.sek);

    const headers: Record<string, string> = {
      ...this.commonHeaders(),
      user_name: this.config.portalUser,
      AuthToken: auth.authToken,
      "once-token": request.token,
      "correlation-id": request.token,
    };

    const url = joinUrl(this.config.irpBaseUrl, this.config.irpEndpointPath);
    const result = await this.transport.request("POST", url, headers, { Data: envelope }, context);

    const error = irpEnvelopeError(result.body);
    if (error) {
      throw new PortalRejectionError(
        `IRP rejected the submission${error.code ? ` [${error.code}]` : ""}: ${error.message ?? "see portal error"}`,
        {
          provider: "live",
          channel: "irp-irn",
          httpStatus: result.httpStatus,
          onceToken: request.token,
          portalErrorCode: error.code,
        },
      );
    }

    const decoded = decodeIrpData(result.body, auth.sek);
    const status: FilingStatus = decoded.irn ? "filed" : "error";

    return {
      provider: "live",
      channel: "irp-irn",
      status,
      token: request.token,
      reference: decoded.irn ?? decoded.ackNumber ?? request.token,
      irn: decoded.irn,
      ackNumber: decoded.ackNumber,
      ackDate: decoded.ackDate,
      portalMessage: decoded.status,
      submittedAt: new Date().toISOString(),
      digest,
      httpStatus: result.httpStatus,
    };
  }

  async submit(request: FilingSubmissionRequest): Promise<FilingReceipt> {
    if (request.channel !== "irp-irn") {
      throw new FilingConfigError(`GstnIrpGateway only serves "irp-irn" (got "${request.channel}").`, {
        provider: "live",
        channel: "irp-irn",
        onceToken: request.token,
      });
    }
    return this.submitPayload(request, { provider: "live", channel: "irp-irn", token: request.token });
  }

  /**
   * Query a prior IRN. Pass the IRN in `payload.irn` (or as the token) — the
   * IRP returns the same encrypted envelope, decrypted here with the cached
   * Sek.
   */
  async status(request: FilingSubmissionRequest): Promise<FilingReceipt> {
    const auth = await this.ensureAuth(request.token);
    const irn = (asRecord(request.payload)?.["irn"] as string | undefined) ?? request.token;
    const url = `${joinUrl(this.config.irpBaseUrl, `${this.config.irpEndpointPath}/irn`)}?irn=${encodeURIComponent(irn)}`;
    const result = await this.transport.request(
      "GET",
      url,
      { ...this.commonHeaders(), user_name: this.config.portalUser, AuthToken: auth.authToken },
      undefined,
      {
        provider: "live",
        channel: "irp-irn",
        token: request.token,
      },
    );
    const error = irpEnvelopeError(result.body);
    const decoded = decodeIrpData(result.body, auth.sek);
    const status: FilingStatus = error ? "rejected" : decoded.irn ? "filed" : "accepted-pending";
    return {
      provider: "live",
      channel: "irp-irn",
      status,
      token: request.token,
      reference: decoded.irn ?? irn,
      irn: decoded.irn,
      ackNumber: decoded.ackNumber,
      ackDate: decoded.ackDate,
      portalMessage: error?.message ?? decoded.status,
      submittedAt: new Date().toISOString(),
      digest: "",
      httpStatus: result.httpStatus,
    };
  }

  /**
   * Run the auth handshake ONLY — no invoice is filed. This is the safe way to
   * prove a deployment's IRP credentials and public key work before the first
   * live return; a failure here is a credential/config fault, not a filing.
   */
  async preflight(): Promise<FilingPreflightResult> {
    const sandbox = isSandboxHost(this.config.irpBaseUrl);
    try {
      await this.ensureAuth(onceToken());
      return {
        provider: "live",
        channel: "irp-irn",
        ok: true,
        detail: `IRP auth handshake succeeded — client_id authenticated for GSTIN ${this.config.gstin.toUpperCase()} and an AuthToken + Sek were issued (valid ~360 min). No document was filed.`,
        sandbox,
        httpStatus: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        provider: "live",
        channel: "irp-irn",
        ok: false,
        detail: err instanceof Error ? err.message : "IRP auth handshake failed.",
        sandbox,
        httpStatus: err instanceof PortalRejectionError ? (err.details.httpStatus ?? null) : null,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  health(): FilingGatewayHealth | null {
    const availability: GatewayAvailability = { configured: true, provider: "live", missing: [] };
    return {
      provider: "live",
      channels: {
        "irp-irn": availability,
        "efiling-return": { configured: false, provider: "n/a", missing: ["efiling credentials"] },
        "efiling-audit": { configured: false, provider: "n/a", missing: ["efiling credentials"] },
      },
      liveEligible: true,
      activeChannel: "irp-irn",
    };
  }
}

// ---------------------------------------------------------------------------
// Income-tax e-filing (ERI)
// ---------------------------------------------------------------------------

interface EfilingEnvelope {
  readonly ackNumber: string | null;
  readonly ackDate: string | null;
  readonly status: string | null;
  readonly errorCode: string | null;
  readonly errorMsg: string | null;
}

function parseEfilingEnvelope(body: Record<string, unknown> | null, fields: EfilingFieldMap): EfilingEnvelope {
  return {
    ackNumber: resolveField(body, fields.ackNumber),
    ackDate: resolveField(body, fields.ackDate),
    status: resolveField(body, fields.status),
    errorCode: resolveField(body, fields.errorCode),
    errorMsg: resolveField(body, fields.errorMessage),
  };
}

function efilingAccessToken(body: Record<string, unknown> | null, fields: EfilingFieldMap): string | null {
  return resolveField(body, fields.token);
}

export class ItdEfilingGateway implements FilingGateway {
  readonly provider: ProviderKind = "live";
  private readonly fields: EfilingFieldMap;

  constructor(
    private readonly config: EfilingConnectionConfig,
    private readonly transport: Pick<FilingTransport, "request"> = new FilingTransport({
      timeoutMs: config.timeoutMs,
      maxAttempts: 3,
      baseMs: 1_000,
    }),
  ) {
    this.fields = config.fields ?? DEFAULT_EFILING_FIELDS;
    const missing = (
      [
        ["tokenUrl", config.tokenUrl],
        ["submitUrl", config.submitUrl],
        ["clientId", config.clientId],
        ["clientSecret", config.clientSecret],
      ] as Array<[string, string]>
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) throw new CredentialMissingError("efiling", missing, { provider: "live" });
  }

  /**
   * Mint a bearer token. The ERI flow is session-based, so when a username +
   * password are supplied the token request uses a password grant; otherwise
   * it falls back to client_credentials.
   */
  private async accessToken(token: string): Promise<string> {
    const body = this.config.username
      ? {
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          username: this.config.username,
          password: this.config.password,
          grant_type: "password",
        }
      : {
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: "client_credentials",
        };
    const result = await this.transport.request("POST", this.config.tokenUrl, {}, body, {
      provider: "live",
      channel: "efiling-return",
      token,
    });
    const access = efilingAccessToken(result.body, this.fields);
    if (!access) {
      throw new PortalRejectionError("e-filing token endpoint returned no access token.", {
        provider: "live",
        channel: "efiling-return",
        httpStatus: result.httpStatus,
        onceToken: token,
      });
    }
    return access;
  }

  private async submitPayload(
    request: FilingSubmissionRequest,
    context: { provider: string; channel: FilingChannel; token: string },
  ): Promise<FilingReceipt> {
    const bearer = await this.accessToken(request.token);
    // Canonicalise exactly the way the proof bundle does, so the receipt's
    // digest and the locally recomputed payload digest are the same value.
    const canonical = canonicalJson(request.payload);
    const digest = sha256Hex(canonical);
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearer}`,
      "once-token": request.token,
      "correlation-id": request.token,
      ...(request.ay ? { "assessment-year": request.ay } : {}),
      ...(request.signature
        ? {
            "x-dsc-signature": request.signature.signatureBase64,
            "x-dsc-certificate-serial": request.signature.certificateSerial,
            "x-dsc-signed-at": request.signature.signedAt,
            "x-dsc-digest": request.signature.digest,
          }
        : {}),
    };
    // `undefined` (not configured) defaults to the documented "json" wrapper;
    // an explicit "" posts the payload raw.
    const submitKey = this.config.submitBodyKey ?? "json";
    const base = submitKey ? { [submitKey]: request.payload } : request.payload;
    // efiling-audit carries the detached DSC envelope alongside the return.
    // The ERI registration pack defines where the portal expects it; the
    // generic `dsc` block + headers are the documented adapter contract.
    const submitBody =
      request.signature && base && typeof base === "object" && !Array.isArray(base)
        ? { ...(base as Record<string, unknown>), dsc: request.signature }
        : base;
    const result = await this.transport.request("POST", this.config.submitUrl, headers, submitBody, context);
    const env = parseEfilingEnvelope(result.body, this.fields);

    if (env.errorCode && !env.ackNumber) {
      throw new PortalRejectionError(
        `e-filing rejected the submission${env.errorCode ? ` [${env.errorCode}]` : ""}: ${env.errorMsg ?? "see portal error"}`,
        {
          provider: "live",
          channel: context.channel,
          httpStatus: result.httpStatus,
          onceToken: request.token,
          portalErrorCode: env.errorCode,
        },
      );
    }

    const status: FilingStatus = env.ackNumber ? "filed" : env.errorCode ? "rejected" : "accepted-pending";
    return {
      provider: "live",
      channel: context.channel,
      status,
      token: request.token,
      reference: env.ackNumber ?? request.token,
      irn: null,
      ackNumber: env.ackNumber,
      ackDate: env.ackDate,
      portalMessage: env.status ?? env.errorMsg,
      submittedAt: new Date().toISOString(),
      digest,
      httpStatus: result.httpStatus,
    };
  }

  async submit(request: FilingSubmissionRequest): Promise<FilingReceipt> {
    if (request.channel !== "efiling-return" && request.channel !== "efiling-audit") {
      throw new FilingConfigError(`ItdEfilingGateway serves efiling channels only (got "${request.channel}").`, {
        provider: "live",
        channel: "efiling-return",
        onceToken: request.token,
      });
    }
    return this.submitPayload(request, { provider: "live", channel: request.channel, token: request.token });
  }

  /**
   * Exchange the ERI credentials for a bearer token ONLY — no return is lodged.
   * Confirms the configured token endpoint and client credentials work before
   * the first live ITD filing.
   */
  async preflight(): Promise<FilingPreflightResult> {
    const sandbox = isSandboxHost(this.config.tokenUrl) || isSandboxHost(this.config.submitUrl);
    try {
      await this.accessToken(onceToken());
      return {
        provider: "live",
        channel: "efiling-return",
        ok: true,
        detail: "e-filing token endpoint issued an access token. No return was lodged.",
        sandbox,
        httpStatus: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        provider: "live",
        channel: "efiling-return",
        ok: false,
        detail: err instanceof Error ? err.message : "e-filing token exchange failed.",
        sandbox,
        httpStatus: err instanceof PortalRejectionError ? (err.details.httpStatus ?? null) : null,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  health(): FilingGatewayHealth | null {
    const availability: GatewayAvailability = { configured: true, provider: "live", missing: [] };
    return {
      provider: "live",
      channels: {
        "irp-irn": { configured: false, provider: "n/a", missing: ["irp credentials"] },
        "efiling-return": availability,
        "efiling-audit": availability,
      },
      liveEligible: true,
      activeChannel: "efiling-return",
    };
  }
}
