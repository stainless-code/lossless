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

  it("provides the realm backend against the shared host core", async () => {
    const dir = tempDir();
    const { ctx: host, stop: stopHost } = await hostContext(ROUTE, [], dir);
    const realm = realmContext(ROUTE);
    try {
      // Backend-only: the realm never gets the recall registries, so there
      // is no tools service to even query here.
      expect((realm as unknown as { tools?: unknown }).tools).toBeUndefined();
      const stopPreset = applyPreset(realm, { enabled: true, sidecarDir: dir });
      try {
        expect((realm as unknown as { compaction?: unknown }).compaction).toBeInstanceOf(
          LosslessSummarizerEngine,
        );
        expect((host as unknown as { compaction?: unknown }).compaction).toBeInstanceOf(
          LosslessSummarizerEngine,
        );
      } finally {
        stopPreset();
      }
    } finally {
      stopHost();
    }
  });

  it("shares sidecar handles with the host core and never closes them", async () => {
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
        ).store("shared-1");
        const realmStore = engineDepsOf(
          (realm as unknown as { compaction: LosslessSummarizerEngine }).compaction,
        ).store("shared-1");
        expect(realmStore).toBeDefined();
        expect(realmStore).toBe(hostStore);
      } finally {
        stopPreset();
      }
      // The preset disposer leaves shared handles open; the host still reads.
      expect(() =>
        engineDepsOf(
          (host as unknown as { compaction: LosslessSummarizerEngine }).compaction,
        ).store("shared-1"),
      ).not.toThrow();
    } finally {
      stopHost();
    }
  });

  it("ignores a stale disposer after a remount on the same directory", async () => {
    const dir = tempDir();
    const { stop: stopA } = await hostContext(ROUTE, [], dir);
    stopA();
    const { stop: stopB } = await hostContext(ROUTE, [], dir);
    stopA();
    const realm = realmContext(ROUTE);
    try {
      expect(() => applyPreset(realm, { enabled: true, sidecarDir: dir })).not.toThrow();
    } finally {
      stopB();
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

  it("keeps the host dispose ownership: idle stores close on host dispose", async () => {
    const dir = tempDir();
    const { ctx: host, stop: stopHost } = await hostContext(ROUTE, [], dir);
    const session = host.sessions.create(SessionId("owned-1"), { meta: { cwd: dir } });
    appendConversation(session, ROUTE, "owned notes ".repeat(20));
    session.append("turn/start", { turn: 3 });
    const realm = realmContext(ROUTE);
    const stopPreset = applyPreset(realm, { enabled: true, sidecarDir: dir });
    stopPreset();
    stopHost();
    expect(existsSync(join(dir, "owned-1.sqlite"))).toBe(true);
  });
});
