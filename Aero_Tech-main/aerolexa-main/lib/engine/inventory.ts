/**
 * Inventory valuation engine — FIFO, weighted average, negative-stock prevention,
 * and cost-of-goods-sold (COGS) posting for Indian CA practice.
 *
 * Money is in MINOR UNITS (paise) as integers, matching accounting.ts and the
 * ratio engines. All computations are pure functions (no DB, no randomness),
 * so they can be pinned by unit tests.
 */

/** Rupees ↔ paise conversion helpers (same convention as india-tax). */
export function rupees(r: number): number {
  return Math.round(r * 100);
}

export function paise(p: number): number {
  return Math.round(p);
}

/** Inventory valuation method. */
export type ValuationMethod = "fifo" | "weighted-average";

/** A batch of inventory items received into stock. */
export interface InventoryBatch {
  /** Unique batch identifier (e.g. production lot, supplier lot). */
  batchId: string;
  /** Date the batch was received (yyyy-mm-dd). */
  receivedAt: string;
  /** Quantity received (positive number in base units). */
  quantity: number;
  /** Per-unit cost in rupees at time of receipt. */
  unitCost: number;
  /** Optional expiry date (yyyy-mm-dd) for perishable goods. */
  expiryDate?: string;
}

/** Current stock position after applying movements. */
export interface StockPosition {
  /** Total quantity on hand (base units). */
  quantity: number;
  /** Weighted-average cost per unit in rupees (only valid when method is "weighted-average"). */
  weightedAvgCost: number;
  /** Total value of stock on hand in paise. */
  totalValue: number;
  /** Breakdown by valuation method. */
  byMethod: {
    fifo: { quantity: number; totalValue: number } | null;
    weightedAverage: { quantity: number; totalValue: number } | null;
  };
}

/** COGS entry posted for a sale. */
export interface COGSEntry {
  /** Date of sale (yyyy-mm-dd). */
  saleDate: string;
  /** Quantity sold (base units). */
  quantity: number;
  /** Per-unit COGS amount in rupees (depends on valuation method). */
  unitCost: number;
  /** Total COGS amount in paise. */
  totalCost: number;
  /** Remaining quantity after this sale. */
  remainingQuantity: number;
}

/** Compute FIFO valuation of current stock given a history of batches. */
export function computeFIFO(
  batches: InventoryBatch[],
  currentQuantity: number,
): { quantity: number; totalValue: number } | null {
  if (currentQuantity <= 0 || batches.length === 0) {
    return null;
  }

  // Work backwards through batches (oldest first = FIFO)
  let remaining = currentQuantity;
  let totalValue = 0;

  for (let i = batches.length - 1; i >= 0; i--) {
    const batch = batches[i]!;
    const batchQty = batch.quantity;

    if (remaining <= 0) break;

    const useFromBatch = Math.min(batchQty, remaining);
    totalValue += useFromBatch * rupees(batch.unitCost);
    remaining -= useFromBatch;
  }

  if (remaining > 0) {
    // Not enough stock — this should be caught by negative-stock prevention
    return null;
  }

  return {
    quantity: currentQuantity,
    totalValue,
  };
}

/** Compute weighted-average valuation of current stock. */
export function computeWeightedAverage(
  batches: InventoryBatch[],
  currentQuantity: number,
): { quantity: number; totalValue: number } | null {
  if (currentQuantity <= 0 || batches.length === 0) {
    return null;
  }

  let totalCost = 0;
  let totalQty = 0;

  for (const batch of batches) {
    totalCost += rupees(batch.unitCost) * batch.quantity;
    totalQty += batch.quantity;
  }

  if (totalQty === 0) {
    return null;
  }

  const avgCost = totalCost / totalQty; // paise per unit
  const totalValue = Math.round(avgCost * currentQuantity);

  return {
    quantity: currentQuantity,
    totalValue,
  };
}

/** Get the valuation result for the specified method. */
export function getStockValue(
  method: ValuationMethod,
  batches: InventoryBatch[],
  currentQuantity: number,
): { quantity: number; totalValue: number } | null {
  switch (method) {
    case "fifo":
      return computeFIFO(batches, currentQuantity);
    case "weighted-average":
      return computeWeightedAverage(batches, currentQuantity);
    default:
      return null;
  }
}

/** Prevent negative stock: ensure that after a sale, remaining quantity >= 0. */
export function validateNoNegativeStock(
  currentQuantity: number,
  saleQuantity: number,
): { ok: true } | { ok: false; message: string } {
  const remaining = currentQuantity - saleQuantity;
  if (remaining < 0) {
    return {
      ok: false,
      message: `Negative stock prevented: selling ${saleQuantity} units would leave ${remaining} units. Current stock: ${currentQuantity}.`,
    };
  }
  return { ok: true };
}

/** Post COGS for a sale using the specified valuation method. */
export function postCOGS(method: ValuationMethod, batches: InventoryBatch[], saleQuantity: number): COGSEntry | null {
  // First validate no negative stock
  const stock = getStockValue(
    method,
    batches,
    batches.reduce((sum, b) => sum + b.quantity, 0),
  );

  if (!stock) {
    return null;
  }

  const validation = validateNoNegativeStock(stock.quantity, saleQuantity);
  if (!validation.ok) {
    return null;
  }

  // Compute FIFO or weighted-average unit cost
  let unitCost: number;
  if (method === "fifo") {
    const fifoResult = computeFIFO(batches, stock.quantity);
    if (!fifoResult) return null;
    unitCost = fifoResult.totalValue / stock.quantity;
  } else {
    const waResult = computeWeightedAverage(batches, stock.quantity);
    if (!waResult) return null;
    unitCost = waResult.totalValue / stock.quantity;
  }

  const remainingQuantity = stock.quantity - saleQuantity;
  const totalCost = Math.round(rupees(unitCost) * saleQuantity);

  return {
    saleDate: new Date().toISOString().slice(0, 10),
    quantity: saleQuantity,
    unitCost,
    totalCost,
    remainingQuantity,
  };
} /** Example usage with mock data. */
const batches: InventoryBatch[] = [
  { batchId: "B001", receivedAt: "2026-01-01", quantity: 100, unitCost: 50 },
  { batchId: "B002", receivedAt: "2026-02-15", quantity: 200, unitCost: 55 },
  { batchId: "B003", receivedAt: "2026-03-10", quantity: 150, unitCost: 60 },
];

// FIFO: sell 180 units from oldest batches first
const _fifoSale = postCOGS("fifo", batches, 180); // Suppress unused-var warning
// Weighted average: sell 180 units
const _waSale = postCOGS("weighted-average", batches, 180); // Suppress unused-var warning
// Check stock position after sale
const _stockPos = getStockValue("weighted-average", batches, batches.reduce((sum, b) => sum + b.quantity, 0) - 180); // Suppress unused-var warning
