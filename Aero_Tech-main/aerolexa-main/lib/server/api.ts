import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/lib/auth/guard";
import { AnalysisInputError } from "@/lib/engine/analyses";
import { AuditAssuranceError } from "@/lib/engine/ca-audit-assurance";
import { DocumentError } from "@/lib/engine/ca-documents";
import { EntityComplianceError } from "@/lib/engine/ca-entity-compliance";
import { InternalAuditError } from "@/lib/engine/ca-internal-audit";
import { LitigationError } from "@/lib/engine/ca-litigation";
import { PayrollOperationsError } from "@/lib/engine/ca-payroll-operations";
import { PracticeManagementError } from "@/lib/engine/ca-practice-management";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import {
  FilingConfigError,
  FilingGatewayError,
  PortalRejectionError,
  PortalTransportError,
} from "@/lib/engine/filing/errors";
import { ItrUError } from "@/lib/engine/itr-u";
import { TimesheetError } from "@/lib/engine/practice-timesheets";
import { SqlError } from "@/lib/engine/sql";
import { WhatIfError } from "@/lib/engine/whatif";
import { serverEnv } from "@/lib/env";
import { ParseError } from "@/lib/file/parse";

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  headers.set("X-Request-ID", crypto.randomUUID());
  return NextResponse.json({ ok: true, data }, { headers, status: init?.status });
}

export function fail(status: number, code: string, message: string, details?: unknown): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message, details } }, { status });
}

/** Map any thrown error to a user-friendly JSON error response. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    const res = fail(err.status, err.code, err.message, err.details);
    if (err.headers) {
      for (const [key, value] of Object.entries(err.headers)) res.headers.set(key, value);
    }
    return res;
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return fail(400, "VALIDATION", first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.");
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Translate database constraints into client-actionable responses instead
    // of leaking a 500. P2002 = unique violation (duplicate record),
    // P2025 = record not found, P2003 = foreign-key restriction.
    if (err.code === "P2002") {
      const target = (err.meta as { target?: unknown } | undefined)?.target;
      const field = Array.isArray(target) ? target.join(", ") : typeof target === "string" ? target : "record";
      return fail(409, "CONFLICT", `A record with the same ${field} already exists.`);
    }
    if (err.code === "P2025") {
      return fail(404, "NOT_FOUND", "The requested record no longer exists.");
    }
    if (err.code === "P2003") {
      return fail(409, "CONFLICT", "This record is still referenced by other data and cannot be changed.");
    }
  }
  if (err instanceof ParseError) {
    return fail(400, "FILE_INVALID", err.message);
  }
  if (err instanceof AnalysisInputError) {
    return fail(400, "ANALYSIS_INPUT", err.message);
  }
  if (err instanceof AuditAssuranceError) {
    // A workflow input the engine refuses (e.g. non-positive tolerable
    // misstatement) is a caller error, not a server fault.
    return fail(400, "AUDIT_ASSURANCE_INPUT", err.message);
  }
  if (err instanceof EntityComplianceError) {
    // A corporate-compliance input the engine refuses (e.g. filing a blocked
    // task, or an unknown form) is a caller error, not a server fault.
    return fail(400, "ENTITY_COMPLIANCE_INPUT", err.message);
  }
  if (err instanceof PayrollOperationsError) {
    // A payroll input the engine refuses (e.g. negative leave balance) is a
    // caller error, not a server fault.
    return fail(400, "PAYROLL_OPERATIONS_INPUT", err.message);
  }
  if (err instanceof PracticeManagementError) {
    // A practice-management input the engine refuses (e.g. a deadline
    // dependency cycle, unknown client mapping, or a workpaper cross-reference
    // to a missing number) is a caller error, not a server fault.
    return fail(400, "PRACTICE_MANAGEMENT_INPUT", err.message);
  }
  if (err instanceof InternalAuditError) {
    // An internal/concurrent/stock audit input the engine refuses (a duplicate
    // COSO component, or a negative book value/counted value/limit) is a caller
    // error, not a server fault.
    return fail(400, "INTERNAL_AUDIT_INPUT", err.message);
  }
  if (err instanceof LitigationError) {
    // A litigation input the engine refuses (negative tax effect, no grounds,
    // a malformed date) is a caller error.
    return fail(400, "LITIGATION_INPUT", err.message);
  }
  if (err instanceof TimesheetError) {
    // Bad hours, rates, dates or a discount that is not a percentage.
    return fail(400, "TIMESHEET_INPUT", err.message);
  }
  if (err instanceof DocumentError) {
    // A document register input the engine refuses (bad date, negative period).
    return fail(400, "DOCUMENT_INPUT", err.message);
  }
  if (err instanceof ItrUError) {
    // An updated-return input the engine refuses (bad AY label, negative money).
    return fail(400, "ITR_U_INPUT", err.message);
  }
  if (err instanceof SqlError) {
    return fail(400, "SQL_INPUT", err.message);
  }
  if (err instanceof WhatIfError) {
    return fail(400, "WHATIF_INPUT", err.message);
  }
  if (err instanceof ConnectorError) {
    // Clean "What happened / How to fix" payloads with the right status.
    return fail(err.status, err.code, err.message);
  }
  if (err instanceof FilingConfigError || (err instanceof FilingGatewayError && err.kind === "credential")) {
    // Deployment fault — readable, never retryable, signal the operator.
    return fail(503, "FILING_NOT_CONFIGURED", err.message, err.details);
  }
  if (err instanceof PortalTransportError) {
    return fail(502, "PORTAL_UNREACHABLE", err.message, err.details);
  }
  if (err instanceof PortalRejectionError) {
    return fail(422, err.details.portalErrorCode ?? "PORTAL_REJECTED", err.message, err.details);
  }
  if (err instanceof Error) {
    // Never leak stack traces or internals to the client.
    return fail(500, "INTERNAL", "An unexpected error occurred. Please try again.");
  }
  return fail(500, "INTERNAL", "An unexpected error occurred. Please try again.");
}

/**
 * Read and parse a JSON request body, refusing bodies larger than
 * MAX_JSON_BODY_BYTES.
 *
 * Two layers, because Content-Length alone is not trustworthy (it can be
 * absent on chunked requests or understate the stream): a declared length over
 * the cap is rejected up front, and the stream is counted as it is read so a
 * lying/absent header cannot make the server buffer an unbounded payload.
 */
