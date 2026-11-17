/**
 * Public entry point for the industry template modules.
 *
 * Each vertical lives in its own module; this barrel exposes the shared lookup
 * helpers so callers (routes, dashboards) do not depend on a vertical's file
 * name.
 */
export { formatKPIValue, getIndustryTemplate, getKPIById } from "./finance";
export type { Industry } from "./finance";
export {
  getComplianceRequirements,
  getIndustryComplianceMap,
} from "./compliance-mappings";
export type {
  ComplianceFramework,
  ComplianceRequirements,
  IndustryComplianceMap,
} from "./compliance-mappings";
