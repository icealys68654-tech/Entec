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
  const client = new TagEngineClient({
    baseUrl: "http://localhost:3000/",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        ...singleResult,
        baseline: { processedCount: 1, volumeSerial: "ABCD-1234", anchorIso: singleResult.anchorIso }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const result = await client.analyze({ baselineText: "snapshot", minSeverity: 2.5 });
  assert.equal(requestedUrl, "http://localhost:3000/api/analyze");
  assert.deepEqual(requestedBody, { baselineText: "snapshot", targetText: "", minSeverity: 2.5 });
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
