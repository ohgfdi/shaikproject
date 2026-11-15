/** Indian banking integration - IMPS/NEFT/RTGS, account statement parsing, cheque truncation */

export class IndianBankingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndianBankingError";
  }
}

import { formatInr } from "./india-tax";

// ---------------------------------------------------------------------------
// IMPS (Immediate Payment Service)
// ---------------------------------------------------------------------------

export interface IMPSConfig {
  bankCode: string; // 3-digit bank code (e.g., "000" for state bank of India)
  accountNumber: string;
  ifscCode: string;
  mobileNumber: string;
  mmID?: string | null; // Mobile Money Identifier
  userName?: string | null;
}

export interface IMPSLimits {
  minAmount: number; // Minor units (₹1 minimum)
  maxAmount: number; // Minor units (₹5,00,000 per transaction)
  dailyLimit: number; // Minor units (₹5,00,000 per day)
}

export const IMPS_LIMITS: IMPSLimits = {
  minAmount: 100,
  maxAmount: 50000000, // ₹5,00,000
  dailyLimit: 50000000, // ₹5,00,000
};

export interface IMPSFundsTransfer {
  transactionId: string;
  fromAccount: string;
  toAccount?: string | null;
  toMobileNumber?: string | null;
  toMMID?: string | null;
  amount: number;
  fee: number;
  status: "initiated" | "success" | "failed" | "reversed";
  impsReference: string;
  transactionDate: string;
  remark?: string | null;
}

export function calculateIMPSFee(amount: number, channel: "mobile" | "online" | "branch"): number {
  // Simplified - actual fees vary by bank
  if (channel === "mobile" || channel === "online") {
    if (amount <= 1000000) return 500; // ₹5
    if (amount <= 10000000) return 1000; // ₹10
    return 2500; // ₹25
  }
  // Branch: higher charges
  return 1000 + Math.round(amount * 0.002); // ₹10 + 0.2%
}

