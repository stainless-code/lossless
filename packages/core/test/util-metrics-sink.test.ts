import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vite-plus/test";

import { appendMetricRow, readMetricRows } from "../src/util/metrics-sink.ts";

function seedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "metrics-sink-"));
  appendMetricRow(dir, { session: "a", kind: "x", n: 1 });
  appendMetricRow(dir, { session: "b", kind: "x", n: 2 });
  appendMetricRow(dir, { session: "a", kind: "x", n: 3 });
  return dir;
}

test("metrics-sink: no-session negative limit reads all rows", () => {
  const dir = seedDir();
  const rows = readMetricRows(dir, { limit: -1 });
  assert.equal(rows.length, 3);
});

test("metrics-sink: session negative limit reads all matching rows", () => {
  const dir = seedDir();
  const rows = readMetricRows(dir, { session: "a", limit: -5 });
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((row) => (row as Record<string, unknown>).session === "a"),
    JSON.stringify(rows),
  );
});

test("metrics-sink: limit zero still returns no rows", () => {
  const dir = seedDir();
  assert.deepEqual(readMetricRows(dir, { limit: 0 }), []);
  assert.deepEqual(readMetricRows(dir, { session: "a", limit: 0 }), []);
});
