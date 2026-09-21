import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vite-plus/test";

import { LcmStore } from "../src/store.ts";

function leaf(overrides: { firstEntryId?: string; lastEntryId?: string; fileIds?: string[] } = {}) {
  return {
    kind: "leaf" as const,
    text: "leaf text",
    tokens: 3,
    depth: 0,
    firstEntryId: overrides.firstEntryId ?? "e0",
    lastEntryId: overrides.lastEntryId ?? "e3",
    fileIds: overrides.fileIds ?? [],
  };
}

test("store: a summary whose file link is rejected leaves no node behind", () => {
  const store = new LcmStore(":memory:");
  // `summary_files.file_id` references `files(file_id)` and foreign keys are
  // on, so an id with no descriptor is rejected after the node row is written.
  // `OR IGNORE` does not cover foreign keys, so this is a real failure path.
  assert.throws(() => store.insertSummary(leaf({ fileIds: ["missing-file"] })));
  assert.equal(store.stats().summaries, 0, "the node rolled back with its rejected link");
  store.close();
});

test("store: a committed summary is visible through a second handle", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-tx-"));
  const path = join(dir, "session.db");
  const first = new LcmStore(path);
  first.insertFile(
    { fileId: "f1", path: "/tmp/big.json", bytes: 12, sha256: "abc", kind: "json", preview: "{}" },
    "e0",
  );
  const result = first.insertSummary(leaf({ fileIds: ["f1"] }));
  assert.equal(result.created, true);
  const second = new LcmStore(path);
  assert.equal(second.stats().summaries, 1, "the commit is durable, not handle-local");
  first.close();
  second.close();
  rmSync(dir, { recursive: true, force: true });
});

test("store: a nested transaction joins the open one, and a throw inside rolls the outer back", () => {
  const store = new LcmStore(":memory:");
  const result = store.transaction(() => store.insertSummary(leaf()));
  assert.equal(result.created, true);
  assert.equal(store.stats().summaries, 1);

  assert.throws(
    () =>
      store.transaction(() => {
        store.insertSummary(leaf({ firstEntryId: "x0", lastEntryId: "x3" }));
        store.transaction(() => {
          throw new Error("nested failure");
        });
      }),
    /nested failure/,
  );
  assert.equal(store.stats().summaries, 1, "the nested throw rolled back the outer write");
  store.close();
});
