import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vite-plus/test";

import { appendMetricRow, readMetricRows } from "../src/util/metrics-sink.ts";
import {
  addUsageTally,
  createUsageTally,
  tokenUsageOfTally,
  zeroCostUsageOfTokens,
} from "../src/util/metrics-sink.ts";

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

test("metrics-sink: empty tally folds to undefined usage", () => {
  const tally = createUsageTally();
  assert.equal(tokenUsageOfTally(tally), undefined);
});

test("metrics-sink: tally adds one call and folds to provider names", () => {
  const tally = createUsageTally();
  addUsageTally(tally, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
  const usage = tokenUsageOfTally(tally);
  assert.deepEqual(usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
  });
  const zeroed = zeroCostUsageOfTokens(usage);
  assert.equal(zeroed?.input, 10);
  assert.equal(zeroed?.output, 5);
});
