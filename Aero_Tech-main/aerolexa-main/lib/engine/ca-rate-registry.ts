/**
 * Finance Act rate registry — the single versioned home for every statutory
 * rate/slab/threshold the CA engines use, keyed by assessment year.
 *
 * THE PATTERN: the other CA engines label their defaults with the AY they
 * apply to and let callers override. This registry makes that discipline
 * explicit and centralised:
 *
 *  - every table carries `ay`, `source`, and an `asOn` label;
 *  - callers apply Finance Act / notification changes by REGISTRATION, not by
 *    editing engine constants — `registerOverride(ay, kind, table)` wins over
 *    the built-in default and is returned with `overridden: true`;
 *  - lookups are pure and deterministic, so oracle tests can pin every table.
 *
 * Rates are expressed as basis-point integers (10000 = 100%) or integer paise
 * to avoid float drift; slab tables carry their own units in `unit`.
 */

export class RateRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateRegistryError";
  }
}

export type RateKind =
  | "individual-slab-old"
  | "individual-slab-new"
  | "corporate-rate"
  | "surcharge"
  | "cess"
  | "tds-section"
  | "gst-rate"
  | "custom";

export interface SlabRow {
  /** Income up to this amount, in the table's unit (null = infinity). */
  upTo: number | null;
  /** Rate in basis points (e.g. 500 = 5%) or amount in the table's unit. */
  rate: number;
}

export interface RateTable {
  ay: string;
  kind: RateKind;
  unit: "paise" | "bps" | "amount";
  source: string;
  asOn: string;
  rows: readonly SlabRow[];
}

const REGISTRY = new Map<string, RateTable>();
const OVERRIDES = new Map<string, RateTable>();

const key = (ay: string, kind: string) => `${ay}::${kind}`;

function put(map: Map<string, RateTable>, table: RateTable): void {
  if (!/^\d{4}-\d{2}$/.test(table.ay)) throw new RateRegistryError(`Invalid AY "${table.ay}" — expected "2025-26".`);
  if (table.rows.length === 0) throw new RateRegistryError("A rate table needs at least one row.");
  map.set(key(table.ay, table.kind), table);
}

// ---------------------------------------------------------------------------
// Built-in defaults (AY 2025-26). Every row is labelled; a Finance Act change
// is applied with registerOverride(), never by editing these.
// ---------------------------------------------------------------------------

put(REGISTRY, {
  ay: "2025-26",
  kind: "individual-slab-new",
  unit: "paise",
  source: "Finance Act 2025 (commonly referenced new-regime slabs, AY 2025-26)",
  asOn: "2025-04-01",
  rows: [
    { upTo: 4_00_000 * 100, rate: 0 },
    { upTo: 8_00_000 * 100, rate: 500 },
    { upTo: 12_00_000 * 100, rate: 1000 },
    { upTo: 16_00_000 * 100, rate: 1500 },
    { upTo: 20_00_000 * 100, rate: 2000 },
    { upTo: 24_00_000 * 100, rate: 2500 },
    { upTo: null, rate: 3000 },
  ],
});

put(REGISTRY, {
  ay: "2025-26",
  kind: "individual-slab-old",
  unit: "paise",
  source: "Finance Act (commonly referenced old-regime slabs, AY 2025-26)",
  asOn: "2025-04-01",
  rows: [
    { upTo: 2_50_000 * 100, rate: 0 },
    { upTo: 5_00_000 * 100, rate: 500 },
    { upTo: 10_00_000 * 100, rate: 2000 },
    { upTo: null, rate: 3000 },
  ],
});

put(REGISTRY, {
  ay: "2025-26",
  kind: "corporate-rate",
  unit: "bps",
  source: "Finance Act (domestic company rates commonly referenced, AY 2025-26)",
  asOn: "2025-04-01",
  rows: [
    { upTo: null, rate: 2200 }, // s.115BAA: 22% + surcharge 10% + cess 4% ≈ 25.168%
    { upTo: null, rate: 1500 }, // s.115BAB: 15% manufacturing
  ],
});

put(REGISTRY, {
  ay: "2025-26",
  kind: "cess",
  unit: "bps",
  source: "Health and education cess, commonly referenced",
  asOn: "2025-04-01",
  rows: [{ upTo: null, rate: 400 }],
});

put(REGISTRY, {
  ay: "2025-26",
  kind: "surcharge",
  unit: "bps",
  source: "Surcharge slabs commonly referenced (individual/HUF/AOP)",
  asOn: "2025-04-01",
  rows: [
    { upTo: 50_00_000 * 100, rate: 0 },
    { upTo: 1_00_00_000 * 100, rate: 1000 },
    { upTo: 2_00_00_000 * 100, rate: 1500 },
    { upTo: 5_00_00_000 * 100, rate: 2500 },
    { upTo: null, rate: 3700 },
  ],
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Look up a rate table; the registered override wins over the built-in default. */
export function getRateTable(ay: string, kind: RateKind): { table: RateTable; overridden: boolean } {
  const k = key(ay, kind);
  const override = OVERRIDES.get(k);
  if (override) return { table: override, overridden: true };
  const def = REGISTRY.get(k);
  if (def) return { table: def, overridden: false };
  throw new RateRegistryError(`No ${kind} table registered for AY ${ay}. Register it with registerOverride().`);
}

/**
 * Register a caller-owned table (a Finance Act change, a notification, a
 * client-specific agreed rate). Registered tables always win over defaults.
 */
export function registerOverride(table: RateTable): void {
  put(OVERRIDES, table);
}

/** True when an override exists for this AY + kind — surfaces in API responses. */
export function hasOverride(ay: string, kind: RateKind): boolean {
  return OVERRIDES.has(key(ay, kind));
}

/** List every AY that has at least one table registered (default or override). */
export function registeredAys(): string[] {
  const ays = new Set<string>();
  for (const k of REGISTRY.keys()) ays.add(k.split("::")[0]!);
  for (const k of OVERRIDES.keys()) ays.add(k.split("::")[0]!);
  return [...ays].sort();
}

/**
 * Apply a slab table to a taxable income (in the table's unit): finds the row
 * whose `upTo` first exceeds the income and returns its rate. Marginal
 * slab-wise tax computation is the caller engine's job (see india-tax).
 */
export function slabRateFor(table: RateTable, income: number): { rate: number; row: SlabRow } {
  if (income < 0) throw new RateRegistryError("Income cannot be negative.");
  for (const row of table.rows) {
    if (row.upTo === null || income <= row.upTo) return { rate: row.rate, row };
  }
  throw new RateRegistryError("Slab table is malformed — no row matched.");
}

/** All tables for an AY — used by audit surfaces to show what was applied. */
export function tablesForAy(ay: string): { kind: RateKind; overridden: boolean }[] {
  const kinds = new Set<string>();
  for (const k of REGISTRY.keys()) if (k.startsWith(ay + "::")) kinds.add(k.split("::")[1]!);
  for (const k of OVERRIDES.keys()) if (k.startsWith(ay + "::")) kinds.add(k.split("::")[1]!);
  return [...kinds].map((kind) => ({ kind: kind as RateKind, overridden: OVERRIDES.has(`${ay}::${kind}`) }));
}
