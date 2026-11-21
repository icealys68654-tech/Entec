# Entec Umbrella

Entec Umbrella is the orchestration and abstraction layer for the Entec platform. It provides stable contracts for snapshot ingestion, normalization, vector parsing, comparison, and downstream storage/security services.

## Repository responsibilities

- **Entec** owns shared contracts, orchestration, and integrations.
- **TagEngine** owns the specialized Windows `dir /s` parser, 12D JSONL vector generation, and SQLite-backed disk diff.
- The Entec TagEngine adapter calls TagEngine's existing HTTP API. It does not fork or duplicate TagEngine's parser/comparator implementation.

## Pipeline

`INGEST → ABSTRACT → TAGENGINE VECTOR_PARSE → SQLITE DIFF → PUBLISH`

The 12 vector dimensions are: executable, archive/image, script/config, recycle-bin path, system/program path, hidden/dot path, reparse point, directory, normalized path depth, normalized log size, recency, and timestamp anomaly.

## Quick start

```sh
npm install
npm test
```

## Use the local reference pipeline

```ts
import { runSnapshotPipeline } from "@entec/umbrella";

const result = await runSnapshotPipeline({
  baselineText,
  targetText
});
console.log(result.summary);
```

## Call the existing TagEngine service

TagEngine exposes `POST /api/analyze`. Entec provides a typed HTTP adapter for that exact contract:

```ts
import { TagEngineClient } from "@entec/umbrella";

const tagEngine = new TagEngineClient({
  baseUrl: process.env.TAGENGINE_URL ?? "http://127.0.0.1:3000",
  apiToken: process.env.TAGENGINE_API_TOKEN
});

const result = await tagEngine.analyze({
  baselineText,
  targetText,
  minSeverity: 2
});

if (result.mode === "SNAPSHOT_DIFF") {
  console.log(result.summary, result.alerts);
} else {
  console.log(result.recordsReturned, result.records);
}
```

The adapter supports an injected `fetch` implementation for tests, optional server-side bearer authentication, validates inputs, enforces the service's 50MB request limit, applies a configurable timeout, and surfaces non-2xx responses as `TagEngineHttpError`.

## Deploying the integration safely

1. Deploy TagEngine separately using its own package and SQLite dependency.
2. Set `TAGENGINE_URL` to a private service address reachable by Entec.
3. Configure `ENTEC_API_TOKEN` in TagEngine's server environment and the matching `TAGENGINE_API_TOKEN` in the Entec server environment. Entec sends it as a bearer token. Keep both values in a secret manager; never embed them in browser code.
4. Apply request rate limits and payload limits at the gateway.
5. Treat all generated severity scores as review signals, not malware verdicts. The pipeline is passive and does not block, quarantine, or delete files.

## Existing repositories

- Entec: https://github.com/icealys68654-tech/Entec
- TagEngine: https://github.com/icealys68654-tech/TagEngine

## Development

`npm run build` compiles TypeScript. `npm test` runs parser and TagEngine adapter contract tests. The tests mock HTTP responses and do not require a running TagEngine instance.


## Persistent snapshot inventory

TagEngine can persist parsed snapshots on its host. Entec exposes typed methods
for the authenticated storage API:

```ts
const saved = await tagEngine.createSnapshot({
  snapshotText,
  volumeId: "workstation-01",
  label: "Monday baseline"
});
const history = await tagEngine.listSnapshots({ volumeId: "workstation-01", limit: 50 });
const snapshot = await tagEngine.getSnapshot(saved.id);
```

Configure TagEngine's `ENTEC_SNAPSHOT_DIR` on a durable volume and back it
up. The storage service supports historical comparisons and operator-triggered retention. See the lifecycle section below.


## Historical snapshot comparisons

The TagEngine adapter can compare two saved snapshot IDs without sending the
original snapshot text back over the network:

```ts
const comparison = await tagEngine.compareSnapshots({
  baselineId: savedBaseline.id,
  targetId: savedTarget.id,
  minSeverity: 2
});
console.log(comparison.summary, comparison.alerts);

const history = await tagEngine.listComparisons({
  volumeId: "workstation-01",
  limit: 50
});
const previous = await tagEngine.getComparison(history[0].id);
```

TagEngine enforces same-volume comparisons, uses a shared time anchor when
rebuilding vectors, and persists comparison metadata plus alert JSONL files.
The adapter returns the service's capped alert payload (up to 2,000 records);
use the summary counts for total change volume. Comparison endpoints require
the same server-side bearer token as snapshot storage.


## Snapshot retention operations

The Entec adapter exposes `runRetention()` for TagEngine's authenticated maintenance
endpoint. It defaults to a non-destructive preview:

```ts
const preview = await tagEngine.runRetention({
  retentionDays: 90,
  keepLatestPerVolume: 3
});

// Review candidates and estimated bytes before authorizing deletion.
console.log(preview.candidates, preview.bytesReclaimable);

// Explicitly execute only after reviewing the preview.
const result = await tagEngine.runRetention({
  retentionDays: 90,
  keepLatestPerVolume: 3,
  dryRun: false
});
```

The retention call is intended for trusted server-side operations. Keep the TagEngine
bearer token out of browser code. TagEngine retains snapshots referenced by comparisons
that remain in retention, and reports tracked snapshot/comparison artifact usage.

## Operations dashboard

Entec includes a small server-rendered-by-static-assets operations console. It reads stored snapshot inventory, comparison history and alert details, and runs a retention preview. It uses the TagEngine API through the server-side `TagEngineClient`; the TagEngine bearer token is never sent to the browser.

Configure the service environment and start it after building:

```sh
TAGENGINE_URL=http://127.0.0.1:3000 \
TAGENGINE_API_TOKEN=your-server-side-tagengine-token \
npm run build
npm run dashboard
```

The dashboard listens on `127.0.0.1:4173` by default. For remote binding, set `ENTEC_DASHBOARD_HOST` and a separate `ENTEC_DASHBOARD_TOKEN`; browser API requests require that token. Put remote deployments behind TLS and an authenticated reverse proxy. Keep both tokens in a secret manager.

Retention preview is non-destructive. Deletion requires entering `DELETE EXPIRED DATA` and confirming the browser prompt; the server independently checks the confirmation phrase. The dashboard displays the latest 500 snapshots/comparisons and the service-capped alert details. It does not expose raw snapshot contents or filesystem paths.
