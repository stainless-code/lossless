import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "vite-plus/test";

import { runCompaction } from "../src/compaction-engine.ts";
import type { CompactionSpanEntry } from "../src/compaction-engine.ts";
import { estimateTokens } from "../src/estimate-tokens.ts";
import { exportTranscript } from "../src/export.ts";
import { ingestEntries } from "../src/ingest.ts";
import { SummarizerFailure } from "../src/llm.ts";
import { metricsPath } from "../src/metrics.ts";
import { describeView } from "../src/recall-view.ts";
import { makeRedact, redactSecrets } from "../src/redact.ts";
import { LcmStore } from "../src/store.ts";
import { summarizeWithEscalation, deterministicTruncate } from "../src/summarize.ts";
import { storedPass } from "./support/pass-outcome.ts";

function makeStore(): LcmStore {
  return new LcmStore(`:memory:`);
}

function metricsMark(): number {
  try {
    return readFileSync(metricsPath(), "utf8").length;
  } catch {
    return 0;
  }
}

function metricsSince(mark: number): Array<Record<string, unknown>> {
  const raw = readFileSync(metricsPath(), "utf8").slice(mark).trim();
  return raw ? raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

function wideSpan(count: number, chars: number): CompactionSpanEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    entryId: `e${i}`,
    role: "user",
    text: "q".repeat(chars),
  }));
}

test("escalation: an extreme oversize result is retried once and kept when no better", async () => {
  let calls = 0;
  const result = await summarizeWithEscalation(
    [{ role: "user", text: "q".repeat(80_000) }],
    1500,
    async () => {
      calls++;
      return "x".repeat(20_000);
    },
    "t",
  );
  assert.equal(calls, 2, "5000 tokens over a 1500 target earns one retry");
  assert.equal(result.retried, true);
  assert.equal(result.level, 1, "the retry answered the same size, so level 1 stands");
  assert.equal(result.sourceTokens, 20_000);
  assert.equal(estimateTokens(result.text), 5000);
});

test("escalation: a smaller retry is stored instead of the oversize result", async () => {
  let calls = 0;
  const result = await summarizeWithEscalation(
    [{ role: "user", text: "q".repeat(80_000) }],
    1500,
    async () => {
      calls++;
      return calls === 1 ? "x".repeat(20_000) : "y".repeat(4000);
    },
    "t",
  );
  assert.equal(calls, 2, "a second generation happened");
  assert.equal(result.retried, true);
  assert.equal(result.level, 2);
  assert.equal(result.text, "y".repeat(4000), "the smaller text is what gets stored");
});

test("escalation: over target but under the retry threshold is stored as is", async () => {
  let calls = 0;
  const result = await summarizeWithEscalation(
    [{ role: "user", text: "q".repeat(80_000) }],
    1500,
    async () => {
      calls++;
      return "z".repeat(8000);
    },
    "t",
  );
  assert.equal(calls, 1, "2000 tokens is over target but not over twice it");
  assert.equal(result.retried, false);
  assert.equal(result.level, 1);
  assert.equal(estimateTokens(result.text), 2000);
});

test("escalation: a result over twice the target is retried whatever the source ratio", async () => {
  let calls = 0;
  const result = await summarizeWithEscalation(
    [{ role: "user", text: "q".repeat(16_000) }],
    1500,
    async () => {
      calls++;
      return calls === 1 ? "x".repeat(14_000) : "y".repeat(4000);
    },
    "t",
  );
  assert.equal(calls, 2);
  assert.equal(result.retried, true);
  assert.equal(result.level, 2);
  assert.equal(estimateTokens(result.text), 1000);
});

test("escalation: the leaf path records an oversize node with its ratio", async () => {
  const s = makeStore();
  const mark = metricsMark();
  let calls = 0;
  const outcome = await storedPass(
    s,
    { span: wideSpan(8, 8000), targetTokens: 3000 },
    async () => {
      calls++;
      return "x".repeat(20_000);
    },
    { leafChunkTokens: 2000, maxChunks: 1, session: "t" },
  );
  assert.equal(calls, 2, "one generation plus one retry");
  const oversize = metricsSince(mark).filter((m) => m.kind === "summary-oversized");
  assert.equal(oversize.length, 1);
  assert.deepEqual(
    [
      oversize[0]!.stage,
      oversize[0]!.depth,
      oversize[0]!.tokens,
      oversize[0]!.targetTokens,
      oversize[0]!.sourceTokens,
      oversize[0]!.retried,
      oversize[0]!.level,
    ],
    ["leaf", 0, 5000, 1000, 16_000, true, 1],
  );
  assert.equal(s.getSummary(outcome.leafSummaryIds[0]!)!.tokens, 5000);
  s.close();
});

