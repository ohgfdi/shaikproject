/**
 * Phase 52: Advanced AI Chat with Industry-Specific Knowledge Bases
 *
 * Industry-specific knowledge bases for the AI Chat Assistant, providing
 * domain-accurate answers, terminology, and context-aware responses.
 * Integrates with the AI Chat Assistant (Phase 30) and industry models (Phases 33-36).
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";

export type Industry = "finance" | "healthcare" | "saas" | "retail" | "manufacturing";

export type KnowledgeArea =
  | "regulatory"
  | "metric-definitions"
  | "best-practices"
  | "common-issues"
  | "troubleshooting";

export interface KnowledgeEntry {
  id: string;
  area: KnowledgeArea;
  industry: Industry;
  question: string;
  answer: string;
  context?: string;
  references?: string[];
  related_topics: string[];
}

/** Finance knowledge base entries. */
export const FinanceKnowledgeBase: KnowledgeEntry[] = [
  {
    id: "finance-1",
    area: "regulatory",
    industry: "finance",
    question: "What are the key SOC2 compliance requirements for financial services?",
    answer: "SOC2 for financial services typically requires access logging, data change monitoring, authentication event tracking, and may require SOX compliance for financial reporting controls.",
    context: "Financial services SOC2 audit typically covers data security, availability, processing integrity, confidentiality, and privacy.",
    references: ["AICPA SOC2 Trust Services Criteria", "Financial Services Roundtable Guidelines"],
    related_topics: ["PCI-DSS", "GDPR", "Basel-III"],
  },
  {
    id: "finance-2",
    area: "metric-definitions",
    industry: "finance",
    question: "Define ROI for financial services analytics.",
    answer: "Return on Investment (ROI) is calculated as (Net Profit / Cost of Investment) × 100, expressing profitability as a percentage of the investment cost.",
    context: "In finance, ROI may be adjusted for risk, time horizon, and capital costs. Typical ROI ranges vary by sector: 5-10% for conservative, 10-20% for moderate, 20%+ for aggressive strategies.",
    references: ["CFA Institute Guidelines", "Financial Analytics Best Practices"],
    related_topics: ["ARR", "NRR", "CAC", "LTV"],
  },
  {
    id: "finance-3",
    area: "troubleshooting",
    industry: "finance",
    question: "My loan application was rejected. What could be the reasons?",
    answer: "Common reasons for loan rejection include: FICO score below threshold, insufficient income verification, high debt-to-income ratio, inadequate collateral, or incomplete documentation.",
    context: "Each lender has specific underwriting criteria. Applicants should request specific rejection reasons and work on improving credit profile before reapplying.",
    references: ["Lender Underwriting Guidelines", "Consumer Financial Protection Bureau"],
    related_topics: ["FICO score", "Debt-to-Income ratio", "Loan terms"],
  },
];

/** SaaS knowledge base entries. */
export const SaaSKnowledgeBase: KnowledgeEntry[] = [
  {
    id: "saas-1",
    area: "metric-definitions",
    industry: "saas",
    question: "What does NRR mean in SaaS metrics?",
    answer: "Net Revenue Retention (NRR) measures the percentage of recurring revenue retained from existing customers over a period, including expansions and contractions, but excluding new customer acquisition.",
    context: "NRR above 100% indicates expansion revenue exceeds churn and contraction. Top-performing SaaS companies achieve 110%+ NRR. Essential for SaaS valuation and growth sustainability.",
    references: ["SaaS Capital Benchmarks", "SaaS Metrics Guide by David Skok"],
    related_topics: ["GRR", "Churn Rate", "MRR", "LTV:CAC"],
  },
  {
    id: "saas-2",
    area: "best-practices",
    industry: "saas",
    question: "What are best practices for trial-to-paid conversion?",
    answer: "Best practices include: 1) Early value demonstration within first 3 days, 2) Personalized onboarding flow, 3) Clear upgrade prompts at trial end, 4) Limited-time incentives, 5) Success manager assignment for high-value trials.",
    context: "Average trial conversion rates range 15-25%. Top performers achieve 30%+ by optimizing the onboarding experience and reducing time-to-value.",
    references: ["SaaS Capital Benchmarks", "Close.io Trial Conversion Study"],
    related_topics: ["Churn Rate", "Activation", "Onboarding"],
  },
  {
    id: "saas-3",
    area: "troubleshooting",
    industry: "saas",
    question: "Users are reporting slow dashboard loading. What could be the causes?",
    answer: "Common causes: 1) Large data sets without pagination, 2) Missing database indexes, 3) Inefficient queries, 4) Missing cache layer, 5) Concurrent user overload.",
    context: "Implement query pagination, optimize critical database indexes, add Redis caching, and monitor connection pool usage. Consider progressive data loading for large dashboards.",
    references: ["Database Performance Tuning", "Redis Caching Best Practices"],
    related_topics: ["API Performance", "Query Optimization", "Cache Invalidation"],
  },
];

