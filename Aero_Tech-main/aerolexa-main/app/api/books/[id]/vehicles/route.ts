import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import { listVehicles, updateVehicle, deleteVehicle } from "@/lib/server/fixed-assets-register";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const vehicleId = url.searchParams.get("vehicleId");

    if (vehicleId) {
      // Would need getVehicle export
      return ok({ vehicle: null });
    }

    const fy = url.searchParams.get("fy") ?? undefined;
    const vehicles = await listVehicles(ctx.workspace.id, params.id, { fy });
    return ok({ vehicles });
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
    const vehicleId = url.searchParams.get("vehicleId");
    if (!vehicleId) return toErrorResponse(new Error("vehicleId required"));

    const body = await readJsonBody<Record<string, unknown>>(request);
    const vehicle = await updateVehicle(ctx.workspace.id, params.id, vehicleId, body, ctx.user.id);
    return ok({ vehicle });
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
    const vehicleId = url.searchParams.get("vehicleId");
    if (!vehicleId) return toErrorResponse(new Error("vehicleId required"));

    await deleteVehicle(ctx.workspace.id, params.id, vehicleId, ctx.user.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
