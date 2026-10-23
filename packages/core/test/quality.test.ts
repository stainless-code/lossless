import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "vite-plus/test";

import type { CompactionSpanEntry } from "../src/compaction-engine.ts";
import { estimateTokens } from "../src/estimate-tokens.ts";
import { ingestEntries } from "../src/ingest.ts";
import type { LcmMetricRecord, MetricRecord } from "../src/metrics.ts";
import {
  LcmStore,
  SCHEMA_VERSION,
  StaleStoreError,
  TRUNCATED_SUMMARY_PREFIX,
  type SummaryQuality,
} from "../src/store.ts";
import type { LlmComplete } from "../src/summarize.ts";
import { storedPass } from "./support/pass-outcome.ts";

function entries(count: number, chars: number): CompactionSpanEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `message ${i} ${"x".repeat(chars)}`,
  }));
}

function scripted(reply: () => string, rows: MetricRecord[] = []): LlmComplete {
  return Object.assign(async () => reply(), {
    metrics: (row: MetricRecord) => rows.push(row),
  });
}

function rowsOf<K extends LcmMetricRecord["kind"]>(
  rows: readonly MetricRecord[],
  kind: K,
): Array<Extract<LcmMetricRecord, { kind: K }>> {
  return rows.filter(
    (row): row is Extract<LcmMetricRecord, { kind: K }> => row.event === "lcm" && row.kind === kind,
  );
}

function ingest(store: LcmStore, span: readonly CompactionSpanEntry[]): void {
  ingestEntries(
    store,
    span.map((entry) => ({
      entryId: entry.entryId,
      role: entry.role,
      text: entry.text,
      timestamp: 0,
    })),
  );
}

