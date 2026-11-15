"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { api } from "@/lib/client/api";
import { formatInr } from "@/lib/engine/india-tax";

import { GstFilingPanel } from "./gst-filing-panel";
import { JournalPanel } from "./journal-panel";
import { ReconciliationPanel } from "./reconciliation-panel";

// ---------------------------------------------------------------------------
// Types (structural — mirror lib/engine/accounting.ts and the API payloads)
// ---------------------------------------------------------------------------

export interface BookSummary {
  id: string;
  name: string;
  legalName: string | null;
  gstin: string | null;
  pan: string | null;
  entityType: string;
  booksFrom: string | null;
  fiscalYearEnd: string;
}

interface AccountRow {
  code: string;
  name: string;
  type: string;
  category: string;
  openingBalance: number;
}

interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  category: string;
  debit: number;
  credit: number;
}

interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  difference: number;
}

interface StatementLine {
  key: string;
  label: string;
  amount: number;
  children?: StatementLine[];
}

interface IncomeStatement {
  income: StatementLine[];
  expenses: StatementLine[];
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
}

interface BalanceSheet {
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  imbalance: number;
}

interface CashFlow {
  openingCash?: number;
  netChange?: number;
  closingCash?: number;
  reconciled?: boolean;
}

interface Statements {
  trialBalance: TrialBalance;
  incomeStatement: IncomeStatement;
  balanceSheet: BalanceSheet;
  cashFlow: CashFlow;
}

type Tab = "journal" | "trial-balance" | "income" | "balance-sheet" | "cash-flow" | "gst-filing" | "reconciliation";

const TABS: { id: Tab; label: string }[] = [
  { id: "journal", label: "Journal" },
  { id: "trial-balance", label: "Trial balance" },
  { id: "income", label: "P&L" },
  { id: "balance-sheet", label: "Balance sheet" },
  { id: "cash-flow", label: "Cash flow" },
  { id: "gst-filing", label: "GST filing" },
  { id: "reconciliation", label: "Reconciliation" },
];

const EMPTY_STATEMENTS: Statements = {
  trialBalance: { rows: [], totalDebit: 0, totalCredit: 0, balanced: true, difference: 0 },
  incomeStatement: { income: [], expenses: [], totalIncome: 0, totalExpenses: 0, netProfit: 0 },
  balanceSheet: {
    assets: [],
    liabilities: [],
    equity: [],
    totalAssets: 0,
    totalLiabilities: 0,
    totalEquity: 0,
    imbalance: 0,
  },
  cashFlow: {},
};

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function StatementLines({ lines, depth = 0 }: { lines: StatementLine[]; depth?: number }) {
  return (
    <>
      {lines.map((line) => (
        <div key={`${depth}-${line.key}`}>
          <div
            className={`flex items-baseline justify-between rounded px-2 py-1 ${depth === 0 ? "font-medium" : "text-[13px]"}`}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
          >
            <span>{line.label}</span>
            <span className="tabular-nums">{formatInr(line.amount)}</span>
          </div>
          {line.children && line.children.length > 0 ? (
            <StatementLines lines={line.children} depth={depth + 1} />
          ) : null}
        </div>
      ))}
    </>
  );
}

