import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import type { FixedAssetInput, VehicleInput } from "@/lib/server/fixed-assets-register";
import {
  createFixedAsset,
  listFixedAssets,
  getFixedAsset,
  updateFixedAsset,
  disposeFixedAsset,
  computeFixedAssetRegister,
  deleteFixedAsset,
  createVehicle,
  listVehicles,
  getVehicle,
  updateVehicle,
  deleteVehicle,
} from "@/lib/server/fixed-assets-register";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const assetId = url.searchParams.get("assetId");
    const vehicleId = url.searchParams.get("vehicleId");

    if (action === "compute-register") {
      const fy = url.searchParams.get("fy");
      const method = (url.searchParams.get("method") ?? "slm") as "slm" | "wdv";
      const residualPct = Number(url.searchParams.get("residualPct") ?? "5");
      if (!fy) return toErrorResponse(new Error("fy required"));
      const result = await computeFixedAssetRegister(ctx.workspace.id, params.id, fy, { method, residualPct });
      return ok({ result });
    }

    if (assetId) {
      const asset = await getFixedAsset(ctx.workspace.id, params.id, assetId);
      return ok({ asset });
    }

    if (vehicleId) {
      const vehicle = await getVehicle(ctx.workspace.id, params.id, vehicleId);
      return ok({ vehicle });
    }

    const isVehicle = url.searchParams.get("type") === "vehicle";
    const fy = url.searchParams.get("fy") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;

    if (isVehicle) {
      const vehicles = await listVehicles(ctx.workspace.id, params.id, { fy });
      return ok({ vehicles });
    }

    const assets = await listFixedAssets(ctx.workspace.id, params.id, { fy, status });
    return ok({ assets });
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
    const type = body.type;

    if (action === "dispose") {
      const assetId = body.assetId as string;
      const disposalDate = body.disposalDate as string;
      const saleProceeds = body.saleProceeds as number;
      if (!assetId || !disposalDate || saleProceeds === undefined) {
        return toErrorResponse(new Error("assetId, disposalDate, saleProceeds required"));
      }
      const result = await disposeFixedAsset(
        ctx.workspace.id,
        params.id,
        assetId,
        disposalDate,
        saleProceeds,
        ctx.user.id,
      );
      return ok({ asset: result });
    }

    const isVehicle = type === "vehicle";
    const {
      action: _action,
      type: _type,
      assetId: _assetId,
      vehicleId: _vehicleId,
      disposalDate: _disposalDate,
      saleProceeds: _saleProceeds,
      ...input
    } = body;

    if (isVehicle) {
      const vehicle = await createVehicle(ctx.workspace.id, params.id, input as unknown as VehicleInput, ctx.user.id);
      return ok({ vehicle }, { status: 201 });
    }

    const asset = await createFixedAsset(ctx.workspace.id, params.id, input as unknown as FixedAssetInput, ctx.user.id);
    return ok({ asset }, { status: 201 });
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
    const assetId = url.searchParams.get("assetId");
    const vehicleId = url.searchParams.get("vehicleId");

    const body = await readJsonBody<Record<string, unknown>>(request);

    if (assetId) {
      const asset = await updateFixedAsset(
        ctx.workspace.id,
        params.id,
        assetId,
        body as Partial<FixedAssetInput>,
        ctx.user.id,
      );
      return ok({ asset });
    }

    if (vehicleId) {
      const vehicle = await updateVehicle(
        ctx.workspace.id,
        params.id,
        vehicleId,
        body as Partial<VehicleInput>,
        ctx.user.id,
      );
      return ok({ vehicle });
    }

    return toErrorResponse(new Error("assetId or vehicleId required"));
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
    const assetId = url.searchParams.get("assetId");
    const vehicleId = url.searchParams.get("vehicleId");

    if (assetId) {
      await deleteFixedAsset(ctx.workspace.id, params.id, assetId, ctx.user.id);
      return ok({ deleted: true });
    }

    if (vehicleId) {
      await deleteVehicle(ctx.workspace.id, params.id, vehicleId, ctx.user.id);
      return ok({ deleted: true });
    }

    return toErrorResponse(new Error("assetId or vehicleId required"));
  } catch (err) {
    return toErrorResponse(err);
  }
}
