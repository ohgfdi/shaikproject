"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/form";
import { api } from "@/lib/client/api";
import { parseStatementCsv } from "@/lib/engine/bank-statement-csv";
import { formatInr } from "@/lib/engine/india-tax";

interface FeedRow {
  id: string;
  accountName: string;
  accountNumber: string;
  bankName: string;
  statementFrom: string;
  statementTo: string;
  openingBalance: number;
  closingBalance: number;
  reconciled: boolean;
  feedType: string;
  _count?: { transactions: number };
}

interface TransactionRow {
  id: string;
  date: string;
  narration: string;
  amount: number;
  reference: string | null;
  matchStatus: string;
  matchScore: number | null;
  matchedVoucherId: string | null;
}

interface SubledgerRegister {
  sourceType: string;
  label: string;
  total: number;
  posted: number;
  unposted: number;
  unpostedAmount: number;
}

interface SubledgerReconciliation {
  period: string;
  reconciled: boolean;
  registers: SubledgerRegister[];
}

function rupeesToMinor(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
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

const STATUS_TONE: Record<string, string> = {
  confirmed: "bg-emerald-100 text-emerald-800",
  suggested: "bg-amber-100 text-amber-800",
  unmatched: "bg-neutral-100 text-neutral-700",
  ignored: "bg-neutral-100 text-neutral-500",
};

/**
 * Bank reconciliation: import the statement, auto-match it against the journal,
 * confirm, and prove the register agrees with the ledger.
 *
 * Matching is a suggestion, never a posting — the engine scores each bank line
 * against vouchers in the statement window and leaves anything it is unsure
 * about as `unmatched`, so a junior reviews the residue instead of trusting a
 * silent guess. Real figures, no demo rows.
 */
export function ReconciliationPanel({ bookId }: { bookId: string }) {
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [feedId, setFeedId] = useState("");
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const [statement, setStatement] = useState("");
  const [feedForm, setFeedForm] = useState({
    accountName: "",
    accountNumber: "",
    bankName: "",
    statementFrom: "",
    statementTo: "",
    openingBalance: "",
    closingBalance: "",
  });

  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [gap, setGap] = useState<SubledgerReconciliation | null>(null);

  const selectedFeed = feeds.find((f) => f.id === feedId) ?? null;
  const parsed = useMemo(() => parseStatementCsv(statement), [statement]);

  const loadFeeds = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ feeds: FeedRow[] }>(`/api/books/${bookId}/bank-feeds`);
      setFeeds(data.feeds ?? []);
      setFeedId((current) => current || data.feeds?.[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load bank feeds.");
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    void loadFeeds();
  }, [loadFeeds]);

  const loadTransactions = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const data = await api<{ transactions: TransactionRow[] }>(
        `/api/books/${bookId}/bank-feeds?action=transactions&feedId=${encodeURIComponent(id)}`,
      );
      setTransactions(data.transactions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load statement lines.");
    }
  }, [bookId]);

  useEffect(() => {
    void loadTransactions(feedId);
  }, [feedId, loadTransactions]);

  const createFeed = async () => {
    setBusy(true);
    setError(null);
    try {
      const { feed } = await api<{ feed: FeedRow }>(`/api/books/${bookId}/bank-feeds`, {
        method: "POST",
        body: JSON.stringify({
          accountName: feedForm.accountName,
          accountNumber: feedForm.accountNumber,
          bankName: feedForm.bankName,
          feedType: "statement-upload",
          statementFrom: feedForm.statementFrom,
          statementTo: feedForm.statementTo,
          openingBalance: rupeesToMinor(feedForm.openingBalance),
          closingBalance: rupeesToMinor(feedForm.closingBalance),
        }),
      });
      setFeeds((current) => [feed, ...current]);
      setFeedId(feed.id);
      setShowCreate(false);
      setFeedForm({
        accountName: "",
        accountNumber: "",
        bankName: "",
        statementFrom: "",
        statementTo: "",
        openingBalance: "",
        closingBalance: "",
      });
      setNotice("Bank feed created. Paste the statement lines to import them.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the bank feed.");
    } finally {
      setBusy(false);
    }
  };

  const importStatement = async () => {
    if (!feedId || parsed.rows.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api<{ created: number }>(`/api/books/${bookId}/bank-feeds`, {
        method: "POST",
        body: JSON.stringify({ action: "bulk-transactions", feedId, transactions: parsed.rows }),
      });
      setNotice(`Imported ${data.created} statement line${data.created === 1 ? "" : "s"}.`);
      setStatement("");
      await loadTransactions(feedId);
      await loadFeeds();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import the statement.");
    } finally {
      setBusy(false);
    }
  };

  const action = async (kind: "auto-match" | "reconcile") => {
    if (!feedId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (kind === "auto-match") {
        const data = await api<{ result: { matched: number; suggested: number; total: number } }>(
          `/api/books/${bookId}/bank-feeds`,
          { method: "POST", body: JSON.stringify({ action: "auto-match", feedId, useRules: true }) },
        );
        const { matched, suggested, total } = data.result;
        setNotice(
          `Matched ${matched} of ${total} line${total === 1 ? "" : "s"}` +
            (suggested ? ` · ${suggested} suggested, awaiting confirmation.` : "."),
        );
      } else {
        const data = await api<{
          result: { reconciled: boolean; totalTransactions: number; unmatchedCount: number };
        }>(`/api/books/${bookId}/bank-feeds`, {
          method: "POST",
          body: JSON.stringify({ action: "reconcile", feedId }),
        });
        setNotice(
          data.result.reconciled
            ? `Reconciled: all ${data.result.totalTransactions} lines are matched.`
            : `${data.result.unmatchedCount} of ${data.result.totalTransactions} lines are still unmatched — the feed stays open.`,
        );
      }
      await loadTransactions(feedId);
      await loadFeeds();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconciliation step failed.");
    } finally {
      setBusy(false);
    }
  };

  const checkGap = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ reconciliation: SubledgerReconciliation }>(
        `/api/books/${bookId}/reconciliation?period=${encodeURIComponent(period)}`,
      );
      setGap(data.reconciliation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reconcile the registers.");
      setGap(null);
    } finally {
      setBusy(false);
    }
  };

  const unmatched = transactions.filter((t) => t.matchStatus === "unmatched").length;

  return (
    <div className="space-y-6">
      {error && <Banner tone="warn">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}

      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-neutral-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Bank statement</h3>
            <p className="text-xs text-neutral-500">
              Paste the statement, auto-match it against the journal, then close the feed only when nothing is left
              unmatched.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div className="min-w-[240px]">
              <Select
                label="Statement"
                value={feedId}
                onChange={(e) => setFeedId(e.target.value)}
                options={[
                  { value: "", label: feeds.length ? "Select a bank feed…" : "No bank feeds yet" },
                  ...feeds.map((f) => ({
                    value: f.id,
                    label: `${f.bankName} · ${f.accountNumber} (${f.statementFrom} → ${f.statementTo})`,
                  })),
                ]}
              />
            </div>
            <Button size="sm" variant="secondary" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "Cancel" : "New bank feed"}
            </Button>
          </div>
        </div>

        {showCreate && (
          <div className="grid gap-3 border-b border-neutral-200 bg-neutral-50 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              label="Account name"
              value={feedForm.accountName}
              onChange={(e) => setFeedForm((f) => ({ ...f, accountName: e.target.value }))}
              placeholder="HDFC Current A/c"
            />
            <Input
              label="Account number"
              value={feedForm.accountNumber}
              onChange={(e) => setFeedForm((f) => ({ ...f, accountNumber: e.target.value }))}
              placeholder="0042 (last 4 is fine)"
            />
            <Input
              label="Bank"
              value={feedForm.bankName}
              onChange={(e) => setFeedForm((f) => ({ ...f, bankName: e.target.value }))}
              placeholder="HDFC Bank"
            />
            <div className="hidden lg:block" />
            <Input
              label="Statement from"
              type="date"
              value={feedForm.statementFrom}
              onChange={(e) => setFeedForm((f) => ({ ...f, statementFrom: e.target.value }))}
            />
            <Input
              label="Statement to"
              type="date"
              value={feedForm.statementTo}
              onChange={(e) => setFeedForm((f) => ({ ...f, statementTo: e.target.value }))}
            />
            <Input
              label="Opening balance (₹)"
              inputMode="decimal"
              value={feedForm.openingBalance}
              onChange={(e) => setFeedForm((f) => ({ ...f, openingBalance: e.target.value }))}
              placeholder="0.00"
            />
            <Input
              label="Closing balance (₹)"
              inputMode="decimal"
              value={feedForm.closingBalance}
              onChange={(e) => setFeedForm((f) => ({ ...f, closingBalance: e.target.value }))}
              placeholder="0.00"
            />
            <div className="sm:col-span-2 lg:col-span-4">
              <Button
                disabled={
                  busy ||
                  !feedForm.accountName.trim() ||
                  !feedForm.accountNumber.trim() ||
                  !feedForm.bankName.trim() ||
                  !feedForm.statementFrom ||
                  !feedForm.statementTo
                }
                onClick={() => void createFeed()}
              >
                Create bank feed
              </Button>
            </div>
          </div>
        )}

        {selectedFeed ? (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-600">
              <span className="rounded bg-neutral-100 px-2 py-1 font-medium">{selectedFeed.bankName}</span>
              <span>A/c {selectedFeed.accountNumber}</span>
              <span>
                {selectedFeed.statementFrom} → {selectedFeed.statementTo}
              </span>
              <span>
                Opening {formatInr(selectedFeed.openingBalance)} · Closing {formatInr(selectedFeed.closingBalance)}
              </span>
              <span
                className={`rounded px-2 py-1 font-medium ${
                  selectedFeed.reconciled ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                }`}
              >
                {selectedFeed.reconciled ? "Reconciled" : "Open"}
              </span>
              <span>
                {transactions.length} lines · {unmatched} unmatched
              </span>
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void action("auto-match")}>
                  Auto-match
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void action("reconcile")}>
                  Reconcile feed
                </Button>
              </span>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <Textarea
                  label="Paste statement lines"
                  rows={6}
                  value={statement}
                  onChange={(e) => setStatement(e.target.value)}
                  placeholder={"2026-03-01,NEFT from Sharma & Co,25000.00 Cr,UTR001\n02/03/2026,Cheque 004512 paid,1500.50 Dr,004512"}
                  helper="date, narration, amount[, reference]. A Dr marker (or brackets) is money out; a bare number is a credit."
                />
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  <span className="text-neutral-600">
                    {parsed.rows.length} line{parsed.rows.length === 1 ? "" : "s"} ready
                    {parsed.errors.length ? ` · ${parsed.errors.length} skipped` : ""}
                  </span>
                  <Button size="sm" disabled={busy || !feedId || parsed.rows.length === 0} onClick={() => void importStatement()}>
                    Import lines
                  </Button>
                </div>
                {parsed.errors.length > 0 && (
                  <ul className="mt-2 max-h-24 overflow-y-auto text-xs text-amber-800">
                    {parsed.errors.slice(0, 8).map((e) => (
                      <li key={e.line}>
                        Line {e.line}: {e.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="max-h-64 overflow-auto rounded-md border border-neutral-200">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50">
                    <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                      <th className="px-2 py-1.5">Date</th>
                      <th className="px-2 py-1.5">Narration</th>
                      <th className="px-2 py-1.5 text-right">Amount</th>
                      <th className="px-2 py-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((t) => (
                      <tr key={t.id} className="border-t border-neutral-100">
                        <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">{t.date}</td>
                        <td className="px-2 py-1">
                          {t.narration}
                          {t.reference ? <span className="text-xs text-neutral-400"> · {t.reference}</span> : null}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{formatInr(t.amount)}</td>
                        <td className="px-2 py-1">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_TONE[t.matchStatus] ?? "bg-neutral-100"}`}
                          >
                            {t.matchStatus}
                            {t.matchScore ? ` ${t.matchScore}%` : ""}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {transactions.length === 0 && (
                      <tr>
                        <td className="px-2 py-3 text-xs text-neutral-500" colSpan={4}>
                          No statement lines imported yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
          <p className="p-4 text-sm text-neutral-500">
            {loading ? "Loading…" : "Create the first bank feed to import a statement."}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-neutral-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Registers ↔ ledger</h3>
            <p className="text-xs text-neutral-500">
              Every GST invoice, stock movement, fixed asset, TDS challan and payroll run must have posted exactly once.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <Input
              label="Period (yyyy-mm)"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              placeholder="2026-03"
            />
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void checkGap()}>
              Check
            </Button>
          </div>
        </div>
        <div className="p-4 text-sm">
          {!gap ? (
            <p className="text-neutral-500">Pick a period to reconcile the sub-ledgers against the journal.</p>
          ) : (
            <div className="space-y-3">
              <Banner tone={gap.reconciled ? "ok" : "warn"}>
                {gap.reconciled
                  ? `All registers for ${gap.period} are posted to the ledger.`
                  : `${gap.registers.filter((r) => r.unposted > 0).length} register(s) have unposted rows for ${gap.period}.`}
              </Banner>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2">Register</th>
                    <th className="py-2 text-right">Rows</th>
                    <th className="py-2 text-right">Posted</th>
                    <th className="py-2 text-right">Unposted</th>
                    <th className="py-2 text-right">Unposted value</th>
                  </tr>
                </thead>
                <tbody>
                  {gap.registers.map((r) => (
                    <tr key={r.sourceType} className="border-b border-neutral-100">
                      <td className="py-1.5">{r.label}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.total}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.posted}</td>
                      <td className={`py-1.5 text-right tabular-nums ${r.unposted ? "font-medium text-amber-700" : ""}`}>
                        {r.unposted}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{formatInr(r.unpostedAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
