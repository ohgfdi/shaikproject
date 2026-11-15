"use client";

import { ArrowLeft, Building2, CalendarClock, CheckCircle2, FileText, IndianRupee, Lock, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, CardContent, Spinner } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";

interface PortalSnapshot {
  engagement: { name: string; code: string | null };
  firmName: string;
  linkExpiresAt: string;
  deliverables: {
    id: string;
    formatCode: string;
    label: string;
    revision: number;
    issuedAt: string | null;
    udin: string | null;
    documentReference: string | null;
  }[];
  uploads: {
    id: string;
    filename: string;
    sizeBytes: number;
    note: string | null;
    uploadedAt: string;
  }[];
  requests: {
    id: string;
    title: string;
    category: string;
    period: string | null;
    dueDate: string;
    notes: string | null;
  }[];
  compliance: {
    id: string;
    title: string;
    authority: string;
    period: string;
    dueDate: string;
    state: string;
  }[];
  filings: {
    id: string;
    title: string;
    authority: string;
    dueDate: string;
    stage: string;
    acknowledgementReference: string | null;
    canApprove: boolean;
    verificationStatus: string;
    verificationNote: string | null;
    filedAt: string | null;
    clientApprovedAt: string | null;
    clientApprovalDigest: string | null;
  }[];
  invoices: {
    id: string;
    number: string;
    issuedOn: string;
    dueDate: string;
    totalMinor: number;
    status: string;
    paidOn: string | null;
    paymentReference: string | null;
  }[];
  statement: {
    date: string;
    kind: "invoice" | "payment";
    reference: string;
    description: string;
    debitMinor: number;
    creditMinor: number;
    balanceMinor: number;
  }[];
  balanceMinor: number;
  payments: { enabled: boolean; keyId: string | null };
}

type RazorpayInstance = { open: () => void };
type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

/** Load Checkout.js once, only when the client actually clicks Pay. */
async function loadRazorpay(): Promise<RazorpayConstructor> {
  const w = window as unknown as { Razorpay?: RazorpayConstructor };
  if (w.Razorpay) return w.Razorpay;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the payment window. Try again or pay by bank transfer."));
    document.body.appendChild(script);
  });
  if (!w.Razorpay) throw new Error("Could not load the payment window. Try again or pay by bank transfer.");
  return w.Razorpay;
}

const FILING_STAGE_LABEL: Record<string, string> = {
  reviewed: "Awaiting your approval",
  "client-approved": "Approved",
  filed: "Filed",
  acknowledged: "Acknowledged",
};

interface RenderedDeliverable {
  versionId: string;
  formatLabel: string;
  revision: number;
  assembledBody: string;
  parts: { heading: string; body: string }[];
  redactions: { policy: string; appliesTo: string }[];
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? dateFmt.format(date) : "—";
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function money(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/**
 * The client's side of the portal. Deliberately narrow: issued deliverables the
 * firm published to this client, plus a way to send documents back. No firm
 * navigation, no internal identifiers, no markup from the server is interpreted
 * as HTML.
 */
export function ClientPortal({ token }: { token: string }) {
  const [snapshot, setSnapshot] = useState<PortalSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RenderedDeliverable | null>(null);
  const [viewing, setViewing] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approverName, setApproverName] = useState("");
  const [paying, setPaying] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ portal: PortalSnapshot }>(`/api/portal/${encodeURIComponent(token)}`);
      setSnapshot(data.portal);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const view = useCallback(
    async (id: string) => {
      setViewing(true);
      setSelected(null);
      try {
        const data = await api<{ deliverable: RenderedDeliverable }>(
          `/api/portal/${encodeURIComponent(token)}/deliverables/${id}`,
        );
        setSelected(data.deliverable);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setViewing(false);
      }
    },
    [token],
  );

