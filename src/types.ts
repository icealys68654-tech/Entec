export const VECTOR_SCHEMA_VERSION = "entec.snapshot.v1" as const;

export type EntryType = "FILE" | "DIR" | "JUNCTION" | "SYMLINKD";

export interface ManifestEntry {
  volumeSerial: string;
  fullPath: string;
  pathKey: string;
  entryType: EntryType;
  sizeBytes: number;
  modifiedAt: string;
  extension: string;
}

export interface VectorRecord extends ManifestEntry {
  schemaVersion: typeof VECTOR_SCHEMA_VERSION;
  vector: number[];
}

export interface ParseSummary {
  volumeSerial: string;
  anchorIso: string;
  processedCount: number;
  skippedCount: number;
}

export interface SnapshotParseResult {
  summary: ParseSummary;
  records: VectorRecord[];
}

export type ChangeKind = "ADDED" | "REMOVED" | "MODIFIED";

export interface SnapshotChange {
  kind: ChangeKind;
  pathKey: string;
  path: string;
  before?: VectorRecord;
  after?: VectorRecord;
  severity: number;
}

export interface PipelineResult {
  schemaVersion: typeof VECTOR_SCHEMA_VERSION;
  baseline: ParseSummary;
  target?: ParseSummary;
  summary: { added: number; removed: number; modified: number; unchanged: number };
  changes: SnapshotChange[];
}

export interface PipelineInput {
  baselineText: string;
  targetText?: string;
  anchorEpochMs?: number;
}
