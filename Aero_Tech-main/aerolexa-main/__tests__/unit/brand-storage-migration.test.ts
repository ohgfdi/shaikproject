/** @jest-environment jsdom */
/**
 * Brand rename — browser storage forward-migration.
 *
 * Split from brand-rename.test.ts because jsdom and the node-only server
 * imports are mutually exclusive within one suite. Together the two files
 * cover the full rename upgrade path.
 *
 * The pre-rename namespace was internally inconsistent — cookies used
 * `aerolexa.theme` while localStorage used `aerolexa:tier` — so every helper
 * must probe BOTH separators or an upgraded user silently loses a preference.
 */
import { BRAND_STORAGE_KEYS, migrateBrandStorage, readBrandLocalStorage, writeBrandLocalStorage } from "@/lib/brand";

describe("localStorage read-fallback (the no-reset guarantee)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("probes both legacy separators", () => {
    window.localStorage.setItem("aerolexa:tier", "studio");
    expect(readBrandLocalStorage(BRAND_STORAGE_KEYS.tier)).toBe("studio");

    window.localStorage.clear();
    window.localStorage.setItem("aerolexa.install-dismissed", "1");
    expect(readBrandLocalStorage(BRAND_STORAGE_KEYS.installDismissed)).toBe("1");
  });

  it("prefers the current key over the legacy one", () => {
    window.localStorage.setItem("ledgerly.tier", "depth");
    window.localStorage.setItem("aerolexa:tier", "studio");
    expect(readBrandLocalStorage(BRAND_STORAGE_KEYS.tier)).toBe("depth");
  });

  it("returns null when neither exists", () => {
    expect(readBrandLocalStorage(BRAND_STORAGE_KEYS.tier)).toBeNull();
  });

  it("writing clears both legacy twins", () => {
    window.localStorage.setItem("aerolexa:tier", "flat");
    window.localStorage.setItem("aerolexa.tier", "flat");
    writeBrandLocalStorage(BRAND_STORAGE_KEYS.tier, "depth");
    expect(window.localStorage.getItem("ledgerly.tier")).toBe("depth");
    expect(window.localStorage.getItem("aerolexa:tier")).toBeNull();
    expect(window.localStorage.getItem("aerolexa.tier")).toBeNull();
  });
});

describe("one-time forward migration", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("moves legacy keys forward without clobbering newer values", () => {
    window.localStorage.setItem("aerolexa.theme", "light");
    window.localStorage.setItem("aerolexa:tier", "flat");
    // A value the user already re-set after the upgrade must win.
    window.localStorage.setItem("ledgerly.theme", "dark");

    migrateBrandStorage();

    expect(window.localStorage.getItem("ledgerly.theme")).toBe("dark");
    expect(window.localStorage.getItem("ledgerly.tier")).toBe("flat");
    expect(window.localStorage.getItem("aerolexa.theme")).toBeNull();
    expect(window.localStorage.getItem("aerolexa.tier")).toBeNull();
  });

  it("is idempotent", () => {
    window.localStorage.setItem("aerolexa:tier", "studio");
    migrateBrandStorage();
    migrateBrandStorage();
    expect(window.localStorage.getItem("ledgerly.tier")).toBe("studio");
  });

  it("leaves unrelated keys alone", () => {
    window.localStorage.setItem("unrelated.key", "keep");
    window.localStorage.setItem("aerolexa.tier", "studio");
    migrateBrandStorage();
    expect(window.localStorage.getItem("unrelated.key")).toBe("keep");
  });
});
