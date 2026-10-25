import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ingestEntries, LcmStore, redactSecrets } from "lossless-core";
import { test } from "vite-plus/test";

import { DUMP_MAX_BYTES, dumpSidecar } from "../src/ui/sidecar-dump.ts";

const SESSION = "ses_pi_dump";
const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789abcd";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-lossless-dump-"));
}

function seedStore(path: string): void {
  const store = new LcmStore(path);
  try {
    ingestEntries(store, [
      { entryId: "m1", role: "user", text: `first note about anchors ${SECRET}`, timestamp: 1 },
      { entryId: "m2", role: "assistant", text: "second note about anchors", timestamp: 2 },
    ]);
    const first = store.messageByEntryId("m1");
    const second = store.messageByEntryId("m2");
    if (first && second) {
      store.insertSummary({
        kind: "leaf",
        text: "anchor summary",
        tokens: 5,
        depth: 0,
        firstEntryId: "m1",
        lastEntryId: "m2",
        messageIds: [first.id, second.id],
      });
      store.setRemoved(["m2"], Date.now());
    }
  } finally {
    store.close();
  }
}

function countMessages(path: string): number {
  const store = new LcmStore(path, { queryOnly: true });
  try {
    return store.messageCount();
  } finally {
    store.close();
  }
}

test("dump: live session is read-only, redacted, and labels removed rows", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "live.sqlite");
    seedStore(path);
    const before = countMessages(path);
    const filesBefore = readdirSync(dir).sort();
    const result = dumpSidecar({
      path,
      sessionId: SESSION,
      redact: redactSecrets,
      includeRemoved: true,
      metricRows: [{ session: SESSION, kind: "context-decision", note: SECRET }],
      sampleQuery: "anchors",
    });
    assert.equal(result.status, "dumped");
    if (result.status !== "dumped") return;
    assert.ok(result.text.includes("LCM sidecar dump"));
    assert.ok(!result.text.includes(SECRET));
    assert.ok(result.text.includes("[REDACTED]"));
    assert.ok(result.text.includes("[removed]"));
    assert.equal(countMessages(path), before);
    assert.deepEqual(readdirSync(dir).sort(), filesBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dump: old generation reports a named skip", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "old.sqlite");
    seedStore(path);
    const raw = new DatabaseSync(path);
    try {
      raw.exec("PRAGMA user_version = 1");
    } finally {
      raw.close();
    }
    const result = dumpSidecar({ path, sessionId: SESSION, redact: redactSecrets });
    assert.equal(result.status, "skipped");
    if (result.status !== "skipped") return;
    assert.equal(result.reason, "older-generation");
    assert.ok(result.detail.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dump: missing sidecar reports a named skip", () => {
  const dir = tempDir();
  try {
    const result = dumpSidecar({
      path: join(dir, "absent.sqlite"),
      sessionId: SESSION,
      redact: redactSecrets,
    });
    assert.equal(result.status, "skipped");
    if (result.status !== "skipped") return;
    assert.equal(result.reason, "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dump: output stays within its byte cap", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "big.sqlite");
    const store = new LcmStore(path);
    try {
      ingestEntries(
        store,
        Array.from({ length: 30 }, (_, i) => ({
          entryId: `e${i}`,
          role: "user" as const,
          text: `anchor note ${i} ${"filler ".repeat(200)}`,
          timestamp: i,
        })),
      );
    } finally {
      store.close();
    }
    const result = dumpSidecar({
      path,
      sessionId: SESSION,
      redact: redactSecrets,
      metricRows: Array.from({ length: 60 }, (_, i) => ({
        session: SESSION,
        kind: "usage",
        input: i,
        note: `row ${i} ${"padding ".repeat(50)}`,
      })),
    });
    assert.equal(result.status, "dumped");
    if (result.status !== "dumped") return;
    assert.ok(Buffer.byteLength(result.text, "utf8") <= DUMP_MAX_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
