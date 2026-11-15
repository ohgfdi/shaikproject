import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";

import { dataDir } from "@/lib/engine/dataset";

/**
 * Generates a synthetic demo dataset ("Demo / Synthetic" — clearly labelled in
 * the UI and stored with Dataset.isDemo = true). Deterministic: the same seed
 * always produces the same file, so nobody can mistake it for uploaded data.
 * Used only as an optional empty-state CTA — the product flow is built around
 * user-uploaded CSV/XLSX files.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ["North", "South", "East", "West", "Central"];
const CHANNELS = ["Online", "Retail", "Partner"];
const PRODUCTS = [
  { name: "Ledgerly Analytics Pro", category: "Software", price: 890 },
  { name: "Ledgerly Cloud Starter", category: "Software", price: 240 },
  { name: "Data Accelerator", category: "Software", price: 460 },
  { name: "Insight Workbench", category: "Software", price: 620 },
  { name: "Consulting Day", category: "Services", price: 1800 },
  { name: "Onboarding Package", category: "Services", price: 980 },
  { name: "Support Retainer", category: "Services", price: 750 },
];

export const DEMO_DATASET_NAME = "Demo / Synthetic — Ledgerly sales (2023–2024)";

/**
 * Write the demo dataset CSV to the parsed directory + return file metadata.
 * Callers then run the standard parse pipeline so demo data benefits from the
 * exact same profiling as uploaded files.
 */
export async function writeDemoCsv(
  datasetId: string,
): Promise<{ fileName: string; filePath: string; mimeType: string }> {
  const dir = path.join(dataDir(), "uploads");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${datasetId}-demo.csv`);
  const rand = mulberry32(20240904);
  const out = createWriteStream(filePath);

  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
  const header = "order_date,region,channel,product,category,customer_id,units,revenue,margin_pct\n";
  out.write(header);

  const start = new Date(Date.UTC(2023, 0, 1));
  const end = new Date(Date.UTC(2024, 11, 31));
  const customers: { id: string; region: string; joinMonth: number }[] = [];
  const customerRegion = new Map<string, string>();

  // Write orders day by day (deterministic pseudo-random stream)
  const cursor = new Date(start);
  const monthKey = 0;
  while (cursor <= end) {
    const month = cursor.getUTCMonth() + cursor.getUTCFullYear() * 12;
    // customer cohort arrivals each month
    const monthIndex = Math.floor((month - (2023 * 12 + 0)) / 1);
    const arrivals = Math.round(14 + 8 * rand() + (monthIndex % 12 === 10 ? 14 : 0));
    for (let i = 0; i < arrivals; i++) {
      const id = `CUST-${String(customers.length + 1).padStart(4, "0")}`;
      const region = REGIONS[Math.floor(rand() * REGIONS.length)] as string;
      customers.push({ id, region, joinMonth: month });
      customerRegion.set(id, region);
    }

    const isWeekend = cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6;
    const baseOrders = isWeekend ? 4 : 9;
    const holiday = cursor.getUTCMonth() === 10 || cursor.getUTCMonth() === 0;
    const orderCount = Math.max(1, Math.round(baseOrders * (0.7 + rand() * 0.8) * (holiday ? 1.6 : 1)));
    for (let o = 0; o < orderCount; o++) {
      // repeat purchase probability grows for established customers
      const isExisting = customers.length && rand() < (customers.length > 240 ? 0.72 : 0.4);
      let customer: { id: string; region: string; joinMonth: number };
      if (isExisting && customers.length) {
        customer = customers[Math.floor(rand() * customers.length)] ?? customers[0]!;
      } else {
        const id = `CUST-${String(customers.length + 1).padStart(4, "0")}`;
        const region = REGIONS[Math.floor(rand() * REGIONS.length)] as string;
        customer = { id, region, joinMonth: month };
        customers.push(customer);
        customerRegion.set(id, region);
      }
      const product = PRODUCTS[Math.floor(rand() * PRODUCTS.length)] as (typeof PRODUCTS)[number];
      const channel = CHANNELS[Math.floor(rand() * CHANNELS.length)] as string;
      // partner & online grow over time
      const growth = 0.75 + (monthIndex / 24) * 0.6;
      const units = Math.max(1, Math.round(1 + rand() * (product.category === "Services" ? 1 : 5)));
      const seasonality = 1 + (cursor.getUTCMonth() === 10 ? 0.35 : cursor.getUTCMonth() === 11 ? 0.2 : 0);
      const noise = 0.82 + rand() * 0.36;
      const revenue = Math.round(product.price * units * growth * seasonality * noise);
      const margin = Math.round((34 + rand() * 30 + (channel === "Online" ? 4 : 0)) * 10) / 10;
      const discount = channel === "Partner" ? 15 : 0;
      const discRevenue = Math.round(revenue * (1 - discount / 100));
      // deliberate data-quality wrinkle: occasional missing region (2%)
      const region = rand() < 0.02 ? "" : customer.region;
      out.write(
        [
          fmtDate(cursor),
          region,
          channel,
          product.name,
          product.category,
          customer.id,
          units,
          discRevenue,
          margin,
        ].join(",") + "\n",
      );
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    void monthKey;
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });
  const stat = await fs.stat(filePath);
  void stat;
  return { fileName: "demo-sales-2023-2024.csv", filePath, mimeType: "text/csv" };
}
