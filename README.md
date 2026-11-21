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
