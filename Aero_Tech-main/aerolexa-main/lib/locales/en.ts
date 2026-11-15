/**
 * English dictionary — the fallback locale. Every key here is the contract;
 * other locales may cover a subset (missing keys fall back to English).
 */

const en = {
  // Brand & shell
  "brand.tagline": "From raw data to boardroom decisions",
  "nav.dashboard": "Dashboard",
  "nav.projects": "Projects",
  "nav.copilot": "Copilot",
  "nav.advisor": "Advisor",
  "nav.settings": "Settings",
  "nav.search": "Search",

  // Common actions
  "action.save": "Save",
  "action.cancel": "Cancel",
  "action.delete": "Delete",
  "action.retry": "Retry",
  "action.upload": "Upload",
  "action.run": "Run",
  "action.create": "Create",
  "action.close": "Close",
  "action.loading": "Loading…",

  // Auth
  "auth.login.title": "Sign in",
  "auth.login.cta": "Sign in",
  "auth.signup.title": "Create your account",
  "auth.signup.cta": "Sign up",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.forgot": "Forgot password?",
  "auth.or": "or",
  "auth.logout": "Sign out",

  // Empty / errors
  "error.generic": "Something went wrong. What happened: an unexpected error. How to fix: retry the action.",
  "empty.generic": "Nothing here yet.",
  "empty.datasets": "No datasets yet — upload a CSV or Excel file to begin.",

  // Locale switcher
  "locale.label": "Language",
  "locale.en": "English",
  "locale.hi": "हिन्दी",
  "locale.ur": "اردو",
} as const;

export type TranslationKey = keyof typeof en;
export default en;