  const upload = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!file) {
        setUploadError("Choose a document to upload.");
        return;
      }
      setUploading(true);
      setUploadError(null);
      setUploadNote(null);
      try {
        const form = new FormData();
        form.set("file", file);
        if (note.trim()) form.set("note", note.trim());
        if (requestId) form.set("requestId", requestId);
        await api(`/api/portal/${encodeURIComponent(token)}/uploads`, { method: "POST", body: form });
        setFile(null);
        setNote("");
        setRequestId("");
        setUploadNote(
          requestId
            ? "Document received and the request is now closed. Your CA firm can see both."
            : "Document received. Your CA firm can now see it.",
        );
        await load();
      } catch (err) {
        setUploadError(errorMessage(err));
      } finally {
        setUploading(false);
      }
    },
    [file, note, requestId, token, load],
  );

  const approve = useCallback(
    async (id: string) => {
      setApproving(id);
      setApproveError(null);
      try {
        await api(`/api/portal/${encodeURIComponent(token)}/filings/${id}/approve`, {
          method: "POST",
          body: JSON.stringify({ approvedBy: approverName.trim() || null }),
        });
        await load();
      } catch (err) {
        setApproveError(errorMessage(err));
      } finally {
        setApproving(null);
      }
    },
    [token, load, approverName],
  );

  const pay = useCallback(
    async (invoiceId: string) => {
      setPaying(invoiceId);
      setPayError(null);
      try {
        const data = await api<{
          payment: { orderId: string; amountMinor: number; currency: string; keyId: string; invoiceNumber: string };
        }>(`/api/portal/${encodeURIComponent(token)}/invoices/${invoiceId}/pay`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        const { payment } = data;
        const Razorpay = await loadRazorpay();
        const checkout = new Razorpay({
          key: payment.keyId,
          order_id: payment.orderId,
          amount: payment.amountMinor,
          currency: payment.currency,
          name: snapshot?.firmName ?? "Your CA firm",
          description: `Invoice ${payment.invoiceNumber}`,
          handler: async (response: {
            razorpay_order_id: string;
            razorpay_payment_id: string;
            razorpay_signature: string;
          }) => {
            try {
              await api(`/api/portal/${encodeURIComponent(token)}/invoices/${invoiceId}/verify`, {
                method: "POST",
                body: JSON.stringify({
                  razorpayOrderId: response.razorpay_order_id,
                  razorpayPaymentId: response.razorpay_payment_id,
                  razorpaySignature: response.razorpay_signature,
                }),
              });
              await load();
            } catch (err) {
              setPayError(errorMessage(err));
            }
          },
          theme: { color: "#5AA8AA" },
        });
        checkout.open();
      } catch (err) {
        setPayError(errorMessage(err));
      } finally {
        setPaying(null);
      }
    },
    [token, snapshot?.firmName, load],
  );

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface">
        <span className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Opening your portal…
        </span>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface px-4">
        <Card className="w-full max-w-md">
          <CardContent className="space-y-2 text-center">
            <Lock aria-hidden className="mx-auto size-8 text-muted" />
            <h1 className="text-lg font-semibold text-foreground">This link is not available</h1>
            <p className="text-sm text-muted">
              {error ?? "The link may have expired or been withdrawn by your CA firm."}
            </p>
            <p className="text-caption text-muted">Ask your firm for a new client portal link.</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-surface px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <p className="flex items-center gap-2 text-caption font-medium tracking-wide text-muted uppercase">
            <Building2 aria-hidden className="size-4" /> {snapshot.firmName} · Client portal
          </p>
          <h1 className="text-2xl font-semibold text-foreground">{snapshot.engagement.name}</h1>
          <p className="text-sm text-muted">
            Read-only access to the documents your firm has issued
            {snapshot.linkExpiresAt ? ` · link valid until ${fmtDate(snapshot.linkExpiresAt)}` : ""}.
          </p>
        </header>

        {selected ? (
          <Card>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(null)}>
                  <ArrowLeft aria-hidden className="size-4" /> Back
                </Button>
                <Badge variant="accent">Issued · v{selected.revision}</Badge>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">{selected.formatLabel}</h2>
                <p className="text-caption text-muted">
                  {selected.redactions.length > 0
                    ? `${selected.redactions.length} identifier redaction rule(s) applied for the client copy.`
                    : "Client copy."}
                </p>
              </div>
              <div className="space-y-4">
                {selected.parts.length === 0 ? (
                  <pre className="whitespace-pre-wrap font-sans text-sm text-foreground">{selected.assembledBody}</pre>
                ) : (
                  selected.parts.map((part, index) => (
                    <section key={`${part.heading}-${index}`} className="space-y-1">
                      <h3 className="text-sm font-semibold text-foreground">{part.heading}</h3>
                      <pre className="whitespace-pre-wrap font-sans text-sm text-foreground">{part.body}</pre>
                    </section>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <FileText aria-hidden className="size-4" /> Issued documents
              </h2>
              {snapshot.deliverables.length === 0 ? (
                <p className="text-sm text-muted">
                  No document has been issued to this portal yet. Your firm will publish them here as they are signed.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {snapshot.deliverables.map((deliverable) => (
                    <li key={deliverable.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{deliverable.label}</p>
                        <p className="text-caption text-muted">
                          Issued {fmtDate(deliverable.issuedAt)} · revision {deliverable.revision}
                          {deliverable.udin
                            ? ` · UDIN ${deliverable.udin}`
                            : deliverable.documentReference
                              ? ` · Document ref ${deliverable.documentReference} (not a UDIN)`
                              : ""}
                        </p>
                      </div>
                      <Button type="button" size="sm" variant="secondary" disabled={viewing} onClick={() => void view(deliverable.id)}>
                        View
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {snapshot.compliance.length > 0 && (
          <Card>
            <CardContent className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CalendarClock aria-hidden className="size-4" /> Your compliance calendar
              </h2>
              <ul className="divide-y divide-line">
                {snapshot.compliance.map((task) => (
                  <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
                      <p className="text-caption text-muted">
                        {task.authority} · {task.period} · due {fmtDate(task.dueDate)}
                      </p>
                    </div>
                    <Badge
                      variant={task.state === "overdue" ? "critical" : task.state === "due-soon" ? "warning" : "info"}
                    >
                      {task.state === "overdue" ? "Overdue" : task.state === "due-soon" ? "Due soon" : "Upcoming"}
                    </Badge>
                  </li>
                ))}
              </ul>
              <p className="text-caption text-muted">
                Generated from your registration details. Dates are the central statutory dates; check any extension
                notified for your case.
              </p>
            </CardContent>
          </Card>
        )}

        {snapshot.filings.length > 0 && (
          <Card>
            <CardContent className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CheckCircle2 aria-hidden className="size-4" /> Filings for your approval
              </h2>
              {approveError && <p className="text-sm text-danger">{approveError}</p>}
              {snapshot.filings.some((filing) => filing.canApprove) && (
                <label className="block text-sm text-muted">
                  <span className="mb-1 block text-caption">Your name (goes on the approval receipt)</span>
                  <input
                    className="input"
                    value={approverName}
                    maxLength={120}
                    onChange={(event) => setApproverName(event.target.value)}
                    placeholder="e.g. R. Sharma, Director"
                  />
                </label>
              )}
              <ul className="divide-y divide-line">
                {snapshot.filings.map((filing) => (
                  <li key={filing.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{filing.title}</p>
                      <p className="text-caption text-muted">
                        {filing.authority} · due {fmtDate(filing.dueDate)} ·{" "}
                        {FILING_STAGE_LABEL[filing.stage] ?? filing.stage}
                        {filing.acknowledgementReference ? ` · ${filing.acknowledgementReference}` : ""}
                        {filing.verificationStatus === "defective"
                          ? " · action required"
                          : filing.verificationStatus === "unverifiable"
                            ? " · submitted, not yet verified"
                            : ""}
                      </p>
                    </div>
                    {filing.canApprove ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={approving === filing.id}
                        onClick={() => void approve(filing.id)}
                      >
                        {approving === filing.id ? "Approving…" : "Approve"}
                      </Button>
                    ) : (
                      <div className="flex items-center gap-2">
                        {filing.clientApprovalDigest ? (
                          <a
                            className="text-caption underline underline-offset-2 text-accent"
                            href={`/api/portal/${encodeURIComponent(token)}/filings/${filing.id}/approval-receipt`}
                            download={`approval-receipt-${filing.id}.json`}
                          >
                            Approval receipt
                          </a>
                        ) : null}
                        <Badge variant={filing.stage === "acknowledged" ? "success" : "default"}>
                          {FILING_STAGE_LABEL[filing.stage] ?? filing.stage}
                        </Badge>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-caption text-muted">
                Approving confirms the return is correct from your side. Filing with the portal is done by your CA firm
                afterwards.
              </p>
              <a
                className="text-caption underline underline-offset-2 text-accent"
                href={`/portal/${encodeURIComponent(token)}/report?month=${new Date().toISOString().slice(0, 7)}`}
              >
                Open this month&apos;s compliance report
              </a>
            </CardContent>
          </Card>
        )}

        {snapshot.invoices.length > 0 && (
          <Card>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <IndianRupee aria-hidden className="size-4" /> Invoices
                </h2>
                <Badge variant={snapshot.balanceMinor > 0 ? "warning" : "success"}>
                  {snapshot.balanceMinor > 0 ? `${money(snapshot.balanceMinor)} due` : "Nothing due"}
                </Badge>
              </div>
              {payError && <p className="text-sm text-danger">{payError}</p>}
              <ul className="divide-y divide-line">
                {snapshot.invoices.map((invoice) => (
                  <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {invoice.number} · {money(invoice.totalMinor)}
                      </p>
                      <p className="text-caption text-muted">
                        Issued {fmtDate(invoice.issuedOn)} · due {fmtDate(invoice.dueDate)}
                        {invoice.status === "paid" ? ` · paid ${fmtDate(invoice.paidOn)}` : ""}
                      </p>
                    </div>
                    {invoice.status === "paid" ? (
                      <Badge variant="success">Paid</Badge>
                    ) : snapshot.payments.enabled ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={paying === invoice.id}
                        onClick={() => void pay(invoice.id)}
                      >
                        {paying === invoice.id ? "Opening…" : "Pay now"}
                      </Button>
                    ) : (
                      <Badge variant="warning">Pay by bank transfer</Badge>
                    )}
                  </li>
                ))}
              </ul>
              {snapshot.statement.length > 0 && (
                <div className="border-t border-line pt-3">
                  <p className="mb-1 text-caption font-medium text-muted uppercase">Account statement</p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[420px] text-sm">
                      <thead className="bg-muted/40 text-left text-caption uppercase tracking-wide text-muted">
                        <tr>
                          <th className="px-2 py-1">Date</th>
                          <th className="px-2 py-1">Item</th>
                          <th className="px-2 py-1 text-right">Invoice</th>
                          <th className="px-2 py-1 text-right">Paid</th>
                          <th className="px-2 py-1 text-right">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.statement.map((row, index) => (
                          <tr key={`${row.kind}-${row.reference}-${index}`} className="border-t border-line">
                            <td className="px-2 py-1">{fmtDate(row.date)}</td>
                            <td className="px-2 py-1">{row.description}</td>
                            <td className="px-2 py-1 text-right">
                              {row.debitMinor ? money(row.debitMinor) : "—"}
                            </td>
                            <td className="px-2 py-1 text-right">
                              {row.creditMinor ? money(row.creditMinor) : "—"}
                            </td>
                            <td className="px-2 py-1 text-right font-medium">{money(row.balanceMinor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <p className="text-caption text-muted">
                Online payment is recorded against this invoice only after the payment provider verifies it. A bank
                transfer is recorded by your CA firm.
              </p>
            </CardContent>
          </Card>
        )}

        {snapshot.requests.length > 0 && (
          <Card>
            <CardContent className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <FileText aria-hidden className="size-4" /> Documents your CA has asked for
              </h2>
              <ul className="divide-y divide-line">
                {snapshot.requests.map((request) => (
                  <li key={request.id} className="space-y-1 py-2">
                    <p className="text-sm font-medium text-foreground">{request.title}</p>
                    <p className="text-caption text-muted">
                      {request.period ? `${request.period} · ` : ""}due {fmtDate(request.dueDate)}
                    </p>
                    {request.notes && <p className="text-caption text-muted">{request.notes}</p>}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRequestId(request.id);
                        document.getElementById("portal-upload")?.scrollIntoView({ behavior: "smooth" });
                      }}
                    >
                      Upload this document
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Card id="portal-upload">
          <CardContent className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Upload aria-hidden className="size-4" /> Send a document
            </h2>
            <p className="text-caption text-muted">
              Upload PDF, PNG, JPEG, CSV, XLSX or DOCX files up to 10 MB. Documents are recorded against{" "}
              {snapshot.engagement.name} and visible only to your firm.
            </p>
            <form className="space-y-3" onSubmit={upload}>
              {snapshot.requests.length > 0 && (
                <Field
                  label="This answers"
                  helper="Optional — linking the upload closes your firm's request automatically."
                >
                  <Select
                    value={requestId}
                    onChange={(e) => setRequestId(e.target.value)}
                    placeholder="Not a specific request"
                    options={snapshot.requests.map((request) => ({
                      value: request.id,
                      label: `${request.title}${request.period ? ` · ${request.period}` : ""}`,
                    }))}
                  />
                </Field>
              )}
              <Field label="Document">
                <Input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx,.docx"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </Field>
              <Field label="Note for your CA" helper="Optional — e.g. which period or request this answers.">
                <Textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="FY 2025-26 bank statement, April to September."
                />
              </Field>
              {uploadNote && (
                <p className="flex items-center gap-1 rounded-md border border-emerald/40 bg-emerald/10 px-3 py-2 text-sm text-foreground">
                  <CheckCircle2 aria-hidden className="size-4" /> {uploadNote}
                </p>
              )}
              {uploadError && <p className="text-sm text-danger">{uploadError}</p>}
              <Button type="submit" disabled={uploading || !file}>
                {uploading ? "Uploading…" : "Upload document"}
              </Button>
            </form>

            {snapshot.uploads.length > 0 && (
              <div className="space-y-1 border-t border-line pt-3">
                <p className="text-caption font-medium text-muted uppercase">Uploaded through this link</p>
                <ul className="space-y-1">
                  {snapshot.uploads.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate text-foreground">{item.filename}</span>
                      <span className="shrink-0 text-caption text-muted">
                        {fmtSize(item.sizeBytes)} · {fmtDate(item.uploadedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="flex items-center gap-1 text-caption text-muted">
          <Lock aria-hidden className="size-3.5" /> This portal shows only documents your firm has issued. It cannot
          change, delete or browse anything else in your file.
        </p>
      </div>
    </main>
  );
}
