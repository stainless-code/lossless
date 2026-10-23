import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { estimateTokens } from "../src/estimate-tokens.ts";
import { healSourceBudget, runHeal } from "../src/heal.ts";
import { ingestEntries } from "../src/ingest.ts";
import { SummarizerFailure } from "../src/llm.ts";
import type { LcmMetricRecord, MetricRecord } from "../src/metrics.ts";
import { redactSecrets } from "../src/redact.ts";
import {
  LcmStore,
  type StoredMessage,
  type SummaryNode,
  type SummaryQuality,
} from "../src/store.ts";
import type { LlmComplete } from "../src/summarize.ts";

function storeWithMessages(count: number): { store: LcmStore; messages: StoredMessage[] } {
  const store = new LcmStore(":memory:");
  const entries = Array.from({ length: count }, (_, i) => ({
    entryId: `e${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `SOURCE-${i} ${"z".repeat(700)}`,
    timestamp: i,
  }));
  ingestEntries(store, entries);
  return { store, messages: store.messagesInSpan("e0", `e${count - 1}`) };
}

function insertLeaf(
  store: LcmStore,
  messages: readonly StoredMessage[],
  text: string,
  thoroughText?: string,
  quality?: SummaryQuality,
): number {
  const first = messages[0];
  const last = messages[messages.length - 1];
  assert.ok(first, "a leaf needs a first message");
  assert.ok(last, "a leaf needs a last message");
  return store.insertSummary({
    kind: "leaf",
    text,
    tokens: estimateTokens(text),
    depth: 0,
    firstEntryId: first.entryId,
    lastEntryId: last.entryId,
    ...(quality === undefined ? {} : { quality }),
    messageIds: messages.map((message) => message.id),
    ...(thoroughText === undefined ? {} : { thoroughText }),
  }).id;
}

function insertCondensed(
  store: LcmStore,
  childIds: number[],
  text: string,
  depth: number,
  quality?: SummaryQuality,
): number {
  const children = childIds.map((id) => {
    const child = store.getSummary(id);
    assert.ok(child, `missing child summary ${id}`);
    return child;
  });
  const first = children[0];
  const last = children[children.length - 1];
  assert.ok(first, "a condensed node needs a first child");
  assert.ok(last, "a condensed node needs a last child");
  return store.insertSummary({
    kind: "condensed",
    text,
    tokens: estimateTokens(text),
    depth,
    firstEntryId: first.firstEntryId,
    lastEntryId: last.lastEntryId,
    ...(quality === undefined ? {} : { quality }),
    childSummaryIds: childIds,
  }).id;
}

function scripted(
  reply: (user: string) => string,
  calls: string[] = [],
  rows: MetricRecord[] = [],
): LlmComplete {
  return Object.assign(
    async (_system: string, user: string, _maxTokens: number): Promise<string> => {
      calls.push(user);
      return reply(user);
    },
    { metrics: (row: MetricRecord) => rows.push(row) },
  );
}

function rowsOf<K extends LcmMetricRecord["kind"]>(
  rows: readonly MetricRecord[],
  kind: K,
): Array<Extract<LcmMetricRecord, { kind: K }>> {
  return rows.filter(
    (row): row is Extract<LcmMetricRecord, { kind: K }> => row.event === "lcm" && row.kind === kind,
  );
}

function summary(store: LcmStore, id: number): SummaryNode {
  const node = store.getSummary(id);
  assert.ok(node, `missing summary #${id}`);
  return node;
}

test("heal: the source window derives from the target and stays inside the call budget", () => {
  assert.equal(healSourceBudget({ targetTokens: 1500 }), 12_000);
  assert.equal(healSourceBudget({ targetTokens: 500 }), 4_000);
  assert.equal(healSourceBudget({ targetTokens: 100 }), 3_000);
  assert.equal(healSourceBudget({ targetTokens: 5_000 }), 24_000);
  assert.equal(healSourceBudget({ targetTokens: 1_500, sourceTokens: 20_000 }), 20_000);
  assert.equal(healSourceBudget({ targetTokens: 1_500, sourceTokens: 100_000 }), 24_000);
  assert.equal(
    healSourceBudget({ targetTokens: 1_000, callBudgetTokens: 5_000 }),
    2_976,
    "the request cap reserves the target and prompt",
  );
});

test("heal: a truncated leaf is re-derived from its provenance and its stale rich tier is cleared", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = insertLeaf(
      store,
      messages,
      "[lcm:truncated]\nmechanical",
      "stale rich tier",
      "mechanical",
    );
    const before = summary(store, leaf);
    assert.equal(before.quality, "mechanical");
    const calls: string[] = [];
    const rows: MetricRecord[] = [];
    const llm = scripted(
      (user) =>
        user.includes("SOURCE-0") && user.includes("SOURCE-1") ? "healed leaf" : "unexpected",
      calls,
      rows,
    );

    const outcome = await runHeal(store, { session: "sess-heal", targetTokens: 100 }, llm);

    assert.deepEqual(outcome.repaired, [leaf]);
    assert.equal(outcome.stop, "done");
    assert.equal(outcome.calls, 1);
    const after = summary(store, leaf);
    assert.equal(after.text, "healed leaf");
    assert.equal(after.tokens, estimateTokens("healed leaf"));
    assert.equal(after.quality, "clean", "a successful repair clears the verdict");
    assert.deepEqual(
      [after.kind, after.depth, after.firstEntryId, after.lastEntryId, after.createdAt],
      [before.kind, before.depth, before.firstEntryId, before.lastEntryId, before.createdAt],
    );
    assert.equal("thoroughText" in after, false, "the rich tier described the old source");
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0]!.indexOf("SOURCE-0") < calls[0]!.indexOf("SOURCE-1"),
      "messages reach the model in row order",
    );
    assert.ok(calls[0]!.includes("[user]") && calls[0]!.includes("[assistant]"));

    const start = rowsOf(rows, "heal-start");
    const nodes = rowsOf(rows, "heal-node");
    const complete = rowsOf(rows, "heal-complete");
    assert.equal(start.length, 1, JSON.stringify(rows));
    assert.equal(start[0]!.candidates, 1);
    assert.equal(start[0]!.taintedNodes, 1);
    assert.equal(start[0]!.session, "sess-heal");
    assert.equal(nodes.length, 1);
    assert.deepEqual(
      [nodes[0]!.summaryId, nodes[0]!.outcome, nodes[0]!.levelBefore, nodes[0]!.levelAfter],
      [leaf, "repaired", 3, 1],
    );
    assert.deepEqual([nodes[0]!.qualityBefore, nodes[0]!.qualityAfter], ["mechanical", "clean"]);
    assert.equal(complete.length, 1);
    assert.deepEqual(
      [complete[0]!.repaired, complete[0]!.calls, complete[0]!.stop],
      [1, 1, "done"],
    );
    assert.deepEqual(complete[0]!.repairedIds, [leaf]);
    assert.ok(!JSON.stringify(rows).includes("SOURCE-0"), "no source text in metrics");
    assert.ok(!JSON.stringify(rows).includes("healed leaf"), "no summary text in metrics");
  } finally {
    store.close();
  }
});

