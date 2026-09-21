import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { test } from "vite-plus/test";

import {
  retentionCandidates,
  listDbFootprints,
  hashSessionPath,
  SCRATCH_MAX_AGE_MS,
} from "../src/retention.ts";

const NOW = 1_800_000_000_000;

function seedDir(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "lcm-retention-")), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("retention: session-gone DBs are candidates, live-mapped DBs are not", () => {
  const dir = seedDir("a");
  writeFileSync(join(dir, "aaaaaaaaaaaaaaaa.db"), "x");
  writeFileSync(join(dir, "bbbbbbbbbbbbbbbb.db"), "xx");
  writeFileSync(join(dir, "cccccccccccccccc.db"), "xxx");
  const liveHash = hashSessionPath("/home/user/project/session.jsonl");
  writeFileSync(join(dir, `${liveHash}.db`), "y");
  const cands = retentionCandidates({
    dir,
    liveDbPath: undefined,
    sessionPathHashes: new Set([liveHash]),
    now: NOW,
    scratchMaxAgeMs: SCRATCH_MAX_AGE_MS,
  });
  const names = cands.map((c) => basename(c.path)).sort();
  assert.deepEqual(names, ["aaaaaaaaaaaaaaaa.db", "bbbbbbbbbbbbbbbb.db", "cccccccccccccccc.db"]);
  assert.equal(
    cands.every((c) => c.reason === "session-gone"),
    true,
  );
  assert.ok(!names.includes(`${liveHash}.db`));
});

test("retention: scratch DBs expire only after the age limit", () => {
  const dir = seedDir("b");
  const fresh = join(dir, "scratch-abc.db");
  const old = join(dir, "scratch-def.db");
  writeFileSync(fresh, "x");
  writeFileSync(old, "x");
  utimesSync(fresh, new Date(NOW - 1000), new Date(NOW - 1000));
  utimesSync(
    old,
    new Date(NOW - SCRATCH_MAX_AGE_MS - 60_000),
    new Date(NOW - SCRATCH_MAX_AGE_MS - 60_000),
  );
  const cands = retentionCandidates({
    dir,
    liveDbPath: undefined,
    sessionPathHashes: new Set(),
    now: NOW,
    scratchMaxAgeMs: SCRATCH_MAX_AGE_MS,
  });
  assert.deepEqual(
    cands.map((c) => c.path.split("/").pop()),
    ["scratch-def.db"],
  );
  assert.equal(cands[0]!.reason, "scratch-expired");
});

test("retention: the live session's DB is never a candidate", () => {
  const dir = seedDir("c");
  const livePath = join(dir, "aaaaaaaaaaaaaaaa.db");
  writeFileSync(livePath, "x");
  writeFileSync(join(dir, "bbbbbbbbbbbbbbbb.db"), "xx");
  const cands = retentionCandidates({
    dir,
    liveDbPath: livePath,
    sessionPathHashes: new Set(),
    now: NOW,
    scratchMaxAgeMs: SCRATCH_MAX_AGE_MS,
  });
  assert.deepEqual(
    cands.map((c) => [basename(c.path), c.reason]),
    [["bbbbbbbbbbbbbbbb.db", "session-gone"]],
  );
  const absent = join(tmpdir(), "lcm-does-not-exist-xyz");
  assert.deepEqual(
    retentionCandidates({
      dir: absent,
      liveDbPath: undefined,
      sessionPathHashes: new Set(),
      now: NOW,
      scratchMaxAgeMs: SCRATCH_MAX_AGE_MS,
    }),
    [],
  );
  assert.deepEqual(listDbFootprints(absent), []);
});

test("retention: hashSessionPath is the first 16 hex chars of the path's sha256", () => {
  assert.equal(hashSessionPath("/some/session.jsonl"), "456e52c316cbe37b");
  assert.notEqual(hashSessionPath("/some/other.jsonl"), "456e52c316cbe37b");
});