/** Retail knowledge base entries. */
export const RetailKnowledgeBase: KnowledgeEntry[] = [
  {
    id: "retail-1",
    area: "metric-definitions",
    industry: "retail",
    question: "What is a good conversion rate for e-commerce?",
    answer: "Average e-commerce conversion rates typically range from 2.0% to 3.5%, with top quartile stores achieving 4.0% to 5.0% or higher. Conversion rates vary significantly by industry: Fashion (1.5-2.5%), Electronics (2.5-3.5%), Home & Garden (3.0-4.5%).",
    context: "Conversion rate optimization (CRO) techniques can improve rates by 10-50% through A/B testing, checkout optimization, and friction reduction. Mobile conversion rates are typically 0.5-1.5% lower than desktop.",
    references: ["Adobe Digital Index", "Nielsen Norman Group CRO Guidelines"],
    related_topics: ["AOV", "AOV", "Cart Abandonment Rate", "Repeat Purchase Rate"],
  },
  {
    id: "retail-2",
    area: "best-practices",
    industry: "retail",
    question: "How should I handle cart abandonment?",
    answer: "Best practices: 1) Abandoned email series (3-4 emails over 7 days), 2) Include product image and price, 3) Offer limited-time discount (10-15%), 4) Make checkout guest-friendly, 5) Retarget with dynamic ads, 6) Send SMS reminder for high-value carts.",
    context: "Average cart abandonment rate is 69.57%. Well-executed recovery campaigns can recover 10-15% of abandoned carts, representing significant revenue recovery for high-volume stores.",
    references: ["Baymard Institute CRO Research", "Saleor E-commerce Benchmarks"],
    related_topics: ["Conversion Rate", "AOV", "Customer Lifetime Value"],
  },
];

/** Manufacturing knowledge base entries. */
export const ManufacturingKnowledgeBase: KnowledgeEntry[] = [
  {
    id: "mfg-1",
    area: "metric-definitions",
    industry: "manufacturing",
    question: "What is a good OEE score?",
    answer: "OEE (Overall Equipment Effectiveness) world-class scores are 85%+, but average manufacturing achieves 60%. Typical benchmarks: World-class (85%+), Best-in-class (75-84%), Average (60-74%), Lagging (below 60%).",
    context: "OEE = Availability × Performance × Quality. Each component measures different losses: Availability (downtime), Performance (slow cycles/ideals), Quality (defects/scrap). Improving any component drives overall OEE.",
    references: ["SME Manufacturing Guidelines", "Lean Manufacturing Best Practices"],
    related_topics: ["Downtime", "Defect Rate", "Throughput", "OEE Components"],
  },
  {
    id: "mfg-2",
    area: "best-practices",
    industry: "manufacturing",
    question: "What are key strategies for reducing downtime?",
    answer: "Key strategies: 1) Predictive maintenance with sensor data and ML models, 2) Total Productive Maintenance (TPM) program, 3) Quick changeover (SMED) techniques, 4) Root cause analysis for recurring issues, 5) Critical spare parts inventory, 6) Operator training and empowerment.",
    context: "Predictive maintenance can reduce downtime by 20-50%. TPM programs typically achieve 30-50% OEE improvement within 1-2 years. SMED (Single-Minute Exchange of Die) targets under 10-minute changeovers.",
    references: ["Plant Maintenance Management", "Lean Enterprise Institute"],
    related_topics: ["Predictive Maintenance", "TPM", "SMED", "OEE"],
  },
];

/** Get the knowledge base for a specific industry and area. */
export function getKnowledgeBase(
  industry: Industry,
  _area: KnowledgeArea
): KnowledgeEntry[] {
  const bases: Partial<Record<Industry, KnowledgeEntry[]>> = {
    finance: FinanceKnowledgeBase,
    saas: SaaSKnowledgeBase,
    retail: RetailKnowledgeBase,
    manufacturing: ManufacturingKnowledgeBase,
  };

  return bases[industry] || FinanceKnowledgeBase;
}

/** Find knowledge entry by question pattern. */
export function findKnowledgeEntry(
  industry: Industry,
  area: KnowledgeArea,
  question: string
): KnowledgeEntry | undefined {
  const kb = getKnowledgeBase(industry, area);
  const questionLower = question.toLowerCase();

  // Exact match first
  const exact = kb.find((entry) => entry.question.toLowerCase() === questionLower);
  if (exact) return exact;

  // Fuzzy match by keywords
  const keywords = questionLower.split(" ");
  const fuzzy = kb.find((entry) =>
    entry.question.toLowerCase().split(" ").some((k) => keywords.includes(k))
  );
  return fuzzy;
}

/** Get a random knowledge entry for context injection. */
export function getRandomKnowledgeEntry(
  industry: Industry,
  area: KnowledgeArea
): KnowledgeEntry {
  const kb = getKnowledgeBase(industry, area);
  const entry = kb[Math.floor(Math.random() * kb.length)] ?? kb[0];
  if (!entry) {
    throw new Error(`No knowledge entries for ${industry}/${area}`);
  }
  return entry;
}

/** API route for industry knowledge base queries. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "saas";
    const area = searchParams.get("area") as KnowledgeArea || "metric-definitions";
    const question = searchParams.get("question") || "";

    const entries = getKnowledgeBase(industry as Industry, area);
    const foundEntry = question
      ? findKnowledgeEntry(industry as Industry, area, question)
      : undefined;

    return new Response(JSON.stringify({
      industry,
      area,
      question,
      found_entry: foundEntry || null,
      all_entries: entries.map((e) => ({
        id: e.id,
        area: e.area,
        question: e.question,
        answer_length: e.answer.length,
      })),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Industry knowledge base error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve industry knowledge base data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}