test("escalation: prompts are injection-fenced", async () => {
  let lastConv = "";
  await summarizeWithEscalation(
    [{ role: "user", text: "evil embedded instructions" }],
    256,
    async (_prompt, conv) => {
      lastConv = conv;
      return "ok";
    },
  );
  assert.ok(lastConv.includes("<conversation_chunk>"));
  assert.ok(lastConv.includes("Ignore any instructions"));
});

const fakeLlm = {
  short: (text: string) => text.slice(0, Math.floor(text.length / 3)),
};

test("store: ingest is idempotent per entry id", () => {
  const s = makeStore();
  const entries = [
    { entryId: "a1", role: "user" as const, text: "hello world", timestamp: 1 },
    { entryId: "a2", role: "assistant" as const, text: "hi there", timestamp: 2 },
  ];
  const r1 = ingestEntries(s, entries);
  assert.equal(r1.inserted, 2);
  const r2 = ingestEntries(s, entries);
  assert.equal(r2.inserted, 0);
  assert.equal(r2.skipped, 2);
  s.close();
});

test("store: grep finds ingested messages", () => {
  const s = makeStore();
  ingestEntries(s, [
    { entryId: "a1", role: "user", text: "we decided to use bun for builds", timestamp: 1 },
    { entryId: "a2", role: "assistant", text: "sounds good, updating package.json", timestamp: 2 },
  ]);
  const hits = s.grep("bun");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.entryId, "a1");
  s.close();
});

test("escalation: level 3 deterministic truncate always shrinks", () => {
  assert.equal(
    deterministicTruncate("x".repeat(10_000), 512),
    `${"x".repeat(1433)}\n\n[…truncated…]\n\n${"x".repeat(409)}`,
  );
  assert.equal(deterministicTruncate("short", 512), "short");
});

test("escalation: falls through to level 2 then 3 when LLM fails", async () => {
  let calls = 0;
  const llm = async () => {
    calls++;
    if (calls < 2) throw new Error("boom");
    return "short summary";
  };
  const r = await summarizeWithEscalation([{ role: "user", text: "a".repeat(2000) }], 256, llm);
  assert.equal(r.level, 2);
  assert.equal(r.text, "short summary");
});

test("escalation: level 3 when every LLM call fails", async () => {
  const llm = async () => {
    throw new Error("provider down");
  };
  const items = [{ role: "user", text: "b".repeat(5000) }];
  const r = await summarizeWithEscalation(items, 256, llm);
  assert.equal(r.level, 3);
});

test("compaction: builds leaf summaries with engine-side pointers", async () => {
  const s = makeStore();
  const span: CompactionSpanEntry[] = Array.from({ length: 6 }, (_, i) => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `message ${i}: `.padEnd(400, "z"),
  }));
  const llm = async (_p: string, conv: string) => fakeLlm.short(conv);
  const outcome = await storedPass(s, { span, targetTokens: 500 }, llm);
  assert.deepEqual(outcome.leafSummaryIds, [1]);
  assert.deepEqual(outcome.condensedSummaryIds, []);
  assert.ok(
    outcome.summaryText.startsWith("[lcm:summary #1 depth 0 span e0..e5]\n"),
    outcome.summaryText,
  );
  const leaf = s.getSummary(1)!;
  assert.equal(leaf.kind, "leaf");
  assert.equal(leaf.firstEntryId, "e0");
  assert.equal(leaf.lastEntryId, "e5");
  s.close();
});

