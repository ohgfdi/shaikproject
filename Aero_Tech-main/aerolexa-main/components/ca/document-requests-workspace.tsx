"use client";

import { BellRing, FolderOpen, Mail, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "@/lib/engine/ca-documents";

interface Deadline {
  dueDate: string;
  daysLeft: number;
  status: "overdue" | "due" | "upcoming";
}

interface DocumentRequestRow {
  id: string;
  clientName: string;
  clientEmail: string | null;
  title: string;
  category: string;
  period: string | null;
  dueDate: string;
  status: "requested" | "received" | "waived";
  notes: string | null;
  reminderCount: number;
  lastRemindedAt: string | null;
  receivedAt: string | null;
  bookId: string | null;
  deadline: Deadline;
}

interface BookOption {
  id: string;
  name: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  "engagement-letter": "Engagement letter",
  "working-paper": "Working paper",
  "financial-statement": "Financial statement",
  "tax-return": "Tax return",
  "audit-report": "Audit report",
  "gst-record": "GST record",
  kyc: "KYC",
  "client-correspondence": "Client correspondence",
  other: "Other",
};

function deadlineText(deadline: Deadline): string {
  if (deadline.daysLeft < 0) return `${Math.abs(deadline.daysLeft)} day(s) overdue`;
  if (deadline.daysLeft === 0) return "due today";
  return `${deadline.daysLeft} day(s) left`;
}

const EMPTY_FORM = {
  clientName: "",
  clientEmail: "",
  title: "",
  category: "financial-statement" as DocumentCategory,
  period: "",
  dueDate: "",
  notes: "",
  bookId: "",
};

const FILTERS = [
  { value: "open", label: "Open" },
  { value: "received", label: "Received" },
  { value: "all", label: "All" },
];

/**
 * Document chasing: what the firm has asked each client for, when it is due and
 * how many times they have been reminded. A reminder is recorded even when no
 * email leaves the building, and an SMTP failure is shown rather than counted
 * as sent.
 */
export function DocumentRequestsWorkspace() {
  const [requests, setRequests] = useState<DocumentRequestRow[]>([]);
  const [books, setBooks] = useState<BookOption[]>([]);
  const [filter, setFilter] = useState("open");
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ requests: DocumentRequestRow[] }>("/api/document-requests");
      setRequests(data.requests ?? []);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBooks = useCallback(async () => {
    try {
      const data = await api<{ books: BookOption[] }>("/api/books");
      setBooks(data.books ?? []);
    } catch {
      // Books are optional here; a request can exist without a book.
      setBooks([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadBooks();
  }, [load, loadBooks]);

  const visible = useMemo(() => {
    if (filter === "all") return requests;
    if (filter === "received") return requests.filter((r) => r.status !== "requested");
    return requests.filter((r) => r.status === "requested");
  }, [requests, filter]);

  const overdue = requests.filter((r) => r.status === "requested" && r.deadline.status === "overdue").length;
  const open = requests.filter((r) => r.status === "requested").length;

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      await api("/api/document-requests", {
        method: "POST",
        body: JSON.stringify({
          clientName: form.clientName,
          clientEmail: form.clientEmail || null,
          title: form.title,
          category: form.category,
          period: form.period || null,
          dueDate: form.dueDate,
          notes: form.notes || null,
          bookId: form.bookId || null,
        }),
      });
      setMessage(`Requested “${form.title}” from ${form.clientName}.`);
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const transition = async (id: string, status: "received" | "waived" | "requested") => {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/document-requests/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "status", status }),
      });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const remind = async (row: DocumentRequestRow) => {
    setBusyId(row.id);
    setError(null);
    setMessage(null);
    try {
      const data = await api<{
        reminder: { reminderCount: number; emailDelivered: boolean; emailError: string | null };
      }>(`/api/document-requests/${row.id}`, { method: "PATCH", body: JSON.stringify({ action: "remind" }) });
      const { reminderCount, emailDelivered, emailError } = data.reminder;
      setMessage(
        emailDelivered
          ? `Reminder ${reminderCount} emailed to ${row.clientEmail}.`
          : emailError
            ? `Reminder ${reminderCount} recorded, but the email failed: ${emailError}`
            : `Reminder ${reminderCount} recorded in-app (no client email on file).`,
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-danger">{error}</p>}
      {message && (
        <p className="rounded-md border border-emerald/40 bg-emerald/10 px-3 py-2 text-sm text-foreground">{message}</p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant="warning">{open} open</Badge>
        <Badge variant="critical">{overdue} overdue</Badge>
        <span className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                filter === f.value ? "bg-foreground text-surface" : "bg-surface-2 text-muted"
              }`}
            >
              {f.label}
            </button>
          ))}
        </span>
        <Button
          className="ml-auto"
          size="sm"
          variant="secondary"
          onClick={() => setShowForm((v) => !v)}
          icon={<FolderOpen aria-hidden className="size-4" />}
        >
          {showForm ? "Cancel" : "Request documents"}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              label="Client"
              value={form.clientName}
              onChange={(e) => setForm((f) => ({ ...f, clientName: e.target.value }))}
              placeholder="Sharma Traders"
            />
            <Input
              label="Client email"
              type="email"
              value={form.clientEmail}
              onChange={(e) => setForm((f) => ({ ...f, clientEmail: e.target.value }))}
              placeholder="accounts@sharmatraders.in"
              helper="Reminders go here. Leave blank to chase in-app only."
            />
            <Input
              label="Document"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Bank statements — March 2026"
            />
            <Select
              label="Category"
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as DocumentCategory }))}
              options={DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))}
            />
            <Input
              label="Period"
              value={form.period}
              onChange={(e) => setForm((f) => ({ ...f, period: e.target.value }))}
              placeholder="2026-03 or FY 2025-26"
            />
            <Input
              label="Due date"
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
            />
            <Select
              label="Client books (optional)"
              value={form.bookId}
              onChange={(e) => setForm((f) => ({ ...f, bookId: e.target.value }))}
              options={[
                { value: "", label: "Not linked to a book" },
                ...books.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
            <div className="sm:col-span-2">
              <Textarea
                label="Note to the client"
                rows={2}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Needed for the 3CD annexure and the stock audit."
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <Button
                disabled={creating || !form.clientName.trim() || form.title.trim().length < 2 || !form.dueDate}
                onClick={() => void create()}
                loading={creating}
              >
                Create request
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted">Loading requests…</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted">
              {filter === "received"
                ? "No documents have been received yet."
                : "Nothing outstanding — every requested document has been received or waived."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-caption uppercase tracking-wide text-muted">
                    <th className="py-2 pr-3 font-medium">Client</th>
                    <th className="py-2 pr-3 font-medium">Document</th>
                    <th className="py-2 pr-3 font-medium">Due</th>
                    <th className="py-2 pr-3 font-medium">Chased</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.id} className="border-b border-line/60 align-top">
                      <td className="py-2 pr-3">
                        <div className="text-foreground">{row.clientName}</div>
                        <div className="text-caption text-muted">{row.clientEmail ?? "no email on file"}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="text-foreground">{row.title}</div>
                        <div className="text-caption text-muted">
                          {CATEGORY_LABEL[row.category] ?? row.category}
                          {row.period ? ` · ${row.period}` : ""}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="whitespace-nowrap font-mono text-xs">{row.dueDate}</div>
                        <div
                          className={`text-caption ${
                            row.status === "requested" && row.deadline.status === "overdue"
                              ? "text-danger"
                              : "text-muted"
                          }`}
                        >
                          {row.status === "requested" ? deadlineText(row.deadline) : "—"}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1 text-caption text-muted">
                          <Mail aria-hidden className="size-3" />
                          {row.reminderCount} reminder{row.reminderCount === 1 ? "" : "s"}
                        </div>
                        {row.lastRemindedAt && (
                          <div className="text-caption text-muted">
                            last {row.lastRemindedAt.slice(0, 10)}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge
                          variant={
                            row.status === "received" ? "success" : row.status === "waived" ? "outline" : "warning"
                          }
                        >
                          {row.status}
                        </Badge>
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {row.status === "requested" ? (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busyId === row.id}
                                onClick={() => void remind(row)}
                                icon={<BellRing aria-hidden className="size-3.5" />}
                              >
                                Remind
                              </Button>
                              <Button size="sm" disabled={busyId === row.id} onClick={() => void transition(row.id, "received")}>
                                Mark received
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busyId === row.id}
                                onClick={() => void transition(row.id, "waived")}
                              >
                                Waive
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busyId === row.id}
                              onClick={() => void transition(row.id, "requested")}
                              icon={<Send aria-hidden className="size-3.5" />}
                            >
                              Reopen
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
