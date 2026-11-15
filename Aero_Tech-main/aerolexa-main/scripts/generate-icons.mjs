import path from "node:path";

import sharp from "sharp";

const inputSvg = path.join(import.meta.dirname, "../public/icons/icon.svg");
// Full-bleed source for Android maskable icons: the artwork already sits inside
// the inner 80% safe zone, so it survives the launcher's circular/squircle crop.
const inputMaskableSvg = path.join(import.meta.dirname, "../public/icons/icon-maskable.svg");
const outputDir = path.join(import.meta.dirname, "../public/icons");

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
// Chrome/Android require a dedicated maskable icon for install quality; the
// manifest must never advertise the rounded "any" icon as maskable.
const maskableSizes = [192, 512];

async function generateIcons() {
  for (const size of sizes) {
    const outputPath = path.join(outputDir, `icon-${size}x${size}.png`);
    await sharp(inputSvg, { density: 300 }).resize(size, size).png().toFile(outputPath);
    console.log(`Generated: ${outputPath}`);
  }

  // Generate shortcut icons
  await sharp(inputSvg, { density: 300 }).resize(192, 192).png().toFile(path.join(outputDir, "shortcut-analysis.png"));
  await sharp(inputSvg, { density: 300 }).resize(192, 192).png().toFile(path.join(outputDir, "shortcut-dataset.png"));
  await sharp(inputSvg, { density: 300 }).resize(192, 192).png().toFile(path.join(outputDir, "shortcut-settings.png"));

  // Generate maskable icons (Android adaptive launchers).
  for (const size of maskableSizes) {
    const outputPath = path.join(outputDir, `icon-maskable-${size}x${size}.png`);
    await sharp(inputMaskableSvg, { density: 300 }).resize(size, size).png().toFile(outputPath);
    console.log(`Generated: ${outputPath}`);
  }

  // Generate Apple touch icon
  await sharp(inputSvg, { density: 300 }).resize(180, 180).png().toFile(path.join(outputDir, "apple-touch-icon.png"));

  console.log("All icons generated!");
}

generateIcons().catch(console.error);
