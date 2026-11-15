import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
export const dynamic = "force-dynamic";
/**
 * POST /api/gst/entities — create a new multi-GSTIN entity
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const registrationSchema = z.object({
      gstin: z.string().trim().min(15).max(15),
      legalName: z.string().trim().min(1),
      tradeName: z.string().optional(),
      stateCode: z.string().trim().min(2).max(2),
      stateName: z.string().trim().min(1),
      registrationType: z.enum([
        "regular",
        "composition",
        "tcs-collector",
        "tds-deductor",
        "non-resident",
        "casual",
        "isd",
      ]),
      status: z.enum(["active", "suspended", "cancelled", "pending-verification"]),
      registrationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      cancellationDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      constitution: z.enum(["proprietorship", "partnership", "company", "llp", "huf", "trust", "government", "other"]),
      address: z.string(), // JSON
      authorizedSignatories: z.string(), // JSON
    });
    const body = z
      .object({
        workspaceId: z.string(),
        bookId: z.string().optional(),
        entityName: z.string().trim().min(1),
        pan: z.string().trim().min(10).max(10),
        entityType: z.enum(["company", "llp", "partnership", "proprietorship", "huf", "trust", "other"]),
        primaryGstin: z.string().trim().min(15).max(15),
        gstinRegistrations: z.array(registrationSchema).min(1),
        createdById: z.string(),
      })
      .parse(await readJsonBody(request));
    const entity = await prisma.gstEntity.create({
      data: {
        workspaceId: body.workspaceId,
        bookId: body.bookId,
        entityName: body.entityName,
        pan: body.pan,
        entityType: body.entityType,
        primaryGstin: body.primaryGstin,
        createdById: body.createdById,
        gstinRegistrations: {
          create: body.gstinRegistrations.map((r) => ({
            gstin: r.gstin,
            legalName: r.legalName,
            tradeName: r.tradeName,
            stateCode: r.stateCode,
            stateName: r.stateName,
            registrationType: r.registrationType,
            status: r.status,
            registrationDate: r.registrationDate,
            cancellationDate: r.cancellationDate,
            constitution: r.constitution,
            address: r.address,
            authorizedSignatories: r.authorizedSignatories,
            workspaceId: body.workspaceId,
          })),
        },
      },
      include: {
        gstinRegistrations: true,
      },
    });
    return ok({ entity });
  } catch (err) {
    return toErrorResponse(err);
  }
}
/**
 * GET /api/gst/entities — list entities for a workspace
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const bookId = searchParams.get("bookId");
    if (!workspaceId) {
      return toErrorResponse(new Error("workspaceId is required"));
    }
    const entities = await prisma.gstEntity.findMany({
      where: {
        workspaceId,
        ...(bookId ? { bookId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return ok({ entities });
  } catch (err) {
    return toErrorResponse(err);
  }
}
