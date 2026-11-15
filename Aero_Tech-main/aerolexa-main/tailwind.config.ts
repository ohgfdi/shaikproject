import type { Config } from "tailwindcss";

/**
 * Ledgerly design tokens — see docs/design-system.md.
 *
 * Semantic tokens are defined as CSS variables in styles/globals.css and mapped
 * here, so light/dark themes and the user-selectable accent colour resolve
 * automatically at runtime without swapping Tailwind class names.
 */
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Colours live in styles/globals.css under @theme inline — Tailwind v4
      // resolves opacity modifiers there, which <alpha-value> placeholders in a
      // JS config do not do.
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        // Typographic scale — 1rem = 16px, line-height 1.5
        h1: ["2rem", { lineHeight: "1.3", letterSpacing: "-0.02em", fontWeight: "650" }], // 32px
        h2: ["1.5rem", { lineHeight: "1.35", letterSpacing: "-0.015em", fontWeight: "650" }], // 24px
        h3: ["1.25rem", { lineHeight: "1.4", letterSpacing: "-0.01em", fontWeight: "600" }], // 20px
        body: ["1rem", { lineHeight: "1.5" }], // 16px
        caption: ["0.75rem", { lineHeight: "1.5" }], // 12px
      },
      borderRadius: {
        // Design token: 4px radius, small and precise
        DEFAULT: "4px",
        sm: "3px",
        md: "4px",
        lg: "6px",
        xl: "8px",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(0 0 0 / 0.3), 0 1px 3px 0 rgb(0 0 0 / 0.18)",
        pop: "0 4px 6px -1px rgb(0 0 0 / 0.35), 0 2px 4px -2px rgb(0 0 0 / 0.25)",
        focus: "0 0 0 2px rgb(var(--focus) / 0.4)",
      },
      animation: {
        "fade-in": "fadeIn 180ms ease-out",
        "slide-up": "slideUp 220ms ease-out",
        shimmer: "shimmer 1.6s linear infinite",
        marquee: "marquee 32s linear infinite",
        float: "float 7s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: { from: { opacity: "0" }, to: { opacity: "1" } },
        slideUp: {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: { "0%": { backgroundPosition: "-400px 0" }, "100%": { backgroundPosition: "400px 0" } },
        // Marketing site: slow horizontal scroll for the tech-stack strip.
        marquee: { from: { transform: "translateX(0)" }, to: { transform: "translateX(-50%)" } },
        // Marketing site: gentle float for hero mockup accent cards.
        float: { "0%, 100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-8px)" } },
      },
    },
  },
  plugins: [],
};

export default config;