test("heal: a clipped source improves a mechanical node but is not called a repair", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = insertLeaf(store, messages, "[lcm:truncated]\nmechanical");
    const rows: MetricRecord[] = [];
    const llm = scripted(() => "healed from clipped source", [], rows);

    const outcome = await runHeal(store, { targetTokens: 100, sourceTokens: 10 }, llm);

    assert.deepEqual(outcome.repaired, []);
    assert.deepEqual(outcome.improved, [leaf]);
    assert.equal(summary(store, leaf).quality, "clipped");
    const nodes = rowsOf(rows, "heal-node");
    assert.equal(nodes[0]?.outcome, "improved");
    assert.equal(nodes[0]?.qualityAfter, "clipped");
    assert.ok(
      rowsOf(rows, "summary-input-clipped").length > 0,
      "the clipped source is visible in the log",
    );
    assert.ok(
      store.taintedSummaries("[lcm:truncated]").some((node) => node.id === leaf),
      "a clipped improvement remains a candidate",
    );
  } finally {
    store.close();
  }
});

test("heal: a whole-node window covers one large source message and stores clean", async () => {
  const store = new LcmStore(":memory:");
  try {
    const text = `large tool result ${"z".repeat(39_000)}`;
    ingestEntries(store, [{ entryId: "e0", role: "toolResult", text, timestamp: 0 }]);
    const message = store.messageByEntryId("e0");
    assert.ok(message);
    const leaf = insertLeaf(store, [message], "[lcm:truncated]\nmechanical");
    const calls: string[] = [];
    const llm = scripted(() => "large source healed", calls);

    const outcome = await runHeal(store, { targetTokens: 1500 }, llm);

    assert.deepEqual(outcome.repaired, [leaf]);
    assert.equal(outcome.sourceTokens, 12_000);
    assert.equal(summary(store, leaf).quality, "clean");
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.includes("large tool result"));
  } finally {
    store.close();
  }
});