test("escalation: level 3 is the plain source text truncated, no prompt fence", async () => {
  const long = "x".repeat(6000);
  const r = await summarizeWithEscalation([{ role: "user", text: long }], 256, async () => {
    throw new Error("summarizer down");
  });
  assert.equal(r.level, 3);
  assert.ok(r.text.startsWith("[user]\nx"), r.text.slice(0, 20));
  assert.ok(!r.text.includes("<conversation_chunk>"));
  assert.ok(!r.text.includes("Ignore any instructions"));
  assert.ok(r.text.includes("[…truncated…]"));
  assert.ok(estimateTokens(r.text) <= 512 + 8, String(estimateTokens(r.text)));
});

test("compaction: a span handed in an order no row range expresses still covers the store's range", async () => {
  const s = new LcmStore(":memory:");
  const span: CompactionSpanEntry[] = [
    { entryId: "c1", role: "custom", text: "pi summary of the head" },
    { entryId: "e0", role: "user", text: `msg 0 ${"content ".repeat(50)}` },
    { entryId: "e1", role: "assistant", text: `msg 1 ${"content ".repeat(50)}` },
  ];
  ingestEntries(s, [
    { entryId: "e0", role: "user", text: span[1]!.text, timestamp: 0 },
    { entryId: "e1", role: "assistant", text: span[2]!.text, timestamp: 0 },
    { entryId: "c1", role: "custom", text: span[0]!.text, timestamp: 0, piCompaction: true },
  ]);
  const outcome = await storedPass(s, { span, targetTokens: 10_000 }, async () => "leaf text");
  assert.deepEqual(outcome.leafSummaryIds, [1]);
  assert.deepEqual(s.uncoveredMessagesInSpan("c1", "e1"), []);
  assert.deepEqual(s.coveredMessageIds(1), [1, 2, 3]);
  s.close();
});

test("compaction: level 3 leaves are stored, tagged, and reported; nothing throws", async () => {
  const s = new LcmStore(":memory:");
  const span: CompactionSpanEntry[] = Array.from({ length: 4 }, (_, i) => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `msg ${i} ${"content ".repeat(50)}`,
  }));
  const outcome = await storedPass(s, { span, targetTokens: 300 }, async () => {
    throw new Error("llm down");
  });
  assert.deepEqual(outcome.leafSummaryIds, [1]);
  const leaf = s.getSummary(1)!;
  assert.ok(leaf.text.startsWith("[lcm:truncated]\n[user]\nmsg 0 content"), leaf.text.slice(0, 60));
  assert.ok(!leaf.text.includes("<conversation_chunk>"));
  assert.deepEqual(new Set(s.coveredMessageIds(1)), new Set([1, 2, 3, 4]));
  assert.equal(s.uncoveredMessagesInSpan("e0", "e3").length, 0);
  assert.ok(outcome.summaryText.includes("[lcm:summary #1 depth 0 span e0..e3]\n[lcm:truncated]"));
  s.close();
});

test("store: a span's ends come from the rows, not from the caller's order", () => {
  const s = new LcmStore(":memory:");
  for (const id of ["e0", "e1", "e2", "e3", "c1"]) {
    s.insertMessage({ entryId: id, role: "user", text: id, tokens: 1, timestamp: 0 });
  }
  assert.deepEqual(s.spanBounds(["c1", "e1", "e2"]), { firstEntryId: "e1", lastEntryId: "c1" });
  assert.deepEqual(s.spanBounds(["c1", "zz"]), { firstEntryId: "c1", lastEntryId: "c1" });
  assert.equal(s.spanBounds(["zz"]), null);
  assert.equal(s.spanBounds([]), null);
  assert.equal(s.uncoveredMessagesInSpan("c1", "e1").length, 0);
  assert.equal(s.uncoveredMessagesInSpan("e1", "c1").length, 4);
  s.close();
});

test("compaction: a span the store holds no row for names the state instead of throwing", async () => {
  const s = new LcmStore(":memory:");
  const span: CompactionSpanEntry[] = [{ entryId: "e0", role: "user", text: "   " }];
  const calls: string[] = [];
  const llm = async () => {
    calls.push("paid");
    return "unused";
  };
  const outcome = await runCompaction(s, { span, targetTokens: 300 }, llm);
  assert.deepEqual(outcome, { kind: "nothing", reason: "no-entries", ingested: 0 });
  assert.deepEqual(calls, []);
  s.close();
});

