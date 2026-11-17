/**
 * Phase 29: Mobile API Utilities
 *
 * Provides mobile-optimized API endpoints for the React Native app.
 * Handles tenant-scoped queries, error summaries, and export formatting.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";

/** Fetch dashboard data scoped to tenant. */
export async function fetchDashboardData(
  tenantId: string
): Promise<{
  charts: Array<{ id: string; title: string; type: string; lastUpdated: Date }>;
  kpis: Array<{ id: string; label: string; value: string; color: string }>;
  activity: Array<{ id: string; message: string; timestamp: Date }>;
}> {
  const charts = await prisma.chart.findMany({
    where: { tenantId },
    select: {
      id: true,
      title: true,
      type: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
  });

  const kpis = await prisma.kpi.findMany({
    where: { tenantId },
    select: {
      id: true,
      label: true,
      value: true,
      color: true,
    },
    orderBy: { createdAt: "desc" },
    take: 6,
  });

  const activity = await prisma.auditLog.findMany({
    where: { organizationId },
    select: {
      id: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return {
    charts: charts.map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
      lastUpdated: c.updatedAt,
    })),
    kpis: kpis.map((k) => ({
      id: k.id,
      label: k.label,
      value: k.value || "0",
      color: k.color || "#0052cc",
    })),
    activity: activity.map((a) => ({
      id: a.id,
      timestamp: a.createdAt,
    })),
  };
}

/** Fetch error summary for mobile display. */
export async function fetchErrorSummary(
  tenantId: string
): Promise<{
  totalErrors: number;
  criticalErrors: number;
  errorByType: Record<string, number>;
  recentErrors: Array<{ id: string; message: string; timestamp: Date; fingerprint: string }>;
}> {
  const errors = await prisma.errorTracking.findMany({
    where: { tenantId },
    select: {
      id: true,
      message: true,
      fingerprint: true,
      createdAt: true,
      severity: true,
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const errorByType: Record<string, number> = {};
  let totalErrors = 0;
  let criticalErrors = 0;

  errors.forEach((err) => {
    totalErrors++;
    errorByType[err.fingerprint] = (errorByType[err.fingerprint] || 0) + 1;
    if (err.severity === "critical") {
      criticalErrors++;
    }
  });

  return {
    totalErrors,
    criticalErrors,
    errorByType,
    recentErrors: errors.map((err) => ({
      id: err.id,
      message: err.message || "Unknown error",
      timestamp: err.createdAt,
      fingerprint: err.fingerprint,
    })),
  };
}

/** Health check for mobile connectivity. */
export async function checkMobileHealth(
  tenantId: string
): Promise<{
  status: "ok" | "error";
  database: "connected" | "disconnected";
  rls: "enabled" | "disabled";
  lastSync: Date;
  version: string;
}> {
  try {
    // Simple database connectivity check
    await prisma.$queryRaw`SELECT 1`;

    return {
      status: "ok",
      database: "connected",
      rls: "enabled",
      lastSync: new Date(),
      version: "1.0.0",
    };
  } catch (error) {
    return {
      status: "error",
      database: "disconnected",
      rls: "disabled",
      lastSync: new Date(),
      version: "1.0.0",
    };
  }
}

/** Export data in mobile-optimized format. */
export async function exportMobileData(
  tenantId: string,
  format: "csv" | "json"
): Promise<{ success: boolean; data: string; filename: string }> {
  const records = await prisma.$queryRaw<
    Array<{ id: string; value: string; label: string; createdAt: Date }>
  >`SELECT * FROM tenant_data WHERE "tenantId" = ${tenantId}`;

  let csvContent = "";
  const jsonData: Array<{ id: string; value: string; label: string; createdAt: Date }> = [];

  // Transform to both formats
  if (format === "csv") {
    // CSV generation logic
    csvContent = "id,value,label\n";
    records.forEach((row: any) => {
      csvContent += `${row.id},${row.value},${row.label}\n`;
    });
  } else {
    records.forEach((row: any) => {
      jsonData.push({
        id: row.id,
        value: row.value,
        label: row.label,
        createdAt: row.createdAt,
      });
    });
  }

  const formatter =
    format === "csv"
      ? "text/csv"
      : "application/json";
  const filename = `ledgerly-${tenantId}-${new Date()
    .toISOString()
    .split("T")[0]}.${format}`;

  return {
    success: true,
    data: format === "csv" ? csvContent : JSON.stringify(jsonData, null, 2),
    filename,
  };
}