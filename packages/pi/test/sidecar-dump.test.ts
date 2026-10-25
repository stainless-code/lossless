import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ingestEntries, LcmStore, redactSecrets } from "lossless-core";
import { test } from "vite-plus/test";

import { registerLcmCommand, type LcmCommandDeps } from "../src/ui/command.ts";
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
        note: `row ${i} ${"padding ".repeat(200)}`,
      })),
    });
    assert.equal(result.status, "dumped");
    if (result.status !== "dumped") return;
    assert.ok(Buffer.byteLength(result.text, "utf8") <= DUMP_MAX_BYTES);
    assert.ok(result.text.includes("truncated at the"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dump: caps per-summary text so metrics and footer survive", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "capped.sqlite");
    const store = new LcmStore(path);
    try {
      ingestEntries(
        store,
        Array.from({ length: 10 }, (_, i) => ({
          entryId: `c${i}`,
          role: "user" as const,
          text: `note ${i}`,
          timestamp: i,
        })),
      );
      const ids = Array.from({ length: 10 }, (_, i) => store.messageByEntryId(`c${i}`)?.id).filter(
        (v): v is number => v !== undefined,
      );
      for (let s = 0; s < 5; s++) {
        store.insertSummary({
          kind: "leaf",
          text: `summary ${s}`,
          tokens: 1500,
          depth: 0,
          firstEntryId: `c${s * 2}`,
          lastEntryId: `c${s * 2 + 1}`,
          messageIds: [ids[s * 2]!, ids[s * 2 + 1]!],
          thoroughText: `thorough ${s} ${"x".repeat(6000)}`,
        });
      }
    } finally {
      store.close();
    }
    const marker = "cap-marker-note";
    const result = dumpSidecar({
      path,
      sessionId: SESSION,
      redact: redactSecrets,
      metricRows: [{ session: SESSION, kind: "usage", note: marker }],
      sampleQuery: "note",
    });
    assert.equal(result.status, "dumped");
    if (result.status !== "dumped") return;
    assert.ok(result.text.includes("[lcm:more"));
    assert.ok(result.text.includes(marker));
    assert.ok(result.text.includes("metrics:"));
    assert.ok(result.text.includes("omitted:"));
    assert.ok(!result.text.includes("no absolute paths"));
    assert.ok(!result.text.includes("truncated at the"));
    assert.ok(Buffer.byteLength(result.text, "utf8") <= DUMP_MAX_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dump: masks linked file previews and the echoed query, keeps paths", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "file.sqlite");
    const store = new LcmStore(path);
    try {
      ingestEntries(store, [
        { entryId: "m1", role: "user", text: "note about harbors", timestamp: 1 },
      ]);
      store.insertFile(
        {
          fileId: "file-secret-1",
          path: "notes/keys.txt",
          bytes: 64,
          sha256: "0".repeat(64),
          kind: "text",
          preview: `${SECRET}\nsecond line of the file`,
        },
        "m1",
      );
      const first = store.messageByEntryId("m1");
      assert.ok(first);
      store.insertSummary({
        kind: "leaf",
        text: "harbor summary",
        tokens: 5,
        depth: 0,
        firstEntryId: "m1",
        lastEntryId: "m1",
        messageIds: [first.id],
        fileIds: ["file-secret-1"],
      });
    } finally {
      store.close();
    }
    const result = dumpSidecar({
      path,
      sessionId: SESSION,
      redact: redactSecrets,
      sampleQuery: `harbors ${SECRET}`,
    });
    assert.equal(result.status, "dumped");
    if (result.status !== "dumped") return;
    assert.ok(!result.text.includes(SECRET), result.text);
    assert.ok(result.text.includes("[REDACTED]"), result.text);
    assert.ok(result.text.includes("notes/keys.txt"), result.text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dump: default sampling skips removed rows, --include-removed labels them", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "removed.sqlite");
    seedStore(path);
    const hidden = dumpSidecar({ path, sessionId: SESSION, redact: redactSecrets });
    assert.equal(hidden.status, "dumped");
    if (hidden.status !== "dumped") return;
    assert.ok(!hidden.text.includes("second note about anchors"), hidden.text);
    assert.ok(!hidden.text.includes("[m2]"), hidden.text);
    assert.ok(hidden.text.includes("first note about anchors"), hidden.text);
    assert.ok(hidden.text.includes("[REDACTED]"), hidden.text);

    const shown = dumpSidecar({
      path,
      sessionId: SESSION,
      redact: redactSecrets,
      includeRemoved: true,
    });
    assert.equal(shown.status, "dumped");
    if (shown.status !== "dumped") return;
    assert.ok(shown.text.includes("second note about anchors"), shown.text);
    assert.ok(shown.text.includes("[m2] (assistant) [removed]"), shown.text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dump --save: writes through a private temp at mode 0600", async () => {
  const dir = tempDir();
  const origHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const dbPath = join(dir, "save.sqlite");
    const liveStore = new LcmStore(dbPath);
    try {
      ingestEntries(liveStore, [
        { entryId: "m1", role: "user", text: "saved dump note", timestamp: 1 },
      ]);
      const notifications: string[] = [];
      const commands = new Map<
        string,
        { handler: (args: string | undefined, ctx: unknown) => Promise<unknown> }
      >();
      const fakePi = {
        registerCommand: (name: string, def: never) => {
          commands.set(name, def);
        },
      };
      const deps: LcmCommandDeps = {
        getStore: () => liveStore,
        openStore: () => liveStore,
        getConfig: () => ({}),
        patchConfig: () => {},
        resetConfig: () => {},
        clearCommitState: () => {},
        getCommitState: () => null,
        getDbPath: () => dbPath,
        keepRecentTokens: () => 20_000,
      };
      registerLcmCommand(fakePi as never, deps);
      const ctx = {
        mode: "tui",
        sessionManager: {
          getSessionFile: () => join(dir, "sess.jsonl"),
          getSessionId: () => "pi-dump-save",
        },
        getContextUsage: () => undefined,
        ui: {
          notify: (msg: string) => {
            notifications.push(msg);
          },
        },
      };
      const target = join(dir, "lcm-dump.txt");
      writeFileSync(target, "stale bytes", { mode: 0o644 });
      chmodSync(target, 0o644);
      await commands.get("lcm")!.handler(`dump --save ${target}`, ctx);
      assert.equal(statSync(target).mode & 0o777, 0o600);
      const written = readFileSync(target, "utf8");
      assert.ok(written.includes("LCM sidecar dump"), written);
      assert.ok(!written.includes("stale bytes"), written);
      assert.ok(!existsSync(`${target}.tmp`), "no temp file is left behind");
      assert.ok(notifications.at(-1)!.includes("(mode 0600)"), notifications.join(" | "));
    } finally {
      liveStore.close();
    }
  } finally {
    process.env.HOME = origHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
