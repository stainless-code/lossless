import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "vite-plus/test";

import { renderFrontier } from "../src/assembly.ts";
import { MAX_DAG_FANOUT, condensationGroup, runCompaction } from "../src/compaction-engine.ts";
import type { CompactionSpanEntry } from "../src/compaction-engine.ts";
import { estimateTokens } from "../src/estimate-tokens.ts";
import { ingestEntries } from "../src/ingest.ts";
import { metricsPath } from "../src/metrics.ts";
import { LcmStore } from "../src/store.ts";
import type { SummaryNode } from "../src/store.ts";
import { storedPass } from "./support/pass-outcome.ts";

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

test("store: frontier finds the single leaf a small span produces; a missing anchor yields nothing", async () => {
  const s = new LcmStore(":memory:");
  const span: CompactionSpanEntry[] = Array.from({ length: 4 }, (_, i) => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: "x".repeat(500),
  }));
  const llm = async (_p: string, conv: string) => conv.slice(0, Math.floor(conv.length / 4));
  const outcome = await storedPass(s, { span, targetTokens: 300 }, llm);
  assert.deepEqual(outcome.leafSummaryIds, [1]);
  assert.deepEqual(outcome.condensedSummaryIds, []);
  const [found, ...rest] = s.frontier("e0", "e3");
  assert.deepEqual(rest, []);
  assert.ok(found, "summary ending at last span entry must exist");
  assert.equal(found.id, 1);
  assert.equal(found.kind, "leaf");
  assert.equal(found.depth, 0);
  assert.equal(found.firstEntryId, "e0");
  assert.equal(found.lastEntryId, "e3");
  assert.deepEqual(s.frontier("e0", "e99"), []);
  s.close();
});

test("engine: an anchor the store holds no row for renders the pass's own frontier", async () => {
  const s = new LcmStore(":memory:");
  const span: CompactionSpanEntry[] = Array.from({ length: 4 }, (_, i) => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: "x".repeat(500),
  }));
  const llm = async (_p: string, conv: string) => conv.slice(0, Math.floor(conv.length / 4));
  const outcome = await runCompaction(
    s,
    { span, previousSummary: "older memory", frontierFrom: "missing" },
    llm,
  );
  assert.equal(s.stats().summaries, 1, "the leaf was written");
  assert.equal(outcome.kind, "stored");
  const text = outcome.kind === "stored" ? outcome.summaryText : "";
  assert.ok(text.startsWith("older memory\n\n"), text);
  assert.match(text, /\[lcm:summary #1 depth 0 span e0\.\.e3\]/);
  assert.deepEqual(outcome.kind === "stored" ? outcome.leafSummaryIds : [], [1]);
  s.close();
});

test("store: coveredMessageIds walks condensed → leaf → messages", async () => {
  const s = new LcmStore(":memory:");
  ingestEntries(s, [
    { entryId: "a", role: "user", text: "alpha", timestamp: 1 },
    { entryId: "b", role: "user", text: "beta", timestamp: 2 },
  ]);
  const msgs = s.messagesInSpan("a", "b");
  const leaf = s.insertSummary({
    kind: "leaf",
    text: "leaf1",
    tokens: 2,
    depth: 0,
    firstEntryId: "a",
    lastEntryId: "b",
    messageIds: msgs.map((m) => m.id),
  }).id;
  const condensed = s.insertSummary({
    kind: "condensed",
    text: "condensed",
    tokens: 2,
    depth: 1,
    firstEntryId: "a",
    lastEntryId: "b",
    childSummaryIds: [leaf],
  }).id;
  const covered = s.coveredMessageIds(condensed);
  assert.equal(covered.length, 2);
  const expanded = s.messagesByIds(covered);
  assert.deepEqual(
    expanded.map((m) => m.text),
    ["alpha", "beta"],
  );
  s.close();
});

test("store: coveredMessageIds reports a shared leaf once", () => {
  const s = new LcmStore(":memory:");
  ingestEntries(s, [{ entryId: "e0", role: "user", text: "shared", timestamp: 0 }]);
  const messageIds = s.messagesInSpan("e0", "e0").map((m) => m.id);
  const leaf = s.insertSummary({
    kind: "leaf",
    text: "leaf",
    tokens: 1,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e0",
    messageIds,
  }).id;
  // Two parents over one leaf: the schema allows it, so an import can carry it.
  const left = s.insertSummary({
    kind: "condensed",
    text: "left",
    tokens: 1,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e0",
    childSummaryIds: [leaf],
  }).id;
  const right = s.insertSummary({
    kind: "condensed",
    text: "right",
    tokens: 1,
    depth: 1,
    firstEntryId: "r0",
    lastEntryId: "r0",
    childSummaryIds: [leaf],
  }).id;
  const root = s.insertSummary({
    kind: "condensed",
    text: "root",
    tokens: 1,
    depth: 2,
    firstEntryId: "r1",
    lastEntryId: "r1",
    childSummaryIds: [left, right],
  }).id;
  assert.deepEqual(s.coveredMessageIds(root), messageIds, "a shared leaf is reported once");
  s.close();
});

