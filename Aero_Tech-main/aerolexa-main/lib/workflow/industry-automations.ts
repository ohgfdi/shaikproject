/**
 * Phase 43: Industry-Specific Workflow Automations
 *
 * Pre-built workflow automations optimized for each industry vertical.
 * Triggers, conditions, and actions are tailored to industry-specific business processes.
 */
import type { NextRequest } from "next/server";

export type Industry = "finance" | "healthcare" | "saas" | "retail" | "manufacturing";

export type AutomationTrigger =
  | "new_record"
  | "field_change"
  | "schedule"
  | "webhook"
  | "threshold_crossed";

export type AutomationAction =
  | "send_email"
  | "create_record"
  | "update_field"
  | "send_sms"
  | "trigger_webhook"
  | "notify_slack"
  | "generate_pdf"
  | "assign_task";

/**
 * A connector record the rules evaluate. Columns vary by industry, so the
 * fields rules actually compare are declared and anything else stays opaque.
 */
export interface AutomationRecord {
  status?: string;
  risk_score?: number;
  days_overdue?: number;
  trial_days?: number;
  converted?: boolean;
  churn_risk_score?: number;
  usage_pct?: number;
  current_stock?: number;
  reorder_point?: number;
  cart_abandoned_at?: Date;
  defect_rate?: number;
  downtime_minutes?: number;
  /** Any other connector column. */
  [field: string]: unknown;
}

export interface AutomationRule {
  id: string;
  name: string;
  industry: Industry;
  trigger: AutomationTrigger;
  condition: (record: AutomationRecord) => boolean;
  action: AutomationAction;
  action_config: Record<string, unknown>;
  is_active: boolean;
  created_at: Date;
}

export interface FinanceAutomations {
  // Loan approval workflow
  loan_approved: AutomationRule;
  // Fraud alert workflow
  fraud_detected: AutomationRule;
  // Payment overdue workflow
  payment_overdue: AutomationRule;
}

export interface SaaSAutomations {
  // Trial conversion workflow
  trial_conversion: AutomationRule;
  // Churn risk alert
  churn_risk_alert: AutomationRule;
  // Plan upgrade workflow
  plan_upgrade: AutomationRule;
}

export interface RetailAutomations {
  // Low stock alert
  low_stock_alert: AutomationRule;
  // Order shipped notification
  order_shipped: AutomationRule;
  // Abandoned cart recovery
  abandoned_cart: AutomationRule;
}

export interface ManufacturingAutomations {
  // Quality issue alert
  quality_issue: AutomationRule;
  // Maintenance scheduled
  maintenance_scheduled: AutomationRule;
  // Production delay notification
  production_delay: AutomationRule;
}

