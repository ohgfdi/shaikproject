/**
 * Tax-audit determination engine — oracle tests.
 *
 * The S.44AB determination is arithmetic over caller-supplied turnover, so
 * every expected flag below is derived by hand. Two properties matter most and
 * are pinned explicitly:
 *
 *   1. The threshold comparison is INCLUSIVE (turnover === limitation crosses).
 *   2. The limitation is looked up by the caller's category — including the
 *      hyphenated `hindu-undivided-family` key, which a spaced typo would have
 *      silently missed, falling back to the resident limit without any signal.
 *
 * The engine is a scaffold: it does not fetch live law, so these tests pin the
 * computation and the surfaced thresholds rather than a legal conclusion.
 */

import { determineTaxAudit } from "@/lib/engine/ca-tax-audit";

/** ₹100 crore = 100,00,00,000 = 1e9 — the commonly referenced S.44AB limit. */
const LIMIT = 100_00_00_000;

const base = {
  fy: "2025-26",
  entityType: "company",
  turnover: 0,
  presumptiveTurnover: 0,
  exemptTurnover: 0,
  booksRequired: false,
  auditedTurnoverFlag: false,
  professionalServices: false,
  presumptiveOpted: false,
  digitalReceiptsPct: 0,
};

const trigger = (name: string, res: ReturnType<typeof determineTaxAudit>) => res.triggers.find((t) => t.name === name);

describe("determineTaxAudit: S.44AB turnover limitation", () => {
  it("does not cross the limitation one rupee below it", () => {
    const res = determineTaxAudit({ ...base, turnover: LIMIT - 1 });

    expect(res.turnoverAnalysis.turnoverForAuditLimitation).toBe(LIMIT - 1);
    expect(trigger("S.44AB book-audit (turnover/gross receipts above limitation)", res)?.applies).toBe(false);
    expect(res.warnings.some((w) => w.includes("not crossed"))).toBe(true);
  });

  it("crosses at exactly the limitation — the comparison is inclusive", () => {
    const res = determineTaxAudit({ ...base, turnover: LIMIT });

    expect(res.turnoverAnalysis.turnoverForAuditLimitation).toBe(LIMIT);
    expect(trigger("S.44AB book-audit (turnover/gross receipts above limitation)", res)?.applies).toBe(true);
    expect(res.warnings.some((w) => w.includes("crossed"))).toBe(true);
  });

  it("aggregates turnover + presumptive + exempt for the limitation test", () => {
    // 60cr + 30cr + 10cr = 100cr exactly, so the audit triggers even though the
    // ordinary turnover figure alone (60cr) is below the limit.
    const res = determineTaxAudit({
      ...base,
      turnover: 600_000_000,
      presumptiveTurnover: 300_000_000,
      exemptTurnover: 100_000_000,
    });

    expect(res.turnoverAnalysis).toEqual({
      grossTurnover: 600_000_000,
      presumptiveTurnover: 300_000_000,
      exemptTurnover: 100_000_000,
      turnoverForAuditLimitation: LIMIT,
    });
    expect(trigger("S.44AB book-audit (turnover/gross receipts above limitation)", res)?.applies).toBe(true);
  });
});

describe("determineTaxAudit: category threshold lookup", () => {
  it("looks the limit up by the hyphenated HUF category", () => {
    // regression: a "hindu- undivided-family" (spaced) category key would not
    // match the limits table and the engine would silently use "resident".
    const res = determineTaxAudit({ ...base, category: "hindu-undivided-family", turnover: 0 });

    expect(
      res.checklist.some(
        (c) =>
          c ===
          `Applicable limitation for hindu-undivided-family: ${LIMIT} (commonly referenced; verify current notification).`,
      ),
    ).toBe(true);
  });

  it("falls back to the resident limitation for an unknown category", () => {
    const res = determineTaxAudit({ ...base, category: "cooperative", turnover: 0 });

    expect(
      res.checklist.some(
        (c) => c === `Applicable limitation for resident: ${LIMIT} (commonly referenced; verify current notification).`,
      ),
    ).toBe(true);
  });
});

describe("determineTaxAudit: audit-trigger flags", () => {
  it("reflects the books-of-account and audited-turnover flags", () => {
    const off = determineTaxAudit({ ...base });
    expect(trigger("Books of account required to be maintained", off)?.applies).toBe(false);
    expect(trigger("Audited turnover flag", off)?.applies).toBe(false);

    const on = determineTaxAudit({ ...base, booksRequired: true, auditedTurnoverFlag: true });
    expect(trigger("Books of account required to be maintained", on)?.applies).toBe(true);
    expect(trigger("Audited turnover flag", on)?.applies).toBe(true);
  });

  it("adds the profession trigger only when professional services apply", () => {
    const none = determineTaxAudit({ ...base });
    expect(none.triggers.some((t) => t.name.includes("Professional services"))).toBe(false);

    const professional = determineTaxAudit({ ...base, professionalServices: true });
    expect(trigger("Professional services — presumptive provisions may apply", professional)?.applies).toBe(true);
  });

  it("splits the digital-receipts trigger at the 5% boundary", () => {
    const atBoundary = determineTaxAudit({ ...base, presumptiveOpted: true, digitalReceiptsPct: 5 });
    expect(trigger("Digital receipts >= 5% (44AD relevance)", atBoundary)?.applies).toBe(true);
    expect(trigger("Digital receipts < 5%", atBoundary)).toBeUndefined();

    const below = determineTaxAudit({ ...base, presumptiveOpted: true, digitalReceiptsPct: 4.99 });
    expect(trigger("Digital receipts < 5%", below)?.applies).toBe(true);
    expect(trigger("Digital receipts >= 5% (44AD relevance)", below)).toBeUndefined();
  });

  it("adds the presumptive-scheme trigger only when opted in", () => {
    const notOpted = determineTaxAudit({ ...base });
    expect(notOpted.triggers.some((t) => t.name.includes("Presumptive scheme opted"))).toBe(false);

    const opted = determineTaxAudit({ ...base, presumptiveOpted: true, digitalReceiptsPct: 0 });
    expect(trigger("Presumptive scheme opted (44AD/ADA/AGS)", opted)?.applies).toBe(true);
  });
});

describe("determineTaxAudit: surfaced computation basis", () => {
  it("prints the turnover breakdown and FY into the checklist", () => {
    const res = determineTaxAudit({
      ...base,
      fy: "2024-25",
      turnover: 1_000,
      presumptiveTurnover: 2_000,
      exemptTurnover: 3_000,
    });

    expect(res.fy).toBe("2024-25");
    expect(res.turnoverAnalysis.turnoverForAuditLimitation).toBe(6_000);
    expect(res.checklist).toContain("Confirm the relevant FY is 2024-25.");
    expect(res.checklist).toContain(
      "Aggregate turnover/gross receipts: 6000 (turnover 1000 + presumptive 2000 + exempt 3000).",
    );
    expect(res.methodology.length).toBeGreaterThan(0);
  });
});