test("heal: an oversized source is mapped in windows and reduced once", async () => {
  const store = new LcmStore(":memory:");
  try {
    const text = `start ${"z".repeat(39_000)} end`;
    ingestEntries(store, [{ entryId: "e0", role: "toolResult", text, timestamp: 0 }]);
    const message = store.messageByEntryId("e0");
    assert.ok(message);
    const leaf = insertLeaf(store, [message], "[lcm:truncated]\nmechanical");
    const calls: string[] = [];
    const rows: MetricRecord[] = [];
    const llm = scripted(
      (user) => (user.includes("summary window") ? "reduced result" : "window summary"),
      calls,
      rows,
    );

    const outcome = await runHeal(
      store,
      { targetTokens: 100, sourceTokens: 3_000, maxNodes: 1 },
      llm,
    );

    assert.deepEqual(outcome.repaired, [leaf]);
    assert.equal(outcome.calls, 5, "four map calls plus one reduce");
    assert.equal(calls.length, 5);
    assert.equal(summary(store, leaf).text, "reduced result");
    assert.equal(summary(store, leaf).quality, "clean");
    assert.equal(rowsOf(rows, "summary-input-clipped").length, 0);
  } finally {
    store.close();
  }
});

test("heal: the largest observed source fits eight windows", async () => {
  const store = new LcmStore(":memory:");
  try {
    const text = `${"x ".repeat(353_000)}tail`;
    ingestEntries(store, [{ entryId: "e0", role: "toolResult", text, timestamp: 0 }]);
    const message = store.messageByEntryId("e0");
    assert.ok(message);
    const leaf = insertLeaf(store, [message], "[lcm:truncated]\nmechanical");
    const calls: string[] = [];
    const llm = scripted((user) => (user.includes("summary window") ? "reduced" : "window"), calls);

    const outcome = await runHeal(
      store,
      { targetTokens: 100, sourceTokens: 24_000, maxNodes: 1 },
      llm,
    );

    assert.deepEqual(outcome.repaired, [leaf]);
    assert.equal(outcome.calls, 9, "eight map calls plus one reduce");
    assert.equal(summary(store, leaf).quality, "clean");
  } finally {
    store.close();
  }
});

test("heal: an over-budget window plan falls back to a clipped mechanical attempt", async () => {
  const store = new LcmStore(":memory:");
  try {
    const text = `start ${"z".repeat(100_000)} end`;
    ingestEntries(store, [{ entryId: "e0", role: "toolResult", text, timestamp: 0 }]);
    const message = store.messageByEntryId("e0");
    assert.ok(message);
    const leaf = insertLeaf(store, [message], "[lcm:truncated]\nmechanical");
    const calls: string[] = [];
    const llm = scripted(() => "clipped improvement", calls);

    const outcome = await runHeal(store, { targetTokens: 100, sourceTokens: 1_000 }, llm);

    assert.deepEqual(outcome.repaired, []);
    assert.deepEqual(outcome.improved, [leaf]);
    assert.equal(outcome.calls, 1);
    assert.equal(summary(store, leaf).quality, "clipped");
  } finally {
    store.close();
  }
});