test("store: coveredMessageIds walks past the DAG depth cap and survives a cycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-walk-"));
  const s = new LcmStore(join(dir, "store.db"));
  try {
    ingestEntries(s, [{ entryId: "e0", role: "user", text: "deep", timestamp: 0 }]);
    const messageIds = s.messagesInSpan("e0", "e0").map((m) => m.id);
    let node = s.insertSummary({
      kind: "leaf",
      text: "l0",
      tokens: 1,
      depth: 0,
      firstEntryId: "e0",
      lastEntryId: "e0",
      messageIds,
    }).id;
    // Deeper than MAX_DAG_DEPTH, the shape a foreign export can carry.
    for (let depth = 1; depth <= 12; depth++) {
      node = s.insertSummary({
        kind: "condensed",
        text: `l${depth}`,
        tokens: 1,
        depth,
        firstEntryId: `s${depth}`,
        lastEntryId: `s${depth}`,
        childSummaryIds: [node],
      }).id;
    }
    assert.deepEqual(s.coveredMessageIds(node), messageIds, "a deep chain walks to its messages");
    const raw = new DatabaseSync(join(dir, "store.db"));
    raw
      .prepare("INSERT INTO provenance (summary_id, child_type, child_id) VALUES (?, 'summary', ?)")
      .run(node, node);
    raw.close();
    assert.deepEqual(
      s.coveredMessageIds(node),
      messageIds,
      "a self-referencing node does not recurse forever",
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compaction: maxChunks bounds LLM call count", async () => {
  const s = new LcmStore(":memory:");
  const span: CompactionSpanEntry[] = Array.from({ length: 40 }, (_, i) => ({
    entryId: `e${i}`,
    role: "user",
    text: "y".repeat(2000),
  }));
  let calls = 0;
  const llm = async (_p: string, conv: string) => {
    calls++;
    return conv.slice(0, 500);
  };
  const outcome = await storedPass(s, { span, targetTokens: 300 }, llm, { maxChunks: 5 });
  assert.equal(calls, 5);
  assert.deepEqual(outcome.leafSummaryIds, [1, 2, 3, 4]);
  assert.deepEqual(outcome.condensedSummaryIds, [5]);
  assert.deepEqual(
    outcome.leafSummaryIds.map((id) => {
      const leaf = s.getSummary(id)!;
      return [leaf.firstEntryId, leaf.lastEntryId];
    }),
    [
      ["e0", "e11"],
      ["e12", "e23"],
      ["e24", "e35"],
      ["e36", "e39"],
    ],
  );
  const condensed = s.getSummary(5)!;
  assert.equal(condensed.kind, "condensed");
  assert.equal(condensed.depth, 1);
  assert.equal(condensed.firstEntryId, "e0");
  assert.equal(condensed.lastEntryId, "e39");
  s.close();
});

function sixMessages(s: LcmStore): void {
  ingestEntries(
    s,
    Array.from({ length: 6 }, (_, i) => ({
      entryId: `e${i}`,
      role: "user" as const,
      text: `message ${i}`,
      timestamp: i + 1,
    })),
  );
}

function leafOver(s: LcmStore, first: string, last: string, text = `${first}..${last}`): number {
  return s.insertSummary({
    kind: "leaf",
    text,
    tokens: 4,
    depth: 0,
    firstEntryId: first,
    lastEntryId: last,
    messageIds: s.messagesInSpan(first, last).map((m) => m.id),
  }).id;
}

test("store: uncoveredMessagesInSpan skips messages a leaf already covers, keeps holes", () => {
  const s = new LcmStore(":memory:");
  sixMessages(s);
  leafOver(s, "e0", "e1");
  leafOver(s, "e3", "e3");
  assert.deepEqual(
    s.uncoveredMessagesInSpan("e0", "e5").map((m) => m.entryId),
    ["e2", "e4", "e5"],
  );
  assert.deepEqual(s.uncoveredMessagesInSpan("e0", "e1"), []);
  assert.deepEqual(
    s.uncoveredMessagesInSpan("e4", "e5").map((m) => m.entryId),
    ["e4", "e5"],
  );
  s.close();
});

