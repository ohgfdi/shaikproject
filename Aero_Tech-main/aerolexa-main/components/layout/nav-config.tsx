import {
  BarChart3,
  Bot,
  BookOpen,
  Building2,
  Calculator,
  CalendarDays,
  ClipboardCheck,
  Clock,
  Compass,
  FileCheck2,
  FileSearch,
  FileSignature,
  FileSpreadsheet,
  FileText,
  FileWarning,
  FolderKanban,
  Home,
  Library,
  MessageSquareText,
  Notebook,
  Presentation,
  Scale,
  Settings,
  Shield,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

/**
 * Navigation contract.
 *
 * One entry per destination that genuinely exists under `app/(app)`. A capability
 * without a working page belongs in `docs/BACKLOG.md`, never here: the sidebar is
 * a promise that the link opens something.
 *
 * Groups describe the job, not the implementation: what a CA firm does on a
 * Monday morning (client work, compliance) comes before settings.
 */
export interface ShellNavItem {
  href: string;
  label: string;
  /** Existing lucide icon, rendered at 20px in both sidebar states. */
  icon: LucideIcon;
  /** Extra words the command palette matches against. */
  keywords?: string;
}

export interface ShellNavGroup {
  id: string;
  label: string;
  items: ShellNavItem[];
}

/** Navigation groups aligned to the proposed IA structure.
 * Groups with 1 item render as flat; 2+ items are expandable.
 * Active route auto-expands its group.
 * Badge counts are omitted (handled at the page level, hidden when 0).
 */
const _CORE_ITEMS: ShellNavItem[] = [
  { href: "/dashboard", label: "Home", icon: Home, keywords: "dashboard overview" },
  { href: "/copilot", label: "Copilot", icon: Bot, keywords: "ai chat assistant" },
  { href: "/projects", label: "Projects", icon: FolderKanban, keywords: "client project" },
  { href: "/analyses", label: "Analyses", icon: MessageSquareText, keywords: "analysis" },
  { href: "/dashboards", label: "Dashboards", icon: Compass, keywords: "charts visualisation" },
  { href: "/reports", label: "Reports", icon: FileCheck2, keywords: "deliverable" },
  { href: "/presentations", label: "Presentations", icon: Presentation, keywords: "slides deck" },
  { href: "/books", label: "Client Books", icon: BookOpen, keywords: "trial balance p&l balance sheet cash flow" },
  {
    href: "/ca-sources",
    label: "Client Imports",
    icon: FileSpreadsheet,
    keywords: "tally bank statement gst invoice challan",
  },
  { href: "/ca-compute", label: "Tax Computations", icon: Calculator, keywords: "income tax itr salary property" },
  { href: "/gst-recon", label: "GST Reconciliation", icon: FileCheck2, keywords: "gstr-2b 2a purchase register" },
  { href: "/statutes", label: "Rule & Rate Registry", icon: Scale, keywords: "slabs rates thresholds" },
  { href: "/audit", label: "Audit Trail", icon: Shield, keywords: "security log activity" },
  { href: "/settings", label: "Settings", icon: Settings, keywords: "preferences billing" },
];

/** Extended/flag-gated items: Notebooks, Models, Scheduled Reports, Prompt Library, Growth Funnel */
const EXTENDED_ITEMS: ShellNavItem[] = [
  { href: "/notebooks", label: "Notebooks", icon: Notebook, keywords: "python sql analysis" },
  { href: "/models", label: "Models", icon: BarChart3, keywords: "machine learning forecast" },
  { href: "/scheduled-reports", label: "Scheduled Reports", icon: Clock, keywords: "email schedule" },
  { href: "/prompts", label: "Prompt Library", icon: Library, keywords: "templates ai" },
  { href: "/growth", label: "Growth Funnel", icon: TrendingUp, keywords: "marketing activation cohorts" },
];

/** Core nav groups: Workspace and CA Practice groups. */
export const NAV_GROUPS: ShellNavGroup[] = [
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Home", icon: Home, keywords: "dashboard overview" },
      { href: "/copilot", label: "Copilot", icon: Bot, keywords: "ai chat assistant" },
      { href: "/projects", label: "Projects", icon: FolderKanban, keywords: "client project" },
      { href: "/analyses", label: "Analyses", icon: MessageSquareText, keywords: "analysis" },
      { href: "/dashboards", label: "Dashboards", icon: Compass, keywords: "charts visualisation" },
      { href: "/reports", label: "Reports", icon: FileCheck2, keywords: "deliverable" },
      { href: "/presentations", label: "Presentations", icon: Presentation, keywords: "slides deck" },
    ],
  },
  {
    id: "ca-practice",
    label: "CA Practice",
    items: [
      {
        href: "/engagements",
        label: "Engagements",
        icon: Building2,
        keywords: "clients partner dashboard review team retention",
      },
      { href: "/books", label: "Client Books", icon: BookOpen, keywords: "trial balance p&l balance sheet cash flow" },
      {
        href: "/ca-sources",
        label: "Client Imports",
        icon: FileSpreadsheet,
        keywords: "tally bank statement gst invoice challan",
      },
      { href: "/ca-compute", label: "Tax Computations", icon: Calculator, keywords: "income tax itr salary property" },
      { href: "/gst-recon", label: "GST Reconciliation", icon: FileCheck2, keywords: "gstr-2b 2a purchase register" },
      {
        href: "/tds-recon",
        label: "TDS Credit Recon",
        icon: FileSearch,
        keywords: "26as ais tds credit traces deductee reconciliation",
      },
      { href: "/notices", label: "Notices", icon: FileWarning, keywords: "gst notice asmt drc reply appeal hearing" },
      {
        href: "/working-papers",
        label: "Working Papers",
        icon: ClipboardCheck,
        keywords: "audit sa 230 vouching ticking sampling file",
      },
      {
        href: "/deliverables",
        label: "Deliverables",
        icon: FileSignature,
        keywords: "certificate udin sign off issue publish client report",
      },
      {
        href: "/compliance",
        label: "Compliance Calendar",
        icon: CalendarDays,
        keywords: "due dates gst tds itr roc filing deadline",
      },
      {
        href: "/compliance/filings",
        label: "Filing Runs",
        icon: ClipboardCheck,
        keywords: "prepared reviewed client approved filed acknowledged arn srn",
      },
      {
        href: "/compliance/reports",
        label: "Compliance Reports",
        icon: FileText,
        keywords: "monthly client report late fee exposure on time filed",
      },
      {
        href: "/compliance/pilot",
        label: "Filing Pilot",
        icon: ClipboardCheck,
        keywords: "live gateway certification irn acknowledged reconcile credentials",
      },
      {
        href: "/operations",
        label: "Firm Operations",
        icon: CalendarDays,
        keywords: "sla breach overdue aging workload partner dashboard",
      },
      {
        href: "/document-requests",
        label: "Document Requests",
        icon: FileSearch,
        keywords: "client documents pending chase reminder follow up",
      },
      { href: "/statutes", label: "Rule & Rate Registry", icon: Scale, keywords: "slabs rates thresholds" },
      { href: "/audit", label: "Audit Trail", icon: Shield, keywords: "security log activity" },
    ],
  },
  {
    id: "extended",
    label: "Extended",
    items: EXTENDED_ITEMS,
  },
];

/**
 * The groups that should render for the current module flags. Extended items are
 * filtered individually, and an empty group disappears rather than leaving an
 * orphan heading.
 */
export function navGroupsFor(moduleFlags: Partial<Record<string, boolean>> = {}): ShellNavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      const flag = (item as ShellNavItem & { flag?: string }).flag;
      return !flag || moduleFlags[flag] === true;
    }),
  })).filter((group) => group.items.length > 0);
}

/** Every destination the shell promises, in visual order. */
export function navHrefs(moduleFlags: Partial<Record<string, boolean>> = {}): string[] {
  return navGroupsFor(moduleFlags).flatMap((group) => group.items.map((item) => item.href));
}

/**
 * Active destination. Exact match, or a nested route (`/projects/abc`). This is
 * deliberately not `startsWith(href)`: `/bookmarks` must not light up `/books`.
 */
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
