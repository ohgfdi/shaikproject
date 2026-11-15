import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Motion-token adoption gate (S6): every DOM spring reads the shared tokens
 * from lib/scene/motion.ts. An inline `stiffness:` in a component means the
 * physics vocabulary is being forked again — fail the suite with the file and
 * line so the sweep stays complete.
 */

const COMPONENTS_ROOT = join(__dirname, "..", "..", "components");
const INLINE_SPRING = /\bstiffness:\s*\d/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (/\.(tsx?|ts)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("motion tokens — DOM adoption", () => {
  it("no component hardcodes spring physics inline", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(COMPONENTS_ROOT)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (INLINE_SPRING.test(line)) {
          offenders.push(`${file.replace(COMPONENTS_ROOT, "components")}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
