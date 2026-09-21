import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "vite-plus/test";

import { exportTranscript } from "../src/export.ts";
import { importTranscript, parseExport } from "../src/import.ts";
import { entryToText, ingestEntries, payloadOf } from "../src/ingest.ts";
import { expandView } from "../src/recall-view.ts";
import { redactSecrets } from "../src/redact.ts";
import { LcmStore, SCHEMA_VERSION } from "../src/store.ts";

const thinking = { type: "thinking", thinking: "the retry ladder needs no jitter" };
const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg" };

test("store: a file predating the model state table grows it without losing a row", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-model-state-"));
  const dbPath = join(dir, "legacy.db");
  const first = new LcmStore(dbPath);
  ingestEntries(first, [
    { entryId: "e0", role: "user", text: "kept across the upgrade", timestamp: 1 },
  ]);
  first.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("DROP TABLE model_state");
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  const upgraded = new LcmStore(dbPath);
  assert.equal(upgraded.messageCount(), 1, "the row survived");
  assert.equal(upgraded.getModelState("test/model"), undefined, "nothing sampled it yet");
  upgraded.setModelState("test/model", { charsPerToken: 5.5, samples: 3 });
  assert.deepEqual(upgraded.getModelState("test/model"), {
    charsPerToken: 5.5,
    samples: 3,
    contextWindow: null,
    windowSource: null,
  });
  upgraded.setModelState("other/model", { charsPerToken: null, samples: 4 });
  assert.deepEqual(upgraded.getModelState("other/model"), {
    charsPerToken: null,
    samples: 4,
    contextWindow: null,
    windowSource: null,
  });
  upgraded.setModelState("test/model", { charsPerToken: 6, samples: 5 });
  assert.deepEqual(upgraded.getModelState("test/model"), {
    charsPerToken: 6,
    samples: 5,
    contextWindow: null,
    windowSource: null,
  });
  upgraded.close();

  const version = new DatabaseSync(dbPath);
  const row = version.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(row.user_version, SCHEMA_VERSION);
  version.close();
});

test("payloadOf: a payload exists only when the derived text is incomplete", () => {
  assert.equal(payloadOf("plain text"), undefined);
  assert.equal(payloadOf(undefined), undefined);
  assert.equal(payloadOf(null), undefined);
  assert.equal(payloadOf([]), undefined);
  assert.equal(payloadOf([{ type: "text", text: "one" }]), undefined);
  assert.equal(
    payloadOf([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]),
    undefined,
  );
  assert.equal(
    payloadOf([{ type: "toolCall", name: "read", arguments: { path: "a" } }]),
    undefined,
  );
  assert.equal(
    payloadOf([{ type: "toolCall", name: "read", arguments: { a: 1 }, input: { b: 2 } }]) !==
      undefined,
    true,
  );
});

test("payloadOf: reasoning, image data, and unknown blocks are kept", () => {
  assert.equal(payloadOf([thinking]), JSON.stringify([thinking]));
  assert.equal(payloadOf([image]), JSON.stringify([image]));
  assert.equal(
    payloadOf([{ type: "text", text: "look" }, image]),
    JSON.stringify([{ type: "text", text: "look" }, image]),
  );
  assert.equal(
    payloadOf([{ type: "mystery", value: 1 }]),
    JSON.stringify([{ type: "mystery", value: 1 }]),
  );
  assert.equal(payloadOf({ odd: true }), JSON.stringify({ odd: true }));
});

test("payloadOf: entryToText is unchanged, so the derived view stays the index view", () => {
  const content = [{ type: "text", text: "look:" }, image, thinking];
  assert.equal(entryToText(content), "look:\n[image]");
  assert.equal(payloadOf(content), JSON.stringify(content));
});

