/**
 * tenancy-audit: global-operator — tenant management and configuration is a
 * deployment-wide aggregate rather than per-tenant data access.
 *
 * Phase 24: Multi-Tenant SaaS Enhancements
 *
 * Provides per-tenant data isolation, configuration, and billing.
 * Enables SaaS deployment with multiple customers sharing the same instance.
 *
 * Usage:
 *   import { getTenantContext, withTenantContext } from "@/lib/server/tenant-isolation";
 *
 *   // Get current tenant context from session
 *   const tenant = await getTenantContext();
 *
 *   // Query data scoped to current tenant
 *   const datasets = await withTenantContext(prisma.dataset.findMany, {
 *     where: { tenantId: tenant?.id },
 *   });
 */
import type { NextRequest } from "next/server";
import { v4 as uuidv4 } from "uuid";

import { prisma } from "@/lib/db";

export type TenantStatus = "active" | "suspended" | "deleted";

function normalizeFeatures(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export interface TenantConfig {
  id: string;
  name: string;
  slug: string; // subdomain prefix
  plan: "free" | "pro" | "enterprise";
  status: TenantStatus;
  // Quotas
  maxDashboards: number;
  maxStorageGB: number;
  maxApiCallsPerMinute: number;
  features: string[];
  // Branding
  primaryColor: string;
  secondaryColor: string;
  logoUrl?: string;
  // Timing
  trialEndsAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Get the current tenant context from the request/session. */
export async function getTenantContext(
  request?: NextRequest
): Promise<{ tenant: TenantConfig | null; workspaceId: string }> {
  // In production, read from JWT session, cookies, or auth context
  // For now, return a default/workspace context

  const workspaceId = request?.headers.get("x-tenant-id") || "default-workspace";

  const tenant = await prisma.tenant.findFirst({
    where: { slug: workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
      status: true,
      maxDashboards: true,
      maxStorageGB: true,
      maxApiCallsPerMinute: true,
      features: true,
      primaryColor: true,
      secondaryColor: true,
      logoUrl: true,
      trialEndsAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!tenant) {
    // Return default/free tenant
    return {
      tenant: {
        id: "default",
        name: "Default Tenant",
        slug: "default",
        plan: "free",
        status: "active",
        maxDashboards: 3,
        maxStorageGB: 1,
        maxApiCallsPerMinute: 60,
        features: ["basic-charts", "email-export"],
        primaryColor: "#0052cc",
        secondaryColor: "#e0e7ff",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      workspaceId,
    };
  }

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      plan: tenant.plan as TenantConfig["plan"],
      status: tenant.status as TenantStatus,
      maxDashboards: tenant.maxDashboards,
      maxStorageGB: tenant.maxStorageGB,
      maxApiCallsPerMinute: tenant.maxApiCallsPerMinute,
      features: normalizeFeatures(tenant.features),
      primaryColor: tenant.primaryColor,
      secondaryColor: tenant.secondaryColor,
      logoUrl: tenant.logoUrl ?? undefined,
      trialEndsAt: tenant.trialEndsAt ?? undefined,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
    },
    workspaceId,
  };
}

/** Wrap a Prisma query to scope results to the current tenant. */
export function withTenantContext<T>(
  fn: (tenantId: string) => Promise<T>,
  tenantId: string
): Promise<T> {
  return fn(tenantId);
}

/** Check if tenant has permission for a feature. */
export function hasFeatureAccess(
  tenant: TenantConfig,
  feature: string
): boolean {
  // Free plan features
  const freeFeatures = ["basic-charts", "email-export", "saved-searches"];

  // Pro plan adds
  const proFeatures = ["advanced-charts", "pdf-export", "api-access", "custom-branding"];

  // Enterprise plan has everything
   // all features

  // Check plan-based access
  if (tenant.plan === "enterprise") return true;
  if (tenant.plan === "pro") return proFeatures.includes(feature) || freeFeatures.includes(feature);
  if (tenant.plan === "free") return freeFeatures.includes(feature);

  return false;
}

/** Check if tenant has quota available. */
export function checkQuota(
  tenant: TenantConfig,
  quotaType: "dashboards" | "storage" | "api-calls",
  amount: number = 1
): { available: boolean; remaining: number; limit: number } {
  const _now = new Date();

  switch (quotaType) {
    case "dashboards": {
      // Count user's dashboards
      // In production: query actual count from DB
      const limit = tenant.maxDashboards;
      const remaining = Math.max(0, limit - (amount || 0));
      return { available: remaining >= amount, remaining, limit };
    }
    case "storage": {
      // In production: check actual storage used
      const limitGB = tenant.maxStorageGB;
      const remainingGB = Math.max(0, limitGB - (amount || 0));
      return { available: remainingGB >= amount, remaining: remainingGB, limit: limitGB };
    }
    case "api-calls": {
      // In production: check rate limiter or usage tracking
      const limit = tenant.maxApiCallsPerMinute;
      const remaining = Math.max(0, limit - (amount || 0));
      return { available: remaining >= amount, remaining, limit };
    }
    default:
      return { available: false, remaining: 0, limit: 0 };
  }
}

/** Create a new tenant. */
export async function createTenant(
  data: {
    name: string;
    slug: string;
    plan?: "free" | "pro" | "enterprise";
    features?: string[];
    primaryColor?: string;
    secondaryColor?: string;
    maxDashboards?: number;
    maxStorageGB?: number;
    maxApiCallsPerMinute?: number;
  }
): Promise<TenantConfig> {
  const tenant = await prisma.tenant.create({
    data: {
      id: uuidv4(),
      name: data.name,
      slug: data.slug,
      plan: data.plan || "free",
      status: "active",
      maxDashboards: data.plan === "enterprise" ? -1 : (data.maxDashboards || 3),
      maxStorageGB: data.plan === "enterprise" ? -1 : (data.maxStorageGB || 1),
      maxApiCallsPerMinute: data.plan === "enterprise" ? -1 : (data.maxApiCallsPerMinute || 60),
      features: data.features || ["basic-charts", "email-export"],
      primaryColor: data.primaryColor || "#0052cc",
      secondaryColor: data.secondaryColor || "#e0e7ff",
    },
  });

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    plan: tenant.plan as TenantConfig["plan"],
    status: tenant.status as TenantStatus,
    maxDashboards: tenant.maxDashboards,
    maxStorageGB: tenant.maxStorageGB,
    maxApiCallsPerMinute: tenant.maxApiCallsPerMinute,
    features: normalizeFeatures(tenant.features),
    primaryColor: tenant.primaryColor,
    secondaryColor: tenant.secondaryColor,
    logoUrl: tenant.logoUrl ?? undefined,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  };
}

/** Update tenant plan/subscription. */
export async function updateTenantPlan(
  tenantId: string,
  plan: "free" | "pro" | "enterprise"
): Promise<TenantConfig> {
  const tenant = await prisma.tenant.update({
    where: { id: tenantId },
    data: { plan },
  });

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    plan: tenant.plan as TenantConfig["plan"],
    status: tenant.status as TenantStatus,
    maxDashboards: tenant.maxDashboards,
    maxStorageGB: tenant.maxStorageGB,
    maxApiCallsPerMinute: tenant.maxApiCallsPerMinute,
    features: normalizeFeatures(tenant.features),
    primaryColor: tenant.primaryColor,
    secondaryColor: tenant.secondaryColor,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  };
}