test("heal: a short message does not spend the window a long message needs", async () => {
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(store, [
      { entryId: "e0", role: "toolResult", text: `long ${"z".repeat(39_000)}`, timestamp: 0 },
      { entryId: "e1", role: "user", text: "short follow-up", timestamp: 1 },
    ]);
    const messages = store.messagesInSpan("e0", "e1");
    const leaf = insertLeaf(store, messages, "[lcm:truncated]\nmechanical");
    const calls: string[] = [];
    const llm = scripted(() => "shared window healed", calls);

    const outcome = await runHeal(store, { targetTokens: 1500 }, llm);

    assert.deepEqual(outcome.repaired, [leaf]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.includes("long "));
    assert.ok(calls[0]!.includes("short follow-up"));
    assert.equal(summary(store, leaf).quality, "clean");
  } finally {
    store.close();
  }
});

test("heal: a clipped non-mechanical node is blocked with no call until the window fits", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = insertLeaf(store, messages, "clipped model summary", undefined, "clipped");
    const calls: string[] = [];
    const llm = scripted(() => "healed", calls);

    const first = await runHeal(store, { targetTokens: 100, sourceTokens: 10 }, llm);

    assert.deepEqual(first.repaired, []);
    assert.deepEqual(first.improved, []);
    assert.deepEqual(first.blockedSource, [leaf]);
    assert.deepEqual(first.failed, []);
    assert.equal(first.calls, 0);
    assert.equal(calls.length, 0, "an over-window clipped node is not retried");
    assert.equal(summary(store, leaf).text, "clipped model summary");

    const second = await runHeal(store, { targetTokens: 100, sourceTokens: 3_000 }, llm);

    assert.deepEqual(second.repaired, [leaf]);
    assert.equal(summary(store, leaf).quality, "clean");
    assert.equal(calls.length, 1);
  } finally {
    store.close();
  }
});

test("heal: a source-blocked node does not spend the maxNodes allowance", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = insertLeaf(store, messages, "clipped model summary", undefined, "clipped");
    const parent = insertCondensed(store, [leaf], "[lcm:truncated]\nparent", 1, "mechanical");
    const calls: string[] = [];
    const llm = scripted(() => "parent improved", calls);

    const outcome = await runHeal(store, { targetTokens: 100, sourceTokens: 10, maxNodes: 1 }, llm);

    assert.deepEqual(outcome.blockedSource, [leaf]);
    assert.deepEqual(outcome.improved, [parent]);
    assert.deepEqual(outcome.notAttempted, []);
    assert.equal(outcome.calls, 1);
    assert.equal(calls.length, 1);
    assert.equal(summary(store, parent).text, "parent improved");
  } finally {
    store.close();
  }
});

test("heal: a mechanical node over the window improves once, then is blocked", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = insertLeaf(store, messages, "[lcm:truncated]\nmechanical");
    const calls: string[] = [];
    const llm = scripted(() => "improved but still clipped", calls);

    const first = await runHeal(store, { targetTokens: 100, sourceTokens: 10 }, llm);
    assert.deepEqual(first.improved, [leaf]);
    assert.equal(first.calls, 1);
    assert.equal(summary(store, leaf).quality, "clipped");

    const second = await runHeal(store, { targetTokens: 100, sourceTokens: 10 }, llm);
    assert.deepEqual(second.blockedSource, [leaf]);
    assert.equal(second.calls, 0);
    assert.equal(calls.length, 1, "the same window does not buy another clipped attempt");
  } finally {
    store.close();
  }
});

test("heal: a bounded run repairs mechanical work before a clipped retry", async () => {
  const { store, messages } = storeWithMessages(4);
  try {
    const clipped = store.insertSummary({
      kind: "leaf",
      text: "[lcm:truncated]\nclipped",
      tokens: 5,
      depth: 0,
      quality: "clipped",
      firstEntryId: messages[0]!.entryId,
      lastEntryId: messages[1]!.entryId,
      messageIds: [messages[0]!.id, messages[1]!.id],
    }).id;
    const mechanical = store.insertSummary({
      kind: "leaf",
      text: "[lcm:truncated]\nmechanical",
      tokens: 5,
      depth: 0,
      quality: "mechanical",
      firstEntryId: messages[2]!.entryId,
      lastEntryId: messages[3]!.entryId,
      messageIds: [messages[2]!.id, messages[3]!.id],
    }).id;
    const parent = insertCondensed(store, [clipped, mechanical], "parent", 1);
    const llm = scripted(() => "healed", []);

    const outcome = await runHeal(store, { maxNodes: 1, targetTokens: 100 }, llm);

    assert.deepEqual(outcome.repaired, [mechanical]);
    assert.equal(summary(store, clipped).quality, "clipped");
    assert.equal(summary(store, parent).quality, "derived");
  } finally {
    store.close();
  }
});