export function transferViaIMPS(
  config: IMPSConfig,
  amount: number,
  recipient: { accountNumber?: string | null; mobileNumber?: string | null; mmID?: string | null },
  channel: "mobile" | "online" | "branch" = "mobile",
): IMPSFundsTransfer {
  if (amount < IMPS_LIMITS.minAmount || amount > IMPS_LIMITS.maxAmount) {
    throw new IndianBankingError(`IMPS amount must be between ₹1 and ₹5,00,000.`);
  }

  const fee = calculateIMPSFee(amount, channel);
  const transactionId = `IMPS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const impsReference = `IMPS${Date.now().toString(36).toUpperCase().slice(-12)}`;

  return {
    transactionId,
    fromAccount: config.accountNumber,
    toAccount: recipient.accountNumber,
    toMobileNumber: recipient.mobileNumber,
    toMMID: recipient.mmID,
    amount,
    fee,
    status: "initiated",
    impsReference,
    transactionDate: new Date().toISOString(),
    remark: `IMPS transfer of ${formatInr(amount)}`,
  };
}

// ---------------------------------------------------------------------------
// NEFT (National Electronic Funds Transfer)
// ---------------------------------------------------------------------------

export interface NEFTConfig {
  bankCode: string;
  accountNumber: string;
  ifscCode: string;
}

export interface NEFTBatch {
  batchNumber: number;
  startTime: string;
  endTime: string;
}

export const NEFT_BATCHES: NEFTBatch[] = [
  { batchNumber: 1, startTime: "00:00", endTime: "00:30" },
  { batchNumber: 2, startTime: "00:30", endTime: "01:00" },
  { batchNumber: 3, startTime: "01:00", endTime: "01:30" },
  { batchNumber: 4, startTime: "01:30", endTime: "02:00" },
  { batchNumber: 5, startTime: "02:00", endTime: "02:30" },
  { batchNumber: 6, startTime: "02:30", endTime: "03:00" },
  { batchNumber: 7, startTime: "03:00", endTime: "03:30" },
  { batchNumber: 8, startTime: "03:30", endTime: "04:00" },
  { batchNumber: 9, startTime: "04:00", endTime: "04:30" },
  { batchNumber: 10, startTime: "04:30", endTime: "05:00" },
  { batchNumber: 11, startTime: "05:00", endTime: "05:30" },
  { batchNumber: 12, startTime: "05:30", endTime: "06:00" },
  { batchNumber: 13, startTime: "06:00", endTime: "06:30" },
  { batchNumber: 14, startTime: "06:30", endTime: "07:00" },
  { batchNumber: 15, startTime: "07:00", endTime: "07:30" },
  { batchNumber: 16, startTime: "07:30", endTime: "08:00" },
  { batchNumber: 17, startTime: "08:00", endTime: "08:30" },
  { batchNumber: 18, startTime: "08:30", endTime: "09:00" },
  { batchNumber: 19, startTime: "09:00", endTime: "09:30" },
  { batchNumber: 20, startTime: "09:30", endTime: "10:00" },
  { batchNumber: 21, startTime: "10:00", endTime: "10:30" },
  { batchNumber: 22, startTime: "10:30", endTime: "11:00" },
  { batchNumber: 23, startTime: "11:00", endTime: "11:30" },
  { batchNumber: 24, startTime: "11:30", endTime: "12:00" },
  { batchNumber: 25, startTime: "12:00", endTime: "12:30" },
  { batchNumber: 26, startTime: "12:30", endTime: "13:00" },
  { batchNumber: 27, startTime: "13:00", endTime: "13:30" },
  { batchNumber: 28, startTime: "13:30", endTime: "14:00" },
  { batchNumber: 29, startTime: "14:00", endTime: "14:30" },
  { batchNumber: 30, startTime: "14:30", endTime: "15:00" },
  { batchNumber: 31, startTime: "15:00", endTime: "15:30" },
  { batchNumber: 32, startTime: "15:30", endTime: "16:00" },
  { batchNumber: 33, startTime: "16:00", endTime: "16:30" },
  { batchNumber: 34, startTime: "16:30", endTime: "17:00" },
  { batchNumber: 35, startTime: "17:00", endTime: "17:30" },
  { batchNumber: 36, startTime: "17:30", endTime: "18:00" },
  { batchNumber: 37, startTime: "18:00", endTime: "18:30" },
  { batchNumber: 38, startTime: "18:30", endTime: "19:00" },
  { batchNumber: 39, startTime: "19:00", endTime: "19:30" },
  { batchNumber: 40, startTime: "19:30", endTime: "20:00" },
  { batchNumber: 41, startTime: "20:00", endTime: "20:30" },
  { batchNumber: 42, startTime: "20:30", endTime: "21:00" },
  { batchNumber: 43, startTime: "21:00", endTime: "21:30" },
  { batchNumber: 44, startTime: "21:30", endTime: "22:00" },
  { batchNumber: 45, startTime: "22:00", endTime: "22:30" },
  { batchNumber: 46, startTime: "22:30", endTime: "23:00" },
  { batchNumber: 47, startTime: "23:00", endTime: "23:30" },
  { batchNumber: 48, startTime: "23:30", endTime: "00:00" },
];

export interface NEFTFundsTransfer {
  transactionId: string;
  fromAccount: string;
  toAccount: string;
  beneficiaryName: string;
  amount: number;
  fee: number;
  status: "initiated" | "success" | "failed";
  neftReference: string;
  transactionDate: string;
  batchNumber: number;
  expectedSettlementDate: string;
  remark?: string | null;
}

export function calculateNEFTFee(amount: number, channel: "online" | "branch"): number {
  // Simplified - actual fees vary by bank
  if (channel === "online") return 0; // NEFT through internet banking is free
  // Branch: ₹2.5 + GST for ₹1-10L, ₹5 + GST for ₹10L+
  if (amount <= 1000000) return 255; // ₹2.5 + 20% GST
  return 510; // ₹5 + 20% GST
}

export function getNextNEFTBatch(): NEFTBatch {
  const now = new Date();
  const currentTime = now.getHours() * 60 + now.getMinutes();

  for (const batch of NEFT_BATCHES) {
    const [startHour = 0, startMin = 0] = batch.startTime.split(":").map(Number);
    const startMinTotal = startHour * 60 + startMin;

    if (currentTime < startMinTotal) {
      return batch;
    }
  }

  // If past last batch, return first batch of next day
  return NEFT_BATCHES[0]!;
}

export function transferViaNEFT(
  config: NEFTConfig,
  amount: number,
  toAccount: string,
  beneficiaryName: string,
  channel: "online" | "branch" = "online",
  scheduledDate?: string | null,
): NEFTFundsTransfer {
  if (amount <= 0) {
    throw new IndianBankingError("NEFT amount must be positive.");
  }

  const fee = calculateNEFTFee(amount, channel);
  const transactionId = `NEFT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const neftReference = `NEFT${Date.now().toString(36).toUpperCase().slice(-12)}`;

  const nextBatch = scheduledDate ? NEFT_BATCHES[0]! : getNextNEFTBatch();
  const expectedSettlementDate = scheduledDate ?? new Date().toISOString().slice(0, 10);

  return {
    transactionId,
    fromAccount: config.accountNumber,
    toAccount,
    beneficiaryName,
    amount,
    fee,
    status: "initiated",
    neftReference,
    transactionDate: new Date().toISOString(),
    batchNumber: nextBatch.batchNumber,
    expectedSettlementDate,
    remark: `NEFT transfer of ${formatInr(amount)}`,
  };
}

