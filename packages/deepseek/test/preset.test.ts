import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { LcmStore } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { LosslessSummarizerEngine } from "../src/engine.ts";
import type { DshRoute } from "../src/model-host.ts";
import { applyLossless } from "../src/plugin.ts";
import { apply as applyPreset, Config, inject, name } from "../src/preset.ts";
import { appendConversation } from "./support/conversation.ts";
import { setupContext, textChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };
const SUMMARY = "Checkpoint: engine work started and the config was read.";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deepseek-preset-"));
}

/** A realm-like context: the services the preset backend reads, without the
 * host registries it must not touch. */
function realmContext(route: DshRoute, scripts: StreamChunk[][] = []) {
  const { ctx } = setupContext(route, scripts, { contextWindow: 1_000_000 });
  void new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  void new TokenMeter(ctx);
  return ctx;
}

/** A host-like context: the full registries the core composition mounts. */
async function hostContext(
  route: DshRoute,
  scripts: StreamChunk[][],
  dir: string,
): Promise<{ ctx: Context; stop: () => void }> {
  const { ctx } = setupContext(route, scripts, { contextWindow: 1_000_000 });
  await ctx.plugin(SystemPrompt, {});
  void new ToolRuntime(ctx);
  void new CommandRuntime(ctx);
  void new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  void new TokenMeter(ctx);
  const stop = applyLossless(ctx, { enabled: true, sidecarDir: dir });
  return { ctx, stop };
}

// White-box by design: the engine keeps its deps in a private `lossless`
// field, and these tests pin the cross-entry sharing contract through it.
// If the field moves, update this helper, not the assertions.
function engineDepsOf(engine: LosslessSummarizerEngine): {
  store: (id: string) => unknown;
} {
  return (engine as unknown as { lossless: { store: (id: string) => unknown } }).lossless;
}