test("store: frontier is the minimal top-level cover of a span, in order", () => {
  const s = new LcmStore(":memory:");
  sixMessages(s);
  const l1 = leafOver(s, "e0", "e1");
  const l2 = leafOver(s, "e2", "e3");
  const l3 = leafOver(s, "e4", "e4");
  assert.deepEqual(
    s.frontier("e0", "e5").map((n) => n.id),
    [l1, l2, l3],
  );
  const c1 = s.insertSummary({
    kind: "condensed",
    text: "e0..e3",
    tokens: 3,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e3",
    childSummaryIds: [l1, l2],
  }).id;
  assert.deepEqual(
    s.frontier("e0", "e5").map((n) => [n.id, n.depth]),
    [
      [c1, 1],
      [l3, 0],
    ],
  );
  assert.deepEqual(
    s.frontier("e4", "e5").map((n) => n.id),
    [l3],
  );
  assert.deepEqual(s.frontier("e5", "e5"), []);
  s.close();
});

test("store: frontier drops legacy overlapping nodes that share no provenance", () => {
  // A legacy node from whole-span recompaction: condensed over a growing prefix,
  // with no parent links to the nodes it overlaps. Dropping it keeps the cover
  // non-nested, or a condensation group retries an insert the span index refuses.
  const s = new LcmStore(":memory:");
  sixMessages(s);
  const small = s.insertSummary({
    kind: "condensed",
    text: "e0..e2",
    tokens: 3,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e2",
  }).id;
  const big = s.insertSummary({
    kind: "condensed",
    text: "e0..e4",
    tokens: 3,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e4",
  }).id;
  assert.notEqual(small, big);
  assert.deepEqual(
    s.frontier("e0", "e5").map((n) => n.id),
    [big],
    "the longer node over the same start wins and the nested one is dropped",
  );
  s.close();
});

function syntheticNode(id: number, depth: number, position: number): SummaryNode {
  return {
    id,
    kind: "leaf",
    text: `node ${id}`,
    tokens: 2,
    depth,
    firstEntryId: `s${position}`,
    lastEntryId: `s${position}`,
    createdAt: 0,
  };
}

function syntheticRun(depth: number, count: number, start: number): SummaryNode[] {
  return Array.from({ length: count }, (_, i) => syntheticNode(start + i, depth, start + i));
}

function depthsOf(nodes: readonly SummaryNode[] | undefined): number[] {
  return [...new Set((nodes ?? []).map((n) => n.depth))];
}

test("dag: condensation takes the shallowest same-depth run, never a mixed pair", () => {
  const leaves = condensationGroup(syntheticRun(0, 25, 1));
  assert.equal(leaves?.length, MAX_DAG_FANOUT);
  assert.deepEqual(depthsOf(leaves), [0]);
  assert.deepEqual(
    leaves?.map((n) => n.id),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );

  const mixed = condensationGroup([syntheticNode(100, 8, 1), ...syntheticRun(0, 25, 2)]);
  assert.deepEqual(depthsOf(mixed), [0]);
  assert.ok(!(mixed ?? []).some((n) => n.id === 100));

  assert.equal(
    condensationGroup([
      syntheticNode(1, 3, 1),
      syntheticNode(2, 2, 2),
      syntheticNode(3, 1, 3),
      syntheticNode(4, 0, 4),
    ]),
    undefined,
  );

  assert.deepEqual(
    depthsOf(condensationGroup([...syntheticRun(5, 3, 1), ...syntheticRun(0, 2, 4)])),
    [0],
  );

  assert.deepEqual(
    depthsOf(condensationGroup([syntheticNode(1, 0, 1), ...syntheticRun(1, 3, 2)])),
    [1],
  );
});

test("compaction: the depth cap filters groups and records the stall", async () => {
  const s = new LcmStore(":memory:");
  const mark = metricsMark();
  await balancedTreePass(s, 600, 120, { maxDepth: 1 });
  assert.ok(
    s.allSummaries().every((n) => n.depth <= 1),
    "no node deeper than the injected cap",
  );
  const stalls = metricsSince(mark).filter((m) => m.kind === "condensation-stalled");
  assert.equal(stalls.length, 1);
  const stall = stalls[0]!;
  assert.equal(stall.cap, 1);
  assert.equal(stall.reason, "depth-cap");
  assert.equal(stall.targetTokens, 120);
  assert.equal(stall.frontierTokens, estimateTokens(renderFrontier(s.frontier("e0", "e599"))));
  assert.ok(Number(stall.frontierTokens) > 120, "a stall only reports while over budget");
  assert.ok(Number(stall.nodes) >= 2);
  s.close();
});

test("compaction: a lone frontier node over budget reports why it stopped", async () => {
  const s = new LcmStore(":memory:");
  const mark = metricsMark();
  await balancedTreePass(s, 600, 0);
  const stalls = metricsSince(mark).filter((m) => m.kind === "condensation-stalled");
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0]?.reason, "no-same-depth-run");
  assert.equal(stalls[0]?.nodes, 1);
  assert.equal(stalls[0]?.cap, 8);
  s.close();
});

