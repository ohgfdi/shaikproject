/**
 * HowTo structured data for a template landing page.
 *
 * Extracted from `app/templates/[id]/page.tsx` so there is exactly ONE
 * definition of the JSON-LD body. That matters for correctness beyond tidiness:
 * the page is statically generated, so its inline <script> cannot be authorised
 * by a per-request CSP nonce and must instead be pinned by SHA-256 hash in the
 * Content-Security-Policy. `scripts/generate-jsonld-hashes.mts` hashes what this
 * returns; if the page built its JSON inline instead, the two could drift and the
 * structured data would be silently blocked by the CSP.
 *
 * Pure and framework-free so the generator script can import it directly.
 */

export interface TemplateStepLike {
  surface: string;
  content: string;
  produces: string;
}

export interface TemplateLike {
  title: string;
  description: string;
  steps: TemplateStepLike[];
}

/** The structured-data object for one template. */
export function buildTemplateHowTo(template: TemplateLike): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: template.title,
    description: template.description,
    step: template.steps.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.produces,
      text: `Run this on the ${s.surface.toUpperCase()} surface: ${s.content.slice(0, 400)}`,
    })),
  };
}

/**
 * The EXACT string injected into the page. `<` is escaped to `<` so the
 * content can never terminate the <script> element — this is the only
 * user-adjacent text that reaches it, and it comes from a static catalogue,
 * but the escape makes the guarantee structural rather than incidental.
 */
export function templateJsonLd(template: TemplateLike): string {
  return JSON.stringify(buildTemplateHowTo(template)).replace(/</g, "\\u003c");
}
