import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { test, vi } from "vite-plus/test";

import type { CompactionSpanEntry } from "../src/compaction-engine.ts";
import type { ModelAnswer, Usage } from "../src/host.ts";
import { ingestEntries } from "../src/ingest.ts";
import { makeLlm, resetSummarizerState } from "../src/llm.ts";
import { metricsPath } from "../src/metrics.ts";
import type { LcmMetricRecord, MetricRecord } from "../src/metrics.ts";
import { LcmStore } from "../src/store.ts";
import type { LlmComplete } from "../src/summarize.ts";
import { scriptedHost } from "./support/fake-host.ts";
import { storedPass } from "./support/pass-outcome.ts";

function metricsMark(): number {
  try {
    return readFileSync(metricsPath(), "utf8").length;
  } catch {
    return 0;
  }
}

function metricsSince(mark: number): Array<Record<string, unknown>> {
  let raw = "";
  try {
    raw = readFileSync(metricsPath(), "utf8").slice(mark).trim();
  } catch {
    return [];
  }
  return raw ? raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

function collected<K extends LcmMetricRecord["kind"]>(
  rows: readonly MetricRecord[],
  kind: K,
): Array<Extract<LcmMetricRecord, { kind: K }>> {
  return rows.filter(
    (row): row is Extract<LcmMetricRecord, { kind: K }> => row.event === "lcm" && row.kind === kind,
  );
}

function spanOf(count: number, chars: number): CompactionSpanEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    entryId: `e${i}`,
    role: "user" as const,
    text: `message ${i} `.padEnd(chars, "z"),
  }));
}

function answer(text: string, usage?: Usage): ModelAnswer {
  return { outcome: "answer", text, stop: "stop", usage };
}

function llmWithSink(reply: () => string, rows: MetricRecord[]): LlmComplete {
  return Object.assign(async () => reply(), {
    metrics: (record: MetricRecord) => rows.push(record),
  });
}

const BILLED: Usage = {
  input: 1200,
  output: 300,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1500,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

test("metrics: makeLlm routes every row to the injected sink, not the log", async () => {
  resetSummarizerState();
  const rows: MetricRecord[] = [];
  const { host } = scriptedHost(
    {
      "a/one": new Error("429 rate limit exceeded"),
      "b/two": answer("from two", BILLED),
    },
    "s/session",
  );
  const mark = metricsMark();
  const llm = makeLlm(
    host,
    { summarizer: ["a/one", "b/two"] },
    {
      session: "sess-sink",
      stage: "direct",
      span: { firstEntryId: "e0", lastEntryId: "e1" },
      sink: (record) => rows.push(record),
    },
  );
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "from two");
  assert.deepEqual(
    collected(rows, "summarizer-usage").map((row) => [
      row.model,
      row.stage,
      row.outcome,
      row.input,
      row.output,
      row.session,
    ]),
    [["b/two", "direct", "ok", 1200, 300, "sess-sink"]],
  );
  assert.deepEqual(
    collected(rows, "summarizer-fallback").map((row) => [row.used, row.session, row.attempts]),
    [
      [
        "b/two",
        "sess-sink",
        [
          { model: "a/one", outcome: "threw", error: "429 rate limit exceeded" },
          { model: "b/two", outcome: "ok" },
        ],
      ],
    ],
  );
  assert.deepEqual(metricsSince(mark), [], "a sink replaces the log for this completer");
});

test("metrics: runCompaction sends every engine row to the completer's sink and stamps the session", async () => {
  const s = new LcmStore(":memory:");
  const rows: MetricRecord[] = [];
  const mark = metricsMark();
  const llm = llmWithSink(() => "short summary", rows);
  const outcome = await storedPass(s, { span: spanOf(2, 400), targetTokens: 10_000 }, llm, {
    leafChunkTokens: 10_000,
    session: "sess-engine",
  });
  assert.equal(outcome.kind, "stored");
  const engine = rows.filter((row) => row.event === "lcm");
  assert.ok(engine.length >= 2, JSON.stringify(rows));
  assert.ok(
    engine.every((row) => row.session === "sess-engine"),
    JSON.stringify(engine.filter((row) => row.session !== "sess-engine")),
  );
  assert.deepEqual(
    collected(rows, "summary-stored").map((row) => [row.stage, row.summaryId, row.session]),
    [["leaf", outcome.leafSummaryIds[0], "sess-engine"]],
  );
  assert.deepEqual(
    collected(rows, "compaction-complete").map((row) => [row.leaves, row.session]),
    [[1, "sess-engine"]],
  );
  assert.deepEqual(metricsSince(mark), [], "the injected sink replaces the log");
  s.close();
});

