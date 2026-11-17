import { RotateCcw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { Table } from "@/components/ui/table";
import { requirePageAuth } from "@/lib/auth/guard";
import { fmtDateTime } from "@/lib/format";
import { withTenantDb } from "@/lib/server/tenant-db";

export const metadata = { title: "Audit Log" };

const PAGE_SIZE = 50;

const NULL_DATE = "0001-01-01";

function toReadableType(type: string): string {
  return type
    .split(".")
    .flatMap((part) => part.split("_"))
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

interface AuditSearchParams {
  type?: string;
  actor?: string;
  project?: string;
  from?: string;
  to?: string;
  offset?: string;
}

export default async function AuditLogPage(props: { searchParams: Promise<AuditSearchParams> }) {
  const searchParams = await props.searchParams;
  const ctx = await requirePageAuth();
  const workspaceId = ctx.workspace.id;

  const type = searchParams.type?.trim() || undefined;
  const actor = searchParams.actor?.trim() || undefined;
  const project = searchParams.project?.trim() || undefined;
  const fromString = searchParams.from && searchParams.from !== NULL_DATE ? searchParams.from : undefined;
  const toString = searchParams.to && searchParams.to !== NULL_DATE ? searchParams.to : undefined;
  const from = fromString ? new Date(`${fromString}T00:00:00.000Z`) : undefined;
  const to = toString ? new Date(`${toString}T23:59:59.999Z`) : undefined;
  const offset = Math.max(0, Number.parseInt(searchParams.offset ?? "0", 10) || 0);

  const where = {
    workspaceId,
    ...(type ? { type } : {}),
    ...(actor ? { actorId: actor } : {}),
    ...(project ? { projectId: project } : {}),
    ...(from || to ? { createdAt: { gte: from, lte: to } } : {}),
  };

  const [activities, total, distinctTypes, users, projects] = await Promise.all([
    withTenantDb(ctx, (db) =>
      db.activity.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: PAGE_SIZE,
        skip: offset,
        include: {
          actor: { select: { id: true, name: true, email: true } },
          project: { select: { id: true, name: true } },
        },
      }),
    ),
    withTenantDb(ctx, (db) =>
      db.activity.count({ where }),
    ),
    withTenantDb(ctx, (db) =>
      db.activity.findMany({ where: { workspaceId }, select: { type: true }, distinct: ["type"] }),
    ),
    withTenantDb(ctx, (db) =>
      db.user.findMany({
        where: { workspaceId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, email: true },
      }),
    ),
    withTenantDb(ctx, (db) =>
      db.project.findMany({
        where: { workspaceId },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
  )],
  );

  const eventTypes = Array.from(
    new Set([
      ...distinctTypes.map((t) => t.type),
      "PROJECT_CREATED",
      "DATASET_UPLOADED",
      "ANALYSIS_RUN",
      "INSIGHTS_GENERATED",
      "REPORT_EXPORTED",
      "MODEL_TRAINED",
      "SCHEDULE_RUN",
      "CONNECTOR_SYNCED",
      "SECURITY_SIGN_IN",
      "SECURITY_SIGN_OUT",
      "dataset.uploaded",
      "notebook.cell.run",
      "sql.query.run",
      "schedule.run.completed",
      "connector.sync.completed",
    ]),
  ).sort((a, b) => toReadableType(a).localeCompare(toReadableType(b)));

  const workspaceUsers = users;

  const hasFilters = Boolean(type || actor || project || from || to);
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filterProps: Record<string, string> = {};
  if (type) filterProps.type = type;
  if (actor) filterProps.actor = actor;
  if (project) filterProps.project = project;
  if (fromString) filterProps.from = fromString;
  if (toString) filterProps.to = toString;

  const pageUrl = (nextOffset: number) =>
    `/audit?${new URLSearchParams({ ...filterProps, offset: String(nextOffset) }).toString()}`;

  return (
    <div>
      <PageHeader
        title="Audit Log"
        description="Read-only audit trail of sign-ins, dataset uploads, analysis creation, insight generation, report exports, model training, scheduled report triggers, and SSO login events."
      />

      <div className="mt-6">
        <h2 className="text-h3 text-foreground mb-3">Activity Feed</h2>
        <p className="text-caption text-muted mb-4">
          The audit log records all significant workspace events. No sensitive data (passwords, API keys) is logged.
        </p>
      </div>

      <form method="get" action="/audit" className="mt-4 mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <label className="block">
          <span className="mb-1 block text-caption font-medium text-foreground">Event</span>
          <select
            name="type"
            defaultValue={type ?? ""}
            className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-foreground"
          >
            <option value="">All events</option>
            {eventTypes.map((t) => (
              <option key={t} value={t}>
                {toReadableType(t)}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-caption font-medium text-foreground">User</span>
          <select
            name="actor"
            defaultValue={actor ?? ""}
            className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-foreground"
          >
            <option value="">All users</option>
            {workspaceUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-caption font-medium text-foreground">Project</span>
          <select
            name="project"
            defaultValue={project ?? ""}
            className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-foreground"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-caption font-medium text-foreground">From</span>
          <input
            type="date"
            name="from"
            defaultValue={fromString ?? ""}
            className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-foreground"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-caption font-medium text-foreground">To</span>
          <input
            type="date"
            name="to"
            defaultValue={toString ?? ""}
            className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-foreground"
          />
        </label>

        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
          >
            Apply
          </button>
          {hasFilters && (
            <ButtonLink href="/audit" variant="ghost" size="sm" icon={<RotateCcw aria-hidden className="size-3.5" />}>
              Reset
            </ButtonLink>
          )}
        </div>
      </form>

      {activities.length === 0 && (
        <Card className="p-6 text-muted">
          <p>
            {hasFilters
              ? "No activity matches the selected filters."
              : "No activities recorded yet. Actions like dataset uploads, analysis runs, report exports, and model training will appear here."}
          </p>
        </Card>
      )}

      {activities.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr className="border-b border-line bg-surface/50">
                <th className="text-left text-caption font-medium text-foreground px-3 py-2">WHEN</th>
                <th className="text-left text-caption font-medium text-foreground px-3 py-2">ACTION</th>
                <th className="text-left text-caption font-medium text-foreground px-3 py-2">USER</th>
                <th className="text-left text-caption font-medium text-foreground px-3 py-2">DETAILS</th>
                <th className="text-left text-caption font-medium text-foreground px-3 py-2">PROJECT</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((a) => (
                <tr key={a.id} className="border-b border-line bg-surface/20 hover:bg-surface/30">
                  <td className="px-3 py-2">
                    <span className="text-caption text-muted">{fmtDateTime(a.createdAt)}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-caption font-medium text-foreground">{toReadableType(a.type)}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-caption text-muted">{a.actor?.name ?? "System"}</span>
                  </td>
                  <td className="max-w-md px-3 py-2">
                    <span className="block truncate text-caption text-muted" title={a.message ?? ""}>
                      {a.message ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-caption text-muted">{a.project?.name ?? "—"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-caption text-muted">
            Page {page} of {pageCount} · {total.toLocaleString()} events
          </p>
          <div className="flex items-center gap-2">
            <ButtonLink
              href={pageUrl(Math.max(0, offset - PAGE_SIZE))}
              variant={offset === 0 ? "ghost" : "secondary"}
              size="sm"
              aria-disabled={offset === 0}
              className={offset === 0 ? "pointer-events-none opacity-50" : undefined}
            >
              Previous
            </ButtonLink>
            <ButtonLink
              href={pageUrl(offset + PAGE_SIZE)}
              variant={offset + PAGE_SIZE >= total ? "ghost" : "secondary"}
              size="sm"
              aria-disabled={offset + PAGE_SIZE >= total}
              className={offset + PAGE_SIZE >= total ? "pointer-events-none opacity-50" : undefined}
            >
              Next
            </ButtonLink>
          </div>
        </div>
      )}

      <div className="mt-8 pt-8 border-t border-line">
        <p className="text-caption text-muted">
          Audit logging is always active and append-only — entries are never edited or deleted. No passwords, API keys,
          or PII are ever stored in audit entries.
        </p>
      </div>
    </div>
  );
}
