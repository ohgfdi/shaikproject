"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/client/api";
import type { FilingGatewayHealth, FilingPreflightResult, FilingReceipt } from "@/lib/engine/filing/types";
import type { Gstr9Result } from "@/lib/engine/gstr-9";
import { formatInr } from "@/lib/engine/india-tax";

// ---------------------------------------------------------------------------
// Types — mirror the route payloads (app/api/books/[id]/gst-filing). All money
// the workspace SENDS is in rupees; all money it RECEIVES is in paise and is
// rendered with formatInr (minor units), matching the rest of the books UI.
// ---------------------------------------------------------------------------

export interface GstFilingBook {
  id: string;
  name: string;
  gstin: string | null;
}

interface Gstr3bOutward {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  invoiceCount: number;
}

interface Gstr3bValue {
  period: string;
  outward: Gstr3bOutward;
  itc: { opening: number; availed: number; reversed: number; imports: number; rcm: number; net: number };
  netLiability: number;
  sampleEInvoice?: {
    DocDtls?: { Typ?: string; No?: string; Dt?: string };
    SellerDtls?: { Gstin?: string; LglNm?: string };
    BuyerDtls?: { Gstin?: string; LglNm?: string };
    ValDtls?: {
      AssVal?: number;
      CgstVal?: number;
      SgstVal?: number;
      IgstVal?: number;
      CesVal?: number;
      TotInvVal?: number;
    };
  };
  warnings: string[];
}

type FormType = "gstr-1" | "gstr-3b" | "gstr-9";
type SigningMethod = "dsc" | "evc" | "etm";
type CampaignStatus = "draft" | "prepared" | "filed" | "rejected" | "error";

