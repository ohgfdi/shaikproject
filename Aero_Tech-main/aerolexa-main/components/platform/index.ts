/**
 * Platform — shared components for authentication, roles, and integration.
 *
 * Exports:
 *   - SSOLogin: Authentication flow with role-based redirect
 *   - AdminDashboard: Full-feature dashboard for admins
 *   - PowerUserDashboard: Advanced dashboard for power users
 *   - ViewerDashboard: Read-only dashboard for viewers
 *   - WebhookManager: Webhook subscription management
 *   - MapTemplateGallery: Pre-built map templates
 *   - MapTemplate: Template definition type
 */
export { SSOLogin } from "./sso-login";
export { AdminDashboard } from "./admin-dashboard";
export { PowerUserDashboard } from "./power-user-dashboard";
export { ViewerDashboard } from "./viewer-dashboard";
export { WebhookManager } from "./webhook-manager";
export { MapTemplateGallery, type MapTemplate } from "./map-template-gallery";
export type { UserProfile, WebhookSubscription, WebhookPayload } from "./sso-login";