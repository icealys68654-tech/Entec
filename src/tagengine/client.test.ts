import test from "node:test";
import assert from "node:assert/strict";
import { TagEngineClient, TagEngineHttpError } from "./client";

const singleResult = {
  mode: "SINGLE_PARSE",
  processedCount: 1,
  volumeSerial: "ABCD-1234",
  anchorIso: "2025-01-02T15:04:00.000Z",
  recordsReturned: 1,
  records: []
};

test("posts the existing TagEngine analyze contract and returns typed result", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  let requestedHeaders: Record<string, string> = {};
  const client = new TagEngineClient({
    baseUrl: "http://localhost:3000/",
    apiToken: "test-secret",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      requestedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({
        ...singleResult,
        baseline: { processedCount: 1, volumeSerial: "ABCD-1234", anchorIso: singleResult.anchorIso }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const result = await client.analyze({ baselineText: "snapshot", minSeverity: 2.5 });
  assert.equal(requestedUrl, "http://localhost:3000/api/analyze");
  assert.deepEqual(requestedBody, { baselineText: "snapshot", targetText: "", minSeverity: 2.5 });
  assert.equal(requestedHeaders.authorization, "Bearer test-secret");
  assert.equal(result.mode, "SINGLE_PARSE");
});

test("surfaces TagEngine HTTP errors without hiding status", async () => {
  const client = new TagEngineClient({
    baseUrl: "https://tagengine.internal",
    fetchImpl: async () => new Response('{"error":"bad input"}', { status: 400 })
  });
  await assert.rejects(
    client.analyze({ baselineText: "snapshot" }),
    (error: unknown) => error instanceof TagEngineHttpError && error.status === 400
  );
});

test("validates base URL and severity before making a request", async () => {
  assert.throws(() => new TagEngineClient({ baseUrl: "file:///tmp/service" }));
  const client = new TagEngineClient({ baseUrl: "http://localhost:3000" });
  await assert.rejects(client.analyze({ baselineText: "snapshot", minSeverity: 11 }), /between 0 and 10/);
  await assert.rejects(client.analyze({ baselineText: "  " }), /baselineText is required/);
});


test("rejects an explicitly blank API token", () => {
  assert.throws(() => new TagEngineClient({ baseUrl: "http://localhost:3000", apiToken: " " }), /apiToken must be a non-empty string/);
});


test("creates, lists, and retrieves persisted snapshots with bearer auth", async () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const stored = {
    id, volumeId: "volume-a", label: "Baseline", createdAt: "2026-11-21T12:00:00.000Z",
    processedCount: 1, volumeSerial: "ABCD-1234", anchorIso: "2026-11-20T13:00:00.000Z"
  };
  const calls: Array<{ url: string; method: string; authorization: string }> = [];
  const client = new TagEngineClient({
    baseUrl: "https://tagengine.internal",
    apiToken: "secret",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method || "GET"),
        authorization: (init?.headers as Record<string, string>).authorization
      });
      if (String(input).includes("/api/snapshots?")) {
        return new Response(JSON.stringify({ snapshots: [stored] }), { status: 200 });
      }
      return new Response(JSON.stringify({ snapshot: stored }), { status: String(init?.method) === "POST" ? 201 : 200 });
    }
  });
  const created = await client.createSnapshot({ snapshotText: "snapshot", volumeId: "volume-a", label: "Baseline" });
  const listed = await client.listSnapshots({ volumeId: "volume-a" });
  const fetched = await client.getSnapshot(id);
  assert.equal(created.id, id);
  assert.equal(listed[0].volumeId, "volume-a");
  assert.equal(fetched.id, id);
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[1].url.includes("volumeId=volume-a"));
  assert.equal(calls.every(call => call.authorization === "Bearer secret"), true);
});


test("creates, lists, and retrieves historical comparisons with bearer auth", async () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const stored = {
    id, volumeId: "volume-a", baselineId: id, targetId: "123e4567-e89b-12d3-a456-426614174001",
    createdAt: "2026-11-21T12:00:00.000Z", minSeverity: 1, sharedAnchorIso: "2026-11-20T13:00:00.000Z",
    summary: { added: 1, modified: 2, deleted: 0, alertsEmitted: 3 }, alerts: []
  };
  const calls: Array<{ url: string; method: string; authorization: string }> = [];
  const client = new TagEngineClient({
    baseUrl: "https://tagengine.internal", apiToken: "secret",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), method: String(init?.method || "GET"),
        authorization: (init?.headers as Record<string, string>).authorization });
      if (String(input).includes("/api/snapshot-comparisons?")) return new Response(JSON.stringify({ comparisons: [stored] }), { status: 200 });
      return new Response(JSON.stringify({ comparison: stored }), { status: String(init?.method) === "POST" ? 201 : 200 });
    }
  });
  const created = await client.compareSnapshots({ baselineId: id, targetId: stored.targetId, minSeverity: 2 });
  const listed = await client.listComparisons({ volumeId: "volume-a" });
  const fetched = await client.getComparison(id);
  assert.equal(created.id, id);
  assert.equal(listed[0].summary.alertsEmitted, 3);
  assert.equal(fetched.id, id);
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[1].url.includes("volumeId=volume-a"));
  assert.equal(calls.every(call => call.authorization === "Bearer secret"), true);
});

test("validates historical comparison IDs and severity locally", async () => {
  const client = new TagEngineClient({ baseUrl: "http://localhost:3000" });
  await assert.rejects(client.compareSnapshots({ baselineId: "bad", targetId: "also-bad" }), /UUIDs/);
  const id = "123e4567-e89b-12d3-a456-426614174000";
  await assert.rejects(client.compareSnapshots({ baselineId: id, targetId: id }), /different/);
  await assert.rejects(client.compareSnapshots({ baselineId: id, targetId: "123e4567-e89b-12d3-a456-426614174001", minSeverity: 11 }), /between 0 and 10/);
});


test("runs retention in dry-run mode by default and supports explicit execution", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string }> = [];
  const retention = {
    dryRun: true, cutoff: "2026-08-01T00:00:00.000Z",
    candidates: { snapshots: 4, comparisons: 2 }, deleted: { snapshots: 0, comparisons: 0 },
    bytesReclaimable: 4096, remainingUsage: { files: 12, bytes: 8192 }
  };
  const client = new TagEngineClient({
    baseUrl: "https://tagengine.internal", apiToken: "secret",
    fetchImpl: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(input), body, authorization: (init?.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ retention: { ...retention, dryRun: body.dryRun,
        deleted: body.dryRun ? { snapshots: 0, comparisons: 0 } : { snapshots: 4, comparisons: 2 } } }), { status: 200 });
    }
  });
  const preview = await client.runRetention({ retentionDays: 90, keepLatestPerVolume: 3 });
  const applied = await client.runRetention({ retentionDays: 90, keepLatestPerVolume: 3, dryRun: false });
  assert.equal(preview.dryRun, true);
  assert.equal(calls[0].body.dryRun, true);
  assert.equal(applied.dryRun, false);
  assert.equal(applied.deleted.snapshots, 4);
  assert.ok(calls.every(call => call.url.endsWith("/api/maintenance/retention") && call.authorization === "Bearer secret"));
});

test("validates retention policy bounds before making a request", async () => {
  const client = new TagEngineClient({ baseUrl: "http://localhost:3000" });
  await assert.rejects(client.runRetention({ retentionDays: 0 }), /1 to 3650/);
  await assert.rejects(client.runRetention({ retentionDays: 30, keepLatestPerVolume: 1001 }), /0 to 1000/);
});