test("compaction: a balanced tree never approaches the default depth cap", async () => {
  const s = new LcmStore(":memory:");
  const mark = metricsMark();
  await balancedTreePass(s, 1000, 300);
  const depths = s.allSummaries().map((n) => n.depth);
  assert.ok(Math.max(...depths) <= 4, `deepest node ${Math.max(...depths)} stays well under 8`);
  assert.deepEqual(
    metricsSince(mark).filter((m) => m.kind === "condensation-stalled"),
    [],
  );
  s.close();
});

test("compaction: a span the store already holds is reported and one better retry replaces it", async () => {
  const s = new LcmStore(":memory:");
  sixMessages(s);
  const stale = s.insertSummary({
    kind: "leaf",
    text: "stale and long ".repeat(20),
    tokens: 40,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e5",
  }).id;
  const mark = metricsMark();
  const outcome = await storedPass(
    s,
    { span: sixSpan(), targetTokens: 100_000 },
    async () => "short",
    { leafChunkTokens: 100_000, session: "t" },
  );
  const events = metricsSince(mark);
  const skipped = events.filter((m) => m.kind === "summary-skipped-existing");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.stage, "leaf");
  assert.equal(skipped[0]?.depth, 0);
  assert.deepEqual(skipped[0]?.span, ["e0", "e5"]);
  assert.equal(skipped[0]?.existingTokens, 40, "the size comes from the stored row");
  assert.ok(Number(skipped[0]?.attemptedTokens) < 40);
  const replaced = events.filter((m) => m.kind === "summary-replaced");
  assert.equal(replaced.length, 1);
  assert.deepEqual(
    [replaced[0]?.summaryId, replaced[0]?.beforeTokens, replaced[0]?.afterTokens],
    [stale, 40, skipped[0]?.attemptedTokens],
  );
  assert.equal(s.getSummary(stale)?.text, "short");
  assert.equal(s.stats().summaries, 1, "no row was added");
  assert.deepEqual(outcome.leafSummaryIds, [stale]);
  assert.equal(events.filter((m) => m.kind === "summary-stored").length, 0);
  assert.deepEqual(
    events.filter((m) => m.kind === "summary-fallback-stored"),
    [],
  );
  s.close();
});

test("compaction: a parented node is not rewritten under its parent", async () => {
  const s = new LcmStore(":memory:");
  sixMessages(s);
  const stale = s.insertSummary({
    kind: "leaf",
    text: "stale and long ".repeat(20),
    tokens: 40,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e5",
  }).id;
  s.insertSummary({
    kind: "condensed",
    text: "parent",
    tokens: 50,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e5",
    childSummaryIds: [stale],
  });
  const mark = metricsMark();
  const outcome = await storedPass(
    s,
    { span: sixSpan(), targetTokens: 100_000 },
    async () => "short",
    { leafChunkTokens: 100_000, session: "t" },
  );
  const events = metricsSince(mark);
  assert.equal(events.filter((m) => m.kind === "summary-skipped-existing").length, 1);
  assert.equal(events.filter((m) => m.kind === "summary-replaced").length, 0);
  assert.equal(s.getSummary(stale)?.text, "stale and long ".repeat(20));
  assert.deepEqual(outcome.leafSummaryIds, []);
  s.close();
});

test("compaction: a condensed insert refused mid-pass is replaced and reported as a fallback", async () => {
  const s = new LcmStore(":memory:");
  sixMessages(s);
  const messages = s.uncoveredMessagesInSpan("e0", "e5").map((m) => m.id);
  s.insertSummary({
    kind: "leaf",
    text: "left",
    tokens: 300,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e2",
    messageIds: messages.slice(0, 3),
  });
  s.insertSummary({
    kind: "leaf",
    text: "right",
    tokens: 300,
    depth: 0,
    firstEntryId: "e3",
    lastEntryId: "e5",
    messageIds: messages.slice(3),
  });
  const mark = metricsMark();
  let raced = false;
  await storedPass(
    s,
    { span: sixSpan(), targetTokens: 10 },
    async () => {
      if (!raced) {
        raced = true;
        s.insertSummary({
          kind: "condensed",
          text: "stale ".repeat(100),
          tokens: 300,
          depth: 1,
          firstEntryId: "e0",
          lastEntryId: "e5",
        });
      }
      throw new Error("summarizer down");
    },
    { leafChunkTokens: 100_000, session: "t" },
  );
  const events = metricsSince(mark);
  const replaced = events.filter((m) => m.kind === "summary-replaced");
  assert.equal(replaced.length, 1, JSON.stringify(events));
  assert.equal(replaced[0]?.stage, "condensed");
  const fallbacks = events.filter((m) => m.kind === "summary-fallback-stored");
  assert.equal(fallbacks.length, 1, JSON.stringify(events));
  assert.equal(fallbacks[0]?.stage, "condensed");
  s.close();
});