interface FilingCampaignRow {
  id: string;
  gstin: string;
  formType: FormType;
  period: string;
  dueDate: string;
  signingMethod: SigningMethod;
  status: CampaignStatus;
  ackNumber?: string | null;
  ackDate?: string | null;
  irn?: string | null;
  notes?: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_MONEY = { igst: "", cgst: "", sgst: "", cess: "" };

type MoneyKey = keyof typeof ZERO_MONEY;
type NineRowKey = "availed" | "reversed" | "imports" | "rcm" | "twoB" | "pyc";

const NINE_ROWS: { key: NineRowKey; label: string; note: string }[] = [
  { key: "availed", label: "ITC availed (Table 4A)", note: "As claimed in 3B for the year." },
  { key: "reversed", label: "ITC reversed (Table 4B)", note: "Reversals during the year." },
  { key: "imports", label: "ITC on imports (Table 5)", note: "Optional." },
  { key: "rcm", label: "Inward RCM (Table 6)", note: "Reverse-charge inward supplies." },
  { key: "twoB", label: "ITC as per GSTR-2B (Table 8A)", note: "Drives the 8C reconciliation." },
  { key: "pyc", label: "Previous-FY claims (Table 8D)", note: "Within the s16(4) window." },
];

/** The 12 months of a "yyyy-yy" fiscal year, in April→March order. */
function monthsInYear(fy: string): string[] {
  const start = Number(fy.slice(0, 4));
  return Array.from({ length: 12 }, (_, i) => {
    const month = ((i + 3) % 12) + 1; // Apr(4) … Dec(12), then Jan(1) … Mar(3)
    const year = i < 9 ? start : start + 1;
    return `${year}-${String(month).padStart(2, "0")}`;
  });
}

function moneyNumbers(row: Record<MoneyKey, string>): { igst: number; cgst: number; sgst: number; cess: number } {
  return {
    igst: Number(row.igst || 0),
    cgst: Number(row.cgst || 0),
    sgst: Number(row.sgst || 0),
    cess: Number(row.cess || 0),
  };
}

function anyMoney(row: Record<MoneyKey, string>): boolean {
  const m = moneyNumbers(row);
  return m.igst !== 0 || m.cgst !== 0 || m.sgst !== 0 || m.cess !== 0;
}

function Row({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className="flex items-baseline justify-between gap-4 rounded px-2 py-1 text-sm">
      <span className="text-neutral-700">{label}</span>
      <span
        className={`tabular-nums ${
          tone === "ok" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : "font-medium text-neutral-900"
        }`}
      >
        {formatInr(value)}
      </span>
    </div>
  );
}

function Banner({ tone, children }: { tone: "ok" | "warn" | "info"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : tone === "info"
        ? "border-sky-300 bg-sky-50 text-sky-800"
        : "border-amber-300 bg-amber-50 text-amber-800";
  return <div className={`rounded-md border px-3 py-2 text-[13px] ${cls}`}>{children}</div>;
}

const STATUS_OPTIONS: { value: CampaignStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "prepared", label: "Prepared" },
  { value: "filed", label: "Filed" },
  { value: "rejected", label: "Rejected" },
  { value: "error", label: "Error" },
];

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function GstFilingPanel({ books, selectedBookId }: { books: GstFilingBook[]; selectedBookId: string | null }) {
  const [activeTab, setActiveTab] = useState<"3b" | "9" | "campaigns" | "rcm" | "eway-bill" | "rcm-itc">("3b");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [health, setHealth] = useState<FilingGatewayHealth | null>(null);
  const [preflight, setPreflight] = useState<FilingPreflightResult | null>(null);
  const [testingCredentials, setTestingCredentials] = useState(false);

  // GSTR-3B inputs (rupees)
  const [period, setPeriod] = useState("");
  const [itc, setItc] = useState({ opening: "0", availed: "0", reversed: "0", imports: "0", rcm: "0" });
  const [liabilityCap, setLiabilityCap] = useState("0");
  const [g3b, setG3b] = useState<Gstr3bValue | null>(null);

  // GSTR-9 inputs (rupees)
  const [fy, setFy] = useState("2025-26");
  const [tolerance, setTolerance] = useState("1");
  const [nineMoney, setNineMoney] = useState<Record<NineRowKey, Record<MoneyKey, string>>>({
    availed: { ...ZERO_MONEY },
    reversed: { ...ZERO_MONEY },
    imports: { ...ZERO_MONEY },
    rcm: { ...ZERO_MONEY },
    twoB: { ...ZERO_MONEY },
    pyc: { ...ZERO_MONEY },
  });
  const [g9, setG9] = useState<Gstr9Result | null>(null);
  const [g9Outward, setG9Outward] = useState<
    { month: string; taxableValue: number; igst: number; cgst: number; sgst: number; cess: number }[]
  >([]);

  // Campaigns
  const [campaigns, setCampaigns] = useState<FilingCampaignRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [campaignForm, setCampaignForm] = useState({
    formType: "gstr-3b" as FormType,
    period: "",
    dueDate: "",
    signingMethod: "evc" as SigningMethod,
    notes: "",
  });

  const book = books.find((b) => b.id === selectedBookId) ?? null;
  const bookId = book?.id ?? null;
  const bookGstin = book?.gstin ?? null;

  // Gateway readiness — tells the reviewer up front whether "File" transmits.
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<{ health: FilingGatewayHealth }>(
          `/api/books/${bookId}/gst-filing?action=gateway-health`,
        );
        if (!cancelled) setHealth(data.health);
      } catch {
        /* readiness is non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const load3b = useCallback(async () => {
    if (!bookId || !period) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const qs = new URLSearchParams({
        action: "gstr3b",
        period,
        openingIct: itc.opening || "0",
        itcAvailed: itc.availed || "0",
        itcReversed: itc.reversed || "0",
        importIct: itc.imports || "0",
        rcmItc: itc.rcm || "0",
        liabilityCap: liabilityCap || "0",
      });
      const data = await api<{ gstr3b: Gstr3bValue }>(`/api/books/${bookId}/gst-filing?${qs.toString()}`);
      setG3b(data.gstr3b);
    } catch (err) {
      setError(errorMessage(err));
      setG3b(null);
    } finally {
      setLoading(false);
    }
  }, [bookId, period, itc, liabilityCap]);

  const load9 = useCallback(async () => {
    if (!bookId || !book?.gstin) {
      setError("Set a GSTIN on the book before preparing GSTR-9.");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const months = monthsInYear(fy);
      const perMonth = await Promise.all(
        months.map((m) =>
          api<{ gstr3b: Gstr3bValue }>(`/api/books/${bookId}/gst-filing?action=gstr3b&period=${m}`)
            .then((r) => r.gstr3b.outward)
            .catch(() => ({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, invoiceCount: 0 })),
        ),
      );
      const monthlyOutward = months.map((m, i) => {
        const o = perMonth[i] ?? { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, invoiceCount: 0 };
        return {
          month: m,
          taxableValue: o.taxableValue / 100,
          igst: o.igst / 100,
          cgst: o.cgst / 100,
          sgst: o.sgst / 100,
          cess: o.cess / 100,
        };
      });

      const availed = moneyNumbers(nineMoney.availed);
      const body = {
        bookId,
        fy,
        gstin: book.gstin,
        monthlyOutward,
        monthlyItcAvailed: [{ month: fy, ...availed }],
        monthlyItcReversed: anyMoney(nineMoney.reversed)
          ? [{ month: fy, ...moneyNumbers(nineMoney.reversed) }]
          : undefined,
        importsItc: anyMoney(nineMoney.imports) ? moneyNumbers(nineMoney.imports) : undefined,
        monthlyRcm: anyMoney(nineMoney.rcm) ? [{ month: fy, ...moneyNumbers(nineMoney.rcm) }] : undefined,
        twoBAvailable: anyMoney(nineMoney.twoB) ? moneyNumbers(nineMoney.twoB) : undefined,
        previousYearClaims: anyMoney(nineMoney.pyc) ? moneyNumbers(nineMoney.pyc) : undefined,
        tolerance: Number(tolerance || 0),
      };

      const data = await api<{ gstr9: Gstr9Result; gstin: string }>(`/api/books/${bookId}/gst-filing?action=gstr9`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setG9(data.gstr9);
      setG9Outward(monthlyOutward);
    } catch (err) {
      setError(errorMessage(err));
      setG9(null);
    } finally {
      setLoading(false);
    }
  }, [bookId, book?.gstin, fy, nineMoney, tolerance]);

  const loadCampaigns = useCallback(async () => {
    if (!bookId) return;
    setError(null);
    try {
      const data = await api<{ campaigns: FilingCampaignRow[] }>(`/api/books/${bookId}/gst-filing?action=campaigns`);
      setCampaigns(data.campaigns);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [bookId]);

  const loadRcm = useCallback(async () => {
    if (!bookId) return;
    setError(null);
    setLoading(true);
    setNotice(null);
    try {
      const data = await api<{
        taxableValue: number;
        igst: number;
        cgst: number;
        sgst: number;
        cess: number;
        total: number;
      }>(`/api/gst/rcm/calculate`, {
        method: "POST",
        body: JSON.stringify({
          supply: {
            category: "motor-vehicle",
            supplierGstin: "",
            supplierName: "",
            recipientGstin: bookGstin || "",
            recipientName: "",
            placeOfSupply: "",
            taxableValue: 0,
            invoiceNumber: "",
            invoiceDate: new Date().toISOString().slice(0, 10),
            hsnSac: "",
            isImportOfService: false,
            isEcom: false,
          },
          recipientStateCode: "27",
        }),
      });
      setError(null);
      setNotice(
        `RCM Tax: IGST ${formatInr(data.igst)} + CGST ${formatInr(data.cgst)} + SGST ${formatInr(data.sgst)} + Cess ${formatInr(data.cess)} (total ${formatInr(data.total)})`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [bookId, bookGstin]);

  const loadEwayBill = useCallback(async () => {
    if (!bookId) return;
    setError(null);
    setLoading(true);
    setNotice(null);
    try {
      const data = await api<{ payload: unknown; validity: number }>(`/api/gst/eway-bill/generate-payload`, {
        method: "POST",
        body: JSON.stringify({
          docType: "INV",
          docNo: "TEST-001",
          docDate: new Date().toISOString().slice(0, 10),
          docValue: 10000,
          supplyType: "B2B",
          transactionType: "regular",
          subType: "outward",
          supplier: {
            gstin: bookGstin || "",
            name: "",
            address: "",
            place: "",
            pincode: 110001,
            stateCode: "27",
          },
          recipient: {
            gstin: bookGstin || "",
            name: "",
            address: "",
            place: "",
            pincode: 110001,
            stateCode: "27",
          },
          items: [
            {
              productName: "Test Product",
              description: "Test description",
              hsnCode: "1234",
              quantity: 1,
              unit: "pcs",
              taxableValue: 10000,
              taxRate: 18,
              sgstRate: 9,
              cgstRate: 9,
              igstRate: 0,
              cessRate: 0,
            },
          ],
          transport: {
            mode: "road",
            distance: 100,
            vehicleNo: "DL-01-AB-1234",
            vehicleType: "regular",
          },
        }),
      });
      setError(null);
      setNotice(`E-Way Bill generated. Validity: ${data.validity} hours`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [bookId, bookGstin]);

  const loadRcmItcEligibility = useCallback(async () => {
    if (!bookId) return;
    setError(null);
    setLoading(true);
    setNotice(null);
    try {
      const data = await api<{ eligibility: { eligible: boolean; blockedReason?: string | null } }>(
        `/api/gst/rcm/itc-eligibility`,
        {
          method: "POST",
          body: JSON.stringify({
            supply: {
              category: "motor-vehicle",
              supplierGstin: "",
              supplierName: "",
              recipientGstin: bookGstin || "",
              recipientName: "",
              placeOfSupply: "",
              taxableValue: 50000,
              invoiceNumber: "INV-001",
              invoiceDate: new Date().toISOString().slice(0, 10),
              hsnSac: "1234",
              isImportOfService: false,
              isEcom: false,
            },
            recipientStateCode: "27",
            isBusinessPurpose: true,
            isCapitalGoods: false,
            taxPaid: true,
          }),
        },
      );
      setError(null);
      setNotice(
        `ITC eligibility: ${data.eligibility.eligible ? "Eligible" : "Not eligible"} — blocked: ${data.eligibility.blockedReason || "none"}`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [bookId, bookGstin]);

  useEffect(() => {
    if (activeTab === "campaigns" && bookId) void loadCampaigns();
    if (activeTab === "rcm" && bookId) void loadRcm();
    if (activeTab === "eway-bill" && bookId) void loadEwayBill();
    if (activeTab === "rcm-itc" && bookId) void loadRcmItcEligibility();
  }, [activeTab, bookId, loadCampaigns, loadRcm, loadEwayBill, loadRcmItcEligibility]);

  const createCampaign = async () => {
    if (!bookId || !book?.gstin) {
      setError("Set a GSTIN on the book before creating a filing campaign.");
      return;
    }
    if (!campaignForm.period || !campaignForm.dueDate) {
      setError("A campaign needs a period (yyyy-mm) and a due date (yyyy-mm-dd).");
      return;
    }
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api<{ campaign: FilingCampaignRow }>(`/api/books/${bookId}/gst-filing`, {
        method: "PATCH",
        body: JSON.stringify({ action: "filing-campaign", gstin: book.gstin, ...campaignForm }),
      });
      setCampaigns((prev) => [data.campaign, ...prev]);
      setCampaignForm((f) => ({ ...f, period: "", dueDate: "", notes: "" }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const updateCampaign = async (id: string, status: CampaignStatus) => {
    if (!bookId) return;
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const data = await api<{ campaign: FilingCampaignRow }>(`/api/books/${bookId}/gst-filing`, {
        method: "PATCH",
        body: JSON.stringify({ action: "update-campaign", campaignId: id, status }),
      });
      setCampaigns((prev) => prev.map((c) => (c.id === data.campaign.id ? data.campaign : c)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const submitCampaign = async (id: string) => {
    if (!bookId) return;
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const data = await api<{ receipt: FilingReceipt; campaign: FilingCampaignRow }>(
        `/api/books/${bookId}/gst-filing`,
        { method: "PATCH", body: JSON.stringify({ action: "submit-campaign", campaignId: id }) },
      );
      setCampaigns((prev) => prev.map((c) => (c.id === data.campaign.id ? data.campaign : c)));
      setNotice(
        `Submission handled by the "${data.receipt.provider}" provider → status "${data.receipt.status}". ${
          data.receipt.portalMessage ?? ""
        }`.trim(),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const testCredentials = async () => {
    if (!bookId) return;
    setTestingCredentials(true);
    setPreflight(null);
    setError(null);
    try {
      const data = await api<{ preflight: FilingPreflightResult }>(
        `/api/books/${bookId}/gst-filing?action=gateway-preflight`,
        { method: "POST" },
      );
      setPreflight(data.preflight);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTestingCredentials(false);
    }
  };

  return (
    <div className="space-y-4">
      {health && (
        <Banner tone={health.provider === "live" ? "ok" : "warn"}>
          Filing provider: <strong>{health.provider}</strong>
          {health.provider === "reference" &&
            " — a deterministic local acknowledgement is produced; nothing is transmitted to GSTN / the IRP."}
          {health.provider === "simulation" && " — offline simulator; nothing leaves this machine."}
          {health.provider === "live" &&
            health.activeChannel !== "none" &&
            (health.channels[health.activeChannel].configured
              ? ` — live "${health.activeChannel}" channel is configured.`
              : ` — live "${health.activeChannel}" is NOT configured (missing ${health.channels[
                  health.activeChannel
                ].missing.join(", ")}); submissions fail closed.`)}
        </Banner>
      )}

      {health?.provider === "live" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={testingCredentials || !bookId}
            onClick={() => void testCredentials()}
          >
            {testingCredentials ? "Testing…" : "Test live credentials"}
          </Button>
          <span className="text-xs text-neutral-500">Runs the portal auth handshake only — no document is filed.</span>
        </div>
      )}

      {preflight && (
        <Banner tone={preflight.ok ? "ok" : "warn"}>
          Credential preflight {preflight.ok ? "passed" : "failed"}: {preflight.detail}
          {preflight.sandbox ? " (sandbox endpoint — no real filing)" : ""}
        </Banner>
      )}

      {!book && <p className="text-sm text-neutral-500">Select a book on the left to prepare its GST returns.</p>}

      {error && <Banner tone="warn">{error}</Banner>}
      {notice && <Banner tone="info">{notice}</Banner>}

      {book && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">GST filing workspace</div>
              <div className="text-xs text-neutral-500">
                {book.name}
                {book.gstin ? ` · GSTIN ${book.gstin}` : " · (no GSTIN set on the book)"}
              </div>
            </div>
            <div className="flex gap-1">
              {(["3b", "9", "campaigns", "rcm", "eway-bill", "rcm-itc"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setActiveTab(t);
                    setError(null);
                    setNotice(null);
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    activeTab === t
                      ? "bg-neutral-900 text-white"
                      : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                  }`}
                >
                  {t === "3b"
                    ? "GSTR-3B"
                    : t === "9"
                      ? "GSTR-9"
                      : t === "campaigns"
                        ? "Campaigns"
                        : t === "rcm"
                          ? "RCM"
                          : t === "eway-bill"
                            ? "E‑Way Bill"
                            : "RCM ITC Eligibility"}
                </button>
              ))}
            </div>
          </div>

          {/* ------------------------------------------------ GSTR-3B */}
          {activeTab === "3b" && (
            <div className="space-y-4">
              <p className="text-xs text-neutral-500">
                Figures are computed from the book&apos;s validated/posted invoices for the period. The ITC rows are
                caller-supplied (they are not derived from the book) and are entered in rupees.
              </p>

              <div className="flex flex-wrap items-end gap-3">
                <Input
                  label="Period (yyyy-mm)"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  placeholder="2025-06"
                />
                <Input
                  label="Liability cap (₹)"
                  value={liabilityCap}
                  onChange={(e) => setLiabilityCap(e.target.value)}
                  placeholder="0"
                />
                <Button disabled={!period || loading} onClick={() => void load3b()}>
                  {loading ? "Computing…" : "Compute GSTR-3B"}
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3 rounded border border-neutral-200 bg-neutral-50 p-3 md:grid-cols-5">
                <Input
                  label="Opening ITC (₹)"
                  value={itc.opening}
                  onChange={(e) => setItc((v) => ({ ...v, opening: e.target.value }))}
                />
                <Input
                  label="ITC availed (₹)"
                  value={itc.availed}
                  onChange={(e) => setItc((v) => ({ ...v, availed: e.target.value }))}
                />
                <Input
                  label="ITC reversed (₹)"
                  value={itc.reversed}
                  onChange={(e) => setItc((v) => ({ ...v, reversed: e.target.value }))}
                />
                <Input
                  label="ITC imports (₹)"
                  value={itc.imports}
                  onChange={(e) => setItc((v) => ({ ...v, imports: e.target.value }))}
                />
                <Input
                  label="RCM ITC (₹)"
                  value={itc.rcm}
                  onChange={(e) => setItc((v) => ({ ...v, rcm: e.target.value }))}
                />
              </div>

              {g3b && (
                <div className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Outward supplies · {g3b.period} · {g3b.outward.invoiceCount} invoice(s)
                  </div>
                  <div className="rounded border border-neutral-200 bg-white p-2">
                    <Row label="Taxable value" value={g3b.outward.taxableValue} />
                    <Row label="IGST" value={g3b.outward.igst} />
                    <Row label="CGST" value={g3b.outward.cgst} />
                    <Row label="SGST" value={g3b.outward.sgst} />
                    <Row label="Cess" value={g3b.outward.cess} />
                  </div>

                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Input tax credit</div>
                  <div className="rounded border border-neutral-200 bg-white p-2">
                    <Row label="Opening" value={g3b.itc.opening} />
                    <Row label="Availed" value={g3b.itc.availed} />
                    <Row label="Reversed" value={g3b.itc.reversed} />
                    <Row label="Imports" value={g3b.itc.imports} />
                    <Row label="RCM" value={g3b.itc.rcm} />
                    <Row label="Net ITC" value={g3b.itc.net} />
                  </div>

                  <div className="rounded border border-neutral-200 bg-white p-2">
                    <Row
                      label="Net tax liability"
                      value={g3b.netLiability}
                      tone={g3b.netLiability > 0 ? "warn" : "ok"}
                    />
                  </div>

                  {g3b.warnings.map((w, i) => (
                    <Banner key={i} tone="warn">
                      {w}
                    </Banner>
                  ))}

                  {g3b.sampleEInvoice?.ValDtls && (
                    <div className="rounded border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600">
                      <div className="font-medium text-neutral-700">Sample e-invoice the IRP would accept</div>
                      <div className="mt-1">
                        {g3b.sampleEInvoice.DocDtls?.Typ} {g3b.sampleEInvoice.DocDtls?.No} ·{" "}
                        {g3b.sampleEInvoice.DocDtls?.Dt} · buyer {g3b.sampleEInvoice.BuyerDtls?.Gstin || "—"} · total{" "}
                        {formatInr(g3b.sampleEInvoice.ValDtls.TotInvVal ?? 0)}
                      </div>
                      <div className="mt-1 text-neutral-500">
                        Preview only — no IRN is generated or transmitted here.
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ------------------------------------------------ GSTR-9 */}
          {activeTab === "9" && (
            <div className="space-y-4">
              <p className="text-xs text-neutral-500">
                Monthly outward is derived from the book&apos;s invoices (April→March). Annual ITC figures are
                caller-supplied, entered once in rupees — the annual roll-up is a sum, so one row is exact.
              </p>

              <div className="flex flex-wrap items-end gap-3">
                <Input
                  label="Fiscal year (yyyy-yy)"
                  value={fy}
                  onChange={(e) => setFy(e.target.value)}
                  placeholder="2025-26"
                />
                <Input
                  label="Tolerance (₹)"
                  value={tolerance}
                  onChange={(e) => setTolerance(e.target.value)}
                  placeholder="1"
                />
                <Button disabled={!fy || loading || !book.gstin} onClick={() => void load9()}>
                  {loading ? "Preparing…" : "Prepare GSTR-9"}
                </Button>
              </div>
              {!book.gstin && <Banner tone="warn">This book has no GSTIN — set it on the book first.</Banner>}

              <div className="overflow-x-auto rounded border border-neutral-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                      <th className="px-3 py-2">Annual figure (₹)</th>
                      <th className="px-2 py-2">IGST</th>
                      <th className="px-2 py-2">CGST</th>
                      <th className="px-2 py-2">SGST</th>
                      <th className="px-2 py-2">Cess</th>
                    </tr>
                  </thead>
                  <tbody>
                    {NINE_ROWS.map((r) => (
                      <tr key={r.key} className="border-b border-neutral-100">
                        <td className="px-3 py-2">
                          <div className="font-medium text-neutral-700">{r.label}</div>
                          <div className="text-xs text-neutral-400">{r.note}</div>
                        </td>
                        {(["igst", "cgst", "sgst", "cess"] as MoneyKey[]).map((head) => (
                          <td key={head} className="px-2 py-2">
                            <input
                              type="number"
                              className="h-8 w-24 rounded-md border border-neutral-300 px-2 text-sm"
                              value={nineMoney[r.key][head]}
                              onChange={(e) =>
                                setNineMoney((prev) => ({
                                  ...prev,
                                  [r.key]: { ...prev[r.key], [head]: e.target.value },
                                }))
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {g9 && (
                <div className="space-y-3">
                  <div className="rounded border border-neutral-200 bg-white p-2">
                    <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      Table 4 · ITC
                    </div>
                    <Row
                      label="ITC availed"
                      value={
                        g9.table4.availed.igst +
                        g9.table4.availed.cgst +
                        g9.table4.availed.sgst +
                        g9.table4.availed.cess
                      }
                    />
                    <Row
                      label="ITC reversed"
                      value={
                        g9.table4.reversed.igst +
                        g9.table4.reversed.cgst +
                        g9.table4.reversed.sgst +
                        g9.table4.reversed.cess
                      }
                    />
                    <Row
                      label="Net ITC"
                      value={g9.table4.net.igst + g9.table4.net.cgst + g9.table4.net.sgst + g9.table4.net.cess}
                      tone="ok"
                    />
                  </div>

                  <div className="rounded border border-neutral-200 bg-white p-2">
                    <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      Table 9 · Outward for FY {g9.fy}
                    </div>
                    <Row label="Taxable value" value={g9.table9Outward.taxableValue} />
                    <Row
                      label="Total tax"
                      value={
                        g9.table9Outward.igst + g9.table9Outward.cgst + g9.table9Outward.sgst + g9.table9Outward.cess
                      }
                    />
                  </div>

                  {g9.table8 && (
                    <div
                      className={`rounded border p-3 ${g9.table8.reconciled ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}
                    >
                      <div className="text-xs font-semibold uppercase tracking-wide text-neutral-600">
                        Table 8C · 2B vs 3B reconciliation{" "}
                        {g9.table8.reconciled ? "(within tolerance)" : "(a gap to explain)"}
                      </div>
                      <div className="mt-2">
                        <Row label="8A available in GSTR-2B — IGST" value={g9.table8.twoBAvailable.igst} />
                        <Row label="8B availed in 3B — IGST" value={g9.table8.availed.igst} />
                        <Row label="8C difference — IGST" value={g9.table8.difference.igst} tone="warn" />
                      </div>
                    </div>
                  )}

                  {g9Outward.some((m) => m.taxableValue !== 0) && (
                    <details className="rounded border border-neutral-200 bg-neutral-50 p-3 text-xs">
                      <summary className="cursor-pointer font-medium text-neutral-700">
                        Monthly outward derived from invoices
                      </summary>
                      <div className="mt-2 space-y-1">
                        {g9Outward.map((m) => (
                          <div key={m.month} className="flex justify-between">
                            <span className="text-neutral-600">{m.month}</span>
                            <span className="tabular-nums">
                              {formatInr(m.taxableValue * 100)} taxable ·{" "}
                              {formatInr((m.igst + m.cgst + m.sgst + m.cess) * 100)} tax
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {g9.warnings.map((w, i) => (
                    <Banner key={i} tone="warn">
                      {w}
                    </Banner>
                  ))}

                  <div className="rounded border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500">
                    {g9.methodology.map((m, i) => (
                      <div key={i}>{m}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ------------------------------------------------ Campaigns */}
          {activeTab === "campaigns" && (
            <div className="space-y-3">
              <p className="text-xs text-neutral-500">
                A campaign records the intent to file — and, on Submit, sends it through the active filing provider and
                stores the acknowledgement / IRN returned. Submitting is irreversible for live providers; verify the
                provider banner above first.
              </p>

              <div className="flex flex-wrap items-end gap-3">
                <Select
                  label="Form"
                  value={campaignForm.formType}
                  onChange={(e) => setCampaignForm((f) => ({ ...f, formType: e.target.value as FormType }))}
                  options={[
                    { value: "gstr-3b", label: "GSTR-3B" },
                    { value: "gstr-1", label: "GSTR-1" },
                    { value: "gstr-9", label: "GSTR-9" },
                  ]}
                />
                <Input
                  label="Period (yyyy-mm)"
                  value={campaignForm.period}
                  onChange={(e) => setCampaignForm((f) => ({ ...f, period: e.target.value }))}
                  placeholder="2025-06"
                />
                <Input
                  label="Due date (yyyy-mm-dd)"
                  type="date"
                  value={campaignForm.dueDate}
                  onChange={(e) => setCampaignForm((f) => ({ ...f, dueDate: e.target.value }))}
                />
                <Select
                  label="Signing"
                  value={campaignForm.signingMethod}
                  onChange={(e) => setCampaignForm((f) => ({ ...f, signingMethod: e.target.value as SigningMethod }))}
                  options={[
                    { value: "evc", label: "EVC (bank validation)" },
                    { value: "dsc", label: "DSC" },
                    { value: "etm", label: "ETM / Aadhaar eSign" },
                  ]}
                />
                <Input
                  label="Notes"
                  value={campaignForm.notes}
                  onChange={(e) => setCampaignForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Optional"
                />
                <Button disabled={creating || !book.gstin} onClick={() => void createCampaign()}>
                  {creating ? "Creating…" : "New campaign"}
                </Button>
              </div>

              {campaigns.length === 0 ? (
                <p className="text-sm text-neutral-500">No filing campaigns yet for this book.</p>
              ) : (
                <ul className="space-y-2">
                  {campaigns.map((c) => (
                    <li key={c.id} className="rounded-lg border border-neutral-200 bg-white p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium">
                            {c.formType.toUpperCase()} · {c.period}
                            <span className="ml-2 text-xs font-normal text-neutral-400">due {c.dueDate}</span>
                          </div>
                          <div className="mt-0.5 text-xs text-neutral-500">
                            {c.signingMethod === "dsc" ? "DSC" : c.signingMethod === "etm" ? "ETM/eSign" : "EVC"}
                            {c.ackNumber ? ` · ACK ${c.ackNumber}` : ""}
                            {c.irn ? ` · IRN ${c.irn}` : ""}
                            {c.notes ? ` · ${c.notes}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Select
                            value={c.status}
                            onChange={(e) => void updateCampaign(c.id, e.target.value as CampaignStatus)}
                            options={STATUS_OPTIONS}
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busyId === c.id}
                            onClick={() => void submitCampaign(c.id)}
                          >
                            {busyId === c.id ? "Submitting…" : "Submit"}
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
