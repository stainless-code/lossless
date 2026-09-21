import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import {
  compilePattern,
  MAX_MATCHES_PER_ROW,
  PATTERN_ROW_CHARS,
  scanRows,
  type ScannedRow,
} from "../src/pattern-scan.ts";

function row(rowid: number, text: string, entryId = `e${rowid}`): ScannedRow {
  return { rowid, entryId, role: "user", text, removed: false };
}

const forever = () => 0;

function compiled(source: string, caseSensitive = false) {
  const result = compilePattern(source, caseSensitive);
  if (!result.ok) throw new Error(`pattern did not compile: ${result.reason}`);
  return result.pattern;
}

test("pattern scan: punctuation matches, which is what the FTS path cannot do", () => {
  const rows = [
    row(1, "the header [lcm:summary #12 depth 0 span e1..e9] is in context"),
    row(2, "call state.getCommitState() before the swap"),
    row(3, "nothing relevant here"),
  ];
  const outcome = scanRows(rows, {
    pattern: compiled("lcm:summary #12"),
    offset: 0,
    limit: 20,
    perRowChars: PATTERN_ROW_CHARS,
    deadlineAt: 1_000,
    now: forever,
  });
  assert.equal(outcome.hits.length, 1);
  assert.equal(outcome.hits[0]!.row.entryId, "e1");
  assert.equal(outcome.hits[0]!.at, 12);
  assert.equal(outcome.rows, 3);
  assert.equal(outcome.stopped, "end");

  const calls = scanRows(rows, {
    pattern: compiled("getCommitState\\("),
    offset: 0,
    limit: 20,
    perRowChars: PATTERN_ROW_CHARS,
    deadlineAt: 1_000,
    now: forever,
  });
  assert.deepEqual(
    calls.hits.map((h) => h.row.entryId),
    ["e2"],
  );
});

test("pattern scan: case is insensitive unless the caller says otherwise", () => {
  const rows = [row(1, "the SWAP threshold and the swap line")];
  const insensitive = scanRows(rows, {
    pattern: compiled("swap"),
    offset: 0,
    limit: 20,
    perRowChars: PATTERN_ROW_CHARS,
    deadlineAt: 1_000,
    now: forever,
  });
  assert.equal(insensitive.hits[0]!.matches, 2);
  const sensitive = scanRows(rows, {
    pattern: compiled("swap", true),
    offset: 0,
    limit: 20,
    perRowChars: PATTERN_ROW_CHARS,
    deadlineAt: 1_000,
    now: forever,
  });
  assert.equal(sensitive.hits[0]!.matches, 1);
});

test("pattern scan: a needle past the FTS prefix is found, and the row says it was cut", () => {
  const needle = "PAST_THE_PREFIX";
  const text = `${"x".repeat(150_000)}${needle}${"y".repeat(20_000)}`;
  const scan = (perRowChars: number) =>
    scanRows([row(1, text)], {
      pattern: compiled(needle),
      offset: 0,
      limit: 20,
      perRowChars,
      deadlineAt: 1_000,
      now: forever,
    });
  const found = scan(PATTERN_ROW_CHARS);
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0]!.at, 150_000);
  assert.equal(found.hits[0]!.partial, false);
  assert.equal(found.partialRows, 0);
  const cut = scan(100_000);
  assert.equal(cut.hits.length, 0);
  assert.equal(cut.partialRows, 1);
});

test("pattern scan: a pattern with no hits says so rather than scanning nothing", () => {
  const outcome = scanRows([row(1, "alpha"), row(2, "beta")], {
    pattern: compiled("gamma"),
    offset: 0,
    limit: 20,
    perRowChars: PATTERN_ROW_CHARS,
    deadlineAt: 1_000,
    now: forever,
  });
  assert.deepEqual(outcome.hits, []);
  assert.equal(outcome.rows, 2, "every row was read");
  assert.equal(outcome.stopped, "end");
  assert.equal(outcome.more, false);
});

test("pattern scan: the deadline stops the scan and keeps what it found", () => {
  let clock = 0;
  const rows = [row(1, "alpha hit"), row(2, "alpha hit"), row(3, "alpha hit")];
  const outcome = scanRows(rows, {
    pattern: compiled("alpha"),
    offset: 0,
    limit: 20,
    perRowChars: PATTERN_ROW_CHARS,
    deadlineAt: 9,
    now: () => (clock += 2),
  });
  assert.equal(outcome.stopped, "deadline");
  assert.equal(outcome.hits.length, 2, "the hits before the cut stand");
  assert.equal(outcome.rows, 3, "the row being read when the clock ran out is counted");
  assert.equal(outcome.lastRowId, 3, "the deadline names where it left off");
  assert.equal(outcome.lastEntryId, "e3");
});

test("pattern scan: a page is one more hit than it holds, in offset steps", () => {
  const rows = [row(1, "hit a"), row(2, "hit b"), row(3, "hit c"), row(4, "hit d")];
  const page = (offset: number, limit: number) =>
    scanRows(rows, {
      pattern: compiled("hit"),
      offset,
      limit,
      perRowChars: PATTERN_ROW_CHARS,
      deadlineAt: 1_000,
      now: forever,
    });
  const first = page(0, 2);
  assert.deepEqual(
    first.hits.map((h) => h.row.entryId),
    ["e1", "e2"],
  );
  assert.equal(first.more, true, "a hit exists after the page");
  assert.equal(first.stopped, "page");
  const second = page(2, 2);
  assert.deepEqual(
    second.hits.map((h) => h.row.entryId),
    ["e3", "e4"],
  );
  assert.equal(second.more, false);
  assert.equal(second.stopped, "end");
});

test("pattern scan: one row is one hit however many times it matches", () => {
  const many = Array.from({ length: MAX_MATCHES_PER_ROW + 5 }, () => "x").join(" ");
  const outcome = scanRows([row(1, many)], {
    pattern: compiled("x"),
    offset: 0,
    limit: 20,
    perRowChars: PATTERN_ROW_CHARS,
    deadlineAt: 1_000,
    now: forever,
  });
  assert.equal(outcome.hits.length, 1);
  assert.equal(outcome.hits[0]!.matches, MAX_MATCHES_PER_ROW, "counting stops at the cap");
});

test("pattern scan: a pattern that matches the empty string is refused before any row", () => {
  assert.equal(compilePattern("a*", false).ok, false);
  assert.equal(compilePattern("", false).ok, false);
  assert.equal(compilePattern("(unclosed", false).ok, false);
  assert.equal(compilePattern("abc", false).ok, true);
});
