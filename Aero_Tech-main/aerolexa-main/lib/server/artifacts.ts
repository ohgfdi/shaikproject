/**
 * On-disk artifact helpers for extended modules (model cards, scheduled-run
 * exports). All files live under DATA_DIR (git-ignored, never publicly served
 * except through authenticated routes).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { dataDir } from "@/lib/engine/dataset";
import { keys, readTextFile, saveFile } from "@/lib/server/storage";

export function modelsDir(): string {
  return path.join(dataDir(), "models");
}
export function modelArtifactPath(id: string): string {
  return path.join(modelsDir(), `${id}.json`);
}
export function exportsDir(): string {
  return path.join(dataDir(), "exports");
}
export function exportArtifactPath(kind: string, id: string, stamp: string): string {
  return path.join(exportsDir(), `${kind}-${id.slice(0, 8)}-${stamp}.html`);
}

export async function ensureDirs(): Promise<void> {
  await fs.mkdir(modelsDir(), { recursive: true });
  await fs.mkdir(exportsDir(), { recursive: true });
}

/** URL for a stored export artifact (served by the scheduled-reports route). */
export function exportUrl(relativeName: string): string {
  return `/api/scheduled-reports/artifact?file=${encodeURIComponent(path.basename(relativeName))}`;
}

/** Read a stored export artifact's HTML (validated base name). */
export async function readExportHtml(fileName: string): Promise<string | null> {
  const base = path.basename(fileName);
  if (base !== fileName || !/^[a-z]+-[a-z0-9]+-\d{14}\.html$/.test(base)) return null;
  // Artifacts are produced by whichever replica ran the schedule; resolve
  // through storage so any replica can serve any artifact.
  try {
    const match = /^([a-z]+)-([a-z0-9]+)-(\d{14})\.html$/.exec(base);
    if (!match) return null;
    const [, kind, id, stamp] = match as unknown as [string, string, string, string];
    return await readTextFile(keys.export(kind, id, stamp));
  } catch {
    return null;
  }
}

/** Persist an export artifact through the storage driver. */
export async function writeExportHtml(kind: string, id: string, html: string): Promise<string> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ]/g, "")
    .slice(0, 14);
  const key = keys.export(kind, id, stamp);
  await saveFile(key, html);
  return exportArtifactPath(kind, id, stamp);
}

/** Read a model card through the storage driver. */
export async function readModelCard(id: string): Promise<string | null> {
  try {
    return await readTextFile(keys.modelCard(id));
  } catch {
    return null;
  }
}
