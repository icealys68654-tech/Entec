import { createHash } from "node:crypto";
import type { EntryType, ManifestEntry, VectorRecord } from "../types";
import { VECTOR_SCHEMA_VERSION } from "../types";

export const VECTOR_DIMENSIONS = [
  "isExecutable", "isArchiveOrImage", "isScriptOrConfig", "isRecycleBin",
  "isSystemOrProgramPath", "isHiddenOrDotPath", "isReparsePoint",
  "isDirectory", "pathDepthNorm", "logSize", "recentMtimeScore",
  "timestampSkewAnomaly"
] as const;

const EXEC = new Set([".exe", ".dll", ".sys", ".bat", ".cmd", ".ps1", ".vbs", ".msi", ".scr", ".com", ".node"]);
const ARCHIVE = new Set([".zip", ".7z", ".tar", ".gz", ".xz", ".iso", ".cab", ".rar", ".vhdx", ".vmdk"]);
const SCRIPT = new Set([".js", ".ts", ".jsx", ".tsx", ".py", ".sh", ".json", ".xml", ".inf", ".ini", ".cfg", ".yml", ".yaml", ".toml"]);

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index).toLowerCase() : "";
}

export function hashPath(fullPath: string): string {
  return createHash("sha256").update(fullPath.toLowerCase()).digest("hex");
}

export function vectorize(entry: ManifestEntry, anchorEpochMs: number): VectorRecord {
  const path = entry.fullPath.toLowerCase();
  const segments = entry.fullPath.split(/[\\/]+/).filter(Boolean);
  const ext = entry.extension || extensionOf(entry.fullPath);
  const epoch = Date.parse(entry.modifiedAt);
  const ageMs = Math.max(0, anchorEpochMs - epoch);
  const values = [
    entry.entryType === "FILE" && EXEC.has(ext) ? 1 : 0,
    entry.entryType === "FILE" && ARCHIVE.has(ext) ? 1 : 0,
    entry.entryType === "FILE" && SCRIPT.has(ext) ? 1 : 0,
    path.includes("\\$recycle.bin\\") ? 1 : 0,
    /^(?:[a-z]:\\windows\\|[a-z]:\\program files(?: \(x86\))?\\)/i.test(entry.fullPath) ? 1 : 0,
    segments.some(part => part.startsWith(".") || part.startsWith("$")) ? 1 : 0,
    entry.entryType === "JUNCTION" || entry.entryType === "SYMLINKD" ? 1 : 0,
    entry.entryType !== "FILE" ? 1 : 0,
    Math.min(segments.length / 15, 1),
    entry.entryType === "FILE" ? Math.min(Math.log10(entry.sizeBytes + 1) / 10, 1) : 0,
    Math.exp(-ageMs / (7 * 24 * 60 * 60 * 1000)),
    epoch > anchorEpochMs || new Date(epoch).getUTCFullYear() < 2015 ? 1 : 0
  ].map(value => Number(value.toFixed(4)));

  return { ...entry, schemaVersion: VECTOR_SCHEMA_VERSION, vector: values };
}

const ENTRY = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}\s+[AP]M)\s+(?:(<DIR>|<JUNCTION>|<SYMLINKD>)|([\d,]+))\s+(.+)$/i;
const DIR_HEADER = /^\s*Directory of (.+)$/i;
const SERIAL = /^\s*Volume Serial Number is ([0-9a-f-]+)$/i;

export function parseWindowsDate(dateText: string, timeText: string): number {
  const [month, day, year] = dateText.split("/").map(Number);
  const [clock, meridiem] = timeText.trim().split(/\s+/);
  let [hours, minutes] = clock.split(":").map(Number);
  if (meridiem.toUpperCase() === "PM" && hours !== 12) hours += 12;
  if (meridiem.toUpperCase() === "AM" && hours === 12) hours = 0;
  return Date.UTC(year, month - 1, day, hours, minutes);
}

export function parseSnapshot(text: string, explicitAnchor?: number): {
  entries: ManifestEntry[]; volumeSerial: string; anchorEpochMs: number; skippedCount: number;
} {
  const lines = text.split(/\r?\n/);
  const parsed: Array<{ entry: ManifestEntry; epoch: number }> = [];
  let volumeSerial = "UNKNOWN";
  let currentDir = "";
  let skippedCount = 0;

  for (const line of lines) {
    const serial = line.match(SERIAL);
    if (serial) { volumeSerial = serial[1]; continue; }
    const directory = line.match(DIR_HEADER);
    if (directory) { currentDir = directory[1].trim().replace(/[\\/]$/, ""); continue; }
    const match = line.match(ENTRY);
    if (!match || !currentDir) { if (line.trim()) skippedCount++; continue; }

    const [, dateText, timeText, dirTag, sizeText, rawName] = match;
    const name = rawName.split(" [")[0].trim();
    if (name === "." || name === "..") continue;
    const entryType: EntryType = dirTag?.toUpperCase() === "<DIR>" ? "DIR"
      : dirTag?.toUpperCase() === "<JUNCTION>" ? "JUNCTION"
      : dirTag?.toUpperCase() === "<SYMLINKD>" ? "SYMLINKD" : "FILE";
    const sizeBytes = sizeText ? Number(sizeText.replace(/,/g, "")) : 0;
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) { skippedCount++; continue; }
    const epoch = parseWindowsDate(dateText, timeText);
    const fullPath = currentDir + "\\" + name;
    parsed.push({ epoch, entry: {
      volumeSerial, fullPath, pathKey: hashPath(fullPath), entryType, sizeBytes,
      modifiedAt: new Date(epoch).toISOString(),
      extension: entryType === "FILE" ? extensionOf(name) : ""
    }});
  }

  const newestEpoch = parsed.reduce((max, item) => Math.max(max, item.epoch), 0);
  const anchorEpochMs = explicitAnchor ?? (newestEpoch || Date.now());
  return { entries: parsed.map(item => item.entry), volumeSerial, anchorEpochMs, skippedCount };
}
