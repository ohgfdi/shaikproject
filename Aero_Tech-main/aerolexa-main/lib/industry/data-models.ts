/**
 * Phase 41: Industry-Specific Data Models
 *
 * Pre-built database schemas and validation models optimized for each industry vertical.
 * Extends the industry templates (Phases 33-38) with Prisma schema definitions
 * and TypeScript types for end-to-end data integrity.
 */
import type { NextRequest } from "next/server";


export type Industry = "finance" | "healthcare" | "saas" | "retail" | "manufacturing";

export interface FieldDefinition {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "json";
  required: boolean;
  unique?: boolean;
  description: string;
  // Industry-specific constraints
  min?: number;
  max?: number;
  pattern?: string; // Regex pattern for validation
  enum?: string[];
}

/** Finance data model - loan and investment objects. */
export const FinanceDataModel = {
  name: "Finance",
  tables: {
    loans: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        customer_id: { name: "customer_id", type: "string", required: true },
        amount: { name: "amount", type: "number", required: true, min: 0 },
        interest_rate: { name: "interest_rate", type: "number", required: true, min: 0, max: 100 },
        term_months: { name: "term_months", type: "number", required: true, min: 1 },
        status: { name: "status", type: "string", required: true, enum: ["pending", "approved", "active", "charged_off", "defaulted"] },
        purpose: { name: "purpose", type: "string", required: true, enum: ["personal", "business", "mortgage", "auto", "education"] },
        fico_score: { name: "fico_score", type: "number", required: false, min: 300, max: 850 },
        created_at: { name: "created_at", type: "date", required: true },
        updated_at: { name: "updated_at", type: "date", required: true },
      },
    },
    investments: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        investor_id: { name: "investor_id", type: "string", required: true },
        asset_type: { name: "asset_type", type: "string", required: true, enum: ["stock", "bond", "etf", "real_estate", "crypto"] },
        allocation_pct: { name: "allocation_pct", type: "number", required: true, min: 0, max: 100 },
        risk_tier: { name: "risk_tier", type: "string", required: true, enum: ["conservative", "moderate", "aggressive"] },
        expected_return: { name: "expected_return", type: "number", required: true, min: 0 },
        maturity_date: { name: "maturity_date", type: "date", required: false },
        created_at: { name: "created_at", type: "date", required: true },
      },
    },
    deposits: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        customer_id: { name: "customer_id", type: "string", required: true },
        account_type: { name: "account_type", type: "string", required: true, enum: ["checking", "savings", "cd", "money_market"] },
        balance: { name: "balance", type: "number", required: true, min: 0 },
        interest_rate: { name: "interest_rate", type: "number", required: true, min: 0 },
        term_months: { name: "term_months", type: "number", required: false },
        status: { name: "status", type: "string", required: true, enum: ["active", "closed", "matured"] },
        created_at: { name: "created_at", type: "date", required: true },
      },
    },
  },
};

/** SaaS data model - subscription and usage objects. */
export const SaaSDataModel = {
  name: "SaaS",
  tables: {
    subscriptions: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        customer_id: { name: "customer_id", type: "string", required: true },
        plan_type: { name: "plan_type", type: "string", required: true, enum: ["free", "pro", "enterprise"] },
        status: { name: "status", type: "string", required: true, enum: ["trial", "active", "past_due", "cancelled", "paused"] },
        trial_ends_at: { name: "trial_ends_at", type: "date", required: false },
        cancel_at_period_end: { name: "cancel_at_period_end", type: "boolean", required: true, default: false },
        created_at: { name: "created_at", type: "date", required: true },
        updated_at: { name: "updated_at", type: "date", required: true },
      },
    },
    usage_metrics: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        subscription_id: { name: "subscription_id", type: "string", required: true },
        metric_name: { name: "metric_name", type: "string", required: true, enum: ["api_calls", "storage_gb", "active_users", "login_count"] },
        metric_value: { name: "metric_value", type: "number", required: true },
        period_start: { name: "period_start", type: "date", required: true },
        period_end: { name: "period_end", type: "date", required: true },
        created_at: { name: "created_at", type: "date", required: true },
      },
    },
    webhooks: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        subscription_id: { name: "subscription_id", type: "string", required: true },
        url: { name: "url", type: "string", required: true },
        event_type: { name: "event_type", type: "string", required: true, enum: ["invoice.paid", "invoice.failed", "subscription.created", "subscription.updated", "subscription.deleted"] },
        is_active: { name: "is_active", type: "boolean", required: true, default: true },
        created_at: { name: "created_at", type: "date", required: true },
      },
    },
  },
};

