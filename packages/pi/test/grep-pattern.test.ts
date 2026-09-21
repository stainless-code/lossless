import assert from "node:assert/strict";

import { redactSecrets } from "lossless-core";
import { grepView } from "lossless-core";
import { LcmStore } from "lossless-core";
import { ingestEntries } from "lossless-core";
import { PATTERN_ROW_CHARS } from "lossless-core";
import { test } from "vite-plus/test";

import { createGrepTool, type ToolResultShape } from "../src/tools/recall.ts";

function storeOf(texts: string[]): LcmStore {
  const s = new LcmStore(":memory:");
  ingestEntries(
    s,
    texts.map((text, i) => ({
      entryId: `e${String(i).padStart(2, "0")}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text,
      timestamp: i,
    })),
  );
  return s;
}

function grepTool(s: LcmStore) {
  return createGrepTool({ store: () => s, session: () => "s1", redact: redactSecrets });
}

function textOf(r: ToolResultShape): string {
  return r.content[0]!.text;
}

test("grep pattern: punctuation matches where the token index cannot", async () => {
  const s = storeOf([
    "the header [lcm:summary #12 depth 0 span e1..e9] is in context",
    "call state.getCommitState() before the swap",
    "state.getCommitState is called without parentheses elsewhere",
  ]);
  const tool = grepTool(s);
  // The index cannot tell `getCommitState()` from `getCommitState`: it tokenizes
  // the punctuation away, so both rows answer the query and only the pattern can
  // demand the call, and the parentheses with it.
  const query = await tool.execute("t", { query: "getCommitState" });
  assert.equal(textOf(query).split("\n")[0], "Found 2 match(es):");
  const pattern = await tool.execute("t", { pattern: "getCommitState\\(\\)" });
  assert.equal(
    textOf(pattern).split("\n")[0],
    "Pattern match(es) 1..1 in 3 stored message(s) scanned:",
  );
  assert.match(textOf(pattern), /^\[e01 \(assistant\)\] call state\.getCommitState\(\)/m);

  // A pointer's punctuation is not a token at all, and a span's dots are not a
  // query the index can express.
  const pointer = await tool.execute("t", { pattern: "lcm:summary #12" });
  assert.match(textOf(pointer), /^\[e00 \(user\)\]/m);
  assert.equal(pointer.details.hits, 1);
  assert.equal(pointer.details.stopped, "end");
  const dots = await tool.execute("t", { pattern: "e1\\.\\.e9" });
  assert.equal(dots.details.hits, 1);
  s.close();
});

test("grep pattern: a needle past the 100,000-character index is found", async () => {
  const needle = "PAST_THE_PREFIX";
  const long = `${"x".repeat(150_000)}${needle}${"y".repeat(1_000)}`;
  const s = storeOf([long, "short row"]);
  const tool = grepTool(s);
  const indexed = await tool.execute("t", { query: "PAST_THE_PREFIX" });
  assert.equal(
    textOf(indexed).split("\n")[0],
    'No matches for "PAST_THE_PREFIX" in session history.',
  );
  const scanned = await tool.execute("t", { pattern: needle });
  assert.equal(
    textOf(scanned).split("\n")[0],
    "Pattern match(es) 1..1 in 2 stored message(s) scanned:",
  );
  assert.match(textOf(scanned), /^\[e00 \(user\)\] x+/m);
  assert.equal(scanned.details.hits, 1);
  s.close();
});

test("grep pattern: no hits says what was scanned, not nothing", async () => {
  const s = storeOf(["alpha", "beta", "gamma"]);
  const r = await grepTool(s).execute("t", { pattern: "delta" });
  assert.equal(textOf(r), 'No matches for pattern "delta" in 3 stored message(s) scanned.');
  assert.deepEqual(r.details, { hits: 0, offset: 0, stopped: "end" });
  s.close();
});

test("grep pattern: a row longer than the cap is marked, and the footer counts it", async () => {
  const long = `${"z".repeat(PATTERN_ROW_CHARS + 5_000)}needle`;
  const s = storeOf([long]);
  const r = await grepTool(s).execute("t", { pattern: "zzz" });
  assert.match(
    textOf(r),
    new RegExp(`\\[lcm:scan-partial ${PATTERN_ROW_CHARS} of ${long.length} chars\\]`),
  );
  assert.equal(r.details.partialRows, 1);
  s.close();
});

test("grep pattern: pages, and the footer says more exist rather than counting them", async () => {
  const s = storeOf(Array.from({ length: 5 }, (_, i) => `hit ${i}`));
  const tool = grepTool(s);
  const first = await tool.execute("t", { pattern: "hit", limit: 2 });
  assert.deepEqual(
    textOf(first)
      .split("\n")
      .filter((l) => l.startsWith("["))
      .map((l) => l.slice(1, 4)),
    ["e00", "e01"],
  );
  assert.match(textOf(first), /… more matches exist; pass offset 2 for the next page\./);
  assert.equal(first.details.hits, 2);
  const second = await tool.execute("t", { pattern: "hit", limit: 2, offset: 2 });
  assert.deepEqual(
    textOf(second)
      .split("\n")
      .filter((l) => l.startsWith("["))
      .map((l) => l.slice(1, 4)),
    ["e02", "e03"],
  );
  const last = await tool.execute("t", { pattern: "hit", limit: 2, offset: 4 });
  assert.doesNotMatch(textOf(last), /more matches exist/);
  assert.equal(last.details.hits, 1);
  s.close();
});

test("grep query: offset pages the ranked hits and the header reports the total", async () => {
  const s = storeOf(["hit a", "hit b", "hit c"]);
  const tool = grepTool(s);
  const all = await tool.execute("t", { query: "hit" });
  assert.equal(textOf(all).split("\n")[0], "Found 3 match(es):");
  assert.deepEqual(all.details, { hits: 3, offset: 0, total: 3 });
  const page = await tool.execute("t", { query: "hit", limit: 2, offset: 1 });
  assert.equal(textOf(page).split("\n")[0], "Match(es) 2..3 of 3:");
  assert.match(textOf(page), /^\[e01/m);
  assert.deepEqual(page.details, { hits: 2, offset: 1, total: 3 });
  s.close();
});

test("grep pattern: a deadline stop names where to resume, and after resumes there", () => {
  const s = storeOf(["alpha one", "alpha two", "alpha three"]);
  let clock = 0;
  const cut = grepView(s, redactSecrets, { pattern: "alpha", now: () => (clock += 300) });
  assert.ok(cut.ok);
  if (!cut.ok) return;
  assert.match(cut.text, /scanning stopped at 1000ms after 2 message\(s\)/);
  assert.equal(cut.details.hits, 2);
  assert.equal(cut.details.after, "e01");
  assert.match(cut.text, /pass after "e01" to continue/);

  const rest = grepView(s, redactSecrets, { pattern: "alpha", after: "e01" });
  assert.ok(rest.ok);
  if (!rest.ok) return;
  assert.equal(rest.details.hits, 1);
  assert.match(rest.text, /^\[e02/m);
  assert.equal(rest.details.stopped, "end");
  s.close();
});

test("grep pattern: the parameter surface refuses what it cannot honor", async () => {
  const s = storeOf(["hit"]);
  const tool = grepTool(s);
  const both = await tool.execute("t", { query: "hit", pattern: "hit" });
  assert.equal(textOf(both), "Pass query or pattern, not both.");
  const neither = await tool.execute("t", {});
  assert.equal(neither.details.hits, undefined);
  assert.equal(textOf(neither), "Pass a query (FTS5) or a pattern (regular expression).");
  const bad = await tool.execute("t", { pattern: "(unclosed" });
  assert.match(textOf(bad), /^Invalid pattern/);
  const empty = await tool.execute("t", { pattern: "a*" });
  assert.match(textOf(empty), /matches the empty string/);
  const unknownAfter = await tool.execute("t", { pattern: "hit", after: "e99" });
  assert.equal(textOf(unknownAfter), "No stored message with entry id e99.");
  const afterWithQuery = await tool.execute("t", { query: "hit", after: "e00" });
  assert.match(textOf(afterWithQuery), /after resumes a pattern scan/);
  s.close();
});

test("grep pattern: a matched secret is masked before it is shown", async () => {
  const s = storeOf(["token ghp_0123456789012345678901234567890123ab here"]);
  const r = await grepTool(s).execute("t", { pattern: "ghp_\\w+" });
  assert.doesNotMatch(textOf(r), /ghp_0123/);
  assert.match(textOf(r), /\[REDACTED\]/);
  s.close();
});