test("quality: a v1 store refuses a read-only open, then migrates and backfills verdicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-quality-migrate-"));
  const path = join(dir, "store.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        payload TEXT,
        removed_at INTEGER
      );
      CREATE TABLE summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('leaf','condensed')),
        text TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        first_entry_id TEXT NOT NULL,
        last_entry_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        thorough_text TEXT,
        thorough_tokens INTEGER,
        status TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('pending','committed')),
        run TEXT
      );
      CREATE TABLE provenance (
        summary_id INTEGER NOT NULL,
        child_type TEXT NOT NULL CHECK (child_type IN ('message','summary')),
        child_id INTEGER NOT NULL,
        PRIMARY KEY (summary_id, child_type, child_id)
      );
    `);
    old.exec(`
      INSERT INTO messages (entry_id, role, text, tokens, timestamp) VALUES
        ('e0', 'user', 'alpha', 1, 0),
        ('e1', 'assistant', 'beta', 1, 1),
        ('e2', 'user', 'gamma', 1, 2),
        ('e3', 'assistant', 'delta', 1, 3);
      INSERT INTO summaries
        (id, kind, text, tokens, depth, first_entry_id, last_entry_id, created_at, status)
      VALUES
        (1, 'leaf', '[lcm:truncated]' || char(10) || 'mechanical', 5, 0, 'e0', 'e1', 1, 'committed'),
        (2, 'condensed', 'parent summary', 2, 1, 'e0', 'e1', 1, 'committed'),
        (3, 'leaf', 'clean sibling', 2, 0, 'e2', 'e3', 1, 'committed'),
        (4, 'condensed', 'root summary', 2, 2, 'e0', 'e3', 1, 'committed');
      INSERT INTO provenance (summary_id, child_type, child_id) VALUES
        (1, 'message', 1),
        (1, 'message', 2),
        (3, 'message', 3),
        (3, 'message', 4),
        (2, 'summary', 1),
        (4, 'summary', 2),
        (4, 'summary', 3);
      PRAGMA user_version = 1;
    `);
    old.close();

    assert.throws(
      () => new LcmStore(path, { readOnly: true }),
      (error: unknown) => error instanceof StaleStoreError && error.generation === 1,
      "a read-only open refuses a store older than the quality generation",
    );

    const migrated = new LcmStore(path);
    assert.equal(SCHEMA_VERSION, 2);
    assert.equal(migrated.generation, 2);
    assert.equal(migrated.getSummary(1)?.quality, "mechanical");
    assert.equal(migrated.getSummary(2)?.quality, "derived");
    assert.equal(migrated.getSummary(3)?.quality, "clean");
    assert.equal(migrated.getSummary(4)?.quality, "derived");
    migrated.close();

    const again = new LcmStore(path);
    assert.equal(again.generation, 2);
    assert.equal(again.getSummary(1)?.quality, "mechanical", "the backfill is idempotent");
    assert.equal(again.getSummary(2)?.quality, "derived");
    again.close();

    const read = new LcmStore(path, { readOnly: true });
    assert.equal(read.generation, 2);
    assert.equal(read.getSummary(4)?.quality, "derived");
    read.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quality: detection returns every non-clean verdict plus the text-prefix fallback", () => {
  const store = new LcmStore(":memory:");
  try {
    const span = entries(4, 40);
    ingest(store, span);
    const clean = store.insertSummary({
      kind: "leaf",
      text: "clean leaf",
      tokens: 2,
      depth: 0,
      firstEntryId: "e0",
      lastEntryId: "e0",
    }).id;
    const clipped = store.insertSummary({
      kind: "leaf",
      text: "clipped leaf",
      tokens: 2,
      depth: 0,
      quality: "clipped",
      firstEntryId: "e1",
      lastEntryId: "e1",
    }).id;
    const mechanical = store.insertSummary({
      kind: "leaf",
      text: "mechanical leaf",
      tokens: 2,
      depth: 0,
      quality: "mechanical",
      firstEntryId: "e2",
      lastEntryId: "e2",
    }).id;
    const prefixFallback = store.insertSummary({
      kind: "leaf",
      text: `${TRUNCATED_SUMMARY_PREFIX}\npre-migration row`,
      tokens: 3,
      depth: 0,
      firstEntryId: "e3",
      lastEntryId: "e3",
    }).id;
    const parent = store.insertSummary({
      kind: "condensed",
      text: "derived parent",
      tokens: 2,
      depth: 1,
      quality: "derived",
      firstEntryId: "e0",
      lastEntryId: "e1",
      childSummaryIds: [clean, clipped],
    }).id;

    assert.equal(store.getSummary(clean)?.quality, "clean", "an insert defaults to clean");
    assert.deepEqual(
      store.taintedSummaries(TRUNCATED_SUMMARY_PREFIX).map((node) => [node.id, node.quality]),
      [
        [clipped, "clipped"],
        [mechanical, "mechanical"],
        [prefixFallback, "clean"],
        [parent, "derived"],
      ],
    );
    assert.equal(store.markSummaryDerived(mechanical), false, "a stronger verdict is kept");
    assert.equal(store.getSummary(mechanical)?.quality, "mechanical");
    assert.equal(store.markSummaryDerived(clean), true);
    assert.equal(store.getSummary(clean)?.quality, "derived");
    assert.equal(store.markSummaryDerived(parent), false, "an existing derived row is unchanged");
  } finally {
    store.close();
  }
});

test("quality: compaction stamps leaf rows clean, clipped, and mechanical", async () => {
  const cases: Array<{
    name: string;
    chars: number;
    chunkTokens: number;
    reply: () => string;
    expected: SummaryQuality;
  }> = [
    { name: "clean", chars: 60, chunkTokens: 10_000, reply: () => "short", expected: "clean" },
    { name: "clipped", chars: 200, chunkTokens: 10, reply: () => "short", expected: "clipped" },
    {
      name: "mechanical",
      chars: 60,
      chunkTokens: 10_000,
      reply: () => {
        throw new Error("summarizer down");
      },
      expected: "mechanical",
    },
  ];
  for (const row of cases) {
    const store = new LcmStore(":memory:");
    try {
      const span = entries(1, row.chars);
      const metrics: MetricRecord[] = [];
      const outcome = await storedPass(
        store,
        { span, targetTokens: 100 },
        scripted(row.reply, metrics),
        { leafChunkTokens: row.chunkTokens },
      );
      const leaf = store.getSummary(outcome.leafSummaryIds[0]!);
      assert.equal(leaf?.quality, row.expected, row.name);
      assert.equal(rowsOf(metrics, "summary-stored")[0]?.quality, row.expected, row.name);
    } finally {
      store.close();
    }
  }
});

async function condense(
  childQualities: readonly SummaryQuality[],
  reply: () => string,
): Promise<{ store: LcmStore; condensed: ReturnType<LcmStore["getSummary"]> }> {
  const store = new LcmStore(":memory:");
  const span = entries(childQualities.length * 2, 60);
  ingest(store, span);
  const messages = store.messagesInSpan("e0", `e${span.length - 1}`);
  for (let i = 0; i < childQualities.length; i++) {
    const first = messages[i * 2];
    const last = messages[i * 2 + 1];
    assert.ok(first);
    assert.ok(last);
    store.insertSummary({
      kind: "leaf",
      text: `leaf ${i} ${"t".repeat(200)}`,
      tokens: estimateTokens(`leaf ${i} ${"t".repeat(200)}`),
      depth: 0,
      quality: childQualities[i],
      firstEntryId: first.entryId,
      lastEntryId: last.entryId,
      messageIds: [first.id, last.id],
    });
  }
  await storedPass(store, { span, targetTokens: 10 }, scripted(reply), {
    leafChunkTokens: 100_000,
  });
  return {
    store,
    condensed: store.allSummaries().find((node) => node.kind === "condensed" && node.depth === 1),
  };
}

test("quality: a condensed node is clean over clean children and derived over any other", async () => {
  const derived = await condense(["mechanical", "clean"], () => "parent summary");
  try {
    assert.equal(derived.condensed?.quality, "derived");
  } finally {
    derived.store.close();
  }
  const clean = await condense(["clean", "clean"], () => "parent summary");
  try {
    assert.equal(clean.condensed?.quality, "clean");
  } finally {
    clean.store.close();
  }
  const mechanical = await condense(["clean", "clean"], () => {
    throw new Error("summarizer down");
  });
  try {
    assert.equal(mechanical.condensed?.quality, "mechanical");
  } finally {
    mechanical.store.close();
  }
});

test("quality: a replacement carries its new verdict and reports both sides", async () => {
  const store = new LcmStore(":memory:");
  try {
    const span = entries(4, 60);
    ingest(store, span);
    const stale = store.insertSummary({
      kind: "leaf",
      text: "stale and long ".repeat(20),
      tokens: 40,
      depth: 0,
      quality: "mechanical",
      firstEntryId: "e0",
      lastEntryId: "e3",
    }).id;
    const metrics: MetricRecord[] = [];
    await storedPass(
      store,
      { span, targetTokens: 100_000 },
      scripted(() => "short", metrics),
      { leafChunkTokens: 100_000 },
    );
    const replaced = rowsOf(metrics, "summary-replaced");
    assert.equal(replaced.length, 1);
    assert.deepEqual(
      [replaced[0]!.qualityBefore, replaced[0]!.qualityAfter],
      ["mechanical", "clean"],
    );
    assert.equal(store.getSummary(stale)?.quality, "clean");
    assert.equal(store.getSummary(stale)?.text, "short");
  } finally {
    store.close();
  }
});