test("compaction: a lone over-budget node is re-summarized smaller in place", async () => {
  const s = new LcmStore(":memory:");
  sixMessages(s);
  const leaf = s.insertSummary({
    kind: "leaf",
    text: "leaf text",
    tokens: 4,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e5",
    messageIds: s.uncoveredMessagesInSpan("e0", "e5").map((m) => m.id),
  }).id;
  const node = s.insertSummary({
    kind: "condensed",
    text: "long ".repeat(2000),
    tokens: 2500,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e5",
    childSummaryIds: [leaf],
  }).id;
  const terse = "terse ".repeat(40).trim();
  const mark = metricsMark();
  let calls = 0;
  await storedPass(
    s,
    { span: sixSpan(), targetTokens: 500 },
    async () => {
      calls++;
      return terse;
    },
    { leafChunkTokens: 100_000, session: "t" },
  );
  const events = metricsSince(mark);
  const reduced = events.filter((m) => m.kind === "condensation-reduced");
  assert.equal(reduced.length, 1);
  assert.deepEqual([reduced[0]?.summaryId, reduced[0]?.depth, reduced[0]?.level], [node, 1, 2]);
  assert.equal(calls, 1);
  assert.equal(reduced[0]?.beforeTokens, 2500);
  assert.equal(reduced[0]?.afterTokens, estimateTokens(terse));
  assert.equal(s.getSummary(node)?.text, terse);
  assert.equal(s.getSummary(node)?.tokens, estimateTokens(terse));
  assert.equal(s.stats().summaries, 2, "no row was added");
  const replaced = events.filter((m) => m.kind === "summary-replaced");
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]?.stage, "condensed");
  assert.deepEqual(
    events.filter((m) => m.kind === "summary-final-truncated"),
    [],
  );
  assert.deepEqual(
    events.filter((m) => m.kind === "condensation-stalled"),
    [],
  );
  s.close();
});

test("compaction: a lone node whose re-summary is not smaller records the stall", async () => {
  const s = new LcmStore(":memory:");
  sixMessages(s);
  const leaf = s.insertSummary({
    kind: "leaf",
    text: "leaf text",
    tokens: 4,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e5",
    messageIds: s.uncoveredMessagesInSpan("e0", "e5").map((m) => m.id),
  }).id;
  const text = "long ".repeat(400);
  const node = s.insertSummary({
    kind: "condensed",
    text,
    tokens: 500,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e5",
    childSummaryIds: [leaf],
  }).id;
  const mark = metricsMark();
  let calls = 0;
  await storedPass(
    s,
    { span: sixSpan(), targetTokens: 100 },
    async () => {
      calls++;
      return text;
    },
    { leafChunkTokens: 100_000, session: "t" },
  );
  const events = metricsSince(mark);
  assert.equal(calls, 1);
  assert.deepEqual(
    events.filter((m) => m.kind === "condensation-reduced"),
    [],
  );
  assert.deepEqual(
    events.filter((m) => m.kind === "summary-replaced"),
    [],
  );
  const stalls = events.filter((m) => m.kind === "condensation-stalled");
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0]?.reason, "no-same-depth-run");
  assert.equal(stalls[0]?.nodes, 1);
  assert.equal(s.getSummary(node)?.text, text, "the row was not rewritten");
  s.close();
});

test("compaction: a terse re-summary that grows the node falls to the truncate", async () => {
  const s = new LcmStore(":memory:");
  sixMessages(s);
  const leaf = s.insertSummary({
    kind: "leaf",
    text: "leaf text",
    tokens: 4,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e5",
    messageIds: s.uncoveredMessagesInSpan("e0", "e5").map((m) => m.id),
  }).id;
  const node = s.insertSummary({
    kind: "condensed",
    text: "long ".repeat(2000),
    tokens: 2500,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e5",
    childSummaryIds: [leaf],
  }).id;
  const mark = metricsMark();
  let calls = 0;
  await storedPass(
    s,
    { span: sixSpan(), targetTokens: 500 },
    async () => {
      calls++;
      return "long ".repeat(3000);
    },
    { leafChunkTokens: 100_000, session: "t" },
  );
  const events = metricsSince(mark);
  assert.equal(calls, 1, "an answer that grows the node is not retried");
  const reduced = events.filter((m) => m.kind === "condensation-reduced");
  assert.equal(reduced.length, 1);
  assert.equal(reduced[0]?.level, 3);
  const after = reduced[0]?.afterTokens;
  assert.ok(typeof after === "number" && after < 2500 * 0.75);
  assert.ok(s.getSummary(node)?.text.startsWith("[lcm:truncated]"), "the truncate is tagged");
  assert.equal(events.filter((m) => m.kind === "summary-replaced").length, 1);
  const fallbacks = events.filter((m) => m.kind === "summary-fallback-stored");
  assert.equal(fallbacks.length, 1, JSON.stringify(events));
  assert.equal(fallbacks[0]?.stage, "condensed");
  s.close();
});