test("ingest: a message with raw blocks stores the payload beside the derived text", () => {
  const s = new LcmStore(":memory:");
  const content = [{ type: "text", text: "I will fix it" }, thinking];
  ingestEntries(s, [
    {
      entryId: "e0",
      role: "assistant",
      text: entryToText(content),
      timestamp: 1,
      payload: payloadOf(content)!,
    },
    { entryId: "e1", role: "user", text: "plain", timestamp: 2 },
  ]);
  const [raw, plain] = s.messagesByIds([1, 2]);
  assert.equal(raw!.text, "I will fix it", "the derived text omits the reasoning");
  assert.equal(raw!.payload, JSON.stringify(content), "the payload carries it");
  assert.equal(plain!.payload, undefined, "a text-only message keeps one copy");
  const stats = s.stats();
  assert.equal(stats.payloadMessages, 1);
  assert.equal(stats.payloadBytes, JSON.stringify(content).length);
  // The summarizer path reads the same rows without loading the payloads.
  assert.equal(s.messagesInSpan("e0", "e1")[0]!.payload, undefined);
  s.close();
});

test("ingest: the payload is stored as given and masked on the way out", () => {
  const s = new LcmStore(":memory:");
  const secret = { type: "thinking", thinking: "use key sk-ant-0123456789abcdefghij" };
  const payload = payloadOf([secret])!;
  ingestEntries(s, [{ entryId: "e0", role: "assistant", text: "reading", timestamp: 1, payload }]);
  const stored = s.messagesByIds([1])[0]!;
  assert.equal(stored.payload, payload, "the payload column is the input, byte for byte");
  assert.ok(stored.payload!.includes("sk-ant-"), "the store held the secret");
  const read = expandView(s, redactSecrets, {
    mode: "message",
    entryId: "e0",
    charOffset: 0,
    maxChars: 4000,
  });
  assert.ok(read.ok);
  assert.equal(read.text.includes("sk-ant-"), false, "the read masks the raw blocks");
  assert.deepEqual(JSON.parse(read.text.slice(read.text.indexOf("\n\n") + 2)), [
    { type: "thinking", thinking: "use key [REDACTED]" },
  ]);
  s.close();
});

test("expandView: a windowed read returns the raw blocks, not the derived text", () => {
  const s = new LcmStore(":memory:");
  const content = [thinking, { type: "text", text: "I will fix X" }];
  ingestEntries(s, [
    {
      entryId: "e0",
      role: "assistant",
      text: entryToText(content),
      timestamp: 1,
      payload: payloadOf(content)!,
    },
  ]);
  const msg = s.messagesByIds([1])[0]!;
  const leaf = s.insertSummary({
    kind: "leaf",
    text: "leaf",
    tokens: 1,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e0",
    messageIds: [msg.id],
  }).id;
  const read = expandView(s, redactSecrets, {
    mode: "message",
    id: leaf,
    entryId: "e0",
    charOffset: 0,
    maxChars: 8000,
  });
  assert.ok(read.ok);
  if (!read.ok) return;
  const body = JSON.stringify(content);
  assert.equal(read.details.total, body.length);
  assert.match(read.text, /^\[e0\] \(assistant\) raw blocks chars 0\.\.\d+ of \d+\n\n/);
  assert.equal(read.text.includes("no jitter"), true, "reasoning is readable");
  const half = Math.floor(body.length / 2);
  const second = expandView(s, redactSecrets, {
    mode: "message",
    id: leaf,
    entryId: "e0",
    charOffset: half,
    maxChars: 8000,
  });
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(second.text.endsWith(body.slice(half)), true);
  assert.equal(second.text.includes("chars 0.."), false);
  s.close();
});

test("export and import: a payload survives the round trip", () => {
  const source = new LcmStore(":memory:");
  const content = [{ type: "text", text: "fixed" }, image];
  ingestEntries(source, [
    {
      entryId: "e0",
      role: "assistant",
      text: entryToText(content),
      timestamp: 1,
      payload: payloadOf(content)!,
    },
  ]);
  const text = exportTranscript(source).toJSONL();
  const rows = (parseExport(text) as { rows: never[] }).rows;
  const target = new LcmStore(":memory:");
  const result = importTranscript(target, rows);
  assert.equal(result.messagesInserted, 1);
  assert.equal(target.allMessages()[0]!.payload, JSON.stringify(content));
  target.close();
  source.close();
});