function Banner({ tone, children }: { tone: "ok" | "warn"; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-md border px-3 py-2 text-[13px] ${
        tone === "ok"
          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
          : "border-amber-300 bg-amber-50 text-amber-800"
      }`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

export function BooksWorkspace({ initialBooks }: { initialBooks: BookSummary[] }) {
  const [books, setBooks] = useState<BookSummary[]>(initialBooks);
  const [selectedId, setSelectedId] = useState<string | null>(initialBooks[0]?.id ?? null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [statements, setStatements] = useState<Statements>(EMPTY_STATEMENTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("trial-balance");
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "",
    legalName: "",
    gstin: "",
    pan: "",
    entityType: "company",
    booksFrom: "",
    fiscalYearEnd: "03-31",
  });

  const selected = books.find((b) => b.id === selectedId) ?? null;

  const loadBook = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const [snapshot, st] = await Promise.all([
        api<{ book: BookSummary; accounts: AccountRow[] }>(`/api/books/${id}`),
        api<Statements>(`/api/books/${id}/statements`),
      ]);
      setAccounts(snapshot.accounts ?? []);
      setStatements(st ?? EMPTY_STATEMENTS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the book.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadBook(selectedId);
  }, [selectedId, loadBook]);

  const createBook = async () => {
    if (!form.name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const { book } = await api<{ book: BookSummary }>("/api/books", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          legalName: form.legalName || undefined,
          gstin: form.gstin || undefined,
          pan: form.pan || undefined,
          entityType: form.entityType,
          booksFrom: form.booksFrom || undefined,
          fiscalYearEnd: form.fiscalYearEnd || "03-31",
        }),
      });
      setBooks((prev) => [book, ...prev]);
      setSelectedId(book.id);
      setShowCreate(false);
      setForm({
        name: "",
        legalName: "",
        gstin: "",
        pan: "",
        entityType: "company",
        booksFrom: "",
        fiscalYearEnd: "03-31",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the book.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      {/* ---- Left: books + create ---- */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-800">
            Books <span className="text-neutral-400">({books.length})</span>
          </h2>
          <Button size="sm" variant="secondary" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Cancel" : "New books"}
          </Button>
        </div>

        {showCreate && (
          <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4">
            <Input
              label="Name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Client Pvt Ltd — FY 2025-26"
            />
            <Input
              label="Legal name"
              value={form.legalName}
              onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
              placeholder="Same as name if unchanged"
            />
            <Input
              label="GSTIN"
              value={form.gstin}
              onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
              placeholder="27AAPFU0939F1ZV"
            />
            <Input
              label="PAN"
              value={form.pan}
              onChange={(e) => setForm((f) => ({ ...f, pan: e.target.value.toUpperCase() }))}
              placeholder="AAPFU0939F"
            />
            <Select
              label="Entity type"
              value={form.entityType}
              onChange={(e) => setForm((f) => ({ ...f, entityType: e.target.value }))}
              options={[
                { value: "company", label: "Company" },
                { value: "llp", label: "LLP" },
                { value: "firm", label: "Partnership / firm" },
                { value: "individual", label: "Individual" },
              ]}
            />
            <Input
              label="Books from (yyyy-mm-dd)"
              type="date"
              value={form.booksFrom}
              onChange={(e) => setForm((f) => ({ ...f, booksFrom: e.target.value }))}
            />
            <Input
              label="Fiscal year end (mm-dd)"
              value={form.fiscalYearEnd}
              onChange={(e) => setForm((f) => ({ ...f, fiscalYearEnd: e.target.value }))}
              placeholder="03-31"
            />
            <Button className="w-full" disabled={!form.name.trim() || creating} onClick={() => void createBook()}>
              {creating ? "Creating…" : "Create books (Schedule III chart seeded)"}
            </Button>
          </div>
        )}

        <div className="space-y-2">
          {books.map((b) => (
            <button
              key={b.id}
              onClick={() => setSelectedId(b.id)}
              className={`w-full rounded-lg border p-3 text-left transition ${
                b.id === selectedId
                  ? "border-neutral-900 bg-neutral-50"
                  : "border-neutral-200 bg-white hover:border-neutral-300"
              }`}
            >
              <div className="text-sm font-medium">{b.name}</div>
              <div className="mt-0.5 text-xs text-neutral-500">
                {b.entityType}
                {b.gstin ? ` · GSTIN ${b.gstin}` : ""}
                {b.pan ? ` · PAN ${b.pan}` : ""}
              </div>
              <div className="mt-0.5 text-xs text-neutral-400">FY end {b.fiscalYearEnd}</div>
            </button>
          ))}
          {books.length === 0 && (
            <p className="text-sm text-neutral-500">No books yet — create the first set to begin.</p>
          )}
        </div>
      </div>

      {/* ---- Right: statements ---- */}
      <div className="space-y-4">
        {error && <Banner tone="warn">{error}</Banner>}
        {selected && (
          <div className="rounded-lg border border-neutral-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3">
              <div>
                <div className="text-sm font-semibold">{selected.name}</div>
                <div className="text-xs text-neutral-500">
                  {selected.legalName || selected.name} · {accounts.length} accounts
                  {selected.booksFrom ? ` · from ${selected.booksFrom}` : ""}
                </div>
              </div>
              <div className="flex gap-1">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                      tab === t.id
                        ? "bg-neutral-900 text-white"
                        : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4">
              {loading ? (
                <p className="text-sm text-neutral-500">Loading…</p>
              ) : tab === "journal" ? (
                <JournalPanel bookId={selected.id} accounts={accounts} onPosted={() => void loadBook(selected.id)} />
              ) : tab === "trial-balance" ? (
                <div className="space-y-3">
                  {statements.trialBalance.balanced ? (
                    <Banner tone="ok">
                      Trial balance closes: debits = credits = {formatInr(statements.trialBalance.totalDebit)}.
                    </Banner>
                  ) : (
                    <Banner tone="warn">
                      Trial balance does NOT close — difference {formatInr(statements.trialBalance.difference)}. A
                      voucher may be unbalanced.
                    </Banner>
                  )}
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                        <th className="py-2">Code</th>
                        <th className="py-2">Account</th>
                        <th className="py-2 text-right">Debit</th>
                        <th className="py-2 text-right">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statements.trialBalance.rows.map((r) => (
                        <tr key={r.code} className="border-b border-neutral-100">
                          <td className="py-1.5 font-mono text-xs text-neutral-500">{r.code}</td>
                          <td className="py-1.5">
                            {r.name} <span className="text-xs text-neutral-400">({r.category})</span>
                          </td>
                          <td className="py-1.5 text-right tabular-nums">{r.debit ? formatInr(r.debit) : "—"}</td>
                          <td className="py-1.5 text-right tabular-nums">{r.credit ? formatInr(r.credit) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : tab === "income" ? (
                <div className="space-y-4">
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Income</h3>
                    <StatementLines lines={statements.incomeStatement.income} />
                  </div>
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Expenses</h3>
                    <StatementLines lines={statements.incomeStatement.expenses} />
                  </div>
                  <div className="border-t border-neutral-200 pt-3 text-sm font-semibold">
                    <div className="flex justify-between">
                      <span>Net {statements.incomeStatement.netProfit >= 0 ? "profit" : "loss"}</span>
                      <span className="tabular-nums">{formatInr(Math.abs(statements.incomeStatement.netProfit))}</span>
                    </div>
                  </div>
                </div>
              ) : tab === "balance-sheet" ? (
                <div className="space-y-4">
                  {statements.balanceSheet.imbalance !== 0 ? (
                    <Banner tone="warn">
                      Balance sheet imbalance {formatInr(statements.balanceSheet.imbalance)} — the books are broken, not
                      rounded.
                    </Banner>
                  ) : (
                    <Banner tone="ok">Assets = Liabilities + Equity. The sheet closes.</Banner>
                  )}
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Assets</h3>
                    <StatementLines lines={statements.balanceSheet.assets} />
                  </div>
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Liabilities</h3>
                    <StatementLines lines={statements.balanceSheet.liabilities} />
                  </div>
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Equity</h3>
                    <StatementLines lines={statements.balanceSheet.equity} />
                  </div>
                </div>
              ) : tab === "gst-filing" ? (
                <GstFilingPanel books={books} selectedBookId={selectedId} />
              ) : tab === "reconciliation" ? (
                <ReconciliationPanel bookId={selected.id} />
              ) : (
                <div className="space-y-2 text-sm">
                  {typeof statements.cashFlow.reconciled === "boolean" && (
                    <Banner tone={statements.cashFlow.reconciled ? "ok" : "warn"}>
                      {statements.cashFlow.reconciled
                        ? "Cash flow reconciles: derived closing cash equals the ledger's cash balance."
                        : "Cash flow does NOT reconcile — treat it as unreliable."}
                    </Banner>
                  )}
                  <div className="flex justify-between">
                    <span>Opening cash</span>
                    <span className="tabular-nums">
                      {statements.cashFlow.openingCash !== undefined ? formatInr(statements.cashFlow.openingCash) : "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Net change</span>
                    <span className="tabular-nums">
                      {statements.cashFlow.netChange !== undefined ? formatInr(statements.cashFlow.netChange) : "—"}
                    </span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span>Closing cash</span>
                    <span className="tabular-nums">
                      {statements.cashFlow.closingCash !== undefined ? formatInr(statements.cashFlow.closingCash) : "—"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {!selected && !loading && (
          <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
            Select a book on the left, or create the first set — the Schedule III chart of accounts is seeded
            automatically.
          </div>
        )}

        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-600">
          <p className="font-medium text-neutral-700">Other CA engines</p>
          <p className="mt-1">
            Voucher entry and the day book live in the <strong>Journal</strong> tab; bank-statement import, auto-matching
            and the register↔ledger gap live in <strong>Reconciliation</strong>; GSTR-3B, GSTR-9 and filing campaigns
            live in <strong>GST filing</strong>. AR/AP ageing with MSME 43B(h), payroll (EPF/ESI/PT/TDS), the fixed-asset
            register and TDS returns (24Q/26Q/27Q) are available as <code>POST /api/ca/compute</code> kinds; every
            figure is computed in integer paise with labelled methodology.
          </p>
        </div>
      </div>
    </div>
  );
}