test("heal: a clean-looking parent is recomputed from its updated children, then the root", async () => {
  const { store, messages } = storeWithMessages(6);
  try {
    const leafA = insertLeaf(
      store,
      messages.slice(0, 2),
      "[lcm:truncated]\nmechanical leaf A",
      undefined,
      "mechanical",
    );
    const leafB = insertLeaf(
      store,
      messages.slice(2, 4),
      "[lcm:truncated]\nmechanical leaf B",
      undefined,
      "mechanical",
    );
    const parent = insertCondensed(store, [leafA, leafB], "parent old", 1);
    const leafC = insertLeaf(store, messages.slice(4, 6), "clean leaf C");
    const root = insertCondensed(store, [parent, leafC], "root old", 2);
    const calls: string[] = [];
    const llm = scripted((user) => {
      if (user.includes("SOURCE-0")) return "leaf-A-healed";
      if (user.includes("SOURCE-2")) return "leaf-B-healed";
      if (user.includes("leaf-A-healed") && user.includes("leaf-B-healed")) {
        return "parent-healed";
      }
      if (user.includes("parent-healed")) return "root-healed";
      return "unexpected";
    }, calls);

    const outcome = await runHeal(store, { targetTokens: 100 }, llm);

    assert.deepEqual(outcome.repaired, [leafA, leafB, parent, root]);
    assert.equal(outcome.calls, 4);
    assert.equal(
      summary(store, parent).text,
      "parent-healed",
      "the parent saw both repaired children",
    );
    assert.equal(summary(store, root).text, "root-healed", "the served root was recomputed last");
    assert.deepEqual(
      store.frontier("e0", "e5").map((node) => [node.id, node.text]),
      [[root, "root-healed"]],
      "the projection serves the repaired root",
    );
    const parentCall = calls.find((call) => call.includes("leaf-A-healed"));
    assert.ok(parentCall);
    assert.ok(parentCall.includes("leaf-B-healed"));
    assert.ok(!parentCall.includes("mechanical leaf"), "no old child text reached the parent");
    const rootCall = calls.find((call) => call.includes("parent-healed"));
    assert.ok(rootCall);
    assert.ok(!rootCall.includes("parent old"));
  } finally {
    store.close();
  }
});

test("heal: a clean node is never replaced by a level-3 result, and its parent waits", async () => {
  const { store, messages } = storeWithMessages(4);
  try {
    const leaf = insertLeaf(
      store,
      messages.slice(0, 2),
      "[lcm:truncated]\nmechanical",
      undefined,
      "mechanical",
    );
    const parent = insertCondensed(store, [leaf], "parent old", 1);
    const leafC = insertLeaf(store, messages.slice(2, 4), "clean leaf C");
    const root = insertCondensed(store, [parent, leafC], "root old", 2);
    const calls: string[] = [];
    const llm = scripted((user) => {
      if (user.includes("SOURCE-0")) return "leaf healed";
      throw new Error("summarizer down");
    }, calls);

    const outcome = await runHeal(store, { targetTokens: 100 }, llm);

    assert.deepEqual(outcome.repaired, [leaf]);
    assert.deepEqual(outcome.failed, [parent]);
    assert.deepEqual(outcome.blocked, [root]);
    assert.equal(summary(store, leaf).text, "leaf healed");
    assert.equal(
      summary(store, parent).text,
      "parent old",
      "a mechanical answer keeps the old text",
    );
    assert.equal(summary(store, parent).quality, "derived", "the failed parent stays a retry seed");
    assert.equal(summary(store, root).text, "root old");
    assert.equal(summary(store, root).quality, "clean", "the blocked root was not rewritten");
    const failed = outcome.nodes.find((node) => node.id === parent);
    assert.equal(failed?.reason, "level-3");
    assert.equal(failed?.afterTokens, null);
    assert.equal(calls.length, 3, "the leaf's call plus the parent's two ladder attempts");
  } finally {
    store.close();
  }
});