export async function readJsonBody<T>(request: Request): Promise<T> {
  const max = serverEnv().MAX_JSON_BODY_BYTES;

  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", `The request body exceeds the ${max}-byte limit.`);
  }

  let raw: string;
  try {
    raw = await readCappedText(request, max);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "BAD_JSON", "The request body was not valid JSON.");
  }
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(400, "BAD_JSON", "The request body was not valid JSON.");
  }
}

/** Stream a request body into a string, aborting past `maxBytes` (413). */
async function readCappedText(request: Request, maxBytes: number): Promise<string> {
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", `The request body exceeds the ${maxBytes}-byte limit.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
  return text;
}

/**
 * defineRoute - composes auth → rate limit → Zod body/query → error mapping → request id → audit
 *
 * High-risk routes should use this wrapper instead of writing the full middleware stack inline.
 *
 * Example:
 *  ```ts
 *  export const GET = defineRoute(auth, rateLimit('api_general'), async (ctx) => {
 *    return ctx.json({ bookCount: await prisma.book.count() })
 *  })
 *  ```
 */
export function defineRoute(
  handler: (ctx: { params: { bookId?: string }; query: unknown; body: unknown }) => Promise<NextResponse>,
): (req: Request) => Promise<NextResponse> {
  return async (req: Request) => {
    const url = new URL(req.url);
    const params: Record<string, string> = {};
    if (url.pathname.includes("[id]")) {
      const match = url.pathname.match(new RegExp(/^\/([^/]+)\/id\/([^/]+)/));
      if (match && match[1] !== undefined && match[2] !== undefined) {
        params[match[1]] = match[2];
      }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const body = await readFormData(req);
    const requestId = crypto.randomUUID();

    try {
      const result = await handler({ params, query, body });
      return ok(result, { headers: { "X-Request-ID": requestId } });
    } catch (err) {
      const response = toErrorResponse(err);
      response.headers.set("X-Request-ID", requestId);
      return response;
    }
  };
}

/** Parse multipart form data with a size-safe reader. */
export async function readFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new ApiError(400, "BAD_FORM", "Could not read the multipart form data.");
  }
}
