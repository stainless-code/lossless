import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { runCompaction } from "../src/compaction-engine.ts";
import { estimateTokens } from "../src/estimate-tokens.ts";
import { runHeal } from "../src/heal.ts";
import { ingestEntries } from "../src/ingest.ts";
import { checkIntegrity } from "../src/integrity.ts";
import { describeView } from "../src/recall-view.ts";
import { LcmStore, TRUNCATED_SUMMARY_PREFIX } from "../src/store.ts";
import type { LlmComplete } from "../src/summarize.ts";
import {
  isMechanicalToolMessage,
  mechanicalToolNameOf,
  normalizeMechanicalTools,
} from "../src/util/summarizer-config.ts";
import { storedPass } from "./support/pass-outcome.ts";

function countingLlm(reply: () => string, calls: string[]): LlmComplete {
  return Object.assign(
    async (_system: string, user: string, _max: number): Promise<string> => {
      calls.push(user);
      return reply();
    },
    { metrics: () => {} },
  );
}

test("mechanical config: names normalize and match the stored renderings", () => {
  assert.deepEqual(normalizeMechanicalTools([" Read ", "read", "", "BASH"]), ["read", "bash"]);
  assert.deepEqual(normalizeMechanicalTools(undefined), []);
  assert.equal(mechanicalToolNameOf({ text: `tool read {"path":"/x"}\nbody` }), "read");
  assert.equal(mechanicalToolNameOf({ text: `[tool:bash] {"cmd":"ls"}` }), "bash");
  assert.equal(mechanicalToolNameOf({ text: `tool-call: grep pattern` }), "grep");
  assert.equal(mechanicalToolNameOf({ text: "plain prose" }), undefined);
  assert.equal(isMechanicalToolMessage({ text: `tool read {"p":1}\nbody` }, ["read"]), true);
  assert.equal(isMechanicalToolMessage({ text: `tool read {"p":1}\nbody` }, ["bash"]), false);
  assert.equal(isMechanicalToolMessage({ text: "plain" }, ["read"]), false);
  assert.equal(isMechanicalToolMessage({ text: `tool read {}\nbody` }, []), false);
});

test("mechanical tier: a noisy span compacts with zero summarizer calls", async () => {
  const store = new LcmStore(":memory:");
  try {
    const span = [
      {
        entryId: "e0",
        role: "toolResult" as const,
        text: `tool noisy-read {"path":"/a"}\n${"x".repeat(2000)}`,
      },
      {
        entryId: "e1",
        role: "toolResult" as const,
        text: `tool noisy-read {"path":"/b"}\n${"y".repeat(2000)}`,
      },
    ];
    const calls: string[] = [];
    const outcome = await storedPass(
      store,
      { span, targetTokens: 1500, mechanicalTools: ["noisy-read"] },
      countingLlm(() => "must not run", calls),
    );
    assert.equal(calls.length, 0, "the skip path makes no model call");
    assert.equal(outcome.leafSummaryIds.length, 1);
    const leaf = store.getSummary(outcome.leafSummaryIds[0]!);
    assert.ok(leaf);
    assert.equal(leaf.quality, "mechanical");
    assert.ok(leaf.text.startsWith(`${TRUNCATED_SUMMARY_PREFIX}\n`), leaf.text.slice(0, 40));
    assert.deepEqual(store.uncoveredMessagesInSpan("e0", "e1"), []);
    const report = checkIntegrity(store);
    assert.ok(
      !report.findings.some((f) => f.kind === "coverage"),
      `coverage stays complete: ${JSON.stringify(report.findings)}`,
    );
    assert.equal(store.stats().messages, 2, "ingest keeps every message");
  } finally {
    store.close();
  }
});

test("mechanical tier: mixed spans isolate noisy leaves and still call once for prose", async () => {
  const store = new LcmStore(":memory:");
  try {
    const span = [
      { entryId: "e0", role: "user" as const, text: `decide the plan ${"x".repeat(400)}` },
      {
        entryId: "e1",
        role: "toolResult" as const,
        text: `tool noisy-read {}\n${"z".repeat(3000)}`,
      },
    ];
    const calls: string[] = [];
    const outcome = await storedPass(
      store,
      { span, targetTokens: 1500, mechanicalTools: ["noisy-read"] },
      countingLlm(() => "prose summary", calls),
      { leafChunkTokens: 100_000 },
    );
    assert.equal(calls.length, 1, "only the prose chunk pays for a call");
    assert.ok(calls[0]!.includes("decide the plan"));
    assert.ok(!calls[0]!.includes("noisy-read"), "the noisy body never reaches the model");
    const leaves = outcome.leafSummaryIds.map((id) => store.getSummary(id)!);
    assert.equal(leaves.length, 2);
    assert.deepEqual(
      leaves.map((l) => [l.firstEntryId, l.quality]),
      [
        ["e0", "clean"],
        ["e1", "mechanical"],
      ],
    );
    assert.deepEqual(store.uncoveredMessagesInSpan("e0", "e1"), []);
  } finally {
    store.close();
  }
});

