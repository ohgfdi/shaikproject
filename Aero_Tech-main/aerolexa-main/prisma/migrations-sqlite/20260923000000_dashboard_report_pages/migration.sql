-- Dashboard report-pages + bookmarks + theme (Power BI parity round 6):
--   pages     — JSON ReportPage[]; page 0 mirrors the legacy `widgets` array
--               (derived lazily in application code, no row rewrite needed).
--   bookmarks — JSON ReportBookmark[] (named cross-filter/slicer view states).
--   theme     — JSON ReportTheme (report-wide palette/format preset).
ALTER TABLE "Dashboard" ADD COLUMN "pages" TEXT;
ALTER TABLE "Dashboard" ADD COLUMN "bookmarks" TEXT;
ALTER TABLE "Dashboard" ADD COLUMN "theme" TEXT;
