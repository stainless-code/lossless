import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { exportTranscript } from "../src/export.ts";
import {
  computeRawIngestDelta,
  entryToText,
  ingestEntries,
  isIngestible,
  nextIngestWatermark,
} from "../src/ingest.ts";
import { expandView } from "../src/recall-view.ts";
import { redactSecrets } from "../src/redact.ts";
import { LcmStore } from "../src/store.ts";

interface RawFixture {
  id?: string;
  type: string;
}

const raw: RawFixture[] = [
  { id: "x0", type: "model_change" },
  { id: "e0", type: "message" },
  { id: "e1", type: "message" },
  { id: "e2", type: "message" },
  { id: "e3", type: "message" },
];

test("computeRawIngestDelta: no watermark or unknown id collects everything", () => {
  assert.deepEqual(computeRawIngestDelta(raw, null), { startIndex: 0, reset: true });
  assert.deepEqual(computeRawIngestDelta([raw[1]!, raw[4]!], { id: "e2" }), {
    startIndex: 0,
    reset: true,
  });
  assert.deepEqual(computeRawIngestDelta([], { id: "e2" }), { startIndex: 0, reset: true });
});

test("computeRawIngestDelta: a known id starts collection just after it", () => {
  assert.deepEqual(computeRawIngestDelta(raw, { id: "e2" }), { startIndex: 4, reset: false });
  assert.deepEqual(computeRawIngestDelta(raw, { id: "e0" }), { startIndex: 2, reset: false });
  assert.deepEqual(computeRawIngestDelta(raw, { id: "e3" }), { startIndex: 5, reset: false });
  assert.deepEqual(
    computeRawIngestDelta([...raw, { id: "x1", type: "compaction" }], { id: "e3" }),
    {
      startIndex: 5,
      reset: false,
    },
  );
});

test("computeRawIngestDelta: the LAST occurrence of a repeated id wins", () => {
  const dup = [
    { id: "e0", type: "message" },
    { id: "e1", type: "message" },
    { id: "e0", type: "message" },
  ];
  assert.deepEqual(computeRawIngestDelta(dup, { id: "e0" }), { startIndex: 3, reset: false });
});

test('computeRawIngestDelta: an id-less entry maps to ""', () => {
  const withBlank = [
    { id: "e0", type: "message" },
    { type: "message" },
    { id: "e2", type: "message" },
  ];
  assert.deepEqual(computeRawIngestDelta(withBlank, { id: "" }), { startIndex: 2, reset: false });
});

test("ingest: a message far over the index prefix is stored verbatim, tail included", () => {
  const s = new LcmStore(":memory:");
  const text = `${"a".repeat(100_000)}TAIL-MARKER-${"b".repeat(49_000)}`;
  const stats = ingestEntries(s, [{ entryId: "big", role: "user", text, timestamp: 1 }]);
  assert.equal(stats.inserted, 1);
  const stored = s.messagesInSpan("big", "big")[0]!;
  assert.equal(stored.text.length, text.length);
  assert.ok(stored.text.endsWith("b".repeat(20)), "the tail is intact");
  assert.ok(stored.text.includes("TAIL-MARKER-"), "text past the index prefix is intact");
  assert.equal(stored.tokens, Math.ceil(text.length / 4), "tokens cover the whole message");
  const readBack = s.messagesByIds([stored.id])[0]!;
  assert.equal(readBack.text, text, "round-trips through messagesByIds");
  s.close();
});

test("ingest: a message of exactly 100,000 characters is stored whole", () => {
  const s = new LcmStore(":memory:");
  const exact = "b".repeat(100_000);
  ingestEntries(s, [{ entryId: "edge", role: "user", text: exact, timestamp: 1 }]);
  assert.equal(s.messagesInSpan("edge", "edge")[0]!.text.length, 100_000);
  s.close();
});

test("ingest: the index covers the first 100,000 characters of a huge message", () => {
  const s = new LcmStore(":memory:");
  const text = `headmarker ${"a".repeat(99_990)} zzzonlyinthetail`;
  ingestEntries(s, [{ entryId: "big", role: "user", text, timestamp: 1 }]);
  assert.equal(s.messagesInSpan("big", "big")[0]!.text.length, text.length);
  assert.equal(s.grep("headmarker").length, 1, "text inside the prefix is indexed");
  assert.deepEqual(s.grep("zzzonlyinthetail"), [], "text past the prefix is not indexed");
  const hit = s.grep("headmarker")[0]!;
  assert.equal(hit.text.length, text.length);
  s.close();
});

test("ingest: the store keeps the bytes it is given, key and all", () => {
  const s = new LcmStore(":memory:");
  const key = "sk-abcdefghij0123456789";
  const text = `KEY=secret ${key} ${"c".repeat(100_000)}`;
  ingestEntries(s, [{ entryId: "r", role: "user", text, timestamp: 1 }]);
  const stored = s.messagesInSpan("r", "r")[0]!;
  assert.equal(stored.text, text, "the row is the input, byte for byte");
  const read = expandView(s, redactSecrets, {
    mode: "message",
    entryId: "r",
    charOffset: 0,
    maxChars: 4000,
  });
  assert.ok(read.ok);
  assert.equal(read.text.includes(key), false, "the read masks what the store kept");
  s.close();
});

