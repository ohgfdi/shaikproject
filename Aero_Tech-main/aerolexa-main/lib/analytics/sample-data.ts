/**
 * Sample Dataset Generator
 *
 * Creates realistic, deterministic sample datasets for onboarding.
 * Uses seeded randomness so the same dataset is identical every time.
 *
 * Currently supports:
 * - sales: Revenue over time with products, regions, customers
 * - marketing: Campaign performance with conversions
 * - web_analytics: Page views, sessions, bounce rates
 */

export interface SampleDatasetDef {
  name: string;
  description: string;
  columns: SampleColumn[];
  rows: Record<string, unknown>[];
}

export interface SampleColumn {
  name: string;
  type: "string" | "number" | "date" | "boolean";
}

// ---------------------------------------------------------------------------
// Seeded RNG (deterministic — same seed → same data)
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS = ["Enterprise License", "Pro Subscription", "Starter Plan", "Premium Support", "Advanced Analytics"];

const REGIONS = ["North America", "Europe", "Asia Pacific", "Latin America", "Middle East"];

const CUSTOMER_NAMES = [
  "Acme Corp",
  "Globex Inc",
  "Initech",
  "Umbrella Corp",
  "Soylent Corp",
  "Vehement Capital",
  "Massive Dynamic",
  "Hooli",
  "Pied Piper",
  "Stark Industries",
  "Wayne Enterprises",
  "Wonka Industries",
  "Cyberdyne Systems",
  "Tyrell Corp",
  "Weyland-Yutani",
];

// ---------------------------------------------------------------------------
// Sales Dataset
// ---------------------------------------------------------------------------

export function generateSalesDataset(months = 12, transactionsPerMonth = 200): SampleDatasetDef {
  const rand = mulberry32(42); // Fixed seed for determinism

  const rows: Record<string, unknown>[] = [];
  let id = 1;

  for (let month = 0; month < months; month++) {
    const date = new Date(2024, month, 1);

    for (let i = 0; i < transactionsPerMonth; i++) {
      const product = PRODUCTS[Math.floor(rand() * PRODUCTS.length)] ?? "Enterprise License";
      const region = REGIONS[Math.floor(rand() * REGIONS.length)] ?? "North America";
      const customer = CUSTOMER_NAMES[Math.floor(rand() * CUSTOMER_NAMES.length)] ?? "Acme Corp";

      const day = 1 + Math.floor(rand() * 28);
      const transactionDate = new Date(date.getFullYear(), date.getMonth(), day);

      const basePrice = product.includes("Enterprise")
        ? 25000
        : product.includes("Pro")
          ? 5000
          : product.includes("Starter")
            ? 500
            : product.includes("Premium")
              ? 1500
              : 3000;

      const quantity = 1 + Math.floor(rand() * 5);
      const discount = rand() < 0.15 ? rand() * 0.3 : 0;
      const unitPrice = basePrice * (1 - discount);
      const revenue = Math.round(unitPrice * quantity * 100) / 100;
      const cost = Math.round(basePrice * 0.4 * quantity * 100) / 100;
      const profit = Math.round((revenue - cost) * 100) / 100;

      rows.push({
        transaction_id: `TRX-${String(id).padStart(5, "0")}`,
        date: transactionDate.toISOString().split("T")[0],
        customer_name: customer,
        product: product,
        region: region,
        quantity,
        unit_price: unitPrice,
        revenue,
        cost,
        profit,
        status: rand() < 0.9 ? "completed" : "pending",
      });

      id++;
    }
  }

  return {
    name: "sales_data.csv",
    description: "12 months of sales transactions — revenue, profit, regions, products",
    columns: [
      { name: "transaction_id", type: "string" },
      { name: "date", type: "date" },
      { name: "customer_name", type: "string" },
      { name: "product", type: "string" },
      { name: "region", type: "string" },
      { name: "quantity", type: "number" },
      { name: "unit_price", type: "number" },
      { name: "revenue", type: "number" },
      { name: "cost", type: "number" },
      { name: "profit", type: "number" },
      { name: "status", type: "string" },
    ],
    rows,
  };
}