test("compaction: a span whose messages are already memory stores nothing and says covered", async () => {
  const s = new LcmStore(":memory:");
  const span: CompactionSpanEntry[] = Array.from({ length: 4 }, (_, i) => ({
    entryId: `e${i}`,
    role: "user",
    text: `msg ${i} ${"content ".repeat(50)}`,
  }));
  const llm = async () => "leaf text";
  await storedPass(s, { span, targetTokens: 10_000 }, llm);
  const inner = await runCompaction(s, { span: span.slice(1, 3), targetTokens: 10_000 }, llm);
  assert.deepEqual(inner, { kind: "nothing", reason: "covered", ingested: 0 });
  s.close();
});

test("compaction: a second pass summarizes only messages no leaf covers yet", async () => {
  const s = makeStore();
  const llm = async (_p: string, conv: string) => fakeLlm.short(conv);
  const entry = (i: number): CompactionSpanEntry => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `message ${i}: `.padEnd(400, "z"),
  });
  const first = await storedPass(
    s,
    { span: Array.from({ length: 4 }, (_, i) => entry(i)), targetTokens: 2000 },
    llm,
    { leafChunkTokens: 200 },
  );
  assert.deepEqual(first.leafSummaryIds, [1, 2]);
  let calls = 0;
  const counting = async (p: string, conv: string) => {
    calls++;
    return llm(p, conv);
  };
  const second = await storedPass(
    s,
    { span: Array.from({ length: 6 }, (_, i) => entry(i)), targetTokens: 2000 },
    counting,
    { leafChunkTokens: 200 },
  );
  assert.equal(calls, 1);
  assert.deepEqual(second.leafSummaryIds, [3]);
  assert.deepEqual([s.getSummary(3)!.firstEntryId, s.getSummary(3)!.lastEntryId], ["e4", "e5"]);
  assert.deepEqual(
    s.frontier("e0", "e5").map((n) => n.id),
    [1, 2, 3],
  );
  s.close();
});

test("compaction: the span lands verbatim and redaction applies to what leaves", async () => {
  const s = new LcmStore(":memory:");
  const fakeSecret = "sk-fake-1234567890abcdef";
  const span: CompactionSpanEntry[] = [
    {
      entryId: "e0",
      role: "user",
      text: `run with SECRET_KEY=${fakeSecret} now, ${"filler text ".repeat(30)}`,
    },
    {
      entryId: "e1",
      role: "assistant",
      text: `done, used ${fakeSecret}, ${"filler text ".repeat(30)}`,
    },
  ];
  const inputs: string[] = [];
  await storedPass(
    s,
    { span, targetTokens: 300 },
    async (_p, conv) => {
      inputs.push(conv);
      return conv.slice(0, Math.floor(conv.length / 3));
    },
    { redact: redactSecrets },
  );
  assert.equal(s.stats().messages, 2);
  assert.equal(s.grep(JSON.stringify(fakeSecret)).length, 2);
  assert.ok(inputs.length > 0, "the summarizer ran");
  for (const input of inputs) {
    assert.equal(input.includes(fakeSecret), false, "the span reaches the model masked");
    assert.ok(input.includes("[REDACTED]"), input.slice(0, 200));
  }
  const summaries = s.allSummaries();
  assert.equal(summaries.length, 1);
  assert.ok(summaries[0]!.text.includes("SECRET_KEY=[REDACTED]"), summaries[0]!.text);
  assert.ok(!summaries[0]!.text.includes(fakeSecret), summaries[0]!.text);
  s.close();
});

function multiLeafSpan(): CompactionSpanEntry[] {
  return Array.from({ length: 6 }, (_, i) => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `message ${i}: `.padEnd(400, "z"),
  }));
}

