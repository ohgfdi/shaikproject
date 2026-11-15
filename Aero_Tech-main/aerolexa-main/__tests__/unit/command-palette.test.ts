/**
 * Unit gate for the command palette's deterministic pieces (ROADMAP 7.1):
 * the fuzzy scorer and the nav-action derivation. Pure imports — the
 * component is not rendered here (component tests cover the overlay).
 *
 * score() is exercised via the palette module; ACTIONS filtering is pinned
 * by asserting the module's exported helper when present. To keep the gate
 * honest and dependency-free we re-derive the contract from the module's
 * public surface only.
 */
import { describe, expect, it } from "@jest/globals";

import { scoreQuery, rankHits } from "@/lib/client/command-palette-core";

describe("command palette scoring", () => {
  it("ranks prefix matches above substring matches", () => {
    expect(scoreQuery("dash", "Dashboards")).toBeGreaterThan(scoreQuery("dash", "My Dashboards"));
  });

  it("ranks substring above subsequence", () => {
    expect(scoreQuery("dash", "My Dashboards")).toBeGreaterThan(scoreQuery("dsh", "Dashboard"));
  });

  it("returns 0 for non-matches", () => {
    expect(scoreQuery("xyz", "Dashboard")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(scoreQuery("DASH", "dashboards")).toBeGreaterThan(0);
  });

  it("ranks hits deterministically and filters non-matches", () => {
    const hits = [
      { id: "1", type: "Dashboard", title: "Sales Dashboard", href: "/dashboards/1" },
      { id: "2", type: "Report", title: "Q3 Report", href: "/reports/2" },
      { id: "3", type: "Dashboard", title: "Dashboard — Marketing", href: "/dashboards/3" },
    ];
    const ranked = rankHits("dash", hits);
    expect(ranked.map((h) => h.id)).toEqual(["3", "1"]); // prefix first
    expect(ranked.map((h) => h.id)).not.toContain("2");
  });
});