// ---------------------------------------------------------------------------
// Marketing Campaign Dataset
// ---------------------------------------------------------------------------

export function generateMarketingDataset(months = 12, campaignsPerMonth = 25): SampleDatasetDef {
  const rand = mulberry32(7);

  const rows: Record<string, unknown>[] = [];
  let id = 1;

  const channels = ["Google Ads", "Facebook", "LinkedIn", "Email", "Organic", "Referral"];
  const campaignTypes = ["Awareness", "Lead Gen", "Conversion", "Retention", "Brand"];

  for (let month = 0; month < months; month++) {
    const date = new Date(2024, month, 1);

    for (let i = 0; i < campaignsPerMonth; i++) {
      const channel = channels[Math.floor(rand() * channels.length)];
      const type = campaignTypes[Math.floor(rand() * campaignTypes.length)];

      const day = 1 + Math.floor(rand() * 28);
      const campaignDate = new Date(date.getFullYear(), date.getMonth(), day);

      const spend = Math.round((250 + rand() * 2000) * 100) / 100;
      const impressions = Math.round(spend * (50 + rand() * 200));
      const clicks = Math.round(impressions * (0.01 + rand() * 0.05));
      const conversions = Math.round(clicks * (0.02 + rand() * 0.08));
      const revenue = Math.round(conversions * (80 + rand() * 220));

      rows.push({
        campaign_id: `CMP-${String(id).padStart(4, "0")}`,
        date: campaignDate.toISOString().split("T")[0],
        channel,
        campaign_type: type,
        spend,
        impressions,
        clicks,
        conversions,
        revenue,
        ctr: Math.round((clicks / impressions) * 10000) / 10000,
        conversion_rate: Math.round((conversions / clicks) * 10000) / 10000,
        roas: Math.round((revenue / spend) * 1000) / 1000,
      });

      id++;
    }
  }

  return {
    name: "marketing_campaigns.csv",
    description: "12 months of marketing campaign performance across channels",
    columns: [
      { name: "campaign_id", type: "string" },
      { name: "date", type: "date" },
      { name: "channel", type: "string" },
      { name: "campaign_type", type: "string" },
      { name: "spend", type: "number" },
      { name: "impressions", type: "number" },
      { name: "clicks", type: "number" },
      { name: "conversions", type: "number" },
      { name: "revenue", type: "number" },
      { name: "ctr", type: "number" },
      { name: "conversion_rate", type: "number" },
      { name: "roas", type: "number" },
    ],
    rows,
  };
}

// ---------------------------------------------------------------------------
// Web Analytics Dataset
// ---------------------------------------------------------------------------

export function generateWebAnalyticsDataset(days = 90): SampleDatasetDef {
  const rand = mulberry32(99);

  const rows: Record<string, unknown>[] = [];
  let id = 1;

  const pages = [
    "/home",
    "/pricing",
    "/features",
    "/blog",
    "/docs",
    "/signup",
    "/login",
    "/pricing/enterprise",
    "/blog/data-analytics",
    "/features/dashboards",
  ];

  const deviceTypes = ["desktop", "mobile", "tablet"];

  for (let i = 0; i < days; i++) {
    const date = new Date(2024, 0, 1 + i);

    for (let p = 0; p < 8; p++) {
      const page = pages[Math.floor(rand() * pages.length)];

      const sessions = 50 + Math.round(rand() * 200);
      const pageviews = Math.round(sessions * (1.5 + rand() * 2.5));
      const uniqueVisitors = Math.round(sessions * (0.6 + rand() * 0.2));
      const bounceRate = 0.3 + rand() * 0.4;
      const timeOnPage = Math.round((20 + rand() * 150) * 100) / 100;
      const deviceType = deviceTypes[Math.floor(rand() * deviceTypes.length)];

      rows.push({
        session_id: `SESSION-${String(id).padStart(5, "0")}`,
        date: date.toISOString().split("T")[0],
        page,
        device_type: deviceType,
        sessions,
        pageviews,
        unique_visitors: uniqueVisitors,
        bounce_rate: Math.round(bounceRate * 10000) / 10000,
        avg_time_on_page: timeOnPage,
      });

      id++;
    }
  }

  return {
    name: "web_analytics.csv",
    description: "90 days of website analytics — traffic, engagement, device breakdown",
    columns: [
      { name: "session_id", type: "string" },
      { name: "date", type: "date" },
      { name: "page", type: "string" },
      { name: "device_type", type: "string" },
      { name: "sessions", type: "number" },
      { name: "pageviews", type: "number" },
      { name: "unique_visitors", type: "number" },
      { name: "bounce_rate", type: "number" },
      { name: "avg_time_on_page", type: "number" },
    ],
    rows,
  };
}

