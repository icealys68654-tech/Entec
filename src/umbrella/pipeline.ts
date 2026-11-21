import { parseSnapshot, vectorize } from "../vector/parse";
import type { PipelineInput, PipelineResult, SnapshotChange, VectorRecord } from "../types";
import { VECTOR_SCHEMA_VERSION } from "../types";

function severity(kind: SnapshotChange["kind"], record: VectorRecord): number {
  const weights = [3, 2, 2, 4, 3, 2, 3, 0.5, 1, 1, 1, 4];
  const risk = record.vector.reduce((sum, value, index) => sum + value * weights[index], 0);
  const base = kind === "REMOVED" ? 1 : 1.1;
  return Number(Math.min(10, base + risk / weights.reduce((a, b) => a + b, 0) * 8).toFixed(3));
}

export async function runSnapshotPipeline(input: PipelineInput): Promise<PipelineResult> {
  if (!input.baselineText?.trim()) throw new Error("baselineText is required");
  const baselineParsed = parseSnapshot(input.baselineText, input.anchorEpochMs);
  const baseline = baselineParsed.entries.map(entry => vectorize(entry, baselineParsed.anchorEpochMs));

  if (!input.targetText?.trim()) {
    const changes = baseline.map(after => ({
      kind: "ADDED" as const, pathKey: after.pathKey, path: after.fullPath,
      after, severity: severity("ADDED", after)
    }));
    return {
      schemaVersion: VECTOR_SCHEMA_VERSION,
      baseline: { volumeSerial: baselineParsed.volumeSerial, anchorIso: new Date(baselineParsed.anchorEpochMs).toISOString(), processedCount: baseline.length, skippedCount: baselineParsed.skippedCount },
      summary: { added: changes.length, removed: 0, modified: 0, unchanged: 0 },
      changes
    };
  }

  const targetParsed = parseSnapshot(input.targetText, input.anchorEpochMs ?? baselineParsed.anchorEpochMs);
  const target = targetParsed.entries.map(entry => vectorize(entry, targetParsed.anchorEpochMs));
  const beforeByKey = new Map(baseline.map(record => [record.pathKey, record]));
  const afterByKey = new Map(target.map(record => [record.pathKey, record]));
  const changes: SnapshotChange[] = [];
  let unchanged = 0;

  for (const [key, after] of afterByKey) {
    const before = beforeByKey.get(key);
    if (!before) changes.push({ kind: "ADDED", pathKey: key, path: after.fullPath, after, severity: severity("ADDED", after) });
    else if (before.entryType !== after.entryType || before.sizeBytes !== after.sizeBytes || before.modifiedAt !== after.modifiedAt) {
      changes.push({ kind: "MODIFIED", pathKey: key, path: after.fullPath, before, after, severity: severity("MODIFIED", after) });
    } else unchanged++;
  }
  for (const [key, before] of beforeByKey) {
    if (!afterByKey.has(key)) changes.push({ kind: "REMOVED", pathKey: key, path: before.fullPath, before, severity: severity("REMOVED", before) });
  }

  changes.sort((a, b) => b.severity - a.severity || a.path.localeCompare(b.path));
  return {
    schemaVersion: VECTOR_SCHEMA_VERSION,
    baseline: { volumeSerial: baselineParsed.volumeSerial, anchorIso: new Date(baselineParsed.anchorEpochMs).toISOString(), processedCount: baseline.length, skippedCount: baselineParsed.skippedCount },
    target: { volumeSerial: targetParsed.volumeSerial, anchorIso: new Date(targetParsed.anchorEpochMs).toISOString(), processedCount: target.length, skippedCount: targetParsed.skippedCount },
    summary: {
      added: changes.filter(change => change.kind === "ADDED").length,
      removed: changes.filter(change => change.kind === "REMOVED").length,
      modified: changes.filter(change => change.kind === "MODIFIED").length,
      unchanged
    },
    changes
  };
}