test("mechanical tier: quoted markers are not tool traffic", () => {
  assert.equal(
    isMechanicalToolMessage({ text: "I saw [tool:noisy] in the docs", role: "user" }, ["noisy"]),
    false,
  );
  assert.equal(
    isMechanicalToolMessage(
      { text: "note: the log said tool-call: noisy mid-line", role: "assistant" },
      ["noisy"],
    ),
    false,
  );
  assert.equal(
    isMechanicalToolMessage(
      { text: 'Why this is safe.\n[tool:noisy] {"path":"/a"}', role: "assistant" },
      ["noisy"],
    ),
    false,
  );
  assert.equal(
    isMechanicalToolMessage({ text: '[tool:noisy] {"path":"/a"}', role: "assistant" }, ["noisy"]),
    true,
  );
});

test("mechanical tier: mixed prose plus noisy call stays on the summarizer path", async () => {
  const store = new LcmStore(":memory:");
  try {
    const prose = "Here is why the migration is safe";
    const span = [
      {
        entryId: "e0",
        role: "assistant" as const,
        text: `${prose}.\n[tool:noisy-read] {"path":"/a"}`,
      },
    ];
    const calls: string[] = [];
    const outcome = await storedPass(
      store,
      { span, targetTokens: 1500, mechanicalTools: ["noisy-read"] },
      countingLlm(() => "prose summary", calls),
    );
    assert.equal(calls.length, 1, "mixed prose falls back to the model path");
    assert.ok(calls[0]!.includes(prose));
    const leaf = store.getSummary(outcome.leafSummaryIds[0]!);
    assert.ok(leaf);
    assert.equal(leaf.quality, "clean");
    assert.deepEqual(store.uncoveredMessagesInSpan("e0", "e0"), []);
  } finally {
    store.close();
  }
});

test("mechanical tier: alternating spans keep leaf work within maxChunks", async () => {
  const store = new LcmStore(":memory:");
  try {
    const span = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? {
            entryId: `e${i}`,
            role: "user" as const,
            text: `ordinary question ${i} ${"p".repeat(50)}`,
          }
        : {
            entryId: `e${i}`,
            role: "toolResult" as const,
            text: `tool noisy-read {"n":${i}}}\n${"z".repeat(200)}`,
          },
    );
    const calls: string[] = [];
    const outcome = await storedPass(
      store,
      { span, targetTokens: 1500, mechanicalTools: ["noisy-read"] },
      countingLlm(() => "summary", calls),
      { leafChunkTokens: 100_000, maxChunks: 4 },
    );
    assert.ok(calls.length <= 4, `leaf attempts stay capped, got ${calls.length}`);
    assert.ok(outcome.leafSummaryIds.length <= 4);
    assert.deepEqual(store.uncoveredMessagesInSpan("e0", "e19"), []);
  } finally {
    store.close();
  }
});

test("mechanical tier: alternating over-cap spans never prompt noisy bodies", async () => {
  const store = new LcmStore(":memory:");
  try {
    const span = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? {
            entryId: `e${i}`,
            role: "user" as const,
            text: `ORDINARY-${i} ${"p".repeat(50)}`,
          }
        : {
            entryId: `e${i}`,
            role: "toolResult" as const,
            text: `tool noisy-read {"n":${i}}\nNOISY-BODY-${i} ${"z".repeat(200)}`,
          },
    );
    const calls: string[] = [];
    const outcome = await storedPass(
      store,
      { span, targetTokens: 1500, mechanicalTools: ["noisy-read"] },
      countingLlm(() => "summary", calls),
      { leafChunkTokens: 100_000, maxChunks: 4 },
    );
    assert.ok(calls.length >= 1 && calls.length <= 4, `bounded attempts, got ${calls.length}`);
    assert.ok(outcome.leafSummaryIds.length <= 4);
    for (const prompt of calls) {
      assert.ok(!prompt.includes("NOISY-BODY"), `noisy body leaked: ${prompt.slice(0, 120)}`);
      assert.ok(!prompt.includes("noisy-read"), `noisy marker leaked: ${prompt.slice(0, 120)}`);
    }
    const joined = calls.join("\n");
    for (let i = 0; i < 20; i += 2) {
      assert.ok(joined.includes(`ORDINARY-${i}`), `ordinary ${i} reaches a prompt`);
    }
    const allIds = store
      .allMessages()
      .map((m) => m.id)
      .sort((a, b) => a - b);
    const covered: number[] = [];
    for (const id of outcome.leafSummaryIds) covered.push(...store.summarySources(id).messages);
    assert.deepEqual(
      [...covered].sort((a, b) => a - b),
      allIds,
    );
    assert.equal(new Set(covered).size, allIds.length, "no double summary");
    assert.deepEqual(store.uncoveredMessagesInSpan("e0", "e19"), []);
    const frontier = store.frontier("e0", "e19");
    assert.deepEqual(
      frontier.map((n) => n.id),
      outcome.leafSummaryIds,
    );
    assert.deepEqual(
      frontier.map((n) => n.firstEntryId),
      ["e0", "e5", "e10", "e15"],
    );
  } finally {
    store.close();
  }
});