// ---------------------------------------------------------------------------
// RTGS (Real Time Gross Settlement)
// ---------------------------------------------------------------------------

export interface RTGSConfig {
  bankCode: string;
  accountNumber: string;
  ifscCode: string;
}

export interface RTGSFundsTransfer {
  transactionId: string;
  fromAccount: string;
  toAccount: string;
  beneficiaryName: string;
  amount: number;
  fee: number;
  status: "initiated" | "success" | "failed";
  rtgsReference: string;
  transactionDate: string;
  settlementDate: string;
  remark?: string | null;
}

export const RTGS_LIMITS = {
  minAmount: 20000000, // ₹2,00,000
  maxAmount: 10000000000, // No upper limit (₹10 crore)
};

export function calculateRTGSFee(amount: number, channel: "online" | "branch"): number {
  // Simplified - actual fees vary by bank
  if (channel === "online") {
    if (amount <= 10000000) return 1000; // ₹10
    if (amount <= 100000000) return 5000; // ₹50
    return 10000; // ₹100
  }
  // Branch: ₹30 + GST for ₹2L-10L
  if (amount <= 10000000) return 362; // ₹30 + 20.62% GST (approx)
  if (amount <= 100000000) return 605; // ₹50 + GST
  return 1220; // ₹100 + GST
}