test("heal: an answer that echoes the mechanical marker is rejected, not stored as clean", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = insertLeaf(store, messages, "[lcm:truncated]\nmechanical");
    const calls: string[] = [];
    const llm = scripted(() => "[lcm:truncated]\nmodel echoed the marker", calls);

    const outcome = await runHeal(store, { targetTokens: 100 }, llm);

    assert.deepEqual(outcome.failed, [leaf]);
    assert.equal(outcome.nodes.find((node) => node.id === leaf)?.reason, "mechanical-prefix");
    assert.equal(summary(store, leaf).text, "[lcm:truncated]\nmechanical");
  } finally {
    store.close();
  }
});

test("heal: a failed clean parent stays derived and the next run finds it", async () => {
  const { store, messages } = storeWithMessages(4);
  try {
    const leaf = insertLeaf(
      store,
      messages.slice(0, 2),
      "[lcm:truncated]\nmechanical",
      undefined,
      "mechanical",
    );
    const cleanLeaf = insertLeaf(store, messages.slice(2, 4), "clean leaf C");
    const parent = insertCondensed(store, [leaf], "parent old", 1);
    const root = insertCondensed(store, [parent, cleanLeaf], "root old", 2);
    const calls: string[] = [];
    let parentAttempts = 0;
    const leafHealed = `leaf-healed ${"x".repeat(200)}`;
    const parentHealed = `parent-healed ${"y".repeat(100)}`;
    const llm = scripted((user) => {
      if (user.includes("SOURCE-0")) return leafHealed;
      if (user.includes("leaf-healed")) {
        parentAttempts++;
        if (parentAttempts <= 2) throw new Error("summarizer down");
        return parentHealed;
      }
      if (user.includes("parent-healed")) return "root-healed";
      return "unexpected";
    }, calls);

    const first = await runHeal(store, { targetTokens: 100 }, llm);

    assert.deepEqual(first.repaired, [leaf]);
    assert.deepEqual(first.failed, [parent]);
    assert.equal(summary(store, parent).text, "parent old");
    assert.equal(
      summary(store, parent).quality,
      "derived",
      "the failed parent is now the durable seed",
    );
    assert.equal(summary(store, root).quality, "clean");

    const second = await runHeal(store, { targetTokens: 100 }, llm);

    assert.deepEqual(
      second.repaired,
      [parent, root],
      "the derived parent is found without a prefix",
    );
    assert.equal(summary(store, parent).text, parentHealed);
    assert.equal(summary(store, parent).quality, "clean");
    assert.equal(summary(store, root).text, "root-healed");
    assert.equal(summary(store, root).quality, "clean");
  } finally {
    store.close();
  }
});

test("heal: missing provenance fails the node and blocks its ancestors without a model call", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = store.insertSummary({
      kind: "leaf",
      text: "[lcm:truncated]\nmechanical",
      tokens: 5,
      depth: 0,
      firstEntryId: messages[0]!.entryId,
      lastEntryId: messages[1]!.entryId,
    }).id;
    const parent = insertCondensed(store, [leaf], "parent old", 1);
    const calls: string[] = [];
    const llm = scripted(() => "never", calls);

    const outcome = await runHeal(store, { targetTokens: 100 }, llm);

    assert.deepEqual(outcome.repaired, []);
    assert.deepEqual(outcome.failed, [leaf]);
    assert.deepEqual(outcome.blocked, [parent]);
    assert.equal(outcome.calls, 0);
    assert.equal(calls.length, 0, "no source means no provider call");
    assert.equal(outcome.nodes.find((node) => node.id === leaf)?.reason, "no-source");
    assert.equal(summary(store, parent).text, "parent old");
  } finally {
    store.close();
  }
});