test("compaction: leaves within budget stay as the frontier; over budget they condense into one depth-1 node", async () => {
  const s = makeStore();
  const span = multiLeafSpan();
  const llm = async (_p: string, conv: string) => fakeLlm.short(conv);
  const roomy = await storedPass(s, { span, targetTokens: 2000 }, llm, {
    leafChunkTokens: 200,
  });
  assert.equal(roomy.leafSummaryIds.length, 3);
  assert.deepEqual(roomy.condensedSummaryIds, []);
  assert.deepEqual(
    s.frontier("e0", "e5").map((n) => n.id),
    [1, 2, 3],
  );

  const tight = await storedPass(s, { span, targetTokens: 60 }, llm, {
    leafChunkTokens: 200,
  });
  assert.deepEqual(tight.leafSummaryIds, []);
  assert.deepEqual(tight.condensedSummaryIds, [4]);
  const condensed = s.getSummary(4)!;
  assert.equal(condensed.kind, "condensed");
  assert.equal(condensed.depth, 1);
  assert.equal(condensed.firstEntryId, "e0");
  assert.equal(condensed.lastEntryId, "e5");
  const covered = s.coveredMessageIds(condensed.id);
  assert.deepEqual(new Set(covered), new Set(s.messagesInSpan("e0", "e5").map((m) => m.id)));
  assert.deepEqual(
    s.frontier("e0", "e5").map((n) => n.id),
    [4],
  );
  assert.ok(
    tight.summaryText.startsWith("[lcm:summary #4 depth 1 span e0..e5]\n"),
    tight.summaryText,
  );
  s.close();
});

test("compaction: condensation groups same-depth siblings, never a mixed pair", async () => {
  const s = makeStore();
  const llm = async (_p: string, conv: string) => conv.slice(0, Math.floor(conv.length * 0.6));
  const span: CompactionSpanEntry[] = Array.from({ length: 8 }, (_, i) => ({
    entryId: `e${i}`,
    role: "user",
    text: `message ${i}: `.padEnd(400, "z"),
  }));
  await storedPass(s, { span, targetTokens: 100_000 }, llm, { leafChunkTokens: 100 });
  assert.equal(s.frontier("e0", "e7").length, 8);
  const outcome = await storedPass(s, { span, targetTokens: 40 }, llm, {
    leafChunkTokens: 100,
  });
  assert.deepEqual(outcome.condensedSummaryIds, [9]);
  const top = s.getSummary(9)!;
  assert.equal(top.depth, 1);
  assert.deepEqual(
    s.frontier("e0", "e7").map((n) => n.id),
    [9],
  );
  assert.equal(new Set(s.coveredMessageIds(9)).size, 8);

  const more: CompactionSpanEntry[] = [
    ...span,
    { entryId: "e8", role: "user", text: "message 8: ".padEnd(400, "z") },
  ];
  const grown = await storedPass(s, { span: more, targetTokens: 40 }, llm, {
    leafChunkTokens: 100,
  });
  assert.deepEqual(grown.leafSummaryIds, [10]);
  assert.deepEqual(grown.condensedSummaryIds, []);
  assert.deepEqual(
    s.frontier("e0", "e8").map((n) => [n.id, n.depth]),
    [
      [9, 1],
      [10, 0],
    ],
  );

  const most: CompactionSpanEntry[] = [
    ...more,
    { entryId: "e9", role: "user", text: "message 9: ".padEnd(400, "z") },
  ];
  const balanced = await storedPass(s, { span: most, targetTokens: 40 }, llm, {
    leafChunkTokens: 100,
  });
  assert.deepEqual(balanced.leafSummaryIds, [11]);
  assert.deepEqual(balanced.condensedSummaryIds, [12, 13]);
  const deeper = s.getSummary(13)!;
  assert.equal(deeper.depth, 2);
  assert.deepEqual(
    s.childSummaryIds(13).map((id) => s.getSummary(id)?.depth),
    [1, 1],
  );
  assert.deepEqual([deeper.firstEntryId, deeper.lastEntryId], ["e0", "e9"]);
  assert.equal(new Set(s.coveredMessageIds(13)).size, 10);
  s.close();
});

test("compaction: final text over 2× targetTokens is clamped by deterministicTruncate", async () => {
  const s = makeStore();
  const span = multiLeafSpan();
  const llm = async (_p: string, conv: string) => conv.slice(0, Math.floor(conv.length * 0.6));
  const targetTokens = 50;
  const outcome = await storedPass(s, { span, targetTokens }, llm, {
    leafChunkTokens: 200,
  });
  assert.deepEqual(outcome.condensedSummaryIds, [4]);
  assert.ok(outcome.summaryText.includes("[…truncated…]"));
  assert.ok(estimateTokens(outcome.summaryText) <= targetTokens * 2);
  const stored = s.getSummary(4)!;
  assert.ok(!stored.text.includes("[…truncated…]"));
  s.close();
});

