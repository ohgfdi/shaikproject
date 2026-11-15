/**
 * Roadmap A3 — Natural-language → measure (the DAX bridge).
 *
 * The model PROPOSES, the engine VERIFIES. The saved measure's expression —
 * not the model's prose — is the source of truth. Pipeline:
 *
 *   1. The copilot agent calls `propose_measure` with a candidate DAX
 *      expression (built from get_schema's REAL column names).
 *   2. validateMeasure parses it (engine error text on failure — surfaced
 *      verbatim so the agent can fix its own syntax on the next step).
 *   3. evaluateMeasure runs it against the dataset's real rows; a measure
 *      that cannot evaluate over the real data is dead on arrival.
 *   4. When the proposal is a simple single-column aggregation
 *      (SUM/AVERAGE/MIN/MAX/COUNT over one column), a naive recomputation
 *      over the same rows must MATCH — catching subtle column mixups the
 *      parser alone cannot see.
 *   5. Only a verified proposal is returned to the UI, where the user — not
 *      the copilot — decides whether to save it as a governed custom metric.
 */
import { evaluateMeasure, validateMeasure, type DaxFilter, type DaxModel } from "@/lib/engine/dax";
import { fmtNumber } from "@/lib/format";

/** Result of one proposal verification. `ok` is required before any save. */
export interface MeasureProposalResult {
  ok: boolean;
  /** Normalised name suggested for the custom metric. */
  name: string;
  dax: string;
  format: "number" | "currency" | "percentage";
  /** The value the engine actually computed over the real rows. */
  evaluatedValue: string | null;
  /** Naive-recomputation cross-check result (when one exists). */
  crossCheck: "matched" | "mismatched" | "not-applicable" | "skipped";
  /** The engine's real error text (parse or evaluation) when ok=false. */
  error?: string;
}

const NAME_RE = /^[a-zA-Z0-9 _-]{1,100}$/;

function normalizeName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().slice(0, 100) : "";
  return NAME_RE.test(s) ? s : "";
}

function asFormat(v: unknown): "number" | "currency" | "percentage" {
  return v === "currency" || v === "percentage" ? v : "number";
}

function asFilters(v: unknown): DaxFilter[] {
  if (!Array.isArray(v)) return [];
  const out: DaxFilter[] = [];
  for (const f of v) {
    const rec = f as { column?: unknown; values?: unknown } | null;
    if (
      typeof rec?.column === "string" &&
      Array.isArray(rec.values) &&
      rec.values.every((x) => typeof x === "string")
    ) {
      out.push({ column: rec.column, values: rec.values as string[] });
    }
  }
  return out.slice(0, 5);
}

/**
 * Verify a model-proposed DAX measure against the dataset's real rows.
 * `model` is built by the route from the RLS-filtered rows — the proposal is
 * judged against exactly what the user may see.
 */
export function verifyMeasureProposal(model: DaxModel, args: Record<string, unknown>): MeasureProposalResult {
  const name = normalizeName(args.name);
  const dax = typeof args.dax === "string" ? args.dax.trim().slice(0, 5000) : "";
  const format = asFormat(args.format);
  const filters = asFilters(args.filters);

  if (!name) {
    return {
      ok: false,
      name: "",
      dax,
      format,
      evaluatedValue: null,
      crossCheck: "skipped",
      error: "A metric name (1–100 chars, letters/numbers/spaces) is required.",
    };
  }
  if (!dax) {
    return {
      ok: false,
      name,
      dax: "",
      format,
      evaluatedValue: null,
      crossCheck: "skipped",
      error: "A DAX expression is required, e.g. SUM([revenue]).",
    };
  }

  // 1. Parse — the engine's own error text is the correction signal.
  const parseErrors = validateMeasure(dax);
  if (parseErrors.length > 0) {
    return {
      ok: false,
      name,
      dax,
      format,
      evaluatedValue: null,
      crossCheck: "skipped",
      error: `DAX parse error: ${parseErrors[0]}`,
    };
  }

  // 2. Evaluate over the real rows.
  let value: ReturnType<typeof evaluateMeasure>;
  try {
    value = evaluateMeasure(model, dax, filters);
  } catch (err) {
    return {
      ok: false,
      name,
      dax,
      format,
      evaluatedValue: null,
      crossCheck: "skipped",
      error: `The engine rejected the expression: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (value === null || typeof value !== "number" || !Number.isFinite(value)) {
    return {
      ok: false,
      name,
      dax,
      format,
      evaluatedValue: null,
      crossCheck: "skipped",
      error:
        "The expression evaluated to BLANK or a non-numeric result over the real rows — measures must return a finite number.",
    };
  }

  // 3. Naive cross-check for simple single-column aggregations.
  const simple = /^\s*(SUM|AVERAGE|MIN|MAX|COUNT)\s*\(\s*\[([^\]]+)\]\s*\)\s*$/i.exec(dax);
  let crossCheck: MeasureProposalResult["crossCheck"] = "not-applicable";
  if (simple) {
    const column = simple[2]!;
    const idx = model.columns.indexOf(column);
    if (idx === -1) {
      return {
        ok: false,
        name,
        dax,
        format,
        evaluatedValue: null,
        crossCheck: "skipped",
        error: `Column "${column}" does not exist on this dataset. Use get_schema for the real column names.`,
      };
    }
    const numbers: number[] = [];
    for (const row of model.rows) {
      const v = row[idx];
      if (typeof v === "number" && Number.isFinite(v)) numbers.push(v);
    }
    let naive: number;
    const fn = simple[1]!.toUpperCase();
    if (fn === "SUM") naive = numbers.reduce((a, b) => a + b, 0);
    else if (fn === "AVERAGE")
      naive = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : Number.NaN;
    else if (fn === "MIN") naive = numbers.length ? Math.min(...numbers) : Number.NaN;
    else if (fn === "MAX") naive = numbers.length ? Math.max(...numbers) : Number.NaN;
    else naive = numbers.length;
    const matches = Number.isFinite(naive) && Math.abs(naive - value) <= Math.max(1e-9, Math.abs(naive) * 1e-9);
    crossCheck = matches ? "matched" : "mismatched";
    if (!matches) {
      return {
        ok: false,
        name,
        dax,
        format,
        evaluatedValue: fmtNumber(value),
        crossCheck,
        error: `Verification failed: the engine computed ${fmtNumber(value)} but a direct recomputation over the same rows gives ${fmtNumber(naive)}. The proposal was not accepted.`,
      };
    }
  }

  return { ok: true, name, dax, format, evaluatedValue: fmtNumber(value), crossCheck };
}