test("metrics: without a sink runCompaction still appends its rows", async () => {
  const s = new LcmStore(":memory:");
  const mark = metricsMark();
  await storedPass(s, { span: spanOf(2, 400), targetTokens: 10_000 }, async () => "short summary", {
    leafChunkTokens: 10_000,
  });
  const written = metricsSince(mark).filter((row) => row.kind === "summary-stored");
  assert.equal(written.length, 1, JSON.stringify(written));
  assert.equal(written[0]!.session, undefined, "a pass without a session writes no session tag");
  s.close();
});

test("metrics: a stored leaf measures the model call plus the store write", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const s = new LcmStore(":memory:");
  try {
    vi.setSystemTime(1_000_000);
    const rows: MetricRecord[] = [];
    const llm: LlmComplete = Object.assign(
      async () => {
        vi.setSystemTime(1_000_250);
        return "short summary";
      },
      { metrics: (record: MetricRecord) => rows.push(record) },
    );
    const outcome = await storedPass(s, { span: spanOf(2, 400), targetTokens: 10_000 }, llm, {
      leafChunkTokens: 10_000,
      session: "sess-time",
    });
    const stored = collected(rows, "summary-stored");
    assert.equal(stored.length, 1);
    assert.deepEqual(
      [stored[0]!.stage, stored[0]!.durationMs, stored[0]!.summaryId],
      ["leaf", 250, outcome.leafSummaryIds[0]],
    );
  } finally {
    vi.useRealTimers();
    s.close();
  }
});