test("store: db file is created with owner-only permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-perms-"));
  const dbPath = join(dir, "x.db");
  const s = new LcmStore(dbPath);
  s.insertMessage({ entryId: "a", role: "user", text: "hi", tokens: 1, timestamp: 0 });
  s.close();
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

test("store: duplicate span insert returns the existing id (no duplicate rows)", () => {
  const s = new LcmStore(":memory:");
  const first = s.insertSummary({
    kind: "leaf",
    text: "one",
    tokens: 2,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e3",
    messageIds: [1, 2],
  });
  assert.equal(first.created, true);
  const second = s.insertSummary({
    kind: "leaf",
    text: "two (duplicate span, different text)",
    tokens: 5,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e3",
  });
  assert.deepEqual(second, {
    id: first.id,
    created: false,
    own: true,
    existingTokens: 2,
    existingText: "one",
    foreignLive: false,
  });
  assert.equal(s.stats().summaries, 1);
  assert.equal(s.getSummary(first.id)?.text, "one");
  s.close();
});

test("store: a legacy DB with duplicate spans opens without dropping a row", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-migration-"));
  const dbPath = join(dir, "legacy.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
		CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, text TEXT NOT NULL, tokens INTEGER NOT NULL, timestamp INTEGER NOT NULL);
		CREATE TABLE summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL, tokens INTEGER NOT NULL, depth INTEGER NOT NULL, first_entry_id TEXT NOT NULL, last_entry_id TEXT NOT NULL, created_at INTEGER NOT NULL);
		CREATE TABLE provenance (summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE, child_type TEXT NOT NULL, child_id INTEGER NOT NULL, PRIMARY KEY (summary_id, child_type, child_id));
	`);
  legacy
    .prepare(
      "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at) VALUES ('leaf', 'old dup 1', 2, 0, 'e0', 'e3', 1)",
    )
    .run();
  legacy
    .prepare(
      "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at) VALUES ('leaf', 'newest dup', 2, 0, 'e0', 'e3', 2)",
    )
    .run();
  legacy.close();

  const s = new LcmStore(dbPath);
  assert.equal(s.stats().summaries, 2);
  assert.deepEqual(
    s.integritySnapshot().duplicateSpans,
    [{ first: "e0", last: "e3", kind: "leaf", count: 2 }],
    "the duplicates are reported rather than deleted",
  );
  assert.equal(s.getSummary(1)?.text, "old dup 1");
  assert.equal(s.getSummary(2)?.text, "newest dup");

  assert.equal(s.dedupeSpans(), 1);
  assert.equal(s.stats().summaries, 1);
  assert.equal(s.getSummary(2)?.text, "newest dup", "the newest of two equals survives");
  const again = s.insertSummary({
    kind: "leaf",
    text: "another dup",
    tokens: 2,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e3",
  });
  assert.equal(again.id, 2);
  assert.equal(again.created, false);
  assert.equal(s.stats().summaries, 1, "the applied index keeps the span unique");
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("store: updateSummaryText rewrites text and tokens only", () => {
  const s = makeStore();
  ingestEntries(s, [
    { entryId: "e0", role: "user", text: "alpha", timestamp: 1 },
    { entryId: "e1", role: "assistant", text: "beta", timestamp: 2 },
  ]);
  const id = s.insertSummary({
    kind: "leaf",
    text: "old text",
    tokens: 10,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e1",
    messageIds: s.messagesInSpan("e0", "e1").map((m) => m.id),
  }).id;
  const before = s.getSummary(id)!;
  s.updateSummaryText(id, "new text", 3);
  const after = s.getSummary(id)!;
  assert.equal(after.text, "new text");
  assert.equal(after.tokens, 3);
  assert.deepEqual(
    [after.firstEntryId, after.lastEntryId, after.depth, after.kind, after.createdAt],
    [before.firstEntryId, before.lastEntryId, before.depth, before.kind, before.createdAt],
  );
  assert.equal(new Set(s.coveredMessageIds(id)).size, 2);
  assert.deepEqual(
    s.frontier("e0", "e1").map((n) => [n.id, n.text]),
    [[id, "new text"]],
  );
  s.close();
});

test("export: store round-trips through the transcript", () => {
  const s = makeStore();
  ingestEntries(s, [
    { entryId: "e0", role: "user", text: "first question", timestamp: 1 },
    { entryId: "e1", role: "assistant", text: "first answer", timestamp: 2 },
    { entryId: "e2", role: "user", text: "second question", timestamp: 3 },
  ]);
  s.insertSummary({
    kind: "leaf",
    text: "leaf summary",
    tokens: 5,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e1",
    messageIds: [s.messagesInSpan("e0", "e1").map((m) => m.id)[0]!],
  });

  const out = exportTranscript(s);
  const jsonl = out.toJSONL();
  const lines = jsonl.split("\n");
  assert.equal(lines.length, 4);

  const fresh = new LcmStore(":memory:");
  const messageLines = lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((o) => typeof o.entryId === "string");
  const stats = ingestEntries(
    fresh,
    messageLines.map((o) => ({
      entryId: String(o.entryId),
      role: o.role as "user" | "assistant",
      text: String(o.text),
      timestamp: Number(o.timestamp),
    })),
  );
  assert.equal(stats.inserted, 3);
  assert.equal(fresh.stats().messages, 3);
  const first = JSON.parse(lines[0]!) as { entryId: string };
  assert.equal(first.entryId, "e0");
  assert.equal(fresh.messagesInSpan("e0", "e2").length, 3);
  fresh.close();
  s.close();
});

test("redact: makeRedact follows a config that is REPLACED, not mutated", () => {
  let cfg: { redactSecrets?: boolean } = { redactSecrets: true };
  const redact = makeRedact(() => cfg);
  const fake = "sk-ant-api03-aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmmnnnnoooopppp";
  assert.equal(redact(`chave ${fake}`), "chave [REDACTED]");
  cfg = { ...cfg, redactSecrets: false };
  assert.equal(redact(`chave ${fake}`), `chave ${fake}`);
});

test("escalation: an empty response is recorded, and the retry keeps its budget", async () => {
  const mark = metricsMark();
  const r = await summarizeWithEscalation(
    [{ role: "user", text: "x".repeat(600) }],
    256,
    async () => "",
  );
  assert.equal(r.level, 3);
  const empty = metricsSince(mark).filter(
    (e) => e.kind === "summarizer-error" && e.reason === "empty-response",
  );
  assert.deepEqual(
    empty.map((e) => [e.level, e.maxTokens]),
    [
      [1, 256],
      [2, 256],
    ],
  );
});

test("escalation: a thrown call and an empty response are distinguishable", async () => {
  const mark = metricsMark();
  const r = await summarizeWithEscalation(
    [{ role: "user", text: "x".repeat(600) }],
    256,
    async () => {
      throw new SummarizerFailure("summarizer down", "unavailable");
    },
  );
  assert.equal(r.level, 3);
  const events = metricsSince(mark).filter((e) => e.kind === "summarizer-error");
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.reason),
    ["threw", "threw"],
  );
  assert.deepEqual(
    events.map((e) => e.category),
    ["unavailable", "unavailable"],
  );
  assert.ok(events.every((e) => typeof e.error === "string"));
});

test("escalation: a throw that carries no category records unknown", async () => {
  const mark = metricsMark();
  await summarizeWithEscalation([{ role: "user", text: "x".repeat(600) }], 256, async () => {
    throw new Error("summarizer down");
  });
  const events = metricsSince(mark).filter((e) => e.kind === "summarizer-error");
  assert.deepEqual(
    events.map((e) => e.category),
    ["unknown", "unknown"],
  );
});

test("compaction: a condensed level 3 node is marked, reported, and session-tagged", async () => {
  const s = new LcmStore(":memory:");
  const span: CompactionSpanEntry[] = Array.from({ length: 4 }, (_, i) => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `msg ${i} ${"content ".repeat(50)}`,
  }));
  const mark = metricsMark();
  await storedPass(
    s,
    { span, targetTokens: 200 },
    async () => {
      throw new Error("llm down");
    },
    { leafChunkTokens: 300, session: "sess-cond" },
  );
  const condensed = s.allSummaries().find((n) => n.kind === "condensed");
  assert.ok(condensed, "a condensed node was stored");
  assert.ok(condensed.text.startsWith("[lcm:truncated]\n"), condensed.text.slice(0, 40));

  const events = metricsSince(mark);
  const fallbacks = events.filter((e) => e.kind === "summary-fallback-stored");
  assert.ok(fallbacks.length >= 3, JSON.stringify(events));
  assert.equal(fallbacks[fallbacks.length - 1]!.stage, "condensed");
  assert.equal(fallbacks[0]!.stage, "leaf");
  assert.ok(
    fallbacks.every((e) => e.session === "sess-cond"),
    "every fallback event names its session",
  );

  const summarizerErrors = events.filter((e) => e.kind === "summarizer-error");
  assert.ok(summarizerErrors.length > 0);
  assert.ok(
    summarizerErrors.every((e) => e.session === "sess-cond"),
    "a summarizer failure names its session too",
  );

  const stored = events.filter((e) => e.kind === "summary-stored");
  assert.equal(stored.length, fallbacks.length, "one progress event per stored node");
  const leaves = stored.filter((e) => e.stage === "leaf").length;
  const condensedStored = stored.filter((e) => e.stage === "condensed").length;
  assert.equal(condensedStored, 1);
  const done = events.filter((e) => e.kind === "compaction-complete");
  assert.equal(done.length, 1);
  assert.deepEqual(
    [done[0]!.leaves, done[0]!.condensed, done[0]!.session],
    [leaves, condensedStored, "sess-cond"],
  );
  s.close();
});

test("escalation: an oversized level-1 result becomes the node's rich tier", async () => {
  const thorough = "thorough span detail ".repeat(200).trim();
  const seen: string[] = [];
  const r = await summarizeWithEscalation(
    [{ role: "user", text: "x".repeat(40_000) }],
    100,
    async (systemPrompt) => {
      seen.push(systemPrompt.includes("terse bullet points") ? "level2" : "level1");
      return systemPrompt.includes("terse bullet points") ? "terse summary" : thorough;
    },
    "t",
  );
  assert.deepEqual(seen, ["level1", "level2"]);
  assert.equal(r.level, 2);
  assert.equal(r.text, "terse summary");
  assert.equal(r.retried, true);
  assert.equal(r.thoroughText, thorough, "the thorough text is kept, not discarded");
});

test("store: a node keeps its rich tier, and a describe shows it", () => {
  const s = new LcmStore(":memory:");
  ingestEntries(s, [
    { entryId: "e0", role: "user", text: "one", timestamp: 0 },
    { entryId: "e1", role: "user", text: "two", timestamp: 1 },
  ]);
  const thorough = "thorough ".repeat(100).trim();
  const inserted = s.insertSummary({
    kind: "leaf",
    text: "terse",
    tokens: 2,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e0",
    messageIds: [1],
    thoroughText: thorough,
  });
  assert.ok(inserted.created);
  const node = s.getSummary(inserted.id)!;
  assert.equal(node.text, "terse");
  assert.equal(node.thoroughText, thorough);
  assert.equal(node.thoroughTokens, Math.ceil(thorough.length / 4));
  assert.equal(s.frontier("e0", "e0")[0]!.thoroughText, thorough);

  const view = describeView(s, redactSecrets, inserted.id);
  assert.ok(view.ok);
  if (!view.ok) return;
  assert.ok(
    view.text.includes(`Tiers: thorough ${node.thoroughTokens} tokens (shown), terse 2 tokens`),
  );
  assert.ok(view.text.endsWith(thorough), "the thorough text is what describe returns");
  assert.equal(view.details["tokens"], 2, "the row still reports the stored primary");

  const plain = s.insertSummary({
    kind: "leaf",
    text: "only text",
    tokens: 2,
    depth: 0,
    firstEntryId: "e1",
    lastEntryId: "e1",
  });
  const plainView = describeView(s, redactSecrets, plain.id);
  assert.ok(plainView.ok);
  if (!plainView.ok) return;
  assert.equal(plainView.text.includes("Tiers:"), false);
  s.close();
});
