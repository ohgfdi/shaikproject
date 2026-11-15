/**
 * Inventory Register — item master + stock movements with valuation.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";

export class InventoryStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "InventoryStoreError";
  }
}

export interface InventoryItemInput {
  itemCode: string;
  name: string;
  description?: string | null;
  hsnCode?: string | null;
  unit?: string; // PCS | MTR | KG | LTR | BOX | SET
  gstRate?: number;
  cessRate?: number;
  itcEligible?: boolean;
  openingQty?: number;
  openingValue?: number;
  openingDate?: string | null;
  reorderLevel?: number | null;
  maxLevel?: number | null;
  leadTimeDays?: number | null;
  valuationMethod?: string; // fifo | wavg | lifo | specific
  active?: boolean;
}

export interface InventoryMovementInput {
  itemId: string;
  date: string;
  movementType: string; // purchase | sale | return | adjustment | transfer-in | transfer-out | manufacture | consumption
  qty: number; // signed: positive = in, negative = out
  rate: number; // minor units per unit
  narration?: string | null;
  reference?: string | null;
  batchNumber?: string | null;
  expiryDate?: string | null;
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new InventoryStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

// ---------------------------------------------------------------------------
// Inventory Items
// ---------------------------------------------------------------------------

export async function createInventoryItem(
  workspaceId: string,
  bookId: string,
  input: InventoryItemInput,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  const existing = await prisma.inventoryItem.findUnique({
    where: { bookId_itemCode: { bookId, itemCode: input.itemCode } },
  });
  if (existing) throw new InventoryStoreError(409, "DUPLICATE", `Item code ${input.itemCode} already exists.`);

  const item = await prisma.inventoryItem.create({
    data: {
      bookId,
      itemCode: input.itemCode,
      name: input.name,
      description: input.description ?? null,
      hsnCode: input.hsnCode ?? null,
      unit: input.unit ?? "PCS",
      gstRate: input.gstRate ?? 18,
      cessRate: input.cessRate ?? 0,
      itcEligible: input.itcEligible ?? true,
      openingQty: input.openingQty ?? 0,
      openingValue: Math.round(input.openingValue ?? 0),
      openingDate: input.openingDate ?? null,
      reorderLevel: input.reorderLevel ?? null,
      maxLevel: input.maxLevel ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      valuationMethod: input.valuationMethod ?? "fifo",
      active: true,
      createdById: actorId,
    },
  });

  // If opening stock provided, create opening movement
  if (input.openingQty && input.openingQty !== 0) {
    await prisma.inventoryMovement.create({
      data: {
        bookId,
        itemId: item.id,
        date: input.openingDate ?? new Date().toISOString().slice(0, 10),
        movementType: "adjustment",
        qty: input.openingQty,
        rate: input.openingQty !== 0 ? Math.round((input.openingValue ?? 0) / input.openingQty) : 0,
        amount: Math.round(input.openingValue ?? 0),
        narration: "Opening stock",
        reference: "OPENING",
        createdById: actorId,
      },
    });
  }

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "InventoryItem",
      entityId: item.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return item;
}

export async function listInventoryItems(workspaceId: string, bookId: string, opts: { active?: boolean } = {}) {
  await requireBookAccess({ workspaceId }, bookId);

  return prisma.inventoryItem.findMany({
    where: { bookId, ...(opts.active !== undefined ? { active: opts.active } : {}) },
    orderBy: { itemCode: "asc" },
  });
}

export async function getInventoryItem(workspaceId: string, bookId: string, itemId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const item = await prisma.inventoryItem.findFirst({ where: { id: itemId, bookId } });
  if (!item) throw new InventoryStoreError(404, "NOT_FOUND", "Inventory item not found.");
  return item;
}

export async function updateInventoryItem(
  workspaceId: string,
  bookId: string,
  itemId: string,
  input: Partial<InventoryItemInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.inventoryItem.findFirst({ where: { id: itemId, bookId } });
  if (!existing) throw new InventoryStoreError(404, "NOT_FOUND", "Inventory item not found.");

  const updated = await prisma.inventoryItem.update({
    where: { id: itemId },
    data: {
      itemCode: input.itemCode ?? undefined,
      name: input.name ?? undefined,
      description: input.description ?? undefined,
      hsnCode: input.hsnCode ?? undefined,
      unit: input.unit ?? undefined,
      gstRate: input.gstRate ?? undefined,
      cessRate: input.cessRate ?? undefined,
      itcEligible: input.itcEligible ?? undefined,
      reorderLevel: input.reorderLevel ?? undefined,
      maxLevel: input.maxLevel ?? undefined,
      leadTimeDays: input.leadTimeDays ?? undefined,
      valuationMethod: input.valuationMethod ?? undefined,
      active: input.active ?? undefined,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "InventoryItem",
      entityId: itemId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

export async function deleteInventoryItem(workspaceId: string, bookId: string, itemId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  await prisma.inventoryItem.delete({ where: { id: itemId, bookId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "InventoryItem",
      entityId: itemId,
      action: "delete",
      actorId,
    },
  });
}

// ---------------------------------------------------------------------------
// Inventory Movements
// ---------------------------------------------------------------------------

export async function createInventoryMovement(
  workspaceId: string,
  bookId: string,
  input: InventoryMovementInput,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  const item = await prisma.inventoryItem.findFirst({ where: { id: input.itemId, bookId } });
  if (!item) throw new InventoryStoreError(404, "NOT_FOUND", "Inventory item not found.");

  const amount = input.qty * input.rate;

  const movement = await prisma.inventoryMovement.create({
    data: {
      bookId,
      itemId: input.itemId,
      date: input.date,
      movementType: input.movementType,
      qty: input.qty,
      rate: Math.round(input.rate),
      amount: Math.round(amount),
      narration: input.narration ?? null,
      reference: input.reference ?? null,
      batchNumber: input.batchNumber ?? null,
      expiryDate: input.expiryDate ?? null,
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "InventoryMovement",
      entityId: movement.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return movement;
}

export async function listInventoryMovements(
  workspaceId: string,
  bookId: string,
  opts: { itemId?: string; movementType?: string; from?: string; to?: string; limit?: number; offset?: number } = {},
) {
  await requireBookAccess({ workspaceId }, bookId);

  const where: Record<string, unknown> = { bookId };
  if (opts.itemId) where.itemId = opts.itemId;
  if (opts.movementType) where.movementType = opts.movementType;
  if (opts.from || opts.to) {
    where.date = {};
    if (opts.from) (where.date as Record<string, string>).gte = opts.from;
    if (opts.to) (where.date as Record<string, string>).lte = opts.to;
  }

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [movements, total] = await Promise.all([
    prisma.inventoryMovement.findMany({
      where,
      orderBy: { date: "desc" },
      take: limit,
      skip: offset,
      include: { item: true },
    }),
    prisma.inventoryMovement.count({ where }),
  ]);

  return { movements, total, limit, offset };
}

export async function getStockSummary(workspaceId: string, bookId: string, asOfDate?: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const items = await prisma.inventoryItem.findMany({ where: { bookId, active: true } });

  const where: Record<string, unknown> = { bookId };
  if (asOfDate) where.date = { lte: asOfDate };

  const movements = await prisma.inventoryMovement.findMany({
    where,
    orderBy: { date: "asc" },
  });

  // Compute stock per item using FIFO (simplified)
  const stockMap = new Map<string, { qty: number; value: number; movements: typeof movements }>();
  for (const m of movements) {
    const key = m.itemId;
    if (!stockMap.has(key)) stockMap.set(key, { qty: 0, value: 0, movements: [] });
    const s = stockMap.get(key)!;
    s.qty += m.qty;
    s.value += m.amount;
    s.movements.push(m);
  }

  return items.map((item) => {
    const s = stockMap.get(item.id) ?? { qty: item.openingQty, value: item.openingValue, movements: [] };
    return {
      itemId: item.id,
      itemCode: item.itemCode,
      name: item.name,
      unit: item.unit,
      openingQty: item.openingQty,
      openingValue: item.openingValue,
      currentQty: item.openingQty + s.qty,
      currentValue: item.openingValue + s.value,
      reorderLevel: item.reorderLevel,
      belowReorder: item.reorderLevel ? item.openingQty + s.qty <= item.reorderLevel : false,
    };
  });
}