/** Get automation rules for a specific industry. */
export function getIndustryAutomations(
  industry: Industry
): {
  rules: AutomationRule[];
  trigger_counts: Record<AutomationTrigger, number>;
  action_counts: Record<AutomationAction, number>;
} {
  const rules: AutomationRule[] = [];
  const triggerCounts: Record<AutomationTrigger, number> = {
    new_record: 0,
    field_change: 0,
    schedule: 0,
    webhook: 0,
    threshold_crossed: 0,
  };
  const actionCounts: Record<AutomationAction, number> = {
    send_email: 0,
    create_record: 0,
    update_field: 0,
    send_sms: 0,
    trigger_webhook: 0,
    notify_slack: 0,
    generate_pdf: 0,
    assign_task: 0,
  };

  if (industry === "finance") {
    // Loan approved workflow
    const loanApproved: AutomationRule = {
      id: "loan_approved",
      name: "Loan Approved Notification",
      industry: "finance",
      trigger: "field_change" as AutomationTrigger,
      condition: (record) => record.status === "approved",
      action: "send_email" as AutomationAction,
      action_config: {
        to: "{$record.customer_email}",
        subject: "Your Loan Has Been Approved!",
        template: "loan_approval",
        variables: {
          customer_name: "{$record.customer_name}",
          loan_amount: "{$record.amount}",
          interest_rate: "{$record.interest_rate}",
        },
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(loanApproved);
    triggerCounts.field_change++;
    actionCounts.send_email++;

    // Fraud detected workflow
    const fraudDetected: AutomationRule = {
      id: "fraud_detected",
      name: "Fraud Detection Alert",
      industry: "finance",
      trigger: "threshold_crossed" as AutomationTrigger,
      condition: (record) => (record.risk_score ?? 0) > 70,
      action: "notify_slack" as AutomationAction,
      action_config: {
        channel: "#fraud-alerts",
        message: `*Fraud Alert*: Loan application *{$record.id}* has risk score of *{$record.risk_score}%*`,
        persona: "@channel",
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(fraudDetected);
    triggerCounts.threshold_crossed++;
    actionCounts.notify_slack++;

    // Payment overdue workflow
    const paymentOverdue: AutomationRule = {
      id: "payment_overdue",
      name: "Payment Overdue Reminder",
      industry: "finance",
      trigger: "schedule" as AutomationTrigger,
      condition: (record) => (record.days_overdue ?? 0) >= 7,
      action: "send_email" as AutomationAction,
      action_config: {
        to: "{$record.customer_email}",
        subject: "Payment Overdue - Action Required",
        template: "payment_reminder",
        variables: {
          customer_name: "{$record.customer_name}",
          amount_due: "{$record.outstanding_balance}",
          days_overdue: "{$record.days_overdue}",
        },
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(paymentOverdue);
    triggerCounts.schedule++;
    actionCounts.send_email++;
  }

  if (industry === "saas") {
    // Trial conversion workflow
    const trialConversion: AutomationRule = {
      id: "trial_conversion",
      name: "Trial to Paid Conversion",
      industry: "saas",
      trigger: "threshold_crossed" as AutomationTrigger,
      condition: (record) => (record.trial_days ?? 0) >= 30 && record.converted === false,
      action: "send_email" as AutomationAction,
      action_config: {
        to: "{$record.user_email}",
        subject: "Your Trial Is Ending - Choose a Plan",
        template: "trial_conversion",
        variables: {
          trial_ends: "{$record.trial_ends_date}",
          plans: "[Basic, Pro, Enterprise]",
        },
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(trialConversion);
    triggerCounts.threshold_crossed++;
    actionCounts.send_email++;

    // Churn risk alert
    const churnRisk: AutomationRule = {
      id: "churn_risk",
      name: "Churn Risk Alert",
      industry: "saas",
      trigger: "field_change" as AutomationTrigger,
      condition: (record) => (record.churn_risk_score ?? 0) > 75,
      action: "notify_slack" as AutomationAction,
      action_config: {
        channel: "#churn-alerts",
        message: `*Churn Risk*: Customer *{$record.user_id}* has high churn risk ({$record.churn_risk_score}%) - assign to CSM`,
        persona: "@team",
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(churnRisk);
    triggerCounts.field_change++;
    actionCounts.notify_slack++;

    // Plan upgrade workflow
    const planUpgrade: AutomationRule = {
      id: "plan_upgrade",
      name: "Plan Upgrade Notification",
      industry: "saas",
      trigger: "field_change" as AutomationTrigger,
      condition: (record) => (record.usage_pct ?? 0) > 80,
      action: "send_email" as AutomationAction,
      action_config: {
        to: "{$record.user_email}",
        subject: "You're Getting Close to Your Limit",
        template: "plan_upgrade",
        variables: {
          current_plan: "{$record.plan_name}",
          usage_pct: "{$record.usage_pct}",
          new_plan: "Pro/Enterprise",
        },
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(planUpgrade);
    triggerCounts.field_change++;
    actionCounts.send_email++;
  }

  if (industry === "retail") {
    // Low stock alert
    const lowStock: AutomationRule = {
      id: "low_stock",
      name: "Low Stock Alert",
      industry: "retail",
      trigger: "threshold_crossed" as AutomationTrigger,
      condition: (record) =>
        record.current_stock !== undefined &&
        record.reorder_point !== undefined &&
        record.current_stock <= record.reorder_point,
      action: "send_sms" as AutomationAction,
      action_config: {
        to: "{$record.manager_phone}",
        message: `*Low Stock Alert*: {$record.product_name} (SKU: {$record.sku}) is below reorder point (current: {$record.current_stock}, needed: {$record.reorder_point})`,
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(lowStock);
    triggerCounts.threshold_crossed++;
    actionCounts.send_sms++;

    // Order shipped notification
    const orderShipped: AutomationRule = {
      id: "order_shipped",
      name: "Order Shipped Notification",
      industry: "retail",
      trigger: "field_change" as AutomationTrigger,
      condition: (record) => record.status === "shipped",
      action: "send_email" as AutomationAction,
      action_config: {
        to: "{$record.customer_email}",
        subject: "Your Order Has Shipped!",
        template: "order_shipped",
        variables: {
          order_id: "{$record.id}",
          tracking_number: "{$record.tracking_number}",
          estimated_delivery: "{$record.estimated_delivery}",
        },
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(orderShipped);
    triggerCounts.field_change++;
    actionCounts.send_email++;

    // Abandoned cart recovery
    const abandonedCart: AutomationRule = {
      id: "abandoned_cart",
      name: "Abandoned Cart Recovery",
      industry: "retail",
      trigger: "schedule" as AutomationTrigger,
      condition: (record) =>
        record.cart_abandoned_at !== undefined &&
        new Date() > new Date(record.cart_abandoned_at.getTime() + 24 * 60 * 60 * 1000),
      action: "send_email" as AutomationAction,
      action_config: {
        to: "{$record.customer_email}",
        subject: "Did You Forget Something?",
        template: "abandoned_cart",
        variables: {
          items: "{$record.cart_items}",
          cart_total: "{$record.cart_total}",
          discount_code: "WELCOME10",
        },
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(abandonedCart);
    triggerCounts.schedule++;
    actionCounts.send_email++;
  }

  if (industry === "manufacturing") {
    // Quality issue alert
    const qualityIssue: AutomationRule = {
      id: "quality_issue",
      name: "Quality Issue Alert",
      industry: "manufacturing",
      trigger: "field_change" as AutomationTrigger,
      condition: (record) => (record.defect_rate ?? 0) > 5,
      action: "notify_slack" as AutomationAction,
      action_config: {
        channel: "#quality-alerts",
        message: `*Quality Issue*: Production run *{$record.id}* has defect rate of *{$record.defect_rate}%* (FPY: *{$record.first_pass_yield}%)`,
        persona: "@team",
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(qualityIssue);
    triggerCounts.field_change++;
    actionCounts.notify_slack++;

    // Maintenance scheduled
    const maintenanceScheduled: AutomationRule = {
      id: "maintenance_scheduled",
      name: "Maintenance Scheduled",
      industry: "manufacturing",
      trigger: "schedule" as AutomationTrigger,
      condition: () => true,
      action: "send_email" as AutomationAction,
      action_config: {
        to: "{$maintenance_team_email}",
        subject: "Scheduled Maintenance for {$machine_id}",
        template: "maintenance_schedule",
        variables: {
          machine_id: "{$machine_id}",
          maintenance_type: "{$maintenance_type}",
          start_time: "{$start_time}",
          end_time: "{$end_time}",
        },
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(maintenanceScheduled);
    triggerCounts.schedule++;
    actionCounts.send_email++;

    // Production delay notification
    const productionDelay: AutomationRule = {
      id: "production_delay",
      name: "Production Delay Notification",
      industry: "manufacturing",
      trigger: "threshold_crossed" as AutomationTrigger,
      condition: (record) => (record.downtime_minutes ?? 0) > 60,
      action: "notify_slack" as AutomationAction,
      action_config: {
        channel: "#production",
        message: `*Production Delay*: Line *{$record.line_id}* down for *{$record.downtime_minutes} minutes* due to *{$record.reason_code}*`,
        persona: "@production_manager",
      },
      is_active: true,
      created_at: new Date(),
    };
    rules.push(productionDelay);
    triggerCounts.threshold_crossed++;
    actionCounts.notify_slack++;
  }

  // Count triggers and actions from rules
  rules.forEach((rule) => {
    triggerCounts[rule.trigger]++;
    actionCounts[rule.action]++;
  });

  return {
    rules,
    trigger_counts: triggerCounts,
    action_counts: actionCounts,
  };
}

/** API route to get industry workflow automations. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "saas";

    const result = getIndustryAutomations(industry as Industry);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Industry workflow automations error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve workflow automations" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}