// ---------------------------------------------------------------------------
// HR / Workforce Dataset
// ---------------------------------------------------------------------------

export function generateHrDataset(employees = 100): SampleDatasetDef {
  const rand = mulberry32(1337);

  const rows: Record<string, unknown>[] = [];

  const departments = ["Engineering", "Sales", "Marketing", "HR", "Finance", "Operations"];
  const levels = ["Junior", "Mid", "Senior", "Lead", "Manager", "Director"];

  for (let i = 0; i < employees; i++) {
    const department = departments[Math.floor(rand() * departments.length)];
    const level = levels[Math.floor(rand() * levels.length)];
    const age = 22 + Math.floor(rand() * 35);
    const yearsAtCompany = Math.floor(rand() * 15);
    const baseSalary =
      (level === "Director"
        ? 180000
        : level === "Manager"
          ? 130000
          : level === "Lead"
            ? 110000
            : level === "Senior"
              ? 90000
              : level === "Mid"
                ? 70000
                : 55000) + Math.floor(rand() * 15000);

    const performanceScore = 1 + Math.floor(rand() * 5);
    const satisfactionScore = 1 + Math.floor(rand() * 10);
    const leftCompany = rand() < (performanceScore < 3 ? 0.3 : 0.15) ? true : false;

    rows.push({
      employee_id: `EMP-${String(i + 1).padStart(3, "0")}`,
      department,
      job_level: level,
      age,
      years_at_company: yearsAtCompany,
      salary: baseSalary,
      performance_score: performanceScore,
      satisfaction_score: satisfactionScore,
      left_company: leftCompany,
    });
  }

  return {
    name: "employee_data.csv",
    description: "Employee workforce data — departments, salaries, performance, retention",
    columns: [
      { name: "employee_id", type: "string" },
      { name: "department", type: "string" },
      { name: "job_level", type: "string" },
      { name: "age", type: "number" },
      { name: "years_at_company", type: "number" },
      { name: "salary", type: "number" },
      { name: "performance_score", type: "number" },
      { name: "satisfaction_score", type: "number" },
      { name: "left_company", type: "boolean" },
    ],
    rows,
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SAMPLE_DATASETS: Record<string, () => SampleDatasetDef> = {
  sales: () => generateSalesDataset(),
  marketing: () => generateMarketingDataset(),
  web_analytics: () => generateWebAnalyticsDataset(),
  hr: () => generateHrDataset(),
};

export function csvStringify(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const first = rows[0];
  if (!first) return "";
  const headers = Object.keys(first);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => {
          const v = row[h];
          const str = v == null ? "" : typeof v === "boolean" ? (v ? "true" : "false") : String(v);
          return str.includes(",") || str.includes('"') || str.includes("\n") ? `"${str.replace(/"/g, '""')}"` : str;
        })
        .join(","),
    );
  }
  return lines.join("\n");
}

export function toNdjson(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}
