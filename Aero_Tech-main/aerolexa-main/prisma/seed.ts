/**
 * Ledgerly seed script.
 *
 * Default run: prints usage and exits — the product intentionally has no
 * sample data baked in.
 *
 *   npm run db:seed -- --demo
 *
 * Creates ONE clearly-labelled "Demo / Synthetic" account so reviewers can
 * click through the product without uploading a file:
 *
 *   email    demo@aerolexa.local
 *   password demo12345
 *
 * Every artifact created from this account is generated through the normal,
 * labelled demo pipeline (Dataset.isDemo = true, project names prefixed
 * "Demo / Synthetic"). Real user flows should upload their own data.
 *
 * Safe to run repeatedly: existing demo account is reused.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env by hand BEFORE importing anything that reads process.env, because
// tsx does not load dotfiles for you (Prisma CLI does, tsx does not).
function loadDotEnv() {
  try {
    const contents = readFileSync(path.join(root, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // No .env — rely on ambient environment.
  }
}

async function main() {
  const wantsDemo = process.argv.includes("--demo") || process.argv.includes("--labelled-demo");
  if (!wantsDemo) {
    console.log(
      "Ledgerly ships without sample data on purpose.\n" +
        "To create the labelled demo account (demo@aerolexa.local / demo12345) run:\n\n" +
        "  npm run db:seed -- --demo\n",
    );
    return;
  }

  loadDotEnv();

  // Idempotent plan catalog (Band 4.2) — always repaired on seed so fresh
  // installs can subscribe immediately.
  const { ensurePlans } = await import("@/lib/server/billing");
  await ensurePlans();

  const [{ prisma }, { hashPassword }, demoData] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/auth/password"),
    import("@/lib/demo/demo-data"),
  ]);

  const email = "demo@aerolexa.local";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Demo account already exists (demo@aerolexa.local). Nothing to do.");
    return;
  }

  const passwordHash = await hashPassword("demo12345");
  const user = await prisma.user.create({
    data: {
      email,
      name: "Demo Reviewer",
      passwordHash,
      profileRole: "Consultant",
      organization: "Demo / Synthetic company",
      industry: "Software",
      experience: "Intermediate",
      goals: JSON.stringify(["analyze", "reports", "presentations"]),
      emailVerifiedAt: new Date(),
      onboardedAt: new Date(),
      workspace: {
        create: { name: "Demo / Synthetic workspace" },
      },
    },
    include: { workspace: true },
  });
  const workspace = user.workspace;
  if (!workspace)
    throw new Error(
      "Workspace creation failed. What happened: the database failed to create the default workspace. How to fix: check your database connection and try running the seed again.",
    );

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      name: "Demo / Synthetic — sample review",
      description: "Labelled demo project created by prisma/seed.ts. Delete any time.",
      company: "Demo / Synthetic company",
      industry: "Software",
      status: "ACTIVE",
    },
  });

  // Generate + profile the deterministic demo dataset through the exact same
  // pipeline as a user upload (writeDemoCsv → parseAndProfileFile).
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const demo = await demoData.writeDemoCsv(id);
  const { parseAndProfileFile } = await import("@/lib/file/parse");
  const { stringifyJson } = await import("@/lib/json");
  const parsed = await parseAndProfileFile({
    id,
    filePath: demo.filePath,
    fileName: demo.fileName,
    mimeType: demo.mimeType,
    isDemo: true,
  });

  await prisma.dataset.create({
    data: {
      id,
      workspaceId: workspace.id,
      projectId: project.id,
      name: demoData.DEMO_DATASET_NAME,
      originalName: demo.fileName,
      mimeType: demo.mimeType,
      sizeBytes: parsed.rowCount * 120,
      rowCount: parsed.rowCount,
      columnCount: parsed.columnCount,
      isDemo: true,
      filePath: demo.filePath,
      ndjsonPath: `${id}.ndjson`,
      profile: stringifyJson(parsed.profile),
      columns: stringifyJson(parsed.columns),
      preview: stringifyJson(parsed.preview),
      qualityWarnings: stringifyJson(parsed.qualityWarnings),
      createdById: user.id,
    },
  });

  console.log(
    `\nDemo / Synthetic account ready:\n  email    ${email}\n  password demo12345\n` +
      `Workspace “${workspace.name}” contains project “${project.name}” with the deterministic demo dataset (isDemo=true).\n` +
      "Sign in, open the project and run analyses — every result is clearly labelled as prototype logic.\n",
  );
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
