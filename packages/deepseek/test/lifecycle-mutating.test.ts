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
import type { DshRoute } from "../src/model-host.ts";
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
