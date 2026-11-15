/**
 * Urdu dictionary — the RTL locale (ROADMAP 7.5: English + one RTL locale).
 * Covers the same core surfaces as `en`; missing keys fall back to English.
 * Direction is declared once in lib/i18n.ts (RTL_LOCALES) — the root layout
 * sets <html dir="rtl" lang="ur"> when this locale is active.
 */

const ur = {
  // Brand & shell
  "brand.tagline": "کچے ڈیٹا سے بورڈ روم کے فیصلوں تک",
  "nav.dashboard": "ڈیش بورڈ",
  "nav.projects": "پروجیکٹس",
  "nav.copilot": "کوپائلٹ",
  "nav.advisor": "مشیر",
  "nav.settings": "ترتیبات",
  "nav.search": "تلاش",

  // Common actions
  "action.save": "محفوظ کریں",
  "action.cancel": "منسوخ کریں",
  "action.delete": "حذف کریں",
  "action.retry": "دوبارہ کوشش",
  "action.upload": "اپ لوڈ",
  "action.run": "چلائیں",
  "action.create": "بنائیں",
  "action.close": "بند کریں",
  "action.loading": "لوڈ ہو رہا ہے…",

  // Auth
  "auth.login.title": "سائن اِن کریں",
  "auth.login.cta": "سائن اِن",
  "auth.signup.title": "اپنا اکاؤنٹ بنائیں",
  "auth.signup.cta": "سائن اپ",
  "auth.email": "ای میل",
  "auth.password": "پاس ورڈ",
  "auth.forgot": "پاس ورڈ بھول گئے؟",
  "auth.or": "یا",
  "auth.logout": "سائن آؤٹ",

  // Empty / errors
  "error.generic": "کچھ غلط ہو گیا۔ کیا ہوا: غیر متوقع خرابی۔ کیا کریں: دوبارہ کوشش کریں۔",
  "empty.generic": "ابھی کچھ نہیں ہے۔",
  "empty.datasets": "ابھی کوئی ڈیٹا سیٹ نہیں — شروع کرنے کے لیے CSV یا Excel فائل اپ لوڈ کریں۔",

  // Locale switcher
  "locale.label": "زبان",
  "locale.en": "English",
  "locale.hi": "हिन्दी",
  "locale.ur": "اردو",
} as const;

export type UrTranslationKey = keyof typeof ur;
export default ur;
