/**
 * Phase 22: White-Labeling & Custom Domain
 *
 * Provides white-label capabilities for SaaS deployments:
 * - Custom branding (logo, colors, themes)
 * - Custom domain mapping (app.company.com)
 * - Tenant-specific visual identity
 * - SAAS-friendly configuration
 *
 * Usage:
 *   import { getWhiteLabelConfig, applyWhiteLabel } from "@/lib/server/white-label";
 *
 *   const config = getWhiteLabelConfig(tenantId);
 *   applyWhiteLabel(document.body, config);
 */

import { prisma } from "@/lib/db";

export type BrandColor = {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  foreground: string;
};

export type BrandTheme = "light" | "dark" | "system";

export interface WhiteLabelConfig {
  companyName: string;
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  theme: BrandTheme;
  customJs?: string;
  customCss?: string;
}

/** Get white label config for a tenant/organization. */
export async function getWhiteLabelConfig(
  tenantId: string
): Promise<WhiteLabelConfig> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      name: true,
      logoUrl: true,
      faviconUrl: true,
      primaryColor: true,
      secondaryColor: true,
      theme: true,
      customJs: true,
      customCss: true,
    },
  });

  if (!tenant) {
    // Return default config
    return {
      companyName: "Ledgerly",
      primaryColor: "#0052cc",
      secondaryColor: "#e0e7ff",
      theme: "system",
    };
  }

  return {
    companyName: tenant.name || "Ledgerly",
    logoUrl: tenant.logoUrl ?? undefined,
    faviconUrl: tenant.faviconUrl ?? undefined,
    primaryColor: tenant.primaryColor || "#0052cc",
    secondaryColor: tenant.secondaryColor || "#e0e7ff",
    theme: (tenant.theme as BrandTheme) || "system",
    customJs: tenant.customJs ?? undefined,
    customCss: tenant.customCss ?? undefined,
  };
}

/** Apply white-label styling to the document. */
export function applyWhiteLabel(
  config: WhiteLabelConfig
): void {
  const { companyName, logoUrl, faviconUrl, primaryColor, theme } = config;

  // Update document title
  document.title = `${companyName} - Ledgerly`;

  // Apply custom CSS if provided
  if (config.customCss) {
    const styleElement = document.createElement("style");
    styleElement.textContent = config.customCss;
    document.head.appendChild(styleElement);
  }

  // Apply primary colors via CSS variables
  const style = document.createElement("style");
  style.textContent = `
    :root {
      --primary-color: ${primaryColor};
      --secondary-color: ${config.secondaryColor};
    }
    .brand-primary { color: var(--primary-color); }
    .brand-background { background: var(--primary-color); }
  `;
  document.head.appendChild(style);

  // Update logo if provided
  if (logoUrl) {
    const logoElements = document.querySelectorAll(".brand-logo, .logo");
    logoElements.forEach((el) => {
      ;(el as HTMLElement).innerHTML = `
        <img src="${logoUrl}" alt="${companyName}" style="height: 32px;">
      `;
    });
  }

  // Update favicon if provided
  if (faviconUrl) {
    const link = document.querySelector('link[rel="icon"]');
    if (link) {
      ;(link as HTMLLinkElement).href = faviconUrl;
    } else {
      const faviconLink = document.createElement("link");
      faviconLink.rel = "icon";
      faviconLink.href = faviconUrl;
      document.head.appendChild(faviconLink);
    }
  }

  // Update company name in header
  const companyNameElements = document.querySelectorAll(
    ".brand-name, .company-name"
  );
  companyNameElements.forEach((el) => {
    el.textContent = companyName;
  });
}

/** Set custom domain for a tenant. */
export async function setCustomDomain(
  tenantId: string,
  domain: string
): Promise<boolean> {
  try {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { customDomain: domain },
    });

    // In production, would also configure DNS, SSL, etc.
    console.log(`Custom domain ${domain} set for tenant ${tenantId}`);

    return true;
  } catch (error) {
    console.error("Failed to set custom domain:", error);
    return false;
  }
}

/** Get custom domain for a tenant. */
export async function getCustomDomain(tenantId: string): Promise<string | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { customDomain: true },
  });

  return tenant?.customDomain || null;
}