test("heal: dry run reports the candidate graph and makes zero calls", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = insertLeaf(store, messages, "[lcm:truncated]\nmechanical");
    const parent = insertCondensed(store, [leaf], "parent old", 1);
    const calls: string[] = [];
    const llm = scripted(() => "never", calls);

    const outcome = await runHeal(store, { dryRun: true }, llm);

    assert.equal(outcome.stop, "dry-run");
    assert.equal(outcome.calls, 0);
    assert.equal(outcome.tokens, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(outcome.nodes, []);
    assert.deepEqual(
      outcome.candidates.map((candidate) => [candidate.id, candidate.tainted, candidate.parents]),
      [
        [leaf, true, [parent]],
        [parent, false, []],
      ],
    );
    assert.deepEqual(outcome.counts, {
      candidates: 2,
      tainted: 1,
      attempted: 0,
      repaired: 0,
      improved: 0,
      failed: 0,
      blocked: 0,
      blockedSource: 0,
      skipped: 0,
      changed: 0,
      notAttempted: 0,
    });
  } finally {
    store.close();
  }
});

test("heal: maxNodes stops before the next repair and reports what was left", async () => {
  const { store, messages } = storeWithMessages(4);
  try {
    const first = insertLeaf(store, messages.slice(0, 2), "[lcm:truncated]\nfirst");
    const second = insertLeaf(store, messages.slice(2, 4), "[lcm:truncated]\nsecond");
    const calls: string[] = [];
    const llm = scripted(
      (user) => (user.includes("SOURCE-0") ? "first healed" : "second healed"),
      calls,
    );

    const outcome = await runHeal(store, { maxNodes: 1, targetTokens: 100 }, llm);

    assert.equal(outcome.stop, "max-nodes");
    assert.deepEqual(outcome.repaired, [first]);
    assert.deepEqual(outcome.notAttempted, [second]);
    assert.equal(outcome.calls, 1);
    assert.equal(calls.length, 1);
    assert.equal(summary(store, second).text, "[lcm:truncated]\nsecond");
  } finally {
    store.close();
  }
});

test("heal: maxCalls stops before a call is made and leaves the remaining node alone", async () => {
  const { store, messages } = storeWithMessages(4);
  try {
    const first = insertLeaf(store, messages.slice(0, 2), "[lcm:truncated]\nfirst");
    const second = insertLeaf(store, messages.slice(2, 4), "[lcm:truncated]\nsecond");
    const calls: string[] = [];
    const llm = scripted(
      (user) => (user.includes("SOURCE-0") ? "first healed" : "second healed"),
      calls,
    );

    const outcome = await runHeal(store, { maxCalls: 1, targetTokens: 100 }, llm);

    assert.equal(outcome.stop, "max-calls");
    assert.deepEqual(outcome.repaired, [first]);
    assert.deepEqual(outcome.notAttempted, [second]);
    assert.equal(outcome.calls, 1);
    assert.equal(calls.length, 1);
    assert.equal(summary(store, second).text, "[lcm:truncated]\nsecond");
  } finally {
    store.close();
  }
});

test("heal: a failed child blocks its parent instead of rebuilding it from incomplete children", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = insertLeaf(store, messages, "[lcm:truncated]\nmechanical");
    const parent = insertCondensed(store, [leaf], "parent old", 1);
    const calls: string[] = [];
    const llm = scripted(() => {
      throw new Error("summarizer down");
    }, calls);

    const outcome = await runHeal(store, { targetTokens: 100 }, llm);

    assert.deepEqual(outcome.failed, [leaf]);
    assert.deepEqual(outcome.blocked, [parent]);
    assert.equal(calls.length, 2, "the leaf spent both ladder attempts");
    assert.ok(
      calls.every((call) => call.includes("SOURCE-0")),
      "the parent was never asked",
    );
    assert.equal(summary(store, parent).text, "parent old");
  } finally {
    store.close();
  }
});

