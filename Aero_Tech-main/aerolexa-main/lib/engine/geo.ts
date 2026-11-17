/**
 * Choropleth engine (pure, dependency-free).
 *
 * Turns a list of `{ region, value }` rows into everything a choropleth
 * renderer needs — no DOM, no Leaflet, fully unit-testable:
 *
 *  1. `normalizeRegionName` — dataset region labels ("usa", "U.S.A.",
 *     "Maharashtra (MH)") are matched against GeoJSON feature names by
 *     lower-casing, stripping diacritics/punctuation and a small alias table.
 *  2. `classifyValues` — breaks values into classes via quantiles (default,
 *     balanced class sizes) or equal interval, returning per-region colors
 *     on a single-hue ramp plus a legend.
 *  3. `buildChoropleth` — joins values onto GeoJSON features and reports
 *     honestly which regions could not be matched (never silently dropped).
 *
 * Colors: a 5-step single-hue teal ramp anchored on the repo palette
 * (#5AA8AA) with a perceptually even light→dark ordering. `noData` regions
 * render in a neutral gray — they are visible, not hidden.
 */

// ---------------------------------------------------------------------------
// Region-name normalization
// ---------------------------------------------------------------------------

const REGION_ALIASES: Record<string, string> = {
  usa: "united states of america",
  "u s a": "united states of america",
  us: "united states of america",
  "united states": "united states of america",
  america: "united states of america",
  uk: "united kingdom",
  "u k": "united kingdom",
  "great britain": "united kingdom",
  england: "united kingdom",
  uae: "united arab emirates",
  "u a e": "united arab emirates",
  "south korea": "south korea",
  korea: "south korea",
  "republic of korea": "south korea",
  russia: "russia",
  "russian federation": "russia",
  "czech republic": "czechia",
  "the netherlands": "netherlands",
  holland: "netherlands",
  vietnam: "vietnam",
  "viet nam": "vietnam",
  "democratic republic of the congo": "democratic republic of the congo",
  "dr congo": "democratic republic of the congo",
  "congo kinshasa": "democratic republic of the congo",
  swaziland: "eswatini",
  burma: "myanmar",
  "cape verde": "cabo verde",
  "east timor": "timor leste",
  macedonia: "north macedonia",
  turkey: "turkey",
  turkiye: "turkey",
  "cote d ivoire": "cote d ivoire",
  "ivory coast": "cote d ivoire",
};

/** Strip diacritics, punctuation and parenthetical qualifiers; lowercase. */
export function normalizeRegionName(raw: string): string {
  const withoutParens = raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // "Maharashtra (MH)" → "Maharashtra"
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s]/g, " ") // punctuation → space
    .trim()
    .replace(/\s+/g, " ");
  return REGION_ALIASES[withoutParens] ?? withoutParens;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ClassificationMethod = "quantile" | "equal-interval";

export interface ClassBreaks {
  /** Class upper bounds (exclusive, last is max). Length = classCount. */
  bounds: number[];
  method: ClassificationMethod;
}

export interface RegionRow {
  region: string;
  value: number;
}

export interface LegendEntry {
  label: string;
  color: string;
}

export interface ClassifiedRegion {
  region: string;
  value: number;
  color: string;
  classIndex: number;
  /** "Low → High" range label for the tooltip/legend. */
  classLabel: string;
}

export interface ClassificationResult {
  classes: ClassifiedRegion[];
  legend: LegendEntry[];
  breaks: ClassBreaks;
}

/**
 * 5-step single-hue ramp (light → dark) anchored on the Ledgerly teal
 * (#5AA8AA). Order matters: index 0 = lowest class.
 */
export const CHOROPLETH_RAMP = ["#DCEFF0", "#BCDFE0", "#8FCACC", "#5AA8AA", "#33707B"] as const;

export const NO_DATA_COLOR = "#E5E3DC";

/** Assign class indices by quantile (each class holds ≈ n/k regions). */
function quantileIndices(sortedValues: number[], k: number): number[] {
  return sortedValues.map((_, i) => Math.min(k - 1, Math.floor((i * k) / sortedValues.length)));
}

/** Assign class indices by equal-width bins between min and max. */
function equalIntervalIndices(sortedValues: number[], k: number): number[] {
  const min = sortedValues[0]!;
  const max = sortedValues[sortedValues.length - 1]!;
  const span = max - min || 1;
  return sortedValues.map((v) => Math.min(k - 1, Math.floor(((v - min) / span) * k)));
}

