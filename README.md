# Entec Umbrella

Entec Umbrella is the orchestration and abstraction layer for the Entec platform. It provides a stable pipeline contract around snapshot ingestion, normalization, vector parsing, comparison, and downstream storage/security services.

## Relationship to existing repositories

- **Entec** is the platform umbrella and home for shared contracts and orchestration.
- **TagEngine** remains the specialized snapshot manifest parser and SQLite-backed snapshot diff engine. Its existing 12-dimensional feature model informs the Vector Parse Phase.
- This repository contains a dependency-light reference pipeline. It establishes an independently testable integration boundary without copying or silently modifying TagEngine.

## Pipeline

`INGEST → ABSTRACT → VECTOR_PARSE → COMPARE → PUBLISH`

1. **Ingest** — accept Windows `dir /s` text snapshots from a trusted caller.
2. **Abstract** — normalize entries into a platform-neutral manifest record.
3. **Vector Parse** — derive the versioned 12D feature vector and stable SHA-256 path key.
4. **Compare** — identify added, removed, and changed paths across snapshots.
5. **Publish** — return a typed pipeline result to an API, storage adapter, or IDS subsystem.

The vector dimensions, in order, are: executable, archive/image, script/config, recycle-bin path, system/program path, hidden/dot path, reparse point, directory, normalized path depth, normalized log size, recency, and timestamp anomaly.

## Quick start

```sh
npm install
npm run build
npm test
```

Use the library:

```ts
import { runSnapshotPipeline } from "./dist/index";

const result = await runSnapshotPipeline({
  baselineText: baselineSnapshot,
  targetText: targetSnapshot
});
console.log(result.summary);
```

## API shape

The core pipeline is transport-agnostic. Implement `SnapshotParser`, `ManifestSink`, or `AlertPublisher` from `src/abstract/ports.ts` to connect file uploads, databases, message queues, or the existing TagEngine service. No credentials or secrets belong in source control.

## Safety and operational notes

- Parsing is passive: it does not delete, quarantine, block, or modify scanned files.
- Treat snapshot content as untrusted input; apply upload limits and authentication at the API boundary.
- A vector is a deterministic feature representation, not a malware verdict. Review alerts before taking action.
- Keep vector schema changes versioned; changing dimension order requires a schema-version increment and migration plan.

## Existing TagEngine

Repository: https://github.com/icealys68654-tech/TagEngine

TagEngine currently provides the specialized Windows snapshot parser, JSONL output, and disk-backed SQLite comparison. This umbrella layer establishes reusable contracts and a separately testable integration boundary.
