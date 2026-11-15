/**
 * Hindi dictionary — the default locale (India-first wedge).
 * Covers the same core surfaces as `en`; missing keys fall back to English.
 */

const hi = {
  // Brand & shell
  "brand.tagline": "कच्चे डेटा से बोर्ड-रूम निर्णयों तक",
  "nav.dashboard": "डैशबोर्ड",
  "nav.projects": "प्रोजेक्ट्स",
  "nav.copilot": "कोपायलट",
  "nav.advisor": "सलाहकार",
  "nav.settings": "सेटिंग्स",
  "nav.search": "खोजें",

  // Common actions
  "action.save": "सहेजें",
  "action.cancel": "रद्द करें",
  "action.delete": "हटाएँ",
  "action.retry": "पुनः प्रयास",
  "action.upload": "अपलोड करें",
  "action.run": "चलाएँ",
  "action.create": "बनाएँ",
  "action.close": "बंद करें",
  "action.loading": "लोड हो रहा है…",

  // Auth
  "auth.login.title": "साइन इन करें",
  "auth.login.cta": "साइन इन",
  "auth.signup.title": "अपना खाता बनाएँ",
  "auth.signup.cta": "साइन अप",
  "auth.email": "ईमेल",
  "auth.password": "पासवर्ड",
  "auth.forgot": "पासवर्ड भूल गए?",
  "auth.or": "या",
  "auth.logout": "साइन आउट",

  // Empty / errors
  "error.generic": "कुछ ग़लत हो गया। क्या हुआ: अनपेक्षित त्रुटि। कैसे ठीक करें: कार्रवाई दोबारा आज़माएँ।",
  "empty.generic": "यहाँ अभी कुछ नहीं है।",
  "empty.datasets": "अभी कोई डेटासेट नहीं — शुरू करने के लिए CSV या Excel फ़ाइल अपलोड करें।",

  // Locale switcher
  "locale.label": "भाषा",
  "locale.en": "English",
  "locale.hi": "हिन्दी",
  "locale.ur": "اردو",
} as const;

export default hi;
