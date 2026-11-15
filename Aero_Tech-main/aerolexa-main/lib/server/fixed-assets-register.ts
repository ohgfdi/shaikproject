/**
 * Fixed Assets & Vehicles Register — persisted assets with dual depreciation
 * (Companies Act Schedule II + Income Tax block WDV).
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { buildAssetRegister, type AssetRegisterInput } from "@/lib/engine/fixed-assets";
import { stringifyJson } from "@/lib/json";

export class FixedAssetStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "FixedAssetStoreError";
  }
}

export interface FixedAssetInput {
  assetCode: string;
  name: string;
  description?: string | null;
  cost: number;
  acquisitionDate: string;
  putToUseDate: string;
  invoiceRef?: string | null;
  bookClass: string; // Companies Act useful life class
  taxBlock: string; // Income Tax block id
  location?: string | null;
  custodian?: string | null;
  openingBookDepreciation?: number;
  disposal?: { date: string; saleProceeds: number } | null;
  eligibleAddlDepreciation?: boolean;
  addlDepreciationRate?: number | null;
  fy: string;
}

export interface VehicleInput {
  vehicleCode: string;
  registrationNumber: string;
  chassisNumber?: string | null;
  engineNumber?: string | null;
  vehicleType: string; // car | truck | two-wheeler | bus | other
  make: string;
  model: string;
  yearOfMfr?: number | null;
  ownershipType?: string; // owned | leased | hired
  lessorName?: string | null;
  leaseExpiry?: string | null;
  insuranceExpiry?: string | null;
  fitnessExpiry?: string | null;
  permitExpiry?: string | null;
  pucExpiry?: string | null;
  currentOdometer?: number | null;
  avgMonthlyKms?: number | null;
  gstInputClaimed?: boolean;
  gstInputAmount?: number;
  assetId?: string | null;
  fy: string;
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new FixedAssetStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

// ---------------------------------------------------------------------------
// Fixed Assets
// ---------------------------------------------------------------------------

export async function createFixedAsset(workspaceId: string, bookId: string, input: FixedAssetInput, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const existing = await prisma.fixedAsset.findUnique({
    where: { bookId_assetCode: { bookId, assetCode: input.assetCode } },
  });
  if (existing) throw new FixedAssetStoreError(409, "DUPLICATE", `Asset code ${input.assetCode} already exists.`);

  const asset = await prisma.fixedAsset.create({
    data: {
      bookId,
      assetCode: input.assetCode,
      name: input.name,
      description: input.description ?? null,
      cost: Math.round(input.cost),
      acquisitionDate: input.acquisitionDate,
      putToUseDate: input.putToUseDate,
      invoiceRef: input.invoiceRef ?? null,
      bookClass: input.bookClass,
      taxBlock: input.taxBlock,
      location: input.location ?? null,
      custodian: input.custodian ?? null,
      openingBookDepreciation: Math.round(input.openingBookDepreciation ?? 0),
      disposed: input.disposal ? true : false,
      disposalDate: input.disposal?.date ?? null,
      disposalProceeds: Math.round(input.disposal?.saleProceeds ?? 0),
      disposalGainLoss: 0,
      disposalTaxEffect: 0,
      eligibleAddlDepreciation: input.eligibleAddlDepreciation ?? false,
      addlDepreciationRate: input.addlDepreciationRate ?? null,
      fy: input.fy,
      status: "active",
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "FixedAsset",
      entityId: asset.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return asset;
}

export async function listFixedAssets(
  workspaceId: string,
  bookId: string,
  opts: { fy?: string; status?: string } = {},
) {
  await requireBookAccess({ workspaceId }, bookId);

  const where: Record<string, unknown> = { bookId };
  if (opts.fy) where.fy = opts.fy;
  if (opts.status) where.status = opts.status;

  return prisma.fixedAsset.findMany({
    where,
    orderBy: { assetCode: "asc" },
    include: { vehicles: true },
  });
}

export async function getFixedAsset(workspaceId: string, bookId: string, assetId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const asset = await prisma.fixedAsset.findFirst({
    where: { id: assetId, bookId },
    include: { vehicles: true },
  });
  if (!asset) throw new FixedAssetStoreError(404, "NOT_FOUND", "Fixed asset not found.");
  return asset;
}

export async function updateFixedAsset(
  workspaceId: string,
  bookId: string,
  assetId: string,
  input: Partial<FixedAssetInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.fixedAsset.findFirst({ where: { id: assetId, bookId } });
  if (!existing) throw new FixedAssetStoreError(404, "NOT_FOUND", "Fixed asset not found.");

  const updated = await prisma.fixedAsset.update({
    where: { id: assetId },
    data: {
      assetCode: input.assetCode ?? undefined,
      name: input.name ?? undefined,
      description: input.description ?? undefined,
      cost: input.cost !== undefined ? Math.round(input.cost) : undefined,
      acquisitionDate: input.acquisitionDate ?? undefined,
      putToUseDate: input.putToUseDate ?? undefined,
      invoiceRef: input.invoiceRef ?? undefined,
      bookClass: input.bookClass ?? undefined,
      taxBlock: input.taxBlock ?? undefined,
      location: input.location ?? undefined,
      custodian: input.custodian ?? undefined,
      openingBookDepreciation:
        input.openingBookDepreciation !== undefined ? Math.round(input.openingBookDepreciation) : undefined,
      disposalDate: input.disposal?.date ?? undefined,
      disposalProceeds:
        input.disposal?.saleProceeds !== undefined ? Math.round(input.disposal!.saleProceeds) : undefined,
      disposalGainLoss: input.disposal ? 0 : undefined,
      disposalTaxEffect: input.disposal ? 0 : undefined,
      eligibleAddlDepreciation: input.eligibleAddlDepreciation ?? undefined,
      addlDepreciationRate: input.addlDepreciationRate ?? undefined,
      fy: input.fy ?? undefined,
      status: input.disposal ? "disposed" : undefined,
      updatedById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "FixedAsset",
      entityId: assetId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

export async function disposeFixedAsset(
  workspaceId: string,
  bookId: string,
  assetId: string,
  disposalDate: string,
  saleProceeds: number,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const asset = await prisma.fixedAsset.findFirst({ where: { id: assetId, bookId } });
  if (!asset) throw new FixedAssetStoreError(404, "NOT_FOUND", "Fixed asset not found.");
  if (asset.disposed) throw new FixedAssetStoreError(400, "INVALID_STATE", "Asset already disposed.");

  // Compute disposal gain/loss (book)
  const bookValue = asset.cost - asset.openingBookDepreciation;
  const gainLoss = saleProceeds - bookValue;

  const updated = await prisma.fixedAsset.update({
    where: { id: assetId },
    data: {
      disposed: true,
      disposalDate,
      disposalProceeds: Math.round(saleProceeds),
      disposalGainLoss: Math.round(gainLoss),
      disposalTaxEffect: 0, // tax effect computed separately
      status: "disposed",
      updatedById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "FixedAsset",
      entityId: assetId,
      action: "dispose",
      fieldChanges: stringifyJson({ disposalDate, saleProceeds, gainLoss }),
      actorId,
    },
  });

  return updated;
}

export async function computeFixedAssetRegister(
  workspaceId: string,
  bookId: string,
  fy: string,
  opts: {
    method?: "slm" | "wdv";
    residualPct?: number;
    taxOpeningWdv?: Record<string, number>;
    additionalDepreciationPct?: number;
  } = {},
) {
  await requireBookAccess({ workspaceId }, bookId);

  const assets = await prisma.fixedAsset.findMany({ where: { bookId, fy } });
  if (assets.length === 0) throw new FixedAssetStoreError(400, "NO_ASSETS", "No assets found for this FY.");

  const input: AssetRegisterInput = {
    fy,
    assets: assets.map((a) => ({
      id: a.id,
      name: a.name,
      cost: a.cost,
      acquisitionDate: a.acquisitionDate,
      putToUseDate: a.putToUseDate,
      bookClass: a.bookClass,
      taxBlock: a.taxBlock,
      openingBookDepreciation: a.openingBookDepreciation,
      disposal: a.disposed ? { date: a.disposalDate!, saleProceeds: a.disposalProceeds } : null,
    })),
    method: opts.method ?? "slm",
    residualPct: opts.residualPct ?? 5,
    taxOpeningWdv: opts.taxOpeningWdv,
    additionalDepreciationPct: opts.additionalDepreciationPct,
  };

  return buildAssetRegister(input);
}

export async function deleteFixedAsset(workspaceId: string, bookId: string, assetId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const asset = await prisma.fixedAsset.findFirst({ where: { id: assetId, bookId } });
  if (!asset) throw new FixedAssetStoreError(404, "NOT_FOUND", "Fixed asset not found.");
  if (asset.disposalDate) throw new FixedAssetStoreError(400, "INVALID_STATE", "Cannot delete a disposed asset.");

  await prisma.fixedAsset.delete({ where: { id: assetId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "FixedAsset",
      entityId: assetId,
      action: "delete",
      actorId,
    },
  });
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export async function createVehicle(workspaceId: string, bookId: string, input: VehicleInput, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const existing = await prisma.vehicle.findUnique({
    where: { bookId_vehicleCode: { bookId, vehicleCode: input.vehicleCode } },
  });
  if (existing) throw new FixedAssetStoreError(409, "DUPLICATE", `Vehicle code ${input.vehicleCode} already exists.`);

  const existingReg = await prisma.vehicle.findUnique({
    where: { bookId_registrationNumber: { bookId, registrationNumber: input.registrationNumber } },
  });
  if (existingReg)
    throw new FixedAssetStoreError(409, "DUPLICATE", `Registration number ${input.registrationNumber} already exists.`);

  const vehicle = await prisma.vehicle.create({
    data: {
      bookId,
      assetId: input.assetId ?? null,
      vehicleCode: input.vehicleCode,
      registrationNumber: input.registrationNumber,
      chassisNumber: input.chassisNumber ?? null,
      engineNumber: input.engineNumber ?? null,
      vehicleType: input.vehicleType,
      make: input.make,
      model: input.model,
      yearOfMfr: input.yearOfMfr ?? null,
      ownershipType: input.ownershipType ?? "owned",
      lessorName: input.lessorName ?? null,
      leaseExpiry: input.leaseExpiry ?? null,
      insuranceExpiry: input.insuranceExpiry ?? null,
      fitnessExpiry: input.fitnessExpiry ?? null,
      permitExpiry: input.permitExpiry ?? null,
      pucExpiry: input.pucExpiry ?? null,
      currentOdometer: input.currentOdometer ?? null,
      avgMonthlyKms: input.avgMonthlyKms ?? null,
      gstInputClaimed: input.gstInputClaimed ?? false,
      gstInputAmount: Math.round(input.gstInputAmount ?? 0),
      fy: input.fy,
      status: "active",
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "Vehicle",
      entityId: vehicle.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return vehicle;
}

export async function listVehicles(workspaceId: string, bookId: string, opts: { fy?: string } = {}) {
  await requireBookAccess({ workspaceId }, bookId);

  const where: Record<string, unknown> = { bookId };
  if (opts.fy) where.fy = opts.fy;

  return prisma.vehicle.findMany({
    where,
    orderBy: { vehicleCode: "asc" },
    include: { asset: true },
  });
}

export async function getVehicle(workspaceId: string, bookId: string, vehicleId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, bookId },
    include: { asset: true },
  });
  if (!vehicle) throw new FixedAssetStoreError(404, "NOT_FOUND", "Vehicle not found.");
  return vehicle;
}

export async function updateVehicle(
  workspaceId: string,
  bookId: string,
  vehicleId: string,
  input: Partial<VehicleInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.vehicle.findFirst({ where: { id: vehicleId, bookId } });
  if (!existing) throw new FixedAssetStoreError(404, "NOT_FOUND", "Vehicle not found.");

  const updated = await prisma.vehicle.update({
    where: { id: vehicleId },
    data: {
      assetId: input.assetId ?? undefined,
      registrationNumber: input.registrationNumber ?? undefined,
      chassisNumber: input.chassisNumber ?? undefined,
      engineNumber: input.engineNumber ?? undefined,
      vehicleType: input.vehicleType ?? undefined,
      make: input.make ?? undefined,
      model: input.model ?? undefined,
      yearOfMfr: input.yearOfMfr ?? undefined,
      ownershipType: input.ownershipType ?? undefined,
      lessorName: input.lessorName ?? undefined,
      leaseExpiry: input.leaseExpiry ?? undefined,
      insuranceExpiry: input.insuranceExpiry ?? undefined,
      fitnessExpiry: input.fitnessExpiry ?? undefined,
      permitExpiry: input.permitExpiry ?? undefined,
      pucExpiry: input.pucExpiry ?? undefined,
      currentOdometer: input.currentOdometer ?? undefined,
      avgMonthlyKms: input.avgMonthlyKms ?? undefined,
      gstInputClaimed: input.gstInputClaimed ?? undefined,
      gstInputAmount: input.gstInputAmount !== undefined ? Math.round(input.gstInputAmount) : undefined,
      fy: input.fy ?? undefined,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "Vehicle",
      entityId: vehicleId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

export async function deleteVehicle(workspaceId: string, bookId: string, vehicleId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  await prisma.vehicle.delete({ where: { id: vehicleId, bookId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "Vehicle",
      entityId: vehicleId,
      action: "delete",
      actorId,
    },
  });
}
