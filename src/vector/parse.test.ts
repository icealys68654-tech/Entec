import test from "node:test";
import assert from "node:assert/strict";
import { parseSnapshot, vectorize, VECTOR_DIMENSIONS } from "./parse";

const sample = [
  " Volume Serial Number is 12AB-34CD",
  " Directory of C:\\Data",
  "01/02/2025  03:04 PM                 1,024 report.json",
  "01/02/2025  03:05 PM    <DIR>          .cache"
].join("\r\n");

test("parses Windows dir output and emits stable 12D vectors", () => {
  const parsed = parseSnapshot(sample);
  assert.equal(parsed.volumeSerial, "12AB-34CD");
  assert.equal(parsed.entries.length, 2);
  const record = vectorize(parsed.entries[0], parsed.anchorEpochMs);
  assert.equal(record.vector.length, VECTOR_DIMENSIONS.length);
  assert.equal(record.vector[2], 1);
  assert.equal(record.schemaVersion, "entec.snapshot.v1");
});

test("path keys are case-insensitive", () => {
  const a = parseSnapshot(" Directory of C:\\Data\n01/02/2025  03:04 PM  10 File.txt").entries[0];
  const b = parseSnapshot(" Directory of c:\\data\n01/02/2025  03:04 PM  10 file.TXT").entries[0];
  assert.equal(a.pathKey, b.pathKey);
});
