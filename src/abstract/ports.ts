import type { ManifestEntry, SnapshotChange, VectorRecord } from "../types";

export interface SnapshotParser {
  parse(text: string, anchorEpochMs?: number): Promise<{
    entries: ManifestEntry[];
    volumeSerial: string;
    anchorEpochMs: number;
    skippedCount: number;
  }>;
}

export interface Vectorizer {
  vectorize(entry: ManifestEntry, anchorEpochMs: number): VectorRecord;
}

export interface ManifestSink {
  write(records: AsyncIterable<VectorRecord>): Promise<void>;
}

export interface AlertPublisher {
  publish(changes: readonly SnapshotChange[]): Promise<void>;
}