test("ingest: a huge message is reachable in full through windowed reads", async () => {
  const s = new LcmStore(":memory:");
  const text = `${"t".repeat(150_000)}tailmarker`;
  ingestEntries(s, [{ entryId: "huge", role: "user", text, timestamp: 1 }]);
  const msg = s.messagesInSpan("huge", "huge")[0]!;
  const leaf = s.insertSummary({
    kind: "leaf",
    text: "leaf",
    tokens: 1,
    depth: 0,
    firstEntryId: "huge",
    lastEntryId: "huge",
    messageIds: [msg.id],
  }).id;
  assert.equal(s.messagesByIds([msg.id])[0]!.text, text);
  const listed = expandView(s, redactSecrets, {
    mode: "list",
    id: leaf,
    offset: 0,
    limit: 25,
    maxChars: 4000,
  });
  assert.ok(listed.ok);
  if (!listed.ok) return;
  assert.ok(listed.text.includes("t".repeat(4000)));
  assert.ok(!listed.text.includes("tailmarker"), "one window cannot hold 150,000 characters");
  assert.ok(
    listed.text.includes(
      `[lcm:more ${text.length - 4000} chars; read them with entry_id "huge" and char_offset 4000]`,
    ),
    listed.text,
  );
  const tail = expandView(s, redactSecrets, {
    mode: "message",
    id: leaf,
    entryId: "huge",
    charOffset: 148_000,
    maxChars: 4000,
  });
  assert.ok(tail.ok);
  if (!tail.ok) return;
  assert.ok(tail.text.includes("tailmarker"), "the last window carries the tail");
  assert.equal(tail.text.includes("[lcm:budget"), false);
  const exported = exportTranscript(s).toJSONL();
  assert.ok(exported.includes("tailmarker"), "export carries the tail");
  s.close();
});

test("ingest: whitespace-only and empty-id entries are skipped", () => {
  const s = new LcmStore(":memory:");
  const stats = ingestEntries(s, [
    { entryId: "", role: "user", text: "has text but no id", timestamp: 1 },
    { entryId: "ws", role: "user", text: "   \n\t ", timestamp: 2 },
    { entryId: "ok", role: "user", text: "kept", timestamp: 3 },
  ]);
  assert.deepEqual(stats, {
    inserted: 1,
    skipped: 2,
    piCompactions: [],
    files: [],
    largeInline: [],
  });
  assert.equal(s.stats().messages, 1);
  s.close();
});

test("entryToText: string content passes through, non-array content is empty", () => {
  assert.equal(entryToText("plain"), "plain");
  assert.equal(entryToText(undefined), "");
  assert.equal(entryToText(null), "");
  assert.equal(entryToText({ type: "text", text: "not in an array" }), "");
  assert.equal(entryToText(42), "");
});

test("entryToText: toolCall blocks stringify their arguments", () => {
  const text = entryToText([
    { type: "toolCall", name: "read", arguments: { path: "src/a.ts", limit: 10 } },
  ]);
  assert.equal(text, `[tool:read] ${JSON.stringify({ path: "src/a.ts", limit: 10 })}`);
});

test("entryToText: tool_use blocks read `input`, missing name renders as ?", () => {
  assert.equal(
    entryToText([{ type: "tool_use", name: "bash", input: { command: "ls" } }]),
    `[tool:bash] ${JSON.stringify({ command: "ls" })}`,
  );
  assert.equal(entryToText([{ type: "toolCall" }]), "[tool:?] {}");
  assert.equal(
    entryToText([{ type: "toolCall", name: "x", arguments: { a: 1 }, input: { b: 2 } }]),
    `[tool:x] {"a":1}`,
  );
});

test("entryToText: image blocks emit a marker; unknown and malformed blocks are dropped", () => {
  const text = entryToText([
    { type: "text", text: "look:" },
    { type: "image", url: "http://example.invalid/x.png" },
    { type: "thinking", thinking: "hidden" },
    { type: "text", text: 123 },
    null,
    "loose string",
    { type: "text", text: "done" },
  ]);
  assert.equal(text, "look:\n[image]\ndone");
});

test("ingest: a Pi head compaction is flagged once, and never on a re-ingest", () => {
  const s = new LcmStore(":memory:");
  const entries = [
    {
      entryId: "c0",
      role: "custom" as const,
      text: "pi compacted the head of this session",
      timestamp: 1,
      piCompaction: true,
    },
    { entryId: "u1", role: "user" as const, text: "a normal turn", timestamp: 2 },
  ];
  const first = ingestEntries(s, entries);
  assert.deepEqual(first.piCompactions, ["c0"], "the compaction entry is named once");
  assert.equal(first.inserted, 2);
  const again = ingestEntries(s, entries);
  assert.deepEqual(again.piCompactions, []);
  assert.equal(again.skipped, 2);
});

test("ingest: the rule that decides whether an entry is worth a store", () => {
  assert.equal(isIngestible({ entryId: "e1", text: "hello" }), true);
  assert.equal(isIngestible({ entryId: "e1", text: "  " }), false, "whitespace holds nothing");
  assert.equal(
    isIngestible({ entryId: "", text: "hello" }),
    false,
    "an entry without an id cannot be addressed",
  );
});

test("ingest: the watermark comes from the delta, not from what was stored", () => {
  const allEmpty = [
    { entryId: "e1", text: "  " },
    { entryId: "e2", text: "" },
  ];
  assert.deepEqual(
    nextIngestWatermark(allEmpty),
    { id: "e2" },
    "an all-empty delta still moves the watermark",
  );
  const oneReal = [{ entryId: "e3", text: "real" }];
  assert.deepEqual(nextIngestWatermark(oneReal), { id: "e3" });
  assert.equal(nextIngestWatermark([]), null, "an empty delta names nothing");
});