test("parseExport: a version 1 file still imports, with no payload", () => {
  const v1 = JSON.stringify({
    v: 1,
    rowType: "message",
    entryId: "e0",
    role: "user",
    text: "written by the previous build",
    tokens: 7,
    timestamp: 1,
  });
  const parsed = parseExport(v1);
  assert.ok("rows" in parsed);
  const target = new LcmStore(":memory:");
  const result = importTranscript(target, (parsed as { rows: never[] }).rows);
  assert.equal(result.messagesInserted, 1);
  assert.equal(target.allMessages()[0]!.payload, undefined);
  assert.equal(target.allMessages()[0]!.text, "written by the previous build");
  target.close();
});

test("parseExport: the version 3 file the dogfood build wrote is refused", () => {
  const v3 = JSON.stringify({
    v: 3,
    rowType: "message",
    entryId: "e0",
    role: "user",
    text: "written by the dogfood build",
    tokens: 7,
    timestamp: 1,
  });
  assert.deepEqual(parseExport(v3), {
    error: "line 1 has version 3; this build reads version 1",
  });
});

test("migration: a store written before the payload column upgrades in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-payload-migration-"));
  const dbPath = join(dir, "legacy.db");
  const first = new LcmStore(dbPath);
  ingestEntries(first, [
    { entryId: "e0", role: "user", text: "kept across the upgrade", timestamp: 1 },
  ]);
  first.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("ALTER TABLE messages DROP COLUMN payload");
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  const upgraded = new LcmStore(dbPath);
  assert.equal(upgraded.messageCount(), 1, "the row survived");
  assert.equal(upgraded.allMessages()[0]!.text, "kept across the upgrade");
  assert.equal(upgraded.allMessages()[0]!.payload, undefined, "an old row has none to give");
  ingestEntries(upgraded, [
    {
      entryId: "e1",
      role: "assistant",
      text: "new",
      timestamp: 2,
      payload: payloadOf([thinking])!,
    },
  ]);
  assert.equal(upgraded.messagesByIds([2])[0]!.payload, JSON.stringify([thinking]));
  assert.equal(upgraded.stats().payloadMessages, 1);
  upgraded.close();

  const version = new DatabaseSync(dbPath);
  const row = version.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(row.user_version, SCHEMA_VERSION);
  version.close();
});

test("store: a stated window round-trips and a file missing the columns grows them", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-model-window-"));
  const dbPath = join(dir, "legacy.db");
  const first = new LcmStore(dbPath);
  first.setModelState("test/model", { charsPerToken: 4, samples: 2 });
  first.setModelWindow("test/model", 200_000, "provider-error");
  assert.deepEqual(first.getModelState("test/model"), {
    charsPerToken: 4,
    samples: 2,
    contextWindow: 200_000,
    windowSource: "provider-error",
  });
  first.setModelState("test/model", { charsPerToken: 5, samples: 3 });
  assert.equal(first.getModelState("test/model")?.contextWindow, 200_000);
  assert.equal(first.getModelState("test/model")?.samples, 3);
  first.close();

  const raw = new DatabaseSync(dbPath);
  raw.exec("ALTER TABLE model_state DROP COLUMN context_window");
  raw.exec("ALTER TABLE model_state DROP COLUMN window_source");
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  const upgraded = new LcmStore(dbPath);
  assert.equal(
    upgraded.getModelState("test/model")?.contextWindow ?? null,
    null,
    "nothing was stated",
  );
  upgraded.setModelWindow("test/model", 100_000, "provider-error");
  assert.equal(upgraded.getModelState("test/model")?.contextWindow, 100_000);
  assert.equal(upgraded.getModelState("test/model")?.windowSource, "provider-error");
  assert.equal(upgraded.getModelState("test/model")?.samples, 3, "the ratio row survived");
  upgraded.close();
});