/** Retail data model - e-commerce and inventory objects. */
export const RetailDataModel = {
  name: "Retail",
  tables: {
    products: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        name: { name: "name", type: "string", required: true },
        sku: { name: "sku", type: "string", required: true, unique: true },
        category: { name: "category", type: "string", required: true },
        price: { name: "price", type: "number", required: true, min: 0 },
        cost_price: { name: "cost_price", type: "number", required: true, min: 0 },
        stock_keeping_unit: { name: "tracking_sku", type: "string", required: true },
        current_stock: { name: "current_stock", type: "number", required: true, min: 0 },
        reorder_point: { name: "reorder_point", type: "number", required: true, min: 0 },
        backorder_allowed: { name: "backorder_allowed", type: "boolean", required: true, default: false },
        is_active: { name: "is_active", type: "boolean", required: true, default: true },
        created_at: { name: "created_at", type: "date", required: true },
      },
    },
    orders: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        customer_id: { name: "customer_id", type: "string", required: true },
        status: { name: "status", type: "string", required: true, enum: ["pending", "processing", "shipped", "delivered", "cancelled", "returned"] },
        total_amount: { name: "total_amount", type: "number", required: true, min: 0 },
        shipping_address: { name: "shipping_address", type: "json", required: true },
        payment_method: { name: "payment_method", type: "string", required: true, enum: ["credit_card", "debit_card", "paypal", "apple_pay", "google_pay"] },
        created_at: { name: "created_at", type: "date", required: true },
        updated_at: { name: "updated_at", type: "date", required: true },
      },
    },
    inventory_movements: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        product_id: { name: "product_id", type: "string", required: true },
        movement_type: { name: "movement_type", type: "string", required: true, enum: ["in", "out", "adjustment", "transfer", "loss"] },
        quantity: { name: "quantity", type: "number", required: true },
        reason: { name: "reason", type: "string", required: false },
        reference_id: { name: "reference_id", type: "string", required: false },
        created_at: { name: "created_at", type: "date", required: true },
      },
    },
  },
};

/** Manufacturing data model - production and quality objects. */
export const ManufacturingDataModel = {
  name: "Manufacturing",
  tables: {
    production_orders: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        product_sku: { name: "product_sku", type: "string", required: true },
        quantity_ordered: { name: "quantity_ordered", type: "number", required: true, min: 1 },
        quantity_produced: { name: "quantity_produced", type: "number", required: true, min: 0 },
        quantity_scrapped: { name: "quantity_scrapped", type: "number", required: true, min: 0 },
        start_time: { name: "start_time", type: "date", required: true },
        end_time: { name: "end_time", type: "date", required: true },
        status: { name: "status", type: "string", required: true, enum: ["planned", "in_progress", "completed", "scrapped", "delayed"] },
        priority: { name: "priority", type: "string", required: true, enum: ["low", "normal", "high", "urgent"] },
        created_at: { name: "created_at", type: "date", required: true },
        updated_at: { name: "updated_at", type: "date", required: true },
      },
    },
    quality_checks: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        production_order_id: { name: "production_order_id", type: "string", required: true },
        checked_at: { name: "checked_at", type: "date", required: true },
        operator_id: { name: "operator_id", type: "string", required: true },
        first_pass_yield: { name: "first_pass_yield", type: "number", required: true, min: 0, max: 100 },
        defect_count: { name: "defect_count", type: "number", required: true, min: 0 },
        total_inspected: { name: "total_inspected", type: "number", required: true, min: 0 },
        notes: { name: "notes", type: "string", required: false },
      },
    },
    equipment_runs: {
      fields: {
        id: { name: "id", type: "string", required: true, unique: true },
        machine_id: { name: "machine_id", type: "string", required: true },
        start_time: { name: "start_time", type: "date", required: true },
        end_time: { name: "end_time", type: "date", required: true },
        oee_score: { name: "oee_score", type: "number", required: true, min: 0, max: 100 },
        downtime_minutes: { name: "downtime_minutes", type: "number", required: true, min: 0 },
        reason_code: { name: "reason_code", type: "string", required: false },
        is_auto_stopped: { name: "is_auto_stopped", type: "boolean", required: true, default: false },
      },
    },
  },
};

