#!/usr/bin/env node
/**
 * Create a distributable archive of the Ledgerly source tree.
 *
 *   npm run package
 *
 * Produces `Ledgerly-<version>.tar.gz` (and .zip when the `zip` binary is
 * available) at the project root. Excludes generated/heavy directories and
 * any environment file with real secrets (.env*).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version ?? "0.0.0";
const outName = `Ledgerly-${version}`;

const excludes = [
  "node_modules",
  ".next",
  ".git",
  "data",
  "coverage",
  "playwright-report",
  "test-results",
  ".env",
  ".env.local",
  ".env*.local",
  "*.tsbuildinfo",
].map((p) => `--exclude=${p}`);

const tmp = mkdtempSync(path.join(tmpdir(), "Ledgerly-pkg-"));
const stage = path.join(tmp, outName);
execFileSync("mkdir", ["-p", stage], { stdio: "inherit" });

// rsync is available on GitHub runners and most dev machines; fall back to
// copying with find filters when missing.
try {
  execFileSync("rsync", ["-a", "--quiet", ...excludes, `${root}/`, `${stage}/`], { stdio: "inherit" });
} catch {
  execFileSync(
    "cp",
    [
      "-R",
      ...["app", "components", "lib", "prisma", "styles", "scripts", "__tests__", "docs", ".github"]
        .filter((d) => existsSync(path.join(root, d)))
        .map((d) => path.join(root, d)),
      stage,
    ],
    { stdio: "inherit" },
  );
  for (const f of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tailwind.config.ts",
    "next.config.mjs",
    "postcss.config.mjs",
    ".env.example",
    ".gitignore",
    "next-env.d.ts",
    "middleware.ts",
    "jest.config.cjs",
    "playwright.config.ts",
    "Dockerfile",
    "docker-compose.yml",
    "README.md",
  ].filter((f) => existsSync(path.join(root, f)))) {
    execFileSync("cp", [path.join(root, f), stage], { stdio: "inherit" });
  }
}

const out = path.join(root, `${outName}.tar.gz`);
execFileSync("tar", ["-czf", out, "-C", tmp, outName], { stdio: "inherit" });
console.log(`[package] Created ${path.relative(root, out)}`);

// Optional zip (used by the GitHub release workflow when available).
let hasZip = false;
try {
  execFileSync("zip", ["-v"], { stdio: "ignore" });
  hasZip = true;
} catch {
  hasZip = false;
}
if (hasZip) {
  const zipOut = path.join(root, `${outName}.zip`);
  execFileSync("zip", ["-rq", zipOut, outName, "-x", "node_modules/*", ".next/*", ".git/*", "data/*", ".env"], {
    cwd: tmp,
    stdio: "inherit",
  });
  console.log(`[package] Created ${path.relative(root, zipOut)}`);
}

rmSync(tmp, { recursive: true, force: true });
