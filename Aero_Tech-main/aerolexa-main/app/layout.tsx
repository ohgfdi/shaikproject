import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";

import "../styles/globals.css";

import { ErrorReporter } from "@/components/error-reporter";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { PWAProvider } from "@/components/pwa/provider";
import { ServiceWorkerRegistrar } from "@/components/pwa/service-workerRegistrar";
import { ConfirmProvider } from "@/components/ui/confirm";
import { ToastProvider } from "@/components/ui/overlays";
import { BRAND, BRAND_STORAGE_KEYS, readBrandCookie } from "@/lib/brand";
import { appUrl } from "@/lib/env";
import { dirFor } from "@/lib/i18n";
import type {} from "@/lib/i18n";
import { resolveLocale } from "@/lib/i18n-server";
import { parseTheme, parseAccent } from "@/lib/theme";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    default: BRAND.name,
    template: `%s | ${BRAND.name}`,
  },
  description:
    "Data-driven analytics workspace for CA firms, consultants & SMBs. From raw data to boardroom decisions.",
  keywords: ["accounting", "analytics", "GST", "financial reporting", "CA firms", "insights"],
  authors: [{ name: BRAND.name }],
  creator: BRAND.name,
  openGraph: {
    type: "website",
    locale: "en_IN",
    url: appUrl(),
    siteName: BRAND.name,
    title: BRAND.name,
    description:
      "Data-driven analytics workspace for CA firms, consultants & SMBs. From raw data to boardroom decisions.",
    images: [{ url: `${appUrl()}/apple-touch-icon.png`, width: 180, height: 180 }],
  },
  twitter: {
    card: "summary_large_image",
    title: BRAND.name,
    description:
      "Data-driven analytics workspace for CA firms, consultants & SMBs. From raw data to boardroom decisions.",
    images: [{ url: `${appUrl()}/apple-touch-icon.png` }],
  },
  robots: {
    index: true,
    follow: true,
  },
  // Next emits <link rel="manifest"> from this field. Without it the app is
  // not installable, no matter how complete public/manifest.json is.
  manifest: "/manifest.json",
  icons: {
    icon: "/icons/icon.svg",
    apple: "/icons/icon.svg",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: BRAND.name,
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0ea5e9",
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const theme = parseTheme(readBrandCookie<string>(store, BRAND_STORAGE_KEYS.theme)?.value);
  const accent = parseAccent(readBrandCookie<string>(store, BRAND_STORAGE_KEYS.accent)?.value);
  const locale = await resolveLocale();
  return (
    <html
      lang={locale}
      dir={dirFor(locale)}
      className={`${inter.variable} ${theme}`}
      data-accent={accent}
      suppressHydrationWarning
    >
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content={BRAND.name} />
        <meta name="theme-color" content="#0ea5e9" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0ea5e9" media="(prefers-color-scheme: dark)" />
        <link rel="icon" type="image/svg+xml" href="/icons/icon.svg" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192x192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icons/icon-512x512.png" />
        <link rel="mask-icon" href="/icons/icon.svg" color="#0ea5e9" />
      </head>
      <body className="min-h-screen">
        <LocaleProvider locale={locale}>
          {/* /sw.js is registered from the root layout so every route gets the
              offline shell; the registrar is a render-noop. */}
          <ServiceWorkerRegistrar />
          <PWAProvider>
            <ErrorReporter />
            <ConfirmProvider>
              <ToastProvider>{children}</ToastProvider>
            </ConfirmProvider>
          </PWAProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