/** One field in an industry data model table. */
export interface DataModelField {
  name: string;
  type: string;
  required: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  enum?: string[];
  [key: string]: unknown;
}

/** One table in an industry data model. */
export interface DataModelTable {
  fields: Record<string, DataModelField>;
  [key: string]: unknown;
}

/** An industry data model: named tables of typed fields. */
export interface IndustryDataModel {
  tables: Record<string, DataModelTable>;
  [key: string]: unknown;
}

/** Get the data model for a specific industry. */
export function getIndustryDataModel(industry: Industry): IndustryDataModel {
  const models: Partial<Record<Industry, IndustryDataModel>> = {
    finance: FinanceDataModel,
    saas: SaaSDataModel,
    retail: RetailDataModel,
    manufacturing: ManufacturingDataModel,
  };

  return models[industry] || FinanceDataModel;
}

/** Validate data against industry model. */
export function validateAgainstModel(
  model: IndustryDataModel,
  table: string,
  data: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const tableDef = model.tables[table];
  if (!tableDef) {
    return { valid: true, errors: [] }; // Table not in this model
  }

  const errors: string[] = [];

  for (const [fieldName, fieldDef] of Object.entries(tableDef.fields)) {
    const value: unknown = data[fieldName];
    if (fieldDef.required && (value === undefined || value === null)) {
      errors.push(`${fieldName} is required`);
    }

    if (value !== undefined && value !== null) {
      // Type check
      if (fieldDef.type === "number" && typeof value !== "number") {
        errors.push(`${fieldName} must be a number`);
      }
      if (fieldDef.type === "string" && typeof value !== "string") {
        errors.push(`${fieldName} must be a string`);
      }
      if (fieldDef.type === "boolean" && typeof value !== "boolean") {
        errors.push(`${fieldName} must be a boolean`);
      }
      if (fieldDef.type === "date" && !(value instanceof Date)) {
        errors.push(`${fieldName} must be a date`);
      }

      // Min/Max check for numbers
      if (fieldDef.min !== undefined && typeof value === "number" && value < fieldDef.min) {
        errors.push(`${fieldName} must be >= ${fieldDef.min}`);
      }
      if (fieldDef.max !== undefined && typeof value === "number" && value > fieldDef.max) {
        errors.push(`${fieldName} must be <= ${fieldDef.max}`);
      }

      // Pattern check for strings
      if (fieldDef.pattern && typeof value === "string") {
        const regex = new RegExp(fieldDef.pattern);
        if (!regex.test(value)) {
          errors.push(`${fieldName} does not match pattern ${fieldDef.pattern}`);
        }
      }

      // Enum check for strings
      if (fieldDef.enum && typeof value === "string") {
        if (!fieldDef.enum.includes(value)) {
          errors.push(`${fieldName} must be one of: ${fieldDef.enum.join(", ")}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** API route to get industry data model. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "saas";

    const model = getIndustryDataModel(industry as Industry);

    return new Response(JSON.stringify(model), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Industry data model error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve industry data model" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}