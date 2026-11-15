import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import {
  createGstInvoice,
  listGstInvoices,
  getGstInvoice,
  updateGstInvoice,
  deleteGstInvoice,
  matchGstInvoiceTo2a2b,
  unmatchGstInvoice,
  computeGstr1Summary,
  computeIctReconciliation,
  reconcileGstRegisterWithLedger,
  type GstInvoiceInput,
} from "@/lib/server/gst-invoices";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    if (action === "gstr1") {
      const period = url.searchParams.get("period");
      if (!period) return toErrorResponse(new Error("period is required"));
      const result = await computeGstr1Summary(ctx.workspace.id, { bookId: params.id, period });
      return ok({ summary: result });
    }

    if (action === "ict-reconciliation") {
      const period = url.searchParams.get("period");
      const openingIct = Number(url.searchParams.get("openingIct") ?? "0");
      const availableIct2A2B = Number(url.searchParams.get("availableIct2A2B") ?? "0");
      const reverseCharge = Number(url.searchParams.get("reverseCharge") ?? "0");
      if (!period) return toErrorResponse(new Error("period is required"));
      const result = await computeIctReconciliation(ctx.workspace.id, {
        bookId: params.id,
        period,
        openingIct,
        availableIct2A2B,
        reverseCharge,
      });
      return ok({ reconciliation: result });
    }

    if (action === "ledger-reconciliation") {
      const period = url.searchParams.get("period");
      if (!period) return toErrorResponse(new Error("period is required"));
      const result = await reconcileGstRegisterWithLedger(ctx.workspace.id, params.id, period);
      return ok({ reconciliation: result });
    }

    const invoiceId = url.searchParams.get("invoiceId");
    if (invoiceId) {
      const invoice = await getGstInvoice(ctx.workspace.id, params.id, invoiceId);
      return ok({ invoice });
    }

    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    const period = url.searchParams.get("period") ?? undefined;
    const invoiceType = url.searchParams.get("invoiceType") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const matched2a2b =
      url.searchParams.get("matched2a2b") === "true"
        ? true
        : url.searchParams.get("matched2a2b") === "false"
          ? false
          : undefined;
    const supplierGstin = url.searchParams.get("supplierGstin") ?? undefined;
    const recipientGstin = url.searchParams.get("recipientGstin") ?? undefined;
    const itcEligibility = url.searchParams.get("itcEligibility") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const offset = Number(url.searchParams.get("offset") ?? "0");

    const { invoices, total } = await listGstInvoices(ctx.workspace.id, params.id, {
      from,
      to,
      period,
      invoiceType,
      status,
      matched2a2b,
      supplierGstin,
      recipientGstin,
      itcEligibility,
      limit,
      offset,
    });

    return ok({ invoices, total, limit, offset });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    enforceUserRateLimit(ctx.user.id, "books_write", RATE_LIMITS.books_write);
    const body = await readJsonBody<
      GstInvoiceInput & { action?: string; invoiceId?: string; gstr2aRef?: string; reason?: string }
    >(request);
    const action = body.action;

    if (action === "match-2a2b") {
      const invoiceId = body.invoiceId;
      const gstr2aRef = body.gstr2aRef;
      if (!invoiceId || !gstr2aRef) return toErrorResponse(new Error("invoiceId and gstr2aRef required"));
      const result = await matchGstInvoiceTo2a2b(ctx.workspace.id, params.id, invoiceId!, gstr2aRef!, ctx.user.id);
      return ok({ invoice: result });
    }

    if (action === "unmatch") {
      const invoiceId = body.invoiceId;
      const reason = body.reason;
      if (!invoiceId || !reason) return toErrorResponse(new Error("invoiceId and reason required"));
      const result = await unmatchGstInvoice(ctx.workspace.id, params.id, invoiceId!, reason!, ctx.user.id);
      return ok({ invoice: result });
    }

    // Create invoice
    const { action: _action, invoiceId: _invoiceId, gstr2aRef: _gstr2aRef, reason: _reason, ...input } = body;
    const invoice = await createGstInvoice(ctx.workspace.id, params.id, input, ctx.user.id);
    return ok({ invoice }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    enforceUserRateLimit(ctx.user.id, "books_write", RATE_LIMITS.books_write);
    const url = new URL(request.url);
    const invoiceId = url.searchParams.get("invoiceId");
    if (!invoiceId) return toErrorResponse(new Error("invoiceId required"));

    const body = await readJsonBody<Record<string, unknown>>(request);
    const invoice = await updateGstInvoice(ctx.workspace.id, params.id, invoiceId, body, ctx.user.id);
    return ok({ invoice });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    enforceUserRateLimit(ctx.user.id, "books_write", RATE_LIMITS.books_write);
    const url = new URL(request.url);
    const invoiceId = url.searchParams.get("invoiceId");
    if (!invoiceId) return toErrorResponse(new Error("invoiceId required"));

    await deleteGstInvoice(ctx.workspace.id, params.id, invoiceId, ctx.user.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
