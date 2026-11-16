/**
 * Phase 17: Responsive Grid Component
 *
 * A grid system that adapts to different screen sizes
 * for mobile, tablet, and desktop viewing of dashboards.
 */
import React from "react";

export type Breakpoint = "xs" | "sm" | "md" | "lg" | "xl";

export type GridColumn = {
  /** Number of columns at xs (extra small, <640px) */
  xs: number;
  /** Number of columns at sm (small, ≥640px) */
  sm: number;
  /** Number of columns at md (medium, ≥768px) */
  md: number;
  /** Number of columns at lg (large, ≥1024px) */
  lg: number;
  /** Number of columns at xl (extra large, ≥1280px) */
  xl: number;
};

/** ResponsiveGrid - layouts children based on breakpoint. */
export const ResponsiveGrid: React.FC<{
  columns: GridColumn;
  children: React.ReactNode;
  className?: string;
}> = ({ columns, children, className }) => {
  const xs = columns.xs === 12 ? "col-span-12" : `col-span-${columns.xs}`;
  const sm = columns.sm === 12 ? "col-span-12" : `col-span-${columns.sm}`;
  const md = columns.md === 12 ? "col-span-12" : `col-span-${columns.md}`;
  const lg = columns.lg === 12 ? "col-span-12" : `col-span-${columns.lg}`;
  const xl = columns.xl === 12 ? "col-span-12" : `col-span-${columns.xl}`;

  return (
    <div
      className`
        grid
        grid-cols-1
        grid-cols-sm-${columns.sm}
        grid-cols-md-${columns.md}
        grid-cols-lg-${columns.lg}
        grid-cols-xl-${columns.xl}
        gap-4
        ${className}
      `
    >
      {children}
    </div>
  );
};

/** Use responsive breakpoints for dashboard widgets. */
export const useResponsiveBreakpoint = (): Breakpoint => {
  const [breakpoint, setBreakpoint] = React.useState<Breakpoint>("md");

  React.useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      if (width < 640) setBreakpoint("xs");
      else if (width < 768) setBreakpoint("sm");
      else if (width < 1024) setBreakpoint("md");
      else if (width < 1280) setBreakpoint("lg");
      else setBreakpoint("xl");
    };

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return breakpoint;
};

/** Widget layout helper for dashboards. */
export const useDashboardLayout = (widgetType: "chart" | "kpi" | "table" | "map") => {
  const breakpoint = useResponsiveBreakpoint();

  const layouts: Record<Breakpoint, { xs: number; sm: number; md: number; lg: number; xl: number }> = {
    xs: { xs: 12, sm: 12, md: 6, lg: 4, xl: 3 },
    sm: { xs: 12, sm: 12, md: 6, lg: 4, xl: 3 },
    md: { xs: 12, sm: 12, md: 6, lg: 4, xl: 3 },
    lg: { xs: 12, sm: 12, md: 6, lg: 4, xl: 3 },
    xl: { xs: 12, sm: 12, md: 6, lg: 4, xl: 3 },
  };

  return layouts[breakpoint];
};