test("compaction: a replayed span stores nothing the second time", async () => {
  const s = new LcmStore(":memory:");
  const mark = metricsMark();
  const first = await balancedTreePass(s, 600, 300);
  const rowsAfterFirst = s.stats().summaries;
  const second = await balancedTreePass(s, 600, 300);
  const events = metricsSince(mark);
  const stored = events.filter((m) => m.kind === "summary-stored");
  assert.equal(stored.length, first.leafSummaryIds.length + first.condensedSummaryIds.length);
  assert.equal(s.stats().summaries, rowsAfterFirst, "replay adds no rows");
  assert.deepEqual(second.leafSummaryIds, []);
  assert.deepEqual(second.condensedSummaryIds, []);
  s.close();
});

test("metrics: every summary-stored record matches a row, and no row is unrecorded", async () => {
  const s = new LcmStore(":memory:");
  const mark = metricsMark();
  await balancedTreePass(s, 600, 300);
  await balancedTreePass(s, 600, 300);
  const stored = metricsSince(mark).filter((m) => m.kind === "summary-stored");
  const rows = s.allSummaries();
  assert.equal(stored.length, rows.length, "one record per row");
  const tokensById = new Map(rows.map((r) => [r.id, r.tokens]));
  for (const record of stored) {
    assert.equal(
      Number(record.summaryId) > 0 && tokensById.get(Number(record.summaryId)),
      record.tokens,
      `#${String(record.summaryId)} reports the tokens the row holds`,
    );
  }
  s.close();
});

test("compaction: a final text over twice the target is recorded, not just clipped", async () => {
  const s = new LcmStore(":memory:");
  const span: CompactionSpanEntry[] = Array.from({ length: 2 }, (_, i) => ({
    entryId: `e${i}`,
    role: "user",
    text: "w".repeat(4000),
  }));
  const mark = metricsMark();
  const outcome = await storedPass(
    s,
    { span, targetTokens: 200 },
    async (_p, conv) => conv.slice(0, Math.floor(conv.length / 2)),
    { leafChunkTokens: 4000, session: "t" },
  );
  const events = metricsSince(mark).filter((m) => m.kind === "summary-final-truncated");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.stage, "direct");
  assert.deepEqual(events[0]!.span, ["e0", "e1"]);
  const after = Number(events[0]!.afterTokens);
  assert.ok(
    Number(events[0]!.beforeTokens) > 400,
    `before ${String(events[0]!.beforeTokens)} was over budget`,
  );
  assert.ok(after <= 200, `after ${after} is at or below the 200-token target`);
  assert.ok(outcome.summaryText.includes("[…truncated…]"));
  s.close();
});

test("compaction: a pass whose frontier fits records no final truncation", async () => {
  const s = new LcmStore(":memory:");
  const mark = metricsMark();
  await balancedTreePass(s, 600, 300);
  assert.deepEqual(
    metricsSince(mark).filter((m) => m.kind === "summary-final-truncated"),
    [],
  );
  s.close();
});

test("compaction: a message over the chunk budget is clipped for the summarizer only", async () => {
  const s = new LcmStore(":memory:");
  const huge = "h".repeat(200_000);
  const mark = metricsMark();
  let seen = "";
  const outcome = await storedPass(
    s,
    { span: [{ entryId: "h0", role: "user", text: huge }], targetTokens: 100_000 },
    async (_p, conv) => {
      seen = conv;
      return "short summary";
    },
    { leafChunkTokens: 3000, session: "t" },
  );
  const leaf = s.getSummary(outcome.leafSummaryIds[0]!)!;
  assert.deepEqual([leaf.firstEntryId, leaf.lastEntryId], ["h0", "h0"]);
  assert.equal(leaf.tokens, estimateTokens("short summary"));
  const clipped = metricsSince(mark).filter((m) => m.kind === "summary-input-clipped");
  assert.equal(clipped.length, 1);
  assert.deepEqual(
    [clipped[0]!.entryId, clipped[0]!.keptChars, clipped[0]!.droppedChars, clipped[0]!.session],
    ["h0", 12_000, 188_000, "t"],
  );
  assert.ok(seen.includes("h".repeat(12_000)), "the prefix is in the summarizer input");
  assert.ok(!seen.includes("h".repeat(12_001)), "nothing past the cap is");
  assert.ok(seen.includes("kept 12000 of 200000 chars"), "the marker carries the arithmetic");
  assert.ok(
    seen.includes("entry h0 is stored verbatim and lcm_expand_query can read it"),
    "the marker says where the rest is",
  );
  assert.equal(s.messagesInSpan("h0", "h0")[0]!.text.length, 200_000);
  s.close();
});

