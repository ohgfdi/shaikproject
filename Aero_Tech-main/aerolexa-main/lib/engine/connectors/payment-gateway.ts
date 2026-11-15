/**
 * Payment Gateway Connectors — Razorpay and PayU
 */

import type { ColType, SqlValue } from "@/lib/types";

export interface RazorpayPayment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  method?: string;
  email?: string;
  contact?: string;
  created_at: string;
}

export interface PayuTransaction {
  mihpayid: string;
  txnid: string;
  amount: number;
  status: string;
  productinfo?: string;
  email?: string;
  phone?: string;
  addedon: string;
}

export function razorpayToRows(payments: RazorpayPayment[]): {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
} {
  const columns = [
    { name: "id", type: "string" as ColType },
    { name: "amount", type: "number" as ColType },
    { name: "currency", type: "string" as ColType },
    { name: "status", type: "string" as ColType },
    { name: "method", type: "string" as ColType },
    { name: "email", type: "string" as ColType },
    { name: "contact", type: "string" as ColType },
    { name: "created_at", type: "date" as ColType },
  ];
  const rows = payments.map((p) => [
    p.id,
    p.amount,
    p.currency,
    p.status,
    p.method || null,
    p.email || null,
    p.contact || null,
    p.created_at,
  ]);
  return { columns, rows };
}

export function payuToRows(transactions: PayuTransaction[]): {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
} {
  const columns = [
    { name: "mihpayid", type: "string" as ColType },
    { name: "txnid", type: "string" as ColType },
    { name: "amount", type: "number" as ColType },
    { name: "status", type: "string" as ColType },
    { name: "productinfo", type: "string" as ColType },
    { name: "email", type: "string" as ColType },
    { name: "phone", type: "string" as ColType },
    { name: "addedon", type: "date" as ColType },
  ];
  const rows = transactions.map((t) => [
    t.mihpayid,
    t.txnid,
    t.amount,
    t.status,
    t.productinfo || null,
    t.email || null,
    t.phone || null,
    t.addedon,
  ]);
  return { columns, rows };
}
