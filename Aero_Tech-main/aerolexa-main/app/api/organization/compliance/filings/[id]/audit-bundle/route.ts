import { NextResponse } from "next/server";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/server/api";
import { buildApprovalAuditBundle } from "@/lib/server/receipt-audit-bundle";
import { renderApprovalReceiptPdf } from "@/lib/server/receipt-pdf";
import { withTenantDb } from "@/lib/server/tenant-db";

export const dynamic = "force-dynamic";

/**
 * GET — download the approval audit bundle for one filing run.
 *
 * Scoped to the caller's active organization; a run id from another tenant is
 * indistinguishable from a missing run.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const organization = ctx.organization;
    if (!organization) {
      throw new ApiError(400, "NO_ORGANIZATION", "This account is not attached to a firm organization.");
    }

    const run = await withTenantDb(ctx, (db) =>
      db.complianceFilingRun.findFirst({
        where: { id, organizationId: organization.id },
        select: {
          id: true,
          taskId: true,
          title: true,
          authority: true,
          dueDate: true,
          stage: true,
          filedAt: true,
          acknowledgementReference: true,
          verificationStatus: true,
          clientApprovedAt: true,
          clientApprovalReceipt: true,
          clientApprovalDigest: true,
          engagement: { select: { name: true } },
          events: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              fromStage: true,
              toStage: true,
              note: true,
              actorId: true,
              createdAt: true,
            },
          },
        },
      }),
    );
    if (!run) throw new ApiError(404, "NOT_FOUND", "Filing run not found.");

    const bundle = buildApprovalAuditBundle({
      organization: { id: organization.id, name: organization.name },
      engagementName: run.engagement.name,
      generatedAt: new Date(),
      run: {
        id: run.id,
        taskId: run.taskId,
        title: run.title,
        authority: run.authority,
        dueDate: run.dueDate,
        stage: run.stage,
        filedAt: run.filedAt ? run.filedAt.toISOString() : null,
        acknowledgementReference: run.acknowledgementReference,
        verificationStatus: run.verificationStatus,
        clientApprovedAt: run.clientApprovedAt ? run.clientApprovedAt.toISOString() : null,
        clientApprovalReceipt: run.clientApprovalReceipt,
        clientApprovalDigest: run.clientApprovalDigest,
      },
      events: run.events.map((event) => ({
        id: event.id,
        fromStage: event.fromStage,
        toStage: event.toStage,
        note: event.note,
        actorId: event.actorId,
        createdAt: event.createdAt.toISOString(),
      })),
    });

    const format = new URL(_request.url).searchParams.get("format");
    if (format === "pdf") {
      const pdf = renderApprovalReceiptPdf(bundle);
      return new NextResponse(new Uint8Array(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="approval-bundle-${run.id}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="approval-bundle-${run.id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
