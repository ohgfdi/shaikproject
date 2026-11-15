import type { AnalysisKind, Confidence } from "@/lib/types";

/**
 * Trust labels — the single source of truth for how the UI presents the
 * verification status of a number.
 *
 * The product has a verification culture (see lib/engine/*.ts): deterministic
 * engines are oracle-tested against SciPy/NumPy/statsmodels in CI, every
 * figure is traceable via provenance to source rows, and immutable
 * AnalysisVersion / DatasetVersion snapshots prove what changed and when.
 * Results are explicitly labelled — `Calculated (oracle-validated)` versus
 * `Prototype / Demo` — and these helpers keep the wording consistent
 * wherever a number is shown.
 */

export const CALCULATED_LABEL = "Calculated (oracle-validated)";
export const PROTOTYPE_LABEL = "Prototype / Demo";

/** Map the engine's `Confidence` value onto its prominent trust label. */
export function trustLabelForConfidence(confidence: Confidence): string {
  switch (confidence) {
    case "calculated":
      return CALCULATED_LABEL;
    case "inferred":
    case "recommendation":
      return PROTOTYPE_LABEL;
    default: {
      const exhaustive: never = confidence;
      void exhaustive;
      return PROTOTYPE_LABEL;
    }
  }
}

/**
 * Analysis kinds whose engines are still prototype-grade (live ML /
 * prototype-grade modelling) and therefore always carry the
 * `Prototype / Demo` label. Every other kind runs deterministic in-repo
 * logic that is oracle-tested in CI and labelled `Calculated`.
 */
const PROTOTYPE_KINDS: ReadonlySet<AnalysisKind> = new Set<AnalysisKind>([
  "automl",
  "arimax",
  "deep-learning",
  "nlp",
  "uplift",
]);

export function isPrototypeKind(kind: AnalysisKind): boolean {
  return PROTOTYPE_KINDS.has(kind);
}

export function trustLabelForKind(kind: AnalysisKind): string {
  return isPrototypeKind(kind) ? PROTOTYPE_LABEL : CALCULATED_LABEL;
}

/** The 2–3 sentence "How this number is verified" copy. */
export const TRUST_EXPLANATION = [
  "Every number here is computed by hand-written deterministic engines — never a black-box model or a generic AI guess.",
  "Those engines are oracle-tested against SciPy, NumPy and statsmodels in CI, and every figure is traceable via provenance to the exact source rows it was computed from.",
  "Immutable version snapshots prove what changed and when — open the versions panel on any analysis to diff two runs line by line.",
] as const;