test("mechanical tier: a Pi result follows its call onto the skip path", async () => {
  const store = new LcmStore(":memory:");
  try {
    const span = [
      { entryId: "e0", role: "assistant" as const, text: `[tool:noisy] {"path":"/a"}` },
      { entryId: "e1", role: "toolResult" as const, text: `large output ${"w".repeat(2000)}` },
    ];
    const calls: string[] = [];
    const outcome = await storedPass(
      store,
      { span, targetTokens: 1500, mechanicalTools: ["noisy"] },
      countingLlm(() => "must not run", calls),
    );
    assert.equal(calls.length, 0);
    assert.equal(outcome.leafSummaryIds.length, 1);
    assert.equal(store.getSummary(outcome.leafSummaryIds[0]!)?.quality, "mechanical");
  } finally {
    store.close();
  }
});

test("mechanical tier: heal restores a skipped leaf from provenance on demand", async () => {
  const store = new LcmStore(":memory:");
  try {
    const span = [
      {
        entryId: "e0",
        role: "toolResult" as const,
        text: `tool noisy-read {}\nSOURCE-BODY ${"q".repeat(500)}`,
      },
    ];
    const calls: string[] = [];
    const compacted = await storedPass(
      store,
      { span, targetTokens: 1500, mechanicalTools: ["noisy-read"] },
      countingLlm(() => "must not run", calls),
    );
    const leafId = compacted.leafSummaryIds[0]!;
    assert.equal(store.getSummary(leafId)?.quality, "mechanical");
    const healCalls: string[] = [];
    const healLlm: LlmComplete = Object.assign(
      async (_system: string, user: string, _max: number): Promise<string> => {
        healCalls.push(user);
        return "healed summary";
      },
      { metrics: () => {} },
    );
    const healed = await runHeal(store, { targetTokens: 100 }, healLlm);
    assert.deepEqual(healed.repaired, [leafId]);
    assert.equal(healCalls.length, 1);
    assert.ok(healCalls[0]!.includes("SOURCE-BODY"));
    const after = store.getSummary(leafId)!;
    assert.equal(after.text, "healed summary");
    assert.equal(after.quality, "clean");
    assert.equal(after.tokens, estimateTokens("healed summary"));
  } finally {
    store.close();
  }
});

test("mechanical tier: without the list the same span pays for a call", async () => {
  const store = new LcmStore(":memory:");
  try {
    const span = [
      {
        entryId: "e0",
        role: "toolResult" as const,
        text: `tool noisy-read {}\n${"x".repeat(500)}`,
      },
    ];
    const calls: string[] = [];
    await storedPass(
      store,
      { span, targetTokens: 1500 },
      countingLlm(() => "summary", calls),
    );
    assert.equal(calls.length, 1);
  } finally {
    store.close();
  }
});

test("mechanical tier: a lone fallback node without the list still pays for the terse path", async () => {
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(
      store,
      Array.from({ length: 6 }, (_, i) => ({
        entryId: `e${i}`,
        role: "user" as const,
        text: `message ${i}`,
        timestamp: i + 1,
      })),
    );
    const messageIds = store.uncoveredMessagesInSpan("e0", "e5").map((m) => m.id);
    const leaf = store.insertSummary({
      kind: "leaf",
      text: "leaf text",
      tokens: 4,
      depth: 0,
      firstEntryId: "e0",
      lastEntryId: "e5",
      messageIds,
    }).id;
    // A level-3 fallback from before the tier existed: mechanical by verdict
    // and by the stored prefix, with no opted-in tool behind it.
    const node = store.insertSummary({
      kind: "condensed",
      text: `${TRUNCATED_SUMMARY_PREFIX}\n${"long ".repeat(2000)}`,
      tokens: 2500,
      depth: 1,
      quality: "mechanical",
      firstEntryId: "e0",
      lastEntryId: "e5",
      childSummaryIds: [leaf],
    }).id;
    const terse = "terse ".repeat(40).trim();
    const calls: string[] = [];
    const span = Array.from({ length: 6 }, (_, i) => ({
      entryId: `e${i}`,
      role: "user" as const,
      text: `message ${i}`,
    }));
    const outcome = await storedPass(
      store,
      { span, targetTokens: 500 },
      countingLlm(() => terse, calls),
      { leafChunkTokens: 100_000 },
    );
    assert.equal(calls.length, 1, "the empty list keeps the terse re-summarize");
    assert.equal(store.getSummary(node)?.text, terse);
    assert.deepEqual(outcome.condensedSummaryIds, []);
  } finally {
    store.close();
  }
});