describe("preset backend", () => {
  it("exposes the realm entrypoint shape the loader applies", () => {
    expect(name).toBe("deepseek-lossless-preset");
    for (const service of ["sessions", "llm", "tokenMeter"]) {
      expect(inject).toContain(service);
    }
    expect(inject).not.toContain("compaction");
    expect(inject).not.toContain("tools");
    expect(inject).not.toContain("commands");
    expect(inject).not.toContain("sessionQuery");
    expect(Config).toBeDefined();
    expect(typeof applyPreset).toBe("function");
  });

  it("registers nothing until enabled", () => {
    const ctx = realmContext(ROUTE);
    const dir = join(tempDir(), "never-created");
    const dispose = applyPreset(ctx, { sidecarDir: dir });
    expect((ctx as unknown as { compaction?: unknown }).compaction).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    dispose();
  });

  it("fails fast without the host core instead of running split-brain", () => {
    const ctx = realmContext(ROUTE);
    expect(() => applyPreset(ctx, { enabled: true, sidecarDir: tempDir() })).toThrow(
      /no shared core.*host row/,
    );
  });

  it("shares the loader schema with the host row", async () => {
    const { Config: hostConfig } = await import("../src/plugin.ts");
    expect(Config).toBe(hostConfig);
  });

  it("provides the realm backend against the shared host core", async () => {
    const dir = tempDir();
    const { ctx: host, stop: stopHost } = await hostContext(ROUTE, [], dir);
    const realm = realmContext(ROUTE);
    try {
      // Backend-only: the realm never gets the recall registries, so there
      // is no tools service to even query here.
      expect((realm as unknown as { tools?: unknown }).tools).toBeUndefined();
      expect((realm as unknown as { commands?: unknown }).commands).toBeUndefined();
      const stopPreset = applyPreset(realm, { enabled: true, sidecarDir: dir });
      try {
        expect((realm as unknown as { compaction?: unknown }).compaction).toBeInstanceOf(
          LosslessSummarizerEngine,
        );
        expect((host as unknown as { compaction?: unknown }).compaction).toBeInstanceOf(
          LosslessSummarizerEngine,
        );
        // Still backend-only after mount: no recall tools, no command.
        expect((realm as unknown as { tools?: unknown }).tools).toBeUndefined();
        expect((realm as unknown as { commands?: unknown }).commands).toBeUndefined();
      } finally {
        stopPreset();
      }
    } finally {
      stopHost();
    }
  });

  it("leaves shared handles open while the host still holds the core", async () => {
    const dir = tempDir();
    const { ctx: host, stop: stopHost } = await hostContext(ROUTE, [textChunks(SUMMARY)], dir);
    try {
      const session = host.sessions.create(SessionId("shared-1"), { meta: { cwd: dir } });
      appendConversation(session, ROUTE, "shared notes ".repeat(20));
      session.append("turn/start", { turn: 3 });
      const realm = realmContext(ROUTE);
      const stopPreset = applyPreset(realm, { enabled: true, sidecarDir: dir });
      try {
        const hostStore = engineDepsOf(
          (host as unknown as { compaction: LosslessSummarizerEngine }).compaction,
        ).store("shared-1") as LcmStore;
        const realmStore = engineDepsOf(
          (realm as unknown as { compaction: LosslessSummarizerEngine }).compaction,
        ).store("shared-1");
        expect(realmStore).toBeDefined();
        expect(realmStore).toBe(hostStore);
        expect(hostStore.allMessages().length).toBeGreaterThan(0);
      } finally {
        stopPreset();
      }
      // The preset disposer leaves shared handles open and readable.
      const kept = engineDepsOf(
        (host as unknown as { compaction: LosslessSummarizerEngine }).compaction,
      ).store("shared-1") as LcmStore;
      expect(kept.allMessages().length).toBeGreaterThan(0);
    } finally {
      stopHost();
    }
  });

  it("holds the core while a realm borrows it, and drops it after", async () => {
    const dir = tempDir();
    const { ctx: host, stop: stopHost } = await hostContext(ROUTE, [textChunks(SUMMARY)], dir);
    const session = host.sessions.create(SessionId("borrowed-1"), { meta: { cwd: dir } });
    appendConversation(session, ROUTE, "borrowed notes ".repeat(20));
    session.append("turn/start", { turn: 3 });
    const realm = realmContext(ROUTE);
    const stopPreset = applyPreset(realm, { enabled: true, sidecarDir: dir });
    try {
      stopHost();
      // The host dispose released its ownership but skipped every shared
      // close for the live borrower, so the realm still reads.
      const kept = engineDepsOf(
        (realm as unknown as { compaction: LosslessSummarizerEngine }).compaction,
      ).store("borrowed-1") as LcmStore;
      expect(kept.allMessages().length).toBeGreaterThan(0);
      // The entry stays for the borrower: another realm mount still finds it.
      const realm2 = realmContext(ROUTE);
      const stopPreset2 = applyPreset(realm2, { enabled: true, sidecarDir: dir });
      stopPreset2();
    } finally {
      stopPreset();
    }
  });

  it("ignores a stale disposer after a remount on the same directory", async () => {
    const dir = tempDir();
    const first = await hostContext(ROUTE, [], dir);
    first.stop();
    const second = await hostContext(ROUTE, [], dir);
    first.stop();
    // The replacement host still serves: the stale dispose changed nothing.
    const session = second.ctx.sessions.create(SessionId("remount-1"), { meta: { cwd: dir } });
    appendConversation(session, ROUTE, "remount notes ".repeat(20));
    session.append("turn/start", { turn: 3 });
    const realm = realmContext(ROUTE);
    try {
      expect(() => applyPreset(realm, { enabled: true, sidecarDir: dir })).not.toThrow();
      const store = engineDepsOf(
        (second.ctx as unknown as { compaction: LosslessSummarizerEngine }).compaction,
      ).store("remount-1") as LcmStore;
      expect(store.allMessages().length).toBeGreaterThan(0);
    } finally {
      second.stop();
    }
  });

  it("closes idle shared stores when the preset release is the last one", async () => {
    const dir = tempDir();
    const { ctx: host, stop: stopHost } = await hostContext(ROUTE, [textChunks(SUMMARY)], dir);
    const session = host.sessions.create(SessionId("shared-last-1"), { meta: { cwd: dir } });
    appendConversation(session, ROUTE, "shared last ".repeat(20));
    session.append("turn/start", { turn: 3 });
    const realm = realmContext(ROUTE);
    const stopPreset = applyPreset(realm, { enabled: true, sidecarDir: dir });
    const originalClose = Reflect.get(LcmStore.prototype, "close") as (this: LcmStore) => void;
    let closes = 0;
    Reflect.set(LcmStore.prototype, "close", function (this: LcmStore): void {
      closes += 1;
      Reflect.apply(originalClose, this, []);
    });
    try {
      stopHost();
      expect(closes).toBe(0);
      stopPreset();
      expect(closes).toBeGreaterThan(0);
    } finally {
      Reflect.set(LcmStore.prototype, "close", originalClose);
    }
  });

  it("rejects a preset sidecar directory that differs from the host core", async () => {
    const { stop: stopHost } = await hostContext(ROUTE, [], tempDir());
    const realm = realmContext(ROUTE);
    try {
      expect(() => applyPreset(realm, { enabled: true, sidecarDir: tempDir() })).toThrow(
        /no shared core/,
      );
    } finally {
      stopHost();
    }
  });

  it("closes idle stores on the last host dispose", async () => {
    const dir = tempDir();
    const { ctx: host, stop: stopHost } = await hostContext(ROUTE, [], dir);
    const session = host.sessions.create(SessionId("owned-1"), { meta: { cwd: dir } });
    appendConversation(session, ROUTE, "owned notes ".repeat(20));
    session.append("turn/start", { turn: 3 });
    const originalClose = Reflect.get(LcmStore.prototype, "close") as (this: LcmStore) => void;
    let closes = 0;
    Reflect.set(LcmStore.prototype, "close", function (this: LcmStore): void {
      closes += 1;
      Reflect.apply(originalClose, this, []);
    });
    try {
      stopHost();
      expect(closes).toBeGreaterThan(0);
    } finally {
      Reflect.set(LcmStore.prototype, "close", originalClose);
    }
    // Closed cleanly and the data survived for reopen.
    const reopened = new LcmStore(join(dir, "owned-1.sqlite"));
    try {
      expect(reopened.allMessages().length).toBeGreaterThan(0);
    } finally {
      reopened.close();
    }
  });
});
