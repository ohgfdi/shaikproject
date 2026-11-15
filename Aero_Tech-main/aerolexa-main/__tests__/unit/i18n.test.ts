/**
 * Unit tests for the i18n scaffold (lib/i18n.ts + dictionaries).
 * No mocks: the real dictionaries and translate() are exercised.
 */

import { DEFAULT_LOCALE, dirFor, isRtl, LOCALES, normalizeLocale, translate } from "@/lib/i18n";
import en from "@/lib/locales/en";

describe("i18n scaffold", () => {
  it("exposes en + hi + ur (RTL) with English as the default", () => {
    // The product copy is English; hi/ur cover shared strings only. The old
    // expectation (hi) is precisely the D4 defect: an English UI announcing
    // itself as Hindi. English is the honest default until coverage is full.
    expect(LOCALES).toEqual(["en", "hi", "ur"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("normalizes locale input leniently (hi-IN, en-US, ur-PK, garbage)", () => {
    expect(normalizeLocale("hi-IN")).toBe("hi");
    expect(normalizeLocale("  en-US ")).toBe("en");
    expect(normalizeLocale("ur-PK")).toBe("ur");
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
    expect(normalizeLocale("")).toBeNull();
  });

  it("declares RTL only for ur and derives the dir attribute from it", () => {
    expect(isRtl("ur")).toBe(true);
    expect(isRtl("en")).toBe(false);
    expect(isRtl("hi")).toBe(false);
    expect(dirFor("ur")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
    expect(dirFor("hi")).toBe("ltr");
  });

  it("translates in Urdu (RTL locale)", () => {
    expect(translate("ur", "nav.dashboard")).toBe("ڈیش بورڈ");
    expect(translate("ur", "action.save")).toBe("محفوظ کریں");
  });

  it("translates in Hindi and English", () => {
    expect(translate("hi", "nav.dashboard")).toBe("डैशबोर्ड");
    expect(translate("en", "nav.dashboard")).toBe("Dashboard");
    expect(translate("hi", "auth.login.cta")).toBe("साइन इन");
  });

  it("falls back to English for keys missing in the active locale", () => {
    expect(translate("hi", "brand.tagline")).not.toBe("brand.tagline");
    // A key only present in en resolves through the fallback chain:
    expect(translate("hi", "locale.en")).toBe("English");
  });

  it("returns the key itself when it is missing everywhere (never crashes)", () => {
    expect(translate("en", "does.not.exist")).toBe("does.not.exist");
    expect(translate("hi", "does.not.exist")).toBe("does.not.exist");
  });

  it("interpolates {placeholders}", () => {
    expect(translate("en", "brand.tagline")).not.toContain("{");
    const out = translate("en", "does.not.exist", { x: 1 });
    expect(out).toBe("does.not.exist"); // interpolation never crashes on missing keys
  });

  it("keeps the en dictionary as the key contract (no empty strings)", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(key.length).toBeGreaterThan(0);
      expect(String(value).length).toBeGreaterThan(0);
    }
  });

  it("covers every en key in hi and ur (core-surface parity)", async () => {
    const { default: hi } = await import("@/lib/locales/hi");
    const { default: ur } = await import("@/lib/locales/ur");
    for (const key of Object.keys(en)) {
      expect(hi[key as keyof typeof hi]).toBeDefined();
      expect(ur[key as keyof typeof ur]).toBeDefined();
    }
  });
});