export function transferViaRTGS(
  config: RTGSConfig,
  amount: number,
  toAccount: string,
  beneficiaryName: string,
  channel: "online" | "branch" = "online",
): RTGSFundsTransfer {
  if (amount < RTGS_LIMITS.minAmount || amount > RTGS_LIMITS.maxAmount) {
    throw new IndianBankingError(`RTGS amount must be between ₹2,00,000 and ₹10 crore.`);
  }

  const fee = calculateRTGSFee(amount, channel);
  const transactionId = `RTGS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rtgsReference = `RTGS${Date.now().toString(36).toUpperCase().slice(-12)}`;

  return {
    transactionId,
    fromAccount: config.accountNumber,
    toAccount,
    beneficiaryName,
    amount,
    fee,
    status: "initiated",
    rtgsReference,
    transactionDate: new Date().toISOString(),
    settlementDate: new Date().toISOString(), // RTGS is real-time
    remark: `RTGS transfer of ${formatInr(amount)}`,
  };
}

// ---------------------------------------------------------------------------
// Account Statement Parsing
// ---------------------------------------------------------------------------

export interface BankStatementLine {
  date: string;
  description: string;
  debit: number | null;
  credit: number | null;
  balance: number;
  transactionId?: string | null;
  referenceNumber?: string | null;
  chequeNumber?: string | null;
  instrumentType?:
    "cheque" | "dd" | "rtgs" | "neft" | "imps" | "cash" | "deposit" | "withdrawal" | "fee" | "interest" | "other";
  counterparty?: string | null;
  counterpartyAccount?: string | null;
  counterpartyIfsc?: string | null;
  narration?: string | null;
}

export interface ParsedBankStatement {
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  statementDate: string;
  statementPeriod: { startDate: string; endDate: string };
  totalCredits: number;
  totalDebits: number;
  openingBalance: number;
  closingBalance: number;
  entries: BankStatementLine[];
  parsedSuccessful: boolean;
  parseErrors: string[];
}

export function parseBankStatementCSV(csvContent: string, bankName: string = "Unknown Bank"): ParsedBankStatement {
  // Simplified - actual parsing would handle various bank formats
  const lines = csvContent.split("\n").filter((line) => line.trim() !== "");
  const entries: BankStatementLine[] = [];

  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    if (parts.length < 4) continue;

    const date = parts[0]?.trim();
    const description = parts[1]?.trim();
    const debit = parts[2]?.trim();
    const credit = parts[3]?.trim();
    const balance = parts[4]?.trim();

    entries.push({
      date: date ?? "",
      description: description ?? "",
      debit: debit ? Math.round(parseFloat(debit) * 100) : null,
      credit: credit ? Math.round(parseFloat(credit) * 100) : null,
      balance: Math.round(parseFloat(balance ?? "0") * 100),
      transactionId: null,
      referenceNumber: null,
      chequeNumber: null,
      instrumentType: undefined,
      counterparty: null,
      counterpartyAccount: null,
      counterpartyIfsc: null,
      narration: null,
    });
  }

  const totalCredits = entries.reduce((s, e) => s + (e.credit ?? 0), 0);
  const totalDebits = entries.reduce((s, e) => s + (e.debit ?? 0), 0);
  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  const openingBalance = firstEntry ? firstEntry.balance - (firstEntry.credit ?? 0) + (firstEntry.debit ?? 0) : 0;
  const closingBalance = lastEntry ? lastEntry.balance : 0;

  return {
    bankName,
    accountHolderName: "Unknown",
    accountNumber: "0000000000",
    ifscCode: "XXXXXXXXX",
    statementDate: new Date().toISOString().slice(0, 10),
    statementPeriod: { startDate: entries[0]?.date ?? "", endDate: entries[entries.length - 1]?.date ?? "" },
    totalCredits,
    totalDebits,
    openingBalance,
    closingBalance,
    entries,
    parsedSuccessful: true,
    parseErrors: [],
  };
}

// ---------------------------------------------------------------------------
// Cheque Truncation System (CTS)
// ---------------------------------------------------------------------------

export interface ChequeDetails {
  chequeNumber: string;
  chequeDate: string;
  amount: number;
  payeeName: string;
  drawerName: string;
  draweeBank: string;
  draweeBranch: string;
  ifscCode: string;
  micrCode: string;
  accountNumber: string;
  cellularImage?: string | null;
}

export interface CTSCheque {
  chequeNumber: string;
  chequeDate: string;
  amount: number;
  payeeName: string;
  drawerName: string;
  draweeBank: string;
  draweeBranch: string;
  ifscCode: string;
  micrCode: string;
  accountNumber: string;
  ctsDate: string;
  ctsStatus: "truncated" | "processed" | "paid" | "reversed" | "bounced";
  imageReference?: string | null;
  clearingHouseReference?: string | null;
  settlementDate?: string | null;
}

export function truncateCheque(cheque: ChequeDetails, ctsDate: string): CTSCheque {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cheque.chequeDate)) {
    throw new IndianBankingError("chequeDate must be yyyy-mm-dd.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ctsDate)) {
    throw new IndianBankingError("ctsDate must be yyyy-mm-dd.");
  }
  if (!/^[0-9]{6}$/.test(cheque.micrCode)) {
    throw new IndianBankingError("MICR code must be 6 digits.");
  }

  return {
    chequeNumber: cheque.chequeNumber,
    chequeDate: cheque.chequeDate,
    amount: cheque.amount,
    payeeName: cheque.payeeName,
    drawerName: cheque.drawerName,
    draweeBank: cheque.draweeBank,
    draweeBranch: cheque.draweeBranch,
    ifscCode: cheque.ifscCode,
    micrCode: cheque.micrCode,
    accountNumber: cheque.accountNumber,
    ctsDate,
    ctsStatus: "truncated",
    imageReference: cheque.cellularImage,
    clearingHouseReference: `CHQ-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    settlementDate: null,
  };
}

// ---------------------------------------------------------------------------
// Banking Fees Calculator
// ---------------------------------------------------------------------------

