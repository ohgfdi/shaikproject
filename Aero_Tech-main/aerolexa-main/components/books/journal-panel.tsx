"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/form";
import { api } from "@/lib/client/api";
import { formatInr } from "@/lib/engine/india-tax";

export interface JournalAccount {
  code: string;
  name: string;
  type: string;
  category: string;
  openingBalance: number;
}

interface DayBookRow {
  id: string;
  date: string;
  narration: string;
  reference: string | null;
  debit: number;
  credit: number;
}

interface LedgerRow {
  voucherId: string;
  date: string;
  narration: string;
  debit: number;
  credit: number;
  balance: number;
}

interface DraftLine {
  key: number;
  accountCode: string;
  side: "debit" | "credit";
  /** Rupees as typed. Converted to signed paise on post. */
  amount: string;
}

const VOUCHER_TYPES = [
  { value: "journal", label: "Journal" },
  { value: "receipt", label: "Receipt" },
  { value: "payment", label: "Payment" },
  { value: "contra", label: "Contra" },
  { value: "sales", label: "Sales" },
  { value: "purchase", label: "Purchase" },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Signed minor units: a debit is positive, a credit negative (ledger convention). */
function toMinor(line: DraftLine): number {
  const rupees = Number.parseFloat(line.amount);
  if (!Number.isFinite(rupees) || rupees === 0) return 0;
  const minor = Math.round(Math.abs(rupees) * 100);
  return line.side === "debit" ? minor : -minor;
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

/**
 * Journal entry + day book + account ledger.
 *
 * The screen exists because the books module could post balanced vouchers and
 * answer statements, but a junior had no way to enter a voucher or sight a
 * ledger without curl. Posting still goes through the same server path
 * (`postVoucher`): the engine proves the entry balances to the paise before a
 * row is written, so this form can never leave an unbalanced journal behind.
 */
export function JournalPanel({
  bookId,
  accounts,
  onPosted,
}: {
  bookId: string;
  accounts: JournalAccount[];
  onPosted?: () => void;
}) {
  const [date, setDate] = useState(todayIso());
  const [number, setNumber] = useState("JV-0001");
  const [voucherType, setVoucherType] = useState("journal");
  const [narration, setNarration] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([
    { key: 1, accountCode: "", side: "debit", amount: "" },
    { key: 2, accountCode: "", side: "credit", amount: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [dayBook, setDayBook] = useState<DayBookRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState({ from: "", to: "" });

  const [ledgerAccount, setLedgerAccount] = useState("");
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  const accountOptions = useMemo(
    () => accounts.map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` })),
    [accounts],
  );

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const line of lines) {
      const minor = toMinor(line);
      if (minor > 0) debit += minor;
      else credit += -minor;
    }
    return { debit, credit, difference: debit - credit };
  }, [lines]);

  const balanced = totals.debit > 0 && totals.difference === 0;

  const loadDayBook = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (range.from) query.set("from", range.from);
      if (range.to) query.set("to", range.to);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      const data = await api<{ dayBook: DayBookRow[] }>(`/api/books/${bookId}/vouchers${suffix}`);
      setDayBook(data.dayBook ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the day book.");
    } finally {
      setLoading(false);
    }
  }, [bookId, range.from, range.to]);

  useEffect(() => {
    void loadDayBook();
  }, [loadDayBook]);

  const loadLedger = useCallback(async () => {
    if (!ledgerAccount) return;
    setLedgerError(null);
    try {
      const query = new URLSearchParams({ accountCode: ledgerAccount });
      if (range.from) query.set("from", range.from);
      if (range.to) query.set("to", range.to);
      const data = await api<{ rows: LedgerRow[] }>(`/api/books/${bookId}/ledger?${query.toString()}`);
      setLedgerRows(data.rows ?? []);
    } catch (err) {
      setLedgerError(err instanceof Error ? err.message : "Could not load the ledger.");
      setLedgerRows([]);
    }
  }, [bookId, ledgerAccount, range.from, range.to]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  const setLine = (key: number, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const addLine = () =>
    setLines((current) => [
      ...current,
      { key: Math.max(...current.map((l) => l.key), 0) + 1, accountCode: "", side: "debit", amount: "" },
    ]);

  const removeLine = (key: number) =>
    setLines((current) => (current.length <= 2 ? current : current.filter((l) => l.key !== key)));

  const resetForm = (postedNumber: string) => {
    const match = /^(.*?)(\d+)$/.exec(postedNumber);
    const [, prefix = "", digits = ""] = match ?? [];
    const next = match ? `${prefix}${String(Number(digits) + 1).padStart(digits.length, "0")}` : postedNumber;
    setNumber(next);
    setNarration("");
    setReference("");
    setLines([
      { key: 1, accountCode: "", side: "debit", amount: "" },
      { key: 2, accountCode: "", side: "credit", amount: "" },
    ]);
  };

  const post = async () => {
    if (!balanced) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/books/${bookId}/vouchers`, {
        method: "POST",
        body: JSON.stringify({
          number,
          date,
          narration,
          reference: reference || null,
          voucherType,
          lines: lines
            .map((l) => ({ accountCode: l.accountCode, amount: toMinor(l), narration: null }))
            .filter((l) => l.amount !== 0 && l.accountCode),
        }),
      });
      setNotice(`Voucher ${number} posted. Statements and the day book now include it.`);
      resetForm(number);
      await loadDayBook();
      await loadLedger();
      onPosted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post the voucher.");
    } finally {
      setSaving(false);
    }
  };

  const firstPosting = ledgerRows[0];
  const ledgerOpening = firstPosting ? firstPosting.balance - (firstPosting.debit - firstPosting.credit) : 0;

  return (
    <div className="space-y-6">
      {error && <Banner tone="warn">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}

      {/* ---- Entry ---- */}
      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-4 py-3">
          <h3 className="text-sm font-semibold">New voucher</h3>
          <p className="text-xs text-neutral-500">
            Debits and credits must agree to the paise. The server rejects an unbalanced entry before writing it.
          </p>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Voucher no." value={number} onChange={(e) => setNumber(e.target.value)} />
          <Select
            label="Type"
            value={voucherType}
            onChange={(e) => setVoucherType(e.target.value)}
            options={VOUCHER_TYPES}
          />
          <Input
            label="Reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Invoice / cheque no."
          />
        </div>
        <div className="px-4 pb-2">
          <Textarea
            label="Narration"
            rows={2}
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            placeholder="Being goods purchased from …"
          />
        </div>

        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-2">Account</th>
                <th className="py-2">Dr / Cr</th>
                <th className="py-2 text-right">Amount (₹)</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key} className="border-b border-neutral-100">
                  <td className="py-1.5 pr-2">
                    <Select
                      aria-label="Account"
                      value={line.accountCode}
                      onChange={(e) => setLine(line.key, { accountCode: e.target.value })}
                      options={[{ value: "", label: "Select account…" }, ...accountOptions]}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Select
                      aria-label="Side"
                      value={line.side}
                      onChange={(e) => setLine(line.key, { side: e.target.value as DraftLine["side"] })}
                      options={[
                        { value: "debit", label: "Dr" },
                        { value: "credit", label: "Cr" },
                      ]}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      aria-label="Amount in rupees"
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(e) => setLine(line.key, { amount: e.target.value })}
                      placeholder="0.00"
                    />
                  </td>
                  <td className="py-1.5 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={lines.length <= 2}
                      onClick={() => removeLine(line.key)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="text-sm font-medium">
                <td className="pt-2" colSpan={2}>
                  Totals
                </td>
                <td className="pt-2 text-right tabular-nums">
                  Dr {formatInr(totals.debit)} · Cr {formatInr(totals.credit)}
                </td>
                <td className="pt-2 text-right text-xs">
                  {balanced ? (
                    <span className="text-emerald-700">Balanced</span>
                  ) : (
                    <span className="text-amber-700">Out by {formatInr(Math.abs(totals.difference))}</span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={addLine}>
              Add line
            </Button>
            <Button
              onClick={() => void post()}
              disabled={saving || !balanced || !narration.trim() || !number.trim() || !date}
            >
              {saving ? "Posting…" : "Post voucher"}
            </Button>
            <span className="text-xs text-neutral-500">
              {accounts.length === 0
                ? "This book has no chart of accounts — create the book again to seed it."
                : "Posting is date-locked: a closed period rejects the voucher."}
            </span>
          </div>
        </div>
      </section>

      {/* ---- Day book ---- */}
      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-neutral-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Day book</h3>
            <p className="text-xs text-neutral-500">Every posted voucher in the range, straight from the journal.</p>
          </div>
          <div className="flex items-end gap-2">
            <Input
              label="From"
              type="date"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
            <Input
              label="To"
              type="date"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
            <Button size="sm" variant="secondary" onClick={() => void loadDayBook()}>
              Apply
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto p-4">
          {loading ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : dayBook.length === 0 ? (
            <p className="text-sm text-neutral-500">No vouchers in this range yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2">Date</th>
                  <th className="py-2">Voucher</th>
                  <th className="py-2">Narration</th>
                  <th className="py-2 text-right">Debit</th>
                  <th className="py-2 text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {dayBook.map((row) => (
                  <tr key={row.id} className="border-b border-neutral-100">
                    <td className="py-1.5 whitespace-nowrap font-mono text-xs">{row.date}</td>
                    <td className="py-1.5 font-mono text-xs">{row.id}</td>
                    <td className="py-1.5">
                      {row.narration}
                      {row.reference ? <span className="text-xs text-neutral-400"> · {row.reference}</span> : null}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{row.debit ? formatInr(row.debit) : "—"}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.credit ? formatInr(row.credit) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* ---- Account ledger ---- */}
      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-neutral-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Account ledger</h3>
            <p className="text-xs text-neutral-500">
              Running balance on the account&apos;s natural side — what you tick against a voucher in vouching.
            </p>
          </div>
          <div className="min-w-[260px]">
            <Select
              label="Account"
              value={ledgerAccount}
              onChange={(e) => setLedgerAccount(e.target.value)}
              options={[{ value: "", label: "Select account…" }, ...accountOptions]}
            />
          </div>
        </div>
        <div className="overflow-x-auto p-4">
          {ledgerError ? (
            <Banner tone="warn">{ledgerError}</Banner>
          ) : !ledgerAccount ? (
            <p className="text-sm text-neutral-500">Pick an account to sight its ledger.</p>
          ) : ledgerRows.length === 0 ? (
            <p className="text-sm text-neutral-500">No postings on this account in the range.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2">Date</th>
                  <th className="py-2">Voucher</th>
                  <th className="py-2">Narration</th>
                  <th className="py-2 text-right">Debit</th>
                  <th className="py-2 text-right">Credit</th>
                  <th className="py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-neutral-100 text-xs text-neutral-500">
                  <td className="py-1.5" colSpan={5}>
                    Opening
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{formatInr(ledgerOpening)}</td>
                </tr>
                {ledgerRows.map((row, index) => (
                  <tr key={`${row.voucherId}-${index}`} className="border-b border-neutral-100">
                    <td className="py-1.5 whitespace-nowrap font-mono text-xs">{row.date}</td>
                    <td className="py-1.5 font-mono text-xs">{row.voucherId}</td>
                    <td className="py-1.5">{row.narration}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.debit ? formatInr(row.debit) : "—"}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.credit ? formatInr(row.credit) : "—"}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">{formatInr(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
