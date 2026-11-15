import type { MetadataRoute } from "next";

import { appUrl } from "@/lib/env";

/**
 * robots: index the marketing + template surfaces; never the app shell,
 * API routes or the published share views (/apps/* are unauthenticated
 * client artifacts — indexable only if the operator chooses to, kept out
 * by default for privacy).
 */
export default function robots(): MetadataRoute.Robots {
  const base = appUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/templates", "/templates/*", "/signup", "/login"],
        disallow: ["/api/", "/apps/", "/dashboard", "/projects", "/datasets", "/analyses", "/settings", "/growth"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