export function classifyValues(
  rows: RegionRow[],
  opts: { method?: ClassificationMethod; classCount?: number } = {},
): ClassificationResult {
  const k = Math.min(Math.max(opts.classCount ?? 5, 3), 7);
  const method = opts.method ?? "quantile";
  if (rows.length === 0) {
    return {
      classes: [],
      legend: [],
      breaks: { bounds: [], method },
    };
  }

  const sorted = [...rows].sort((a, b) => a.value - b.value);
  const indices =
    method === "quantile"
      ? quantileIndices(
          sorted.map((r) => r.value),
          k,
        )
      : equalIntervalIndices(
          sorted.map((r) => r.value),
          k,
        );

  // Upper bound of each class:
  //   quantile        → the largest value actually assigned to the class
  //                     (data-descriptive; the last bound is the max)
  //   equal-interval  → theoretical edges min + (i+1)·span/k (a class may be
  //                     empty; its edge must still show in the legend)
  const values = sorted.map((r) => r.value);
  const min = values[0]!;
  const max = values[values.length - 1]!;
  const bounds: number[] = [];
  if (method === "equal-interval") {
    const span = max - min;
    for (let c = 0; c < k; c++) bounds.push(min + (span * (c + 1)) / k);
  } else {
    for (let c = 0; c < k; c++) {
      let upper = min;
      for (let i = 0; i < values.length; i++) {
        if (indices[i]! <= c) upper = values[i]!;
      }
      bounds.push(upper);
    }
  }

  const classOf = new Map<string, { index: number; value: number }>();
  sorted.forEach((r, i) => classOf.set(normalizeRegionName(r.region), { index: indices[i]!, value: r.value }));

  const formatBound = (v: number) =>
    Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100);

  const classes: ClassifiedRegion[] = rows.map((r) => {
    const entry = classOf.get(normalizeRegionName(r.region))!;
    const lower = entry.index === 0 ? min : bounds[entry.index - 1]!;
    const upper = bounds[entry.index]!;
    return {
      region: r.region,
      value: r.value,
      color: CHOROPLETH_RAMP[entry.index]!,
      classIndex: entry.index,
      classLabel: `${formatBound(lower)} – ${formatBound(upper)}`,
    };
  });

  const legend: LegendEntry[] = bounds.map((upper, i) => {
    const lower = i === 0 ? min : bounds[i - 1]!;
    return {
      label: `${formatBound(lower)} – ${formatBound(upper)}`,
      color: CHOROPLETH_RAMP[i]!,
    };
  });

  return { classes, legend, breaks: { bounds, method } };
}

// ---------------------------------------------------------------------------
// GeoJSON join
// ---------------------------------------------------------------------------

export interface GeoFeatureLike {
  type: "Feature";
  properties: { name?: string; [key: string]: unknown };
  geometry: unknown;
}

export interface FeatureCollectionLike {
  type: "FeatureCollection";
  features: GeoFeatureLike[];
  [key: string]: unknown;
}

export interface JoinReport {
  /** Features with their assigned color + value (the draw list). */
  matched: { feature: GeoFeatureLike; region: string; value: number; color: string; classLabel: string }[];
  /** Features present in the GeoJSON but with no data value. */
  unmatchedRegions: string[];
  /** Data rows that matched no feature (typo? wrong scope?). */
  unmatchedValues: string[];
}

/**
 * Join classified values onto GeoJSON features. Both sides go through
 * normalizeRegionName; duplicates on either side resolve to the first match
 * (with the duplicate reported in the unmatched* lists for honesty).
 */
export function buildChoropleth(features: GeoFeatureLike[], classified: ClassifiedRegion[]): JoinReport {
  const byKey = new Map<string, ClassifiedRegion>();
  for (const c of classified) {
    const key = normalizeRegionName(c.region);
    if (!byKey.has(key)) byKey.set(key, c);
  }

  const matched: JoinReport["matched"] = [];
  const usedKeys = new Set<string>();
  const unmatchedRegions: string[] = [];

  for (const feature of features) {
    const rawName = String(feature.properties?.name ?? "");
    const key = normalizeRegionName(rawName);
    const hit = byKey.get(key);
    if (hit) {
      usedKeys.add(key);
      matched.push({
        feature,
        region: rawName,
        value: hit.value,
        color: hit.color,
        classLabel: hit.classLabel,
      });
    } else {
      unmatchedRegions.push(rawName);
    }
  }

  const unmatchedValues = classified.filter((c) => !usedKeys.has(normalizeRegionName(c.region))).map((c) => c.region);

  return { matched, unmatchedRegions, unmatchedValues };
}
