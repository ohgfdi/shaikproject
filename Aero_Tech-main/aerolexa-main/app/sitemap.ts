import type { MetadataRoute } from "next";

import { ANALYSIS_TEMPLATES } from "@/lib/engine/template-catalog";
import { appUrl } from "@/lib/env";

/**
 * Dynamic sitemap: the marketing surfaces + every analysis template's
 * dedicated landing page. Template URLs are the search-indexing surface for
 * the vertical keywords ("gst reconciliation tool", "tally data analysis",
 * …) — each is a real, rendered page, never a bare URL list.
 *
 * App pages behind authentication are deliberately absent: a sitemap should
 * only list what an anonymous visitor can actually render.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = appUrl();
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/templates`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/signup`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/login`, lastModified: now, changeFrequency: "monthly", priority: 0.3 },
  ];

  const templateRoutes: MetadataRoute.Sitemap = ANALYSIS_TEMPLATES.map((t) => ({
    url: `${base}/templates/${t.id}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  return [...staticRoutes, ...templateRoutes];
}
