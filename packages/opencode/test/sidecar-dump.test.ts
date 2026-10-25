import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ingestEntries, LcmStore, redactSecrets } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { CommandInvocation } from "../src/host.ts";
import { dumpCommand, type LifecycleDeps } from "../src/lifecycle.ts";
import { DUMP_MAX_BYTES, dumpSidecar } from "../src/sidecar-dump.ts";
import { Sidecars } from "../src/sidecars.ts";

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
          note: `row ${i} ${"padding ".repeat(200)}`,
        })),
      });
      expect(result.status).toBe("dumped");
      if (result.status !== "dumped") return;
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(DUMP_MAX_BYTES);
      expect(result.text).toContain("truncated at the");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps per-summary text so metrics and footer survive", () => {
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
        const ids = Array.from(
          { length: 10 },
          (_, i) => store.messageByEntryId(`c${i}`)?.id,
        ).filter((v): v is number => v !== undefined);
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
      expect(result.status).toBe("dumped");
      if (result.status !== "dumped") return;
      expect(result.text).toContain("[lcm:more");
      expect(result.text).toContain(marker);
      expect(result.text).toContain("metrics:");
      expect(result.text).toContain("omitted:");
      expect(result.text).not.toContain("no absolute paths");
      expect(result.text).not.toContain("truncated at the");
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(DUMP_MAX_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("masks linked file previews and the echoed query, keeps paths", () => {
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
        expect(first).toBeDefined();
        store.insertSummary({
          kind: "leaf",
          text: "harbor summary",
          tokens: 5,
          depth: 0,
          firstEntryId: "m1",
          lastEntryId: "m1",
          messageIds: [first!.id],
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
      expect(result.status).toBe("dumped");
      if (result.status !== "dumped") return;
      expect(result.text).not.toContain(SECRET);
      expect(result.text).toContain("[REDACTED]");
      expect(result.text).toContain("notes/keys.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips removed rows by default and labels them with --include-removed", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "removed.sqlite");
      seedStore(path);
      const hidden = dumpSidecar({ path, sessionId: SESSION, redact: redactSecrets });
      expect(hidden.status).toBe("dumped");
      if (hidden.status !== "dumped") return;
      expect(hidden.text).not.toContain("second note about harbors");
      expect(hidden.text).not.toContain("[m2]");
      expect(hidden.text).toContain("first note about harbors");
      expect(hidden.text).toContain("[REDACTED]");

      const shown = dumpSidecar({
        path,
        sessionId: SESSION,
        redact: redactSecrets,
        includeRemoved: true,
      });
      expect(shown.status).toBe("dumped");
      if (shown.status !== "dumped") return;
      expect(shown.text).toContain("second note about harbors");
      expect(shown.text).toContain("[m2] (assistant) [removed]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves through a private temp at mode 0600", async () => {
    const dir = tempDir();
    const sidecars = new Sidecars(dir);
    const texts: string[] = [];
    const deps: LifecycleDeps = {
      sidecars,
      options: {
        assembly: true,
        swapAtRatio: 0.7,
        recutAtRatio: 0.85,
        keepRecentTokens: 20_000,
      },
      version: () => "opencode-lossless test",
      host: () => "opencode v2",
      prompt: (_sessionID, text) => {
        texts.push(text);
        return Promise.resolve(undefined);
      },
      record: () => {},
      heal: async () => {
        throw new Error("heal is not scripted in this harness");
      },
    };
    try {
      const store = sidecars.for(SESSION);
      ingestEntries(store, [
        { entryId: `${SESSION}:prompt:msg_1`, role: "user", text: "saved dump note", timestamp: 1 },
      ]);
      const target = join(dir, "lossless-dump.txt");
      writeFileSync(target, "stale bytes", { mode: 0o644 });
      chmodSync(target, 0o644);
      await dumpCommand(deps).execute({
        sessionID: SESSION,
        prompt: { text: `/lossless-dump --save ${target}` },
        delivery: {},
      } as CommandInvocation);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      const written = readFileSync(target, "utf8");
      expect(written).toContain("LCM sidecar dump");
      expect(written).not.toContain("stale bytes");
      expect(existsSync(`${target}.tmp`)).toBe(false);
      expect(texts.at(-1)).toContain("(mode 0600)");
    } finally {
      sidecars.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a planted predictable temp untouched", async () => {
    const dir = tempDir();
    const sidecars = new Sidecars(dir);
    const texts: string[] = [];
    const deps: LifecycleDeps = {
      sidecars,
      options: {
        assembly: true,
        swapAtRatio: 0.7,
        recutAtRatio: 0.85,
        keepRecentTokens: 20_000,
      },
      version: () => "opencode-lossless test",
      host: () => "opencode v2",
      prompt: (_sessionID, text) => {
        texts.push(text);
        return Promise.resolve(undefined);
      },
      record: () => {},
      heal: async () => {
        throw new Error("heal is not scripted in this harness");
      },
    };
    try {
      const store = sidecars.for(SESSION);
      ingestEntries(store, [
        { entryId: `${SESSION}:prompt:msg_1`, role: "user", text: "saved dump note", timestamp: 1 },
      ]);
      const target = join(dir, "lossless-dump-plant.txt");
      const decoy = `${target}.tmp`;
      writeFileSync(decoy, "decoy bytes", { mode: 0o644 });
      await dumpCommand(deps).execute({
        sessionID: SESSION,
        prompt: { text: `/lossless-dump --save ${target}` },
        delivery: {},
      } as CommandInvocation);
      expect(readFileSync(decoy, "utf8")).toBe("decoy bytes");
      const written = readFileSync(target, "utf8");
      expect(written).toContain("LCM sidecar dump");
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([
        "lossless-dump-plant.txt.tmp",
      ]);
    } finally {
      sidecars.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes its temp on every post-creation failure path", async () => {
    // node:fs module namespaces are not configurable under ESM, so a write
    // that creates the file then fails (disk full) resists spy fault
    // injection. Pin the cleanup structure instead: the write catch unlinks
    // the candidate before rethrowing, and EEXIST keeps its continue above
    // without unlinking.
    const source = readFileSync(new URL("../src/lifecycle.ts", import.meta.url), "utf8");
    const helper = source.slice(
      source.indexOf("function writeDumpTarget"),
      source.indexOf("cannot create temp file"),
    );
    const eexist = helper.indexOf('code === "EEXIST"');
    const unlink = helper.indexOf("unlinkSync(candidate)");
    const rethrow = helper.indexOf("throw error");
    expect(eexist).toBeGreaterThanOrEqual(0);
    expect(unlink).toBeGreaterThanOrEqual(0);
    expect(rethrow).toBeGreaterThanOrEqual(0);
    expect(eexist).toBeLessThan(unlink);
    expect(unlink).toBeLessThan(rethrow);
    // Success path leaves no temp behind beside the destination.
    const dir = tempDir();
    const sidecars = new Sidecars(dir);
    const texts: string[] = [];
    const deps: LifecycleDeps = {
      sidecars,
      options: {
        assembly: true,
        swapAtRatio: 0.7,
        recutAtRatio: 0.85,
        keepRecentTokens: 20_000,
      },
      version: () => "opencode-lossless test",
      host: () => "opencode v2",
      prompt: (_sessionID, text) => {
        texts.push(text);
        return Promise.resolve(undefined);
      },
      record: () => {},
      heal: async () => {
        throw new Error("heal is not scripted in this harness");
      },
    };
    try {
      const store = sidecars.for(SESSION);
      ingestEntries(store, [
        { entryId: `${SESSION}:prompt:msg_1`, role: "user", text: "saved dump note", timestamp: 1 },
      ]);
      const target = join(dir, "lossless-dump-clean.txt");
      await dumpCommand(deps).execute({
        sessionID: SESSION,
        prompt: { text: `/lossless-dump --save ${target}` },
        delivery: {},
      } as CommandInvocation);
      expect(existsSync(target)).toBe(true);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(texts.at(-1)).toContain("(mode 0600)");
    } finally {
      sidecars.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
