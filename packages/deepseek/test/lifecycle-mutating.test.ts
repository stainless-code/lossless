import { mkdtempSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import { CommandId } from "@deepseek-ai/dsh-commands/brand";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import {
  LcmStore,
  TRUNCATED_SUMMARY_PREFIX,
  ingestEntries,
  sanitizeSidecarId,
  storeGeneration,
  SCHEMA_VERSION,
} from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { lcmCommandDefinition, type LcmCommandDeps } from "../src/command.ts";
import { healInFlightSessions } from "../src/lifecycle.ts";
import type { DshRoute } from "../src/model-host.ts";
import { applyLossless } from "../src/plugin.ts";
import { fakeAgent } from "./support/agent-fake.ts";
import { appendConversation } from "./support/conversation.ts";
import { setupContext, textChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deepseek-lcm-mut-"));
}

async function mountBase(ctx: Context): Promise<void> {
  await ctx.plugin(SystemPrompt, {});
  void new ToolRuntime(ctx);
  void new CommandRuntime(ctx);
  void new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  void new TokenMeter(ctx);
}

function depsFor(dir: string, stores: Map<string, LcmStore>): LcmCommandDeps {
  return {
    stores: () => stores,
    storeFor: (sessionId) => {
      let store = stores.get(sessionId);
      if (!store) {
        store = new LcmStore(join(dir, `${sanitizeSidecarId(sessionId)}.sqlite`));
        stores.set(sessionId, store);
      }
      return store;
    },
    sidecarDir: dir,
    storePathFor: (sessionId) => join(dir, `${sanitizeSidecarId(sessionId)}.sqlite`),
  };
}

function invoke(
  ctx: Context,
  deps: LcmCommandDeps,
  sessionId: string,
  rawInput: string,
): Promise<{ kind: string; text?: string }> {
  const session = ctx.sessions.get(SessionId(sessionId));
  if (!session) throw new Error(`no session ${sessionId}`);
  const definition = lcmCommandDefinition(ctx, deps);
  return definition.handler({
    agent: fakeAgent(session, ROUTE),
    signal: new AbortController().signal,
    commandId: CommandId(`cmd-${rawInput.split(" ")[0] || "status"}`),
    rawInput,
    attachments: [],
  }) as Promise<{ kind: string; text?: string }>;
}

function seedMessages(store: LcmStore, texts: string[]): void {
  ingestEntries(
    store,
    texts.map((text, i) => ({
      entryId: `e${String(i).padStart(2, "0")}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text,
      timestamp: i,
    })),
  );
}

function ageFile(path: string, daysAgo: number): void {
  const old = new Date(Date.now() - daysAgo * 86_400_000);
  utimesSync(path, old, old);
}

describe("lcm mutating verbs", () => {
  it("export then import into a fresh store yields identical message counts", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("round-a"), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("round-b"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    const source = deps.storeFor!("round-a");
    seedMessages(source, ["round trip one", "round trip two"]);
    const target = join(dir, "round.jsonl");
    const exported = await invoke(ctx, deps, "round-a", `export ${target}`);
    expect(exported.kind).toBe("success");
    expect(exported.text).toContain("2 messages");
    const first = await invoke(ctx, deps, "round-b", `import ${target}`);
    expect(first.kind).toBe("success");
    expect(first.text).toContain("2 messages");
    expect(deps.storeFor!("round-b").allMessages().length).toBe(2);
    const second = await invoke(ctx, deps, "round-b", `import ${target}`);
    expect(second.kind).toBe("success");
    expect(second.text).toContain("already present");
    const missing = await invoke(ctx, deps, "round-b", "import");
    expect(missing.kind).toBe("error");
  });

  it("import against a closed store returns an error instead of throwing", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("closed-src"), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("closed-dst"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    seedMessages(deps.storeFor!("closed-src"), ["closed store one", "closed store two"]);
    const target = join(dir, "closed.jsonl");
    const exported = await invoke(ctx, deps, "closed-src", `export ${target}`);
    expect(exported.kind).toBe("success");
    deps.storeFor!("closed-dst").close();
    let result: { kind: string; text?: string } | undefined;
    let threw: unknown = null;
    try {
      result = await invoke(ctx, deps, "closed-dst", `import ${target}`);
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeNull();
    expect(result?.kind).toBe("error");
    expect(result?.text).toContain("LCM import failed:");
  });

  it("gc dry-run lists without deleting and apply deletes only stale sidecars", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    const liveId = "live.session:1";
    ctx.sessions.create(SessionId(liveId), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("other"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    const liveStem = sanitizeSidecarId(liveId);
    const live = deps.storeFor!(liveId);
    seedMessages(live, ["live history stays"]);
    const stalePath = join(dir, "stale-old.sqlite");
    const staleDetached = new LcmStore(stalePath);
    try {
      seedMessages(staleDetached, ["stale history goes"]);
    } finally {
      staleDetached.close();
    }
    ageFile(stalePath, 31);
    ageFile(join(dir, `${liveStem}.sqlite`), 31);
    const dry = await invoke(ctx, deps, liveId, "gc");
    expect(dry.kind).toBe("success");
    expect(dry.text).toContain("dry-run");
    expect(dry.text).toContain("stale-old");
    expect(dry.text).not.toContain(liveStem);
    expect(existsSync(stalePath)).toBe(true);
    const applied = await invoke(ctx, deps, liveId, "gc --apply");
    expect(applied.kind).toBe("success");
    expect(applied.text).toContain("removed 1 of 1");
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(join(dir, `${liveStem}.sqlite`))).toBe(true);
    expect(live.allMessages().length).toBe(1);
    const again = await invoke(ctx, deps, liveId, "gc --apply");
    expect(again.kind).toBe("success");
    expect(again.text).toContain("nothing eligible");
    const gcExports = readdirSync(dir).filter((name) => name.startsWith("lcm-export-gc-"));
    expect(gcExports.length).toBe(1);
  });

  it("gc apply writes one export per sidecar so each restores", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    const liveId = "live-gc-split";
    ctx.sessions.create(SessionId(liveId), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("other-split"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    deps.storeFor!(liveId);
    const seedStale = (stem: string, texts: string[]): string => {
      const path = join(dir, `${stem}.sqlite`);
      const stale = new LcmStore(path);
      try {
        seedMessages(stale, texts);
        const ids = stale.messagesInSpan("e00", "e01").map((message) => message.id);
        stale.insertSummary({
          kind: "leaf",
          text: `leaf for ${stem}`,
          tokens: 4,
          depth: 0,
          firstEntryId: "e00",
          lastEntryId: "e01",
          messageIds: ids,
        });
      } finally {
        stale.close();
      }
      ageFile(path, 31);
      return path;
    };
    const staleA = seedStale("stale-a", ["stale a one", "stale a two"]);
    const staleB = seedStale("stale-b", ["stale b one", "stale b two"]);
    ageFile(join(dir, `${sanitizeSidecarId(liveId)}.sqlite`), 31);
    const applied = await invoke(ctx, deps, liveId, "gc --apply");
    expect(applied.kind).toBe("success");
    expect(applied.text).toContain("removed 2 of 2");
    const gcExports = readdirSync(dir)
      .filter((name) => name.startsWith("lcm-export-gc-"))
      .sort();
    expect(gcExports.length).toBe(2);
    expect(applied.text).toContain(gcExports[0]!);
    expect(applied.text).toContain(gcExports[1]!);
    expect(existsSync(staleA)).toBe(false);
    expect(existsSync(staleB)).toBe(false);
    ctx.sessions.create(SessionId("restore-a"), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("restore-b"), { meta: { cwd: dir } });
    const fileA = gcExports.find((name) => name.includes("stale-a"))!;
    const fileB = gcExports.find((name) => name.includes("stale-b"))!;
    expect(fileA).toBeDefined();
    expect(fileB).toBeDefined();
    const impA = await invoke(ctx, deps, "restore-a", `import ${join(dir, fileA)}`);
    expect(impA.kind).toBe("success");
    expect(deps.storeFor!("restore-a").allMessages().length).toBe(2);
    expect(deps.storeFor!("restore-a").allSummaries().length).toBe(1);
    const impB = await invoke(ctx, deps, "restore-b", `import ${join(dir, fileB)}`);
    expect(impB.kind).toBe("success");
    expect(deps.storeFor!("restore-b").allMessages().length).toBe(2);
    expect(deps.storeFor!("restore-b").allSummaries().length).toBe(1);
    const againA = await invoke(ctx, deps, "restore-a", `import ${join(dir, fileA)}`);
    expect(againA.kind).toBe("success");
    expect(againA.text).toContain("already present");
    expect(deps.storeFor!("restore-a").allMessages().length).toBe(2);
  });

  it("gc apply on an empty stale sidecar removes it without naming an export file", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    const liveId = "live-gc-empty";
    ctx.sessions.create(SessionId(liveId), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("other-empty"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    const live = deps.storeFor!(liveId);
    seedMessages(live, ["live stays"]);
    const emptyPath = join(dir, "empty-old.sqlite");
    const empty = new LcmStore(emptyPath);
    empty.close();
    ageFile(emptyPath, 31);
    ageFile(join(dir, `${sanitizeSidecarId(liveId)}.sqlite`), 31);
    const applied = await invoke(ctx, deps, liveId, "gc --apply");
    expect(applied.kind).toBe("success");
    expect(applied.text).toContain("removed 1 of 1");
    expect(applied.text).toContain("transcripts were empty so no export file was written");
    expect(applied.text).not.toContain("lcm-export-gc-");
    expect(existsSync(emptyPath)).toBe(false);
    const gcExports = readdirSync(dir).filter((name) => name.startsWith("lcm-export-gc-"));
    expect(gcExports.length).toBe(0);
  });

  it("migrate dry-run describes a stale sidecar and apply upgrades it", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("mig-live"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    deps.storeFor!("mig-live");
    appendConversation(ctx.sessions.get(SessionId("mig-live"))!, ROUTE, "live notes");
    const stalePath = join(dir, "old-session.sqlite");
    const old = new DatabaseSync(stalePath);
    try {
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
        PRAGMA user_version = 1;
      `);
    } finally {
      old.close();
    }
    expect(storeGeneration(stalePath)).toBe(1);
    const dry = await invoke(ctx, deps, "mig-live", "migrate");
    expect(dry.kind).toBe("success");
    expect(dry.text).toContain("dry-run");
    expect(dry.text).toContain("old-session");
    expect(dry.text).toContain("generation 1");
    const applied = await invoke(ctx, deps, "mig-live", "migrate --apply");
    expect(applied.kind).toBe("success");
    expect(applied.text).toContain("upgraded 1 of 1");
    expect(storeGeneration(stalePath)).toBe(SCHEMA_VERSION);
    const quiet = await invoke(ctx, deps, "mig-live", "migrate");
    expect(quiet.kind).toBe("success");
    expect(quiet.text).toContain("nothing to do");
  });

  it("heal --apply uses the configured summary model over the agent route", async () => {
    const scripts = [[...textChunks("a repaired leaf summary")]];
    const { ctx, adapter } = setupContext(ROUTE, scripts);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("heal-cfg"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps: LcmCommandDeps = {
      ...depsFor(dir, stores),
      summarizationProvider: ROUTE.provider,
      summarizationModel: "configured-heal-model",
    };
    const store = deps.storeFor!("heal-cfg");
    seedMessages(store, [
      `heal source alpha ${"detail ".repeat(60)}`,
      `heal source beta ${"context ".repeat(60)}`,
    ]);
    const messageIds = store.messagesInSpan("e00", "e01").map((message) => message.id);
    store.insertSummary({
      kind: "leaf",
      text: `${TRUNCATED_SUMMARY_PREFIX}\nmechanical`,
      tokens: 5,
      depth: 0,
      firstEntryId: "e00",
      lastEntryId: "e01",
      messageIds,
      quality: "mechanical",
    });
    const applied = await invoke(ctx, deps, "heal-cfg", "heal --apply");
    expect(applied.kind).toBe("success");
    expect(applied.text).toContain("repaired 1 clean");
    expect(adapter.requests.length).toBeGreaterThan(0);
    expect(adapter.requests[0]?.model).toBe("configured-heal-model");
  });

  it("heal --apply falls back to the agent route when no summary model is configured", async () => {
    const scripts = [[...textChunks("a repaired leaf summary")]];
    const { ctx, adapter } = setupContext(ROUTE, scripts);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("heal-fb"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    const store = deps.storeFor!("heal-fb");
    seedMessages(store, [
      `heal source alpha ${"detail ".repeat(60)}`,
      `heal source beta ${"context ".repeat(60)}`,
    ]);
    const messageIds = store.messagesInSpan("e00", "e01").map((message) => message.id);
    store.insertSummary({
      kind: "leaf",
      text: `${TRUNCATED_SUMMARY_PREFIX}\nmechanical`,
      tokens: 5,
      depth: 0,
      firstEntryId: "e00",
      lastEntryId: "e01",
      messageIds,
      quality: "mechanical",
    });
    const applied = await invoke(ctx, deps, "heal-fb", "heal --apply");
    expect(applied.kind).toBe("success");
    expect(applied.text).toContain("repaired 1 clean");
    expect(adapter.requests.length).toBeGreaterThan(0);
    expect(adapter.requests[0]?.model).toBe(ROUTE.model);
  });

  it("dispose leaves the healing session's store open", async () => {
    const scripts = [[...textChunks("a repaired leaf summary")]];
    const { ctx } = setupContext(ROUTE, scripts);
    await mountBase(ctx);
    const dir = tempDir();
    const dispose = applyLossless(ctx, { enabled: true, sidecarDir: dir });
    const originalClose = Reflect.get(LcmStore.prototype, "close") as (this: LcmStore) => void;
    let closes = 0;
    LcmStore.prototype.close = function (this: LcmStore): void {
      closes += 1;
      Reflect.apply(originalClose, this, []);
    };
    const stores = new Map<string, LcmStore>();
    try {
      ctx.sessions.create(SessionId("heal-live"), { meta: { cwd: dir } });
      const session = ctx.sessions.get(SessionId("heal-live"))!;
      appendConversation(session, ROUTE, "heal live history ".repeat(20));
      const deps = depsFor(dir, stores);
      const store = deps.storeFor!("heal-live");
      const rows = store.allMessages();
      expect(rows.length).toBeGreaterThan(0);
      store.insertSummary({
        kind: "leaf",
        text: `${TRUNCATED_SUMMARY_PREFIX}\nmechanical`,
        tokens: 5,
        depth: 0,
        firstEntryId: rows[0]!.entryId,
        lastEntryId: rows[rows.length - 1]!.entryId,
        messageIds: rows.map((row) => row.id),
        quality: "mechanical",
      });
      const pending = invoke(ctx, deps, "heal-live", "heal --apply");
      expect(healInFlightSessions()).toContain("heal-live");
      dispose();
      expect(closes).toBe(0);
      const applied = await pending;
      expect(applied.kind).toBe("success");
      expect(healInFlightSessions()).toHaveLength(0);
      dispose();
      expect(closes).toBeGreaterThan(0);
    } finally {
      LcmStore.prototype.close = originalClose;
      for (const store of stores.values()) {
        try {
          store.close();
        } catch {}
      }
    }
  });

  it("gc --session collects only that session", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    const liveId = "gc-live-sel";
    ctx.sessions.create(SessionId(liveId), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("other-sel"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    const live = deps.storeFor!(liveId);
    seedMessages(live, ["live history stays"]);
    for (const stem of ["stale-sel-a", "stale-sel-b"]) {
      const stale = new LcmStore(join(dir, `${stem}.sqlite`));
      try {
        seedMessages(stale, [`history for ${stem}`]);
      } finally {
        stale.close();
      }
      ageFile(join(dir, `${stem}.sqlite`), 31);
    }
    const dry = await invoke(ctx, deps, liveId, "gc --session stale-sel-a");
    expect(dry.kind).toBe("success");
    expect(dry.text).toContain("stale-sel-a");
    expect(dry.text).not.toContain("stale-sel-b");
    const applied = await invoke(ctx, deps, liveId, "gc --session stale-sel-a --apply");
    expect(applied.kind).toBe("success");
    expect(applied.text).toContain("removed 1 of 1");
    expect(existsSync(join(dir, "stale-sel-a.sqlite"))).toBe(false);
    expect(existsSync(join(dir, "stale-sel-b.sqlite"))).toBe(true);
  });

  it("gc --older-than collects only sidecars older than the window", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    const liveId = "gc-live-age";
    ctx.sessions.create(SessionId(liveId), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("other-age"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    deps.storeFor!(liveId);
    const oldPath = join(dir, "stale-old-age.sqlite");
    const old = new LcmStore(oldPath);
    try {
      seedMessages(old, ["two days old"]);
    } finally {
      old.close();
    }
    ageFile(oldPath, 2);
    const freshPath = join(dir, "stale-fresh-age.sqlite");
    const fresh = new LcmStore(freshPath);
    try {
      seedMessages(fresh, ["fresh today"]);
    } finally {
      fresh.close();
    }
    const recent = await invoke(ctx, deps, liveId, "gc --older-than 1d");
    expect(recent.kind).toBe("success");
    expect(recent.text).toContain("stale-old-age");
    expect(recent.text).not.toContain("stale-fresh-age");
    const dflt = await invoke(ctx, deps, liveId, "gc");
    expect(dflt.kind).toBe("success");
    expect(dflt.text).toContain("nothing eligible");
  });

  it("gc dry-run hint echoes session and older-than selectors", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    const liveId = "gc-live-hint";
    ctx.sessions.create(SessionId(liveId), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("other-hint"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    deps.storeFor!(liveId);
    for (const stem of ["stale-hint-a", "stale-hint-b"]) {
      const stale = new LcmStore(join(dir, `${stem}.sqlite`));
      try {
        seedMessages(stale, [`history for ${stem}`]);
      } finally {
        stale.close();
      }
      ageFile(join(dir, `${stem}.sqlite`), 31);
    }
    const sessionDry = await invoke(ctx, deps, liveId, "gc --session stale-hint-a");
    expect(sessionDry.kind).toBe("success");
    expect(sessionDry.text).toContain("/lcm gc --apply --session stale-hint-a");
    const ageDry = await invoke(ctx, deps, liveId, "gc --older-than 1d");
    expect(ageDry.kind).toBe("success");
    expect(ageDry.text).toContain("/lcm gc --apply --older-than 1d");
    const bothDry = await invoke(ctx, deps, liveId, "gc --session stale-hint-a --older-than 1d");
    expect(bothDry.kind).toBe("success");
    expect(bothDry.text).toContain("--session stale-hint-a");
    expect(bothDry.text).toContain("--older-than 1d");
  });

  it("gc apply after a session hint deletes only the previewed session", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    const liveId = "gc-live-hint-apply";
    ctx.sessions.create(SessionId(liveId), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("other-hint-apply"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    deps.storeFor!(liveId);
    for (const stem of ["stale-apply-a", "stale-apply-b"]) {
      const stale = new LcmStore(join(dir, `${stem}.sqlite`));
      try {
        seedMessages(stale, [`history for ${stem}`]);
      } finally {
        stale.close();
      }
      ageFile(join(dir, `${stem}.sqlite`), 31);
    }
    const dry = await invoke(ctx, deps, liveId, "gc --session stale-apply-a");
    expect(dry.kind).toBe("success");
    expect(dry.text).toContain("stale-apply-a");
    expect(dry.text).not.toContain("stale-apply-b");
    expect(dry.text).toContain("/lcm gc --apply --session stale-apply-a");
    const applied = await invoke(ctx, deps, liveId, "gc --session stale-apply-a --apply");
    expect(applied.kind).toBe("success");
    expect(applied.text).toContain("removed 1 of 1");
    expect(existsSync(join(dir, "stale-apply-a.sqlite"))).toBe(false);
    expect(existsSync(join(dir, "stale-apply-b.sqlite"))).toBe(true);
  });

  it("gc older-than accepts only a number with an optional d suffix", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    const liveId = "gc-live-parse";
    ctx.sessions.create(SessionId(liveId), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("other-parse"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    deps.storeFor!(liveId);
    for (const valid of ["2", "2d", "2.5d"]) {
      const result = await invoke(ctx, deps, liveId, `gc --older-than ${valid}`);
      expect(result.kind).toBe("success");
    }
    for (const invalid of ["2weeks", "d", "-1"]) {
      const result = await invoke(ctx, deps, liveId, `gc --older-than ${invalid}`);
      expect(result.kind).toBe("error");
      expect(result.text).toContain("--older-than takes a number of days");
    }
    const empty = await invoke(ctx, deps, liveId, "gc --older-than=");
    expect(empty.kind).toBe("error");
    expect(empty.text).toContain("--older-than takes a number of days");
  });

  it("gc refuses a missing or invalid selector value", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    const liveId = "gc-live-bad";
    ctx.sessions.create(SessionId(liveId), { meta: { cwd: dir } });
    ctx.sessions.create(SessionId("other-bad"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    deps.storeFor!(liveId);
    const missingSession = await invoke(ctx, deps, liveId, "gc --session");
    expect(missingSession.kind).toBe("error");
    expect(missingSession.text).toContain("--session takes a session id");
    const missingDays = await invoke(ctx, deps, liveId, "gc --older-than");
    expect(missingDays.kind).toBe("error");
    expect(missingDays.text).toContain("--older-than takes a number of days");
    const invalidDays = await invoke(ctx, deps, liveId, "gc --older-than soon");
    expect(invalidDays.kind).toBe("error");
    expect(invalidDays.text).toContain("--older-than takes a number of days");
    const liveSelected = await invoke(ctx, deps, liveId, `gc --session ${liveId}`);
    expect(liveSelected.kind).toBe("error");
    expect(liveSelected.text).toContain("never deletes an open sidecar");
    const unknown = await invoke(ctx, deps, liveId, "gc --session no-such-sidecar");
    expect(unknown.kind).toBe("success");
    expect(unknown.text).toContain("no sidecar for session no-such-sidecar");
  });

  it("heal dry-run lists a truncated node and apply repairs it on a scripted model", async () => {
    const scripts = [[...textChunks("a repaired leaf summary")]];
    const { ctx } = setupContext(ROUTE, scripts);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("heal-1"), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores);
    const store = deps.storeFor!("heal-1");
    seedMessages(store, [
      `heal source alpha ${"detail ".repeat(60)}`,
      `heal source beta ${"context ".repeat(60)}`,
    ]);
    const messageIds = store.messagesInSpan("e00", "e01").map((message) => message.id);
    store.insertSummary({
      kind: "leaf",
      text: `${TRUNCATED_SUMMARY_PREFIX}\nmechanical`,
      tokens: 5,
      depth: 0,
      firstEntryId: "e00",
      lastEntryId: "e01",
      messageIds,
      quality: "mechanical",
    });
    const badFlag = await invoke(ctx, deps, "heal-1", "heal --max-nodes nope");
    expect(badFlag.kind).toBe("error");
    expect(badFlag.text).toContain("--max-nodes");
    const dry = await invoke(ctx, deps, "heal-1", "heal");
    expect(dry.kind).toBe("success");
    expect(dry.text).toContain("dry-run");
    expect(dry.text).toContain("1 candidate(s)");
    const applied = await invoke(ctx, deps, "heal-1", "heal --apply");
    expect(applied.kind).toBe("success");
    expect(applied.text).toContain("repaired 1 clean");
    const repaired = store.allSummaries()[0];
    expect(repaired?.quality).toBe("clean");
    expect(existsSync(join(dir, "heal-1.sqlite"))).toBe(true);
  });
});