export interface BankingFees {
  accountType: "savings" | "current" | "salary";
  averageMonthlyBalance: number;
  transactions: {
    type:
      | "cash_withdrawal"
      | "cheque_book"
      | "dd"
      | "rtgs"
      | "neft"
      | "imps"
      | "internet_banking"
      | "mobile_banking"
      | "atm_withdrawal"
      | "atm_pin_reset"
      | "cheque_return"
      | "sms_alert"
      | "email_alert"
      | "overdraft";
    count: number;
    totalAmount?: number | null;
  }[];
  branchLocation: "metro" | "non-metro";
}

export interface BankingFeesResult {
  accountType: string;
  averageMonthlyBalance: number;
  maintenanceFee: number;
  transactionFees: {
    type: string;
    count: number;
    feePerTransaction: number;
    totalFee: number;
  }[];
  totalFees: number;
  warnings: string[];
  methodology: string[];
}

export function calculateBankingFees(fees: BankingFees): BankingFeesResult {
  let maintenanceFee = 0;

  if (fees.accountType === "savings") {
    if (fees.branchLocation === "metro") {
      if (fees.averageMonthlyBalance >= 100000) maintenanceFee = 0;
      else if (fees.averageMonthlyBalance >= 50000) maintenanceFee = 5000;
      else if (fees.averageMonthlyBalance >= 30000) maintenanceFee = 10000;
      else maintenanceFee = 15000;
    } else {
      if (fees.averageMonthlyBalance >= 50000) maintenanceFee = 0;
      else if (fees.averageMonthlyBalance >= 25000) maintenanceFee = 5000;
      else if (fees.averageMonthlyBalance >= 10000) maintenanceFee = 10000;
      else maintenanceFee = 15000;
    }
  } else if (fees.accountType === "current") {
    maintenanceFee = 10000 + Math.round(fees.averageMonthlyBalance * 0.005); // ₹100 + 0.5% of AMB
  }

  const transactionFees = fees.transactions.map((t) => {
    let feePerTransaction = 0;
    switch (t.type) {
      case "cash_withdrawal":
        feePerTransaction = 100 + t.count * 50; // ₹100 first + ₹50 subsequent
        break;
      case "cheque_book":
        feePerTransaction = 500; // ₹5 per leaf (approx 100 leaves)
        break;
      case "dd":
        feePerTransaction = 1000; // ₹10
        break;
      case "rtgs":
        feePerTransaction = calculateRTGSFee(t.totalAmount ?? 0, "branch");
        break;
      case "neft":
        feePerTransaction = calculateNEFTFee(t.totalAmount ?? 0, "branch");
        break;
      case "imps":
        feePerTransaction = calculateIMPSFee(t.totalAmount ?? 0, "branch");
        break;
      case "internet_banking":
        feePerTransaction = 0;
        break;
      case "mobile_banking":
        feePerTransaction = 0;
        break;
      case "atm_withdrawal":
        feePerTransaction = t.count > 5 ? 200 : 0; // ₹20 after 5 free
        break;
      case "atm_pin_reset":
        feePerTransaction = 500; // ₹5
        break;
      case "cheque_return":
        feePerTransaction = 15000; // ₹150
        break;
      case "sms_alert":
        feePerTransaction = 200; // ₹2
        break;
      case "email_alert":
        feePerTransaction = 0;
        break;
      case "overdraft":
        feePerTransaction = 100000; // ₹1,000
        break;
      default:
        feePerTransaction = 0;
    }
    return {
      type: t.type,
      count: t.count,
      feePerTransaction,
      totalFee: feePerTransaction * t.count,
    };
  });

  const totalFees = maintenanceFee + transactionFees.reduce((s, f) => s + f.totalFee, 0);

  return {
    accountType: fees.accountType,
    averageMonthlyBalance: fees.averageMonthlyBalance,
    maintenanceFee,
    transactionFees,
    totalFees,
    warnings: [],
    methodology: [
      `Banking fees: ${fees.accountType} account, AMB ₹${formatInr(fees.averageMonthlyBalance)}.`,
      `Maintenance fee: ${formatInr(maintenanceFee)}.`,
      `Transaction fees: ${formatInr(transactionFees.reduce((s, f) => s + f.totalFee, 0))}.`,
      `Total fees: ${formatInr(totalFees)}.`,
    ],
  };
}