test("mechanical tier: opts carry the list when the input does not", async () => {
  const store = new LcmStore(":memory:");
  try {
    const span = [
      {
        entryId: "e0",
        role: "toolResult" as const,
        text: `tool noisy-read {}\n${"x".repeat(500)}`,
      },
    ];
    const calls: string[] = [];
    const outcome = await runCompaction(
      store,
      { span, targetTokens: 1500 },
      countingLlm(() => "must not run", calls),
      { mechanicalTools: ["noisy-read"] },
    );
    assert.equal(outcome.kind, "stored");
    assert.equal(calls.length, 0);
  } finally {
    store.close();
  }
});

test("mechanical tier: merged mixed leaves stay clipped and heal restores detail", async () => {
  const store = new LcmStore(":memory:");
  try {
    const span = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? {
            entryId: `e${i}`,
            role: "user" as const,
            text: `ORDINARY-${i} ${"p".repeat(50)}`,
          }
        : {
            entryId: `e${i}`,
            role: "toolResult" as const,
            text: `tool noisy-read {"n":${i}}\nNOISY-BODY-${i} ${"z".repeat(200)}`,
          },
    );
    const calls: string[] = [];
    const outcome = await storedPass(
      store,
      { span, targetTokens: 1500, mechanicalTools: ["noisy-read"] },
      countingLlm(() => "summary", calls),
      { leafChunkTokens: 100_000, maxChunks: 4 },
    );
    assert.ok(calls.length >= 1 && calls.length <= 4, `bounded attempts, got ${calls.length}`);
    for (const prompt of calls) {
      assert.ok(!prompt.includes("NOISY-BODY"), "noisy body never reaches a model call");
      assert.ok(!prompt.includes("noisy-read"), "noisy marker never reaches a model call");
    }
    const joined = calls.join("\n");
    for (let i = 0; i < 20; i += 2) {
      assert.ok(joined.includes(`ORDINARY-${i}`), `ordinary ${i} reaches a prompt`);
    }
    const leaves = outcome.leafSummaryIds.map((id) => store.getSummary(id)!);
    assert.ok(leaves.length <= 4);
    for (const leaf of leaves) {
      assert.equal(leaf.quality, "clipped", "a mixed leaf never reads as clean");
    }
    const allIds = store
      .allMessages()
      .map((m) => m.id)
      .sort((a, b) => a - b);
    const covered: number[] = [];
    for (const id of outcome.leafSummaryIds) covered.push(...store.summarySources(id).messages);
    assert.deepEqual(
      [...covered].sort((a, b) => a - b),
      allIds,
      "every message stays in exactly one leaf",
    );
    assert.equal(new Set(covered).size, allIds.length, "no double summary");
    assert.deepEqual(store.uncoveredMessagesInSpan("e0", "e19"), []);
    const view = describeView(store, (t) => t, leaves[0]!.id);
    assert.ok(view.ok);
    if (!view.ok) return;
    assert.ok(view.text.includes("Quality: clipped"), view.text);
    assert.equal(view.details["quality"], "clipped");
    const healCalls: string[] = [];
    const healLlm: LlmComplete = Object.assign(
      async (_system: string, user: string, _max: number): Promise<string> => {
        healCalls.push(user);
        return "healed summary";
      },
      { metrics: () => {} },
    );
    const healed = await runHeal(store, { targetTokens: 100 }, healLlm);
    assert.deepEqual(
      [...healed.repaired].sort((a, b) => a - b),
      [...outcome.leafSummaryIds].sort((a, b) => a - b),
    );
    assert.ok(healCalls.length >= 1);
    assert.ok(
      healCalls.join("\n").includes("NOISY-BODY"),
      "heal reads the full rows including noisy text",
    );
    for (const id of outcome.leafSummaryIds) {
      assert.equal(store.getSummary(id)?.quality, "clean");
    }
  } finally {
    store.close();
  }
});