test("heal: a concurrent text change is not clobbered, and its parent waits", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = insertLeaf(store, messages, "[lcm:truncated]\nmechanical");
    const parent = insertCondensed(store, [leaf], "parent old", 1);
    const llm = scripted(() => {
      store.updateSummaryText(leaf, "changed by another writer", 7);
      return "healed leaf";
    }, []);

    const outcome = await runHeal(store, { targetTokens: 100 }, llm);

    assert.deepEqual(outcome.changed, [leaf]);
    assert.deepEqual(outcome.repaired, []);
    assert.deepEqual(outcome.blocked, [parent]);
    assert.equal(summary(store, leaf).text, "changed by another writer");
    assert.equal(summary(store, leaf).tokens, 7);
    assert.equal(summary(store, parent).text, "parent old");
    assert.equal(
      summary(store, parent).quality,
      "derived",
      "the parent is marked for the next run",
    );
  } finally {
    store.close();
  }
});

test("heal: a capped completer stops the run instead of making every node mechanical", async () => {
  const { store, messages } = storeWithMessages(4);
  try {
    const first = insertLeaf(store, messages.slice(0, 2), "[lcm:truncated]\nfirst");
    const second = insertLeaf(store, messages.slice(2, 4), "[lcm:truncated]\nsecond");
    const calls: string[] = [];
    const llm = scripted(() => {
      throw new SummarizerFailure("provider capped the pass", "capped");
    }, calls);

    const outcome = await runHeal(store, { targetTokens: 100 }, llm);

    assert.equal(outcome.stop, "llm-capped");
    assert.deepEqual(outcome.failed, [first]);
    assert.deepEqual(outcome.notAttempted, [second]);
    assert.equal(calls.length, 1, "the capped completer is not asked again");
    assert.equal(outcome.nodes.find((node) => node.id === first)?.reason, "llm-capped");
    assert.equal(summary(store, first).text, "[lcm:truncated]\nfirst");
    assert.equal(summary(store, second).text, "[lcm:truncated]\nsecond");
  } finally {
    store.close();
  }
});

test("heal: the token budget refuses an over-budget call and keeps the old text", async () => {
  const { store, messages } = storeWithMessages(2);
  try {
    const leaf = insertLeaf(store, messages, "[lcm:truncated]\nmechanical");
    const calls: string[] = [];
    const llm = scripted(() => "healed", calls);

    const outcome = await runHeal(store, { targetTokens: 100, maxTokens: 1 }, llm);

    assert.equal(outcome.stop, "token-budget");
    assert.deepEqual(outcome.failed, [leaf]);
    assert.equal(outcome.calls, 0);
    assert.equal(calls.length, 0, "the over-budget request never reached the provider");
    assert.equal(outcome.nodes.find((node) => node.id === leaf)?.reason, "token-budget");
    assert.equal(summary(store, leaf).text, "[lcm:truncated]\nmechanical");
  } finally {
    store.close();
  }
});

test("heal: a leaf source uses the file handle and mask a compaction leaf would", async () => {
  const store = new LcmStore(":memory:");
  const secret = `sk-${"a".repeat(24)}`;
  try {
    const body = `notes\n${secret}\n${"z".repeat(2000)}`;
    ingestEntries(
      store,
      [
        {
          entryId: "e0",
          role: "toolResult",
          text: body,
          timestamp: 0,
          fileHint: { path: "/x/notes.txt" },
        },
      ],
      { externalize: { largeFileChars: 10 } },
    );
    const message = store.messageByEntryId("e0");
    assert.ok(message);
    const leaf = insertLeaf(store, [message], "[lcm:truncated]\nmechanical");
    const calls: string[] = [];
    const llm = scripted(() => "file healed", calls);

    const outcome = await runHeal(store, { targetTokens: 100, redact: redactSecrets }, llm);
    assert.deepEqual(outcome.repaired, [leaf]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.includes("[lcm:file /x/notes.txt"), calls[0]!);
    assert.ok(calls[0]!.includes("[REDACTED]"));
    assert.ok(!calls[0]!.includes(secret), "the stored body is masked on its way to the model");
    assert.equal(store.messageByEntryId("e0")?.text, body, "heal never rewrites the message store");
  } finally {
    store.close();
  }
});