test("metrics: a condensed node measures the model call plus the store write", async () => {
  const s = new LcmStore(":memory:");
  try {
    const span = spanOf(2, 400);
    await storedPass(s, { span, targetTokens: 10_000 }, async () => "short summary", {
      leafChunkTokens: 1,
      maxChunks: 2,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    const rows: MetricRecord[] = [];
    const llm: LlmComplete = Object.assign(
      async () => {
        vi.setSystemTime(2_000_400);
        return "condensed";
      },
      { metrics: (record: MetricRecord) => rows.push(record) },
    );
    const outcome = await storedPass(s, { span, targetTokens: 1 }, llm, {
      leafChunkTokens: 1,
      maxChunks: 2,
      session: "sess-time",
    });
    const stored = collected(rows, "summary-stored");
    assert.equal(stored.length, 1, JSON.stringify(rows));
    assert.deepEqual(
      [stored[0]!.stage, stored[0]!.durationMs, stored[0]!.summaryId],
      ["condensed", 400, outcome.condensedSummaryIds[0]],
    );
  } finally {
    vi.useRealTimers();
    s.close();
  }
});

test("metrics: a skipped attempt and the replacement it allows both carry a duration", async () => {
  const s = new LcmStore(":memory:");
  try {
    const span = spanOf(2, 400);
    ingestEntries(
      s,
      span.map((entry, i) => ({
        entryId: entry.entryId,
        role: "user" as const,
        text: entry.text,
        timestamp: i,
      })),
    );
    const stale = s.insertSummary({
      kind: "leaf",
      text: "x".repeat(200),
      tokens: 50,
      depth: 0,
      firstEntryId: "e0",
      lastEntryId: "e1",
    }).id;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(3_000_000);
    const rows: MetricRecord[] = [];
    const llm: LlmComplete = Object.assign(
      async () => {
        vi.setSystemTime(3_000_075);
        return "short";
      },
      { metrics: (record: MetricRecord) => rows.push(record) },
    );
    const outcome = await storedPass(s, { span, targetTokens: 10_000 }, llm, {
      leafChunkTokens: 10_000,
      session: "sess-time",
    });
    const skipped = collected(rows, "summary-skipped-existing");
    const replaced = collected(rows, "summary-replaced");
    assert.equal(skipped.length, 1, JSON.stringify(rows));
    assert.equal(replaced.length, 1, JSON.stringify(rows));
    assert.deepEqual(outcome.leafSummaryIds, [stale]);
    assert.deepEqual([skipped[0]!.summaryId, skipped[0]!.durationMs], [stale, 75]);
    assert.deepEqual([replaced[0]!.summaryId, replaced[0]!.durationMs], [stale, 75]);
    assert.equal(s.getSummary(stale)!.text, "short");
  } finally {
    vi.useRealTimers();
    s.close();
  }
});

test("metrics: a mechanical fallback and an oversized node name the row they stored", async () => {
  const s = new LcmStore(":memory:");
  const rows: MetricRecord[] = [];
  const llm: LlmComplete = Object.assign(
    async () => {
      throw new Error("summarizer down");
    },
    { metrics: (record: MetricRecord) => rows.push(record) },
  );
  const outcome = await storedPass(s, { span: spanOf(1, 400), targetTokens: 10 }, llm, {
    leafChunkTokens: 10_000,
    session: "sess-fallback",
  });
  const stored = collected(rows, "summary-stored");
  const fallback = collected(rows, "summary-fallback-stored");
  const oversized = collected(rows, "summary-oversized");
  assert.ok(collected(rows, "summarizer-error").length > 0, JSON.stringify(rows));
  assert.equal(stored.length, 1, JSON.stringify(rows));
  assert.equal(fallback.length, 1, JSON.stringify(rows));
  assert.equal(oversized.length, 1, JSON.stringify(rows));
  assert.deepEqual(
    [fallback[0]!.stage, fallback[0]!.summaryId, oversized[0]!.stage, oversized[0]!.summaryId],
    ["leaf", outcome.leafSummaryIds[0], "leaf", outcome.leafSummaryIds[0]],
  );
  assert.deepEqual([stored[0]!.level, stored[0]!.summaryId], [3, outcome.leafSummaryIds[0]]);
  s.close();
});

test("metrics: a direct pass labels the completer and the engine rows direct", async () => {
  resetSummarizerState();
  const s = new LcmStore(":memory:");
  const rows: MetricRecord[] = [];
  const { host } = scriptedHost({ "p/m": answer("y".repeat(4000), BILLED) }, "p/m");
  const llm = makeLlm(
    host,
    { summarizer: "p/m" },
    {
      session: "sess-direct",
      stage: "direct",
      span: { firstEntryId: "e0", lastEntryId: "e0" },
      sink: (record) => rows.push(record),
    },
  );
  assert.ok(llm);
  const outcome = await storedPass(s, { span: spanOf(1, 100), targetTokens: 10 }, llm, {
    leafChunkTokens: 10_000,
    session: "sess-direct",
    stage: "direct",
  });
  assert.equal(outcome.kind, "stored");
  const usage = collected(rows, "summarizer-usage");
  assert.ok(usage.length >= 1, JSON.stringify(rows));
  assert.deepEqual(
    usage.map((row) => row.stage),
    usage.map(() => "direct"),
  );
  const truncated = collected(rows, "summary-final-truncated");
  assert.equal(truncated.length, 1, JSON.stringify(rows));
  assert.equal(truncated[0]!.stage, "direct");
  s.close();
});

test("metrics: estimated usage is marked on the row and left off when measured", async () => {
  resetSummarizerState();
  const estimatedRows: MetricRecord[] = [];
  const estimatedUsage: Usage = { ...BILLED, estimated: true };
  const estimatedHost = scriptedHost({ "p/m": answer("summary", estimatedUsage) }, "p/m").host;
  const estimated = makeLlm(
    estimatedHost,
    { summarizer: "p/m" },
    {
      session: "sess-estimated",
      stage: "direct",
      span: { firstEntryId: "e2", lastEntryId: "e2" },
      sink: (record) => estimatedRows.push(record),
    },
  );
  assert.ok(estimated);
  await estimated("sys", "body", 10);

  const measuredRows: MetricRecord[] = [];
  const measuredHost = scriptedHost({ "p/m": answer("summary", BILLED) }, "p/m").host;
  const measured = makeLlm(
    measuredHost,
    { summarizer: "p/m" },
    {
      session: "sess-estimated",
      stage: "direct",
      span: { firstEntryId: "e3", lastEntryId: "e3" },
      sink: (record) => measuredRows.push(record),
    },
  );
  assert.ok(measured);
  await measured("sys", "body", 10);

  const estimatedRow = collected(estimatedRows, "summarizer-usage")[0]!;
  assert.deepEqual(
    [estimatedRow.estimated, estimatedRow.input, estimatedRow.output],
    [true, 1200, 300],
  );
  const measuredRow = collected(measuredRows, "summarizer-usage")[0]!;
  assert.equal("estimated" in measuredRow, false);
});
