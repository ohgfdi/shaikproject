"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/client/api";
import type { ClientPortalView, DocumentRegisterResult } from "@/lib/engine/ca-documents";

import { ErrorLine, Method, n, postCompute } from "./ca-practice-panels";

/**
 * Document management & client portal panel.
 *
 * The register is the practice's view (retention, completeness, version
 * conflicts, unsigned records); the portal is the client's view and shows only
 * the documents flagged as shared. Both POST to `/api/ca/compute`.
 */

const CATEGORIES = [
  { value: "engagement-letter", label: "Engagement letter" },
  { value: "working-paper", label: "Working paper" },
  { value: "financial-statement", label: "Financial statement" },
  { value: "tax-return", label: "Tax return" },
  { value: "audit-report", label: "Audit report" },
  { value: "gst-record", label: "GST record" },
  { value: "kyc", label: "KYC" },
  { value: "client-correspondence", label: "Client correspondence" },
  { value: "other", label: "Other" },
];

interface DocRow {
  id: string;
  name: string;
  category: string;
  clientId: string;
  clientName: string;
  uploadedAt: string;
  version: string;
  sizeBytes: string;
  signed: boolean;
  sharedWithClient: boolean;
}

const BLANK_DOC: DocRow = {
  id: "D1",
  name: "Engagement-letter.pdf",
  category: "engagement-letter",
  clientId: "C1",
  clientName: "Sharma Textiles Pvt Ltd",
  uploadedAt: "2025-01-10",
  version: "1",
  sizeBytes: "102400",
  signed: true,
  sharedWithClient: true,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocumentsPanel() {
  const [rows, setRows] = useState<DocRow[]>([
    { ...BLANK_DOC },
    {
      ...BLANK_DOC,
      id: "D2",
      name: "WP-1.xlsx",
      category: "working-paper",
      uploadedAt: "2025-03-01",
      version: "1",
      signed: false,
      sharedWithClient: false,
    },
    {
      ...BLANK_DOC,
      id: "D3",
      name: "ITR-FY25.pdf",
      category: "tax-return",
      uploadedAt: "2025-07-01",
      version: "1",
      signed: false,
      sharedWithClient: true,
    },
  ]);
  const [asOfDate, setAsOfDate] = useState("2026-10-16");
  const [register, setRegister] = useState<DocumentRegisterResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [portalClient, setPortalClient] = useState({ clientId: "C1", clientName: "Sharma Textiles Pvt Ltd" });
  const [awaiting, setAwaiting] = useState("kyc, financial-statement");
  const [portal, setPortal] = useState<ClientPortalView | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);

  const update = (i: number, patch: Partial<DocRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const payloadDocs = () =>
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      clientId: r.clientId,
      clientName: r.clientName,
      uploadedAt: r.uploadedAt,
      uploadedBy: "Workspace user",
      version: Math.max(1, Math.round(n(r.version))),
      sizeBytes: Math.max(0, Math.round(n(r.sizeBytes))),
      signed: r.signed,
      sharedWithClient: r.sharedWithClient,
    }));

  async function runRegister() {
    setBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ documentRegister: DocumentRegisterResult }>({
        kind: "documents",
        op: { op: "register", documents: payloadDocs(), asOfDate },
      });
      setRegister(res.documentRegister);
    } catch (err) {
      setRegister(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runPortal() {
    setPortalBusy(true);
    setError(null);
    try {
      const res = await postCompute<{ clientPortal: ClientPortalView }>({
        kind: "documents",
        op: {
          op: "client-portal",
          client: portalClient,
          documents: payloadDocs(),
          awaiting: awaiting
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean),
        },
      });
      setPortal(res.clientPortal);
    } catch (err) {
      setPortal(null);
      setError(errorMessage(err));
    } finally {
      setPortalBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Document register</CardTitle>
          <CardDescription>
            Retention due dates, engagement completeness, version conflicts and unsigned records. Retention periods
            follow the provision named on each row — verify them against your own policy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.map((r, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line bg-surface-2/30 p-2">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input label="Id" value={r.id} onChange={(e) => update(i, { id: e.target.value })} />
                <Input label="File name" value={r.name} onChange={(e) => update(i, { name: e.target.value })} />
                <Select
                  label="Category"
                  value={r.category}
                  onChange={(e) => update(i, { category: e.target.value })}
                  options={CATEGORIES}
                />
                <Input label="Client id" value={r.clientId} onChange={(e) => update(i, { clientId: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input
                  label="Client name"
                  value={r.clientName}
                  onChange={(e) => update(i, { clientName: e.target.value })}
                />
                <Input
                  label="Filed on"
                  type="date"
                  value={r.uploadedAt}
                  onChange={(e) => update(i, { uploadedAt: e.target.value })}
                />
                <Input
                  label="Version"
                  inputMode="numeric"
                  value={r.version}
                  onChange={(e) => update(i, { version: e.target.value })}
                />
                <Input
                  label="Size (bytes)"
                  inputMode="numeric"
                  value={r.sizeBytes}
                  onChange={(e) => update(i, { sizeBytes: e.target.value })}
                />
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <Checkbox label="Signed" checked={r.signed} onChange={(v) => update(i, { signed: v })} />
                <Checkbox
                  label="Shared with client"
                  checked={r.sharedWithClient}
                  onChange={(v) => update(i, { sharedWithClient: v })}
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  Remove document
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setRows([...rows, { ...BLANK_DOC, id: `D${rows.length + 1}`, name: "" }])}
          >
            + Document
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Input label="Register as at" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </div>
          <Button type="button" onClick={runRegister} loading={busy}>
            Build register
          </Button>
          <ErrorLine message={error} />

          {register ? (
            <div className="space-y-3">
              <p className="text-caption text-muted">
                {register.totalDocuments} documents · {formatBytes(register.totalBytes)} · {register.unshared} not
                shared · {register.unsigned.length} unsigned
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-caption uppercase tracking-wide text-muted">
                    <th className="py-1">Document</th>
                    <th className="py-1">Category</th>
                    <th className="py-1">Due</th>
                    <th className="py-1 text-right">Days left</th>
                  </tr>
                </thead>
                <tbody>
                  {register.retention.map((r) => (
                    <tr key={r.id} className="border-t border-line/60">
                      <td className="py-1.5">{r.name}</td>
                      <td className="py-1.5 text-caption text-muted">{r.category}</td>
                      <td className="py-1.5">{r.dueDate}</td>
                      <td
                        className={`py-1.5 text-right tabular-nums ${r.expired ? "text-danger" : r.daysRemaining <= 180 ? "text-amber-600" : ""}`}
                      >
                        {r.daysRemaining}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div
                className={`rounded-md border p-3 text-sm ${register.completeness.complete ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/40 bg-amber-500/10"}`}
              >
                {register.completeness.complete
                  ? "Every required category is on file."
                  : `Missing required categories: ${register.completeness.missing.join(", ")}`}
              </div>
              {register.versionConflicts.length ? (
                <ul className="space-y-1 text-caption text-amber-700 dark:text-amber-400">
                  {register.versionConflicts.map((c) => (
                    <li key={`${c.clientId}-${c.name}`}>
                      Version conflict: {c.name} for {c.clientId} exists as v{c.versions.join(", v")}
                    </li>
                  ))}
                </ul>
              ) : null}
              <Method steps={register.methodology} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Client portal view</CardTitle>
          <CardDescription>
            Exactly what the client sees: only documents flagged as shared, grouped into folders, plus what the practice
            is still waiting for.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Input
              label="Client id"
              value={portalClient.clientId}
              onChange={(e) => setPortalClient({ ...portalClient, clientId: e.target.value })}
            />
            <Input
              label="Client name"
              value={portalClient.clientName}
              onChange={(e) => setPortalClient({ ...portalClient, clientName: e.target.value })}
            />
          </div>
          <Input
            label="Awaiting from client (comma separated)"
            value={awaiting}
            onChange={(e) => setAwaiting(e.target.value)}
          />
          <Button type="button" onClick={runPortal} loading={portalBusy}>
            Open the portal
          </Button>

          {portal ? (
            <div className="space-y-3">
              <p className="text-caption text-muted">
                {portal.sharedCount} shared document(s) · {formatBytes(portal.totalBytes)}
              </p>
              {portal.folders.length ? (
                portal.folders.map((f) => (
                  <div key={f.category} className="rounded-md border border-line bg-surface-2/30 p-3">
                    <p className="text-sm font-medium text-foreground">{f.category}</p>
                    <ul className="mt-1 space-y-1 text-caption text-muted">
                      {f.documents.map((d) => (
                        <li key={d.id}>
                          {d.name} · {formatBytes(d.sizeBytes)} · filed {d.uploadedAt}{" "}
                          {d.signed ? "· signed" : "· unsigned"}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              ) : (
                <p className="text-caption text-muted">Nothing has been shared with this client yet.</p>
              )}
              {portal.checklist.length ? (
                <div>
                  <p className="text-sm font-medium text-foreground">Awaiting from the client</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-caption text-muted">
                    {portal.checklist.map((c: string) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export { DocumentsPanel };
