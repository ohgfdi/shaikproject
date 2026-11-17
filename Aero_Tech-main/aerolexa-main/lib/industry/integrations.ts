/**
 * Phase 38: Vertical Integrations
 *
 * Pre-built integrations for key vertical platforms:
 * - Salesforce CRM
 * - HubSpot Marketing
 * - Jira Project Management
 * - Snowflake Data Warehouse
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";

export type IntegrationType =
  | "salesforce"
  | "hubspot"
  | "jira"
  | "snowflake"
  | "slack"
  | "mailchimp";

export interface IntegrationConfig {
  id: string;
  name: string;
  type: IntegrationType;
  // Connection settings
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  // API settings
  apiVersion?: string;
  domain?: string;
  // Status
  isConnected: boolean;
  lastSync?: Date;
  // Permissions/scopes
  scopes: string[];
  // Error tracking
  lastError?: string;
  errorCount: number;
}

/** Pre-built Salesforce integration configuration. */
export const SalesforceIntegration: IntegrationConfig = {
  id: "salesforce",
  name: "Salesforce CRM",
  type: "salesforce",
  clientId: process.env.SALESFORCE_CLIENT_ID,
  clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
  redirectUri: process.env.SALESFORCE_REDIRECT_URI,
  apiVersion: "v57.0",
  scopes: ["api", "full"],
  isConnected: false,
  errorCount: 0,
};

/** Pre-built HubSpot integration configuration. */
export const HubSpotIntegration: IntegrationConfig = {
  id: "hubspot",
  name: "HubSpot Marketing",
  type: "hubspot",
  clientId: process.env.HUBSPOT_CLIENT_ID,
  clientSecret: process.env.HUBSPOT_CLIENT_SECRET,
  redirectUri: process.env.HUBSPOT_REDIRECT_URI,
  apiVersion: "v3",
  scopes: ["crm.read", "contacts.read", "marketing.read"],
  isConnected: false,
  errorCount: 0,
};

/** Pre-built Jira integration configuration. */
export const JiraIntegration: IntegrationConfig = {
  id: "jira",
  name: "Jira Project Management",
  type: "jira",
  clientId: process.env.JIRA_CLIENT_ID,
  clientSecret: process.env.JIRA_CLIENT_SECRET,
  redirectUri: process.env.JIRA_REDIRECT_URI,
  apiVersion: "3",
  scopes: ["read:jira-work", "read:jira-user"],
  isConnected: false,
  errorCount: 0,
};

/** Pre-built Snowflake integration configuration. */
export const SnowflakeIntegration: IntegrationConfig = {
  id: "snowflake",
  name: "Snowflake Data Warehouse",
  type: "snowflake",
  clientId: process.env.SNOWFLAKE_CLIENT_ID,
  clientSecret: process.env.SNOWFLAKE_CLIENT_SECRET,
  redirectUri: process.env.SNOWFLAKE_REDIRECT_URI,
  apiVersion: "",
  // Snowflake uses account identifier + username/password or key pair
  scopes: ["SELECT", "MONITOR", "USAGE"],
  isConnected: false,
  errorCount: 0,
};

/** Pre-built Slack integration configuration. */
export const SlackIntegration: IntegrationConfig = {
  id: "slack",
  name: "Slack Notifications",
  type: "slack",
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  redirectUri: process.env.SLACK_REDIRECT_URI,
  scopes: ["chat:write", "channels.read", "groups.read"],
  isConnected: false,
  errorCount: 0,
};

/** Pre-built Mailchimp integration configuration. */
export const MailchimpIntegration: IntegrationConfig = {
  id: "mailchimp",
  name: "Mailchimp Email",
  type: "mailchimp",
  clientId: process.env.MAILCHIMP_CLIENT_ID,
  clientSecret: process.env.MAILCHIMP_CLIENT_SECRET,
  redirectUri: process.env.MAILCHIMP_REDIRECT_URI,
  apiVersion: "3.0",
  scopes: ["campaign.read", "campaign.write", "segment.read"],
  isConnected: false,
  errorCount: 0,
};

/** Map integration type to its config. */
export const IntegrationConfigs: Record<IntegrationType, IntegrationConfig> = {
  salesforce: SalesforceIntegration,
  hubspot: HubSpotIntegration,
  jira: JiraIntegration,
  snowflake: SnowflakeIntegration,
  slack: SlackIntegration,
  mailchimp: MailchimpIntegration,
};

/** Get integration config by type. */
export function getIntegrationConfig(
  type: IntegrationType
): IntegrationConfig {
  return IntegrationConfigs[type] || SalesforceIntegration;
}

/** Check if integration is available (has credentials configured). */
export function isIntegrationAvailable(type: IntegrationType): boolean {
  const config = getIntegrationConfig(type);
  return !!(
    process.env[`${type.toUpperCase()}_CLIENT_ID`] ||
    process.env[`${type.toUpperCase()}_API_KEY`]
  );
}

/** API route to get integration configs. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || "salesforce";

    const config = getIntegrationConfig(type as IntegrationType);
    const available = isIntegrationAvailable(type as IntegrationType);

    return new Response(JSON.stringify({ config, available }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Integrations error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve integration config" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}