// In-page measurement helpers, injected into page.evaluate.
// Keep this dependency-free: it runs inside Chromium.
export function measureShell() {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const intersects = (a, b) => {
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return x * y;
  };
  const asides = [...document.querySelectorAll("aside")].filter(visible);
  const sidebar = asides[0] ?? null;
  const navs = [...document.querySelectorAll("nav")].filter(visible);
  const sidebarNavs = sidebar ? [...sidebar.querySelectorAll("nav")].filter(visible) : [];
  // Label = visible text, excluding the collapsed-state tooltip (which lives
  // inside the link but is not part of the visible label or the accessible name,
  // which comes from aria-label).
  const labelOf = (a) =>
    [...a.childNodes]
      .filter((node) => !(node.nodeType === 1 && node.matches('[role="tooltip"]')))
      .map((node) => node.textContent ?? "")
      .join("")
      .trim();
  const navLinks = sidebar
    ? [...sidebar.querySelectorAll("nav a[href]")].filter(visible).map((a) => ({
        href: a.getAttribute("href"),
        label: labelOf(a),
        current: a.getAttribute("aria-current"),
        box: rect(a),
      }))
    : [];
  const counts = {};
  for (const link of navLinks) if (link.label) counts[link.label] = (counts[link.label] ?? 0) + 1;
  const header = document.querySelector("header");
  const headerControls = header
    ? [...header.querySelectorAll("a,button,select,input")].filter(visible).map((el) => ({
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "")
          .trim()
          .slice(0, 60),
        href: el.getAttribute("href"),
        box: rect(el),
      }))
    : [];
  const overlaps = [];
  for (let i = 0; i < navLinks.length; i += 1) {
    for (let j = i + 1; j < navLinks.length; j += 1) {
      const area = intersects(navLinks[i].box, navLinks[j].box);
      if (area > 2) overlaps.push({ kind: "nav-nav", a: navLinks[i].label, b: navLinks[j].label, area });
    }
  }
  for (const c of headerControls) {
    for (const link of navLinks) {
      const area = intersects(c.box, link.box);
      if (area > 2) overlaps.push({ kind: "header-nav", a: c.label, b: link.label, area });
    }
  }
  const headings = sidebar
    ? [...sidebar.querySelectorAll("[data-nav-group]")].filter(visible).map((el) => (el.textContent || "").trim())
    : [];
  return {
    asides: asides.length,
    asideBox: sidebar ? rect(sidebar) : null,
    asideDisplay: sidebar ? getComputedStyle(sidebar).display : null,
    navTotal: navs.length,
    navLabels: navs.map((n) => n.getAttribute("aria-label")),
    sidebarNavCount: sidebarNavs.length,
    navLinks,
    duplicateLabels: Object.entries(counts)
      .filter(([, n]) => n > 1)
      .map(([label, n]) => ({ label, count: n })),
    headerControls,
    overlaps,
    sidebarInputs: sidebar
      ? [...sidebar.querySelectorAll("input")].filter(visible).map((el) => el.getAttribute("placeholder"))
      : [],
    headerSearchCount: header
      ? [...header.querySelectorAll("button,a")]
          .filter(visible)
          .filter((el) => /search/i.test((el.getAttribute("aria-label") || "") + " " + (el.textContent || ""))).length
      : 0,
    groupHeadings: headings,
    sidebarScrollWidth: sidebar?.scrollWidth ?? null,
    sidebarClientWidth: sidebar?.clientWidth ?? null,
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    localeValue: document.querySelector("select[aria-label='Language']")?.value ?? null,
    localeOptions: [...document.querySelectorAll("select[aria-label='Language'] option")].map((o) => o.textContent),
    visibleNavCount: navLinks.length,
  };
}