test("store: coveredSize sums a DAG without loading message text, and entrySpan bounds the store", () => {
  const s = new LcmStore(":memory:");
  assert.equal(s.entrySpan(), undefined);
  assert.equal(s.messageCount(), 0);
  ingestEntries(
    s,
    Array.from({ length: 4 }, (_, i) => ({
      entryId: `e${i}`,
      role: "user" as const,
      text: "x".repeat(400),
      timestamp: i,
    })),
  );
  assert.deepEqual(s.entrySpan(), { first: "e0", last: "e3" });
  assert.equal(s.messageCount(), 4);
  const leaf = (first: string, last: string) =>
    s.insertSummary({
      kind: "leaf",
      text: "leaf",
      tokens: 5,
      depth: 0,
      firstEntryId: first,
      lastEntryId: last,
      messageIds: s.messagesInSpan(first, last).map((m) => m.id),
    }).id;
  const left = leaf("e0", "e1");
  const right = leaf("e2", "e3");
  const top = s.insertSummary({
    kind: "condensed",
    text: "top",
    tokens: 7,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e3",
    childSummaryIds: [left, right],
  }).id;
  assert.deepEqual(s.coveredSize(left), { tokens: 200, messages: 2 });
  assert.deepEqual(s.coveredSize(top), { tokens: 400, messages: 4 });
  assert.deepEqual(s.coveredSize(999), { tokens: 0, messages: 0 });
  s.close();
});

test("compaction: ordinary messages are not clipped and chunk exactly as before", async () => {
  const s = new LcmStore(":memory:");
  const mark = metricsMark();
  const span: CompactionSpanEntry[] = Array.from({ length: 40 }, (_, i) => ({
    entryId: `e${i}`,
    role: "user",
    text: "y".repeat(2000),
  }));
  await storedPass(s, { span, targetTokens: 300 }, async (_p, conv) => conv.slice(0, 500), {
    leafChunkTokens: 3000,
    maxChunks: 5,
    session: "t",
  });
  assert.deepEqual(
    metricsSince(mark).filter((m) => m.kind === "summary-input-clipped"),
    [],
    "nothing under the cap is clipped",
  );
  assert.deepEqual(
    s
      .allSummaries()
      .filter((n) => n.depth === 0)
      .map((n) => [n.firstEntryId, n.lastEntryId]),
    [
      ["e0", "e11"],
      ["e12", "e23"],
      ["e24", "e35"],
      ["e36", "e39"],
    ],
  );
  s.close();
});

async function balancedTreePass(
  s: LcmStore,
  count: number,
  targetTokens = 300,
  opts?: { maxDepth?: number },
) {
  const span: CompactionSpanEntry[] = Array.from({ length: count }, (_, i) => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: "z".repeat(500),
  }));
  const llm = async () => "s".repeat(200);
  return storedPass(s, { span, targetTokens }, llm, { leafChunkTokens: 2000, ...opts });
}

test("compaction: a pass builds a balanced tree, not a vine", async () => {
  const s = new LcmStore(":memory:");
  const outcome = await balancedTreePass(s, 600);
  for (const node of s.allSummaries()) {
    const children = s.childSummaryIds(node.id);
    if (children.length === 0) continue;
    assert.ok(children.length >= 2, `node ${node.id} condensed ${children.length} child`);
    assert.ok(
      children.length <= MAX_DAG_FANOUT,
      `node ${node.id} took ${children.length} children`,
    );
    assert.deepEqual(
      new Set(children.map((id) => s.getSummary(id)?.depth)).size,
      1,
      `node ${node.id} mixes child depths`,
    );
  }
  const frontier = s.frontier("e0", "e599");
  const frontierTok = estimateTokens(renderFrontier(frontier));
  const leafTok = outcome.leafSummaryIds.reduce((n, id) => n + (s.getSummary(id)?.tokens ?? 0), 0);
  assert.ok(frontierTok <= 300, `frontier ${frontierTok} fits the 300-token target`);
  assert.ok(
    frontierTok < leafTok,
    `frontier ${frontierTok} is smaller than the ${leafTok} leaf tokens`,
  );

  const again = await balancedTreePass(s, 600);
  assert.deepEqual(again.leafSummaryIds, []);
  assert.deepEqual(again.condensedSummaryIds, []);
  assert.equal(estimateTokens(renderFrontier(s.frontier("e0", "e599"))), frontierTok);
  s.close();
});

