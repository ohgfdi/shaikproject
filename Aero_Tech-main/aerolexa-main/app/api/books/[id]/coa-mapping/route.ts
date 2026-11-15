import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import type { CoaMappingInput } from "@/lib/server/coa-mapping";
import {
  createCoaMapping,
  listCoaMappings,
  getCoaMapping,
  updateCoaMapping,
  deleteCoaMapping,
  bulkCreateCoaMappings,
  transformVoucherFromExternal,
  exportChartOfAccountsToExternal,
} from "@/lib/server/coa-mapping";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const mappingId = url.searchParams.get("mappingId");

    if (action === "transform") {
      const externalSoftware = url.searchParams.get("externalSoftware");
      const voucher = url.searchParams.get("voucher");
      if (!externalSoftware || !voucher) return toErrorResponse(new Error("externalSoftware and voucher required"));
      const parsed = JSON.parse(voucher);
      const result = await transformVoucherFromExternal(ctx.workspace.id, params.id, externalSoftware, parsed);
      return ok({ result });
    }

    if (action === "export") {
      const externalSoftware = url.searchParams.get("externalSoftware");
      if (!externalSoftware) return toErrorResponse(new Error("externalSoftware required"));
      const result = await exportChartOfAccountsToExternal(ctx.workspace.id, params.id, externalSoftware);
      return ok({ result });
    }

    if (mappingId) {
      const mapping = await getCoaMapping(ctx.workspace.id, params.id, mappingId);
      return ok({ mapping });
    }

    const externalSoftware = url.searchParams.get("externalSoftware") ?? undefined;
    const activeOnly = url.searchParams.get("active") !== "false";

    const mappings = await listCoaMappings(ctx.workspace.id, params.id, { externalSoftware, active: activeOnly });
    return ok({ mappings });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const action = body.action;

    if (action === "bulk") {
      const mappings = body.mappings as import("@/lib/server/coa-mapping").CoaMappingInput[];
      if (!mappings || !Array.isArray(mappings)) return toErrorResponse(new Error("mappings array required"));
      const result = await bulkCreateCoaMappings(ctx.workspace.id, params.id, mappings, ctx.user.id);
      return ok({ result }, { status: 201 });
    }

    if (action === "transform") {
      const externalSoftware = body.externalSoftware as string;
      const voucher = body.voucher as Parameters<typeof transformVoucherFromExternal>[3];
      if (!externalSoftware || !voucher) return toErrorResponse(new Error("externalSoftware and voucher required"));
      const result = await transformVoucherFromExternal(ctx.workspace.id, params.id, externalSoftware, voucher);
      return ok({ result });
    }

    const { action: _, ...input } = body;
    const mapping = await createCoaMapping(
      ctx.workspace.id,
      params.id,
      input as unknown as CoaMappingInput,
      ctx.user.id,
    );
    return ok({ mapping }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const mappingId = url.searchParams.get("mappingId");
    if (!mappingId) return toErrorResponse(new Error("mappingId required"));

    const body = await readJsonBody<Record<string, unknown>>(request);
    const mapping = await updateCoaMapping(
      ctx.workspace.id,
      params.id,
      mappingId,
      body as Partial<CoaMappingInput>,
      ctx.user.id,
    );
    return ok({ mapping });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const mappingId = url.searchParams.get("mappingId");
    if (!mappingId) return toErrorResponse(new Error("mappingId required"));

    await deleteCoaMapping(ctx.workspace.id, params.id, mappingId, ctx.user.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
