import fs from "node:fs";
import path from "node:path";

// @napi-rs/canvas is a prebuilt, API-compatible replacement for node-canvas:
// `canvas` cannot be installed in this project (jest-environment-jsdom@29 pins
// peerOptional canvas@^2.5.0, whose NAN-based build has no prebuilt binary for
// modern Node and fails from source), while this package ships N-API binaries.
import { createCanvas } from "@napi-rs/canvas";

const outputDir = path.join(import.meta.dirname, "../public/screenshots");

function createScreenshot(width, height, filename, label) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, width, height);

  // Card
  ctx.fillStyle = "#1e293b";
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 2;
  const radius = 16;
  const x = 40,
    y = 40,
    w = width - 80,
    h = height - 80;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Title
  ctx.fillStyle = "#0ea5e9";
  ctx.font = "600 32px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Ledgerly", width / 2, height / 2 - 40);

  // Label
  ctx.fillStyle = "#94a3b8";
  ctx.font = "18px system-ui, sans-serif";
  ctx.fillText(label, width / 2, height / 2 + 10);

  // Button
  const btnX = width / 2 - 120;
  const btnY = height / 2 + 60;
  const btnW = 240,
    btnH = 48;
  const btnRadius = 10;

  const gradient = ctx.createLinearGradient(btnX, 0, btnX + btnW, 0);
  gradient.addColorStop(0, "#0ea5e9");
  gradient.addColorStop(1, "#6366f1");

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(btnX + btnRadius, btnY);
  ctx.lineTo(btnX + btnW - btnRadius, btnY);
  ctx.quadraticCurveTo(btnX + btnW, btnY, btnX + btnW, btnY + btnRadius);
  ctx.lineTo(btnX + btnW, btnY + btnH - btnRadius);
  ctx.quadraticCurveTo(btnX + btnW, btnY + btnH, btnX + btnW - btnRadius, btnY + btnH);
  ctx.lineTo(btnX + btnRadius, btnY + btnH);
  ctx.quadraticCurveTo(btnX, btnY + btnH, btnX, btnY + btnH - btnRadius);
  ctx.lineTo(btnX, btnY + btnRadius);
  ctx.quadraticCurveTo(btnX, btnY, btnX + btnRadius, btnY);
  ctx.closePath();
  ctx.fill();

  // Button text
  ctx.fillStyle = "white";
  ctx.font = "600 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Get Started", width / 2, height / 2 + 92);

  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(path.join(outputDir, filename), buffer);
  console.log(`Generated: ${filename}`);
}

function generateScreenshots() {
  createScreenshot(1280, 720, "dashboard-wide.png", "Dashboard overview \u2014 analytics & reconciliation");
  createScreenshot(750, 1334, "dashboard-narrow.png", "Mobile dashboard \u2014 offline ready");
  console.log("Screenshots generated!");
}

generateScreenshots();