test("dag: a middle already claimed by another pass is not re-summarized", async () => {
  const s = new LcmStore(":memory:");
  sixMessages(s);
  let once = false;
  const llm = async (_p: string, conv: string) => {
    if (!once) {
      once = true;
      leafOver(s, "e4", "e5", "claimed elsewhere");
    }
    return conv.slice(0, 20);
  };
  const outcome = await storedPass(s, { span: sixSpan(), targetTokens: 100_000 }, llm, {
    leafChunkTokens: 100_000,
  });
  assert.deepEqual(
    outcome.leafSummaryIds.map((id) => {
      const node = s.getSummary(id)!;
      return [node.firstEntryId, node.lastEntryId];
    }),
    [["e0", "e3"]],
  );
  const claims = new Map<number, number>();
  for (const node of s.allSummaries()) {
    if (node.kind !== "leaf") continue;
    for (const id of s.coveredMessageIds(node.id)) claims.set(id, (claims.get(id) ?? 0) + 1);
  }
  assert.deepEqual(
    [...claims.values()].filter((n) => n > 1),
    [],
    "no message is claimed twice",
  );
  s.close();
});

test("dag: a chunk fully claimed elsewhere is skipped and recorded", async () => {
  const s = new LcmStore(":memory:");
  sixMessages(s);
  let claimed = false;
  const llm = async (_p: string, conv: string) => {
    if (!claimed) {
      claimed = true;
      leafOver(s, "e0", "e5", "claimed elsewhere");
    }
    return conv.slice(0, 20);
  };
  const mark = metricsMark();
  const outcome = await storedPass(s, { span: sixSpan(), targetTokens: 100_000 }, llm, {
    leafChunkTokens: 100_000,
  });
  assert.deepEqual(outcome.leafSummaryIds, []);
  const skipped = metricsSince(mark).filter((m) => m.kind === "summary-skipped-covered");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.stage, "leaf");
  s.close();
});

function sixSpan(): CompactionSpanEntry[] {
  return Array.from({ length: 6 }, (_, i) => ({
    entryId: `e${i}`,
    role: "user" as const,
    text: `message ${i}`,
  }));
}

test("dag: two overlapping passes leave every message claimed at most once", async () => {
  const s = new LcmStore(":memory:");
  const span: CompactionSpanEntry[] = Array.from({ length: 120 }, (_, i) => ({
    entryId: `e${i}`,
    role: "user",
    text: `message ${i} `.padEnd(200, "z"),
  }));
  // An await inside every call is what lets the two passes interleave.
  const llm = async (_p: string, conv: string) => conv.slice(0, 20);
  const slice = (from: number, to: number) => span.slice(from, to);
  // Boundaries deliberately misaligned: 43 is off A's 8-message grid, so the
  // same span-unique index cannot absorb the overlap the way it absorbs two
  // passes that chunk identically.
  await Promise.all([
    runCompaction(s, { span: slice(0, 80), targetTokens: 100_000 }, llm, { leafChunkTokens: 400 }),
    runCompaction(s, { span: slice(43, 120), targetTokens: 100_000 }, llm, {
      leafChunkTokens: 400,
    }),
  ]);
  const claims = new Map<number, string[]>();
  for (const node of s.allSummaries()) {
    if (node.kind !== "leaf") continue;
    for (const id of s.coveredMessageIds(node.id)) {
      claims.set(id, [
        ...(claims.get(id) ?? []),
        `#${node.id} ${node.firstEntryId}..${node.lastEntryId}`,
      ]);
    }
  }
  const doubled = [...claims.entries()].filter(([, owners]) => owners.length > 1);
  assert.deepEqual(doubled, [], "no message carried by two leaves");
  for (let i = 0; i < 120; i++) {
    const m = s.messagesInSpan(`e${i}`, `e${i}`)[0];
    assert.ok(m && claims.has(m.id), `message ${i} is covered`);
  }
  s.close();
});

test("store: stats reports real db bytes (page_count × page_size)", () => {
  // dbBytes is what the file occupies once the WAL is checkpointed at close.
  const dir = mkdtempSync(join(tmpdir(), "lcm-bytes-"));
  const path = join(dir, "s.db");
  try {
    const s = new LcmStore(path);
    ingestEntries(
      s,
      Array.from({ length: 40 }, (_, i) => ({
        entryId: `e${i}`,
        role: "user",
        text: "y".repeat(2000),
        timestamp: i,
      })),
    );
    const reported = s.stats().dbBytes;
    s.close();
    assert.ok(reported > 40 * 2000, `${reported} bytes covers the 80 KB of text`);
    assert.equal(reported, statSync(path).size);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
