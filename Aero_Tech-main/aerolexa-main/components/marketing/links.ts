/** Anchor navigation used by the marketing header, mobile menu and footer. */

export const NAV_LINKS = [
  { href: "#product", label: "Product" },
  { href: "#use-cases", label: "Who it's for" },
  { href: "/templates", label: "Templates" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
] as const;

export const FOOTER_LINKS = {
  Product: [
    { href: "#product", label: "Features" },
    { href: "/templates", label: "Analysis templates" },
    { href: "#how", label: "How it works" },
    { href: "#pricing", label: "Pricing" },
    { href: "#faq", label: "FAQ" },
  ],
  Workspace: [
    { href: "/login", label: "Sign in" },
    { href: "/signup", label: "Get started" },
    { href: "/dashboard", label: "Dashboard" },
    { href: "/studio", label: "Dashboard builder" },
  ],
  About: [
    { href: "/signup", label: "Start free" },
    { href: "/login", label: "Sign in" },
    { href: "#transparency", label: "Transparency" },
    { href: "#faq", label: "Support" },
  ],
} as const;
