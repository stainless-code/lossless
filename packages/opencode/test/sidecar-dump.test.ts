import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ingestEntries, LcmStore, redactSecrets } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { DUMP_MAX_BYTES, dumpSidecar } from "../src/sidecar-dump.ts";

const SESSION = "ses_dump_test";
const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789abcd";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-dump-"));
}

function seedStore(path: string): void {
  const store = new LcmStore(path);
  try {
    ingestEntries(store, [
      { entryId: "m1", role: "user", text: `first note about harbors ${SECRET}`, timestamp: 1 },
      { entryId: "m2", role: "assistant", text: "second note about harbors", timestamp: 2 },
    ]);
    const first = store.messageByEntryId("m1");
    const second = store.messageByEntryId("m2");
    if (first && second) {
      store.insertSummary({
        kind: "leaf",
        text: "harbor summary",
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

describe("sidecar dump", () => {
  it("dumps a live session read-only with redaction and removed labels", () => {
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
        sampleQuery: "harbors",
      });
      expect(result.status).toBe("dumped");
      if (result.status !== "dumped") return;
      expect(result.text).toContain("LCM sidecar dump");
      expect(result.text).not.toContain(SECRET);
      expect(result.text).toContain("[REDACTED]");
      expect(result.text).toContain("[removed]");
      expect(countMessages(path)).toBe(before);
      const filesAfter = readdirSync(dir).sort();
      expect(filesAfter.filter((f) => f.endsWith("-journal"))).toEqual([]);
      expect(filesAfter).toEqual(filesBefore);
      expect(existsSync(`${path}-journal`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an old generation as a named skip instead of crashing", () => {
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
      expect(result.status).toBe("skipped");
      if (result.status !== "skipped") return;
      expect(result.reason).toBe("older-generation");
      expect(result.detail.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing sidecar as a named skip", () => {
    const dir = tempDir();
    try {
      const result = dumpSidecar({
        path: join(dir, "absent.sqlite"),
        sessionId: SESSION,
        redact: redactSecrets,
      });
      expect(result.status).toBe("skipped");
      if (result.status !== "skipped") return;
      expect(result.reason).toBe("missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays within its byte cap", () => {
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
            text: `harbor note ${i} ${"filler ".repeat(200)}`,
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
      expect(result.status).toBe("dumped");
      if (result.status !== "dumped") return;
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(DUMP_MAX_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
