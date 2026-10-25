import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import { CommandId } from "@deepseek-ai/dsh-commands/brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { LcmStore } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { lcmCommandDefinition } from "../src/command.ts";
import { LosslessSummarizerEngine } from "../src/engine.ts";
import type { DshRoute } from "../src/model-host.ts";
import { applyLossless } from "../src/plugin.ts";
import { fakeAgent } from "./support/agent-fake.ts";
import { appendConversation } from "./support/conversation.ts";
import { setupContext, textChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };
const SUMMARY = "Checkpoint: engine work started and the config was read.";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deepseek-lossless-"));
}

async function mountBase(ctx: Context): Promise<void> {
  await ctx.plugin(SystemPrompt, {});
  void new ToolRuntime(ctx);
  void new CommandRuntime(ctx);
  void new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  void new TokenMeter(ctx);
}

function sidecarMap(dir: string): Map<string, LcmStore> {
  const map = new Map<string, LcmStore>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".sqlite")) continue;
    map.set(file.slice(0, -".sqlite".length), new LcmStore(join(dir, file)));
  }
  return map;
}

describe("applyLossless", () => {
  it("registers nothing until enabled", async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, {});
    void new ToolRuntime(ctx);
    const dir = join(tempDir(), "never-created");
    const dispose = applyLossless(ctx, { sidecarDir: dir });
    expect(ctx.tools.schemas().map((schema) => schema.name)).not.toContain("lcm_grep");
    expect(existsSync(dir)).toBe(false);
    dispose();
  });

  it("mounts the engine, the tools, and the live mirror", async () => {
    const { ctx } = setupContext(ROUTE, [textChunks(SUMMARY)], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    const dispose = applyLossless(ctx, { enabled: true, sidecarDir: dir });
    try {
      expect(ctx.compaction).toBeInstanceOf(LosslessSummarizerEngine);
      expect(ctx.tools.schemas().map((schema) => schema.name)).toContain("lcm_grep");
      const session = ctx.sessions.create(SessionId("live-1"), { meta: { cwd: dir } });
      appendConversation(session, ROUTE, "live notes ".repeat(20));
      session.append("turn/start", { turn: 3 });
      const map = sidecarMap(dir);
      expect(map.has("live-1")).toBe(true);
      expect(map.get("live-1")?.allMessages().length).toBe(session.deriveMessages().length);
      const definition = lcmCommandDefinition(ctx, {
        stores: () => map,
        sidecarDir: dir,
        storePathFor: (sessionId) => join(dir, `${sessionId}.sqlite`),
      });
      const status = await definition.handler({
        agent: fakeAgent(session, ROUTE),
        signal: new AbortController().signal,
        commandId: CommandId("cmd-status"),
        rawInput: "status",
        attachments: [],
      });
      expect(status.kind).toBe("success");
      if (status.kind !== "success") throw new Error("status did not succeed");
      expect(status.text).toContain("live-1");
    } finally {
      dispose();
    }
  });

  it("dispose closes every open sidecar and stays safe to run twice", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    const dispose = applyLossless(ctx, { enabled: true, sidecarDir: dir });
    const originalClose = Reflect.get(LcmStore.prototype, "close") as (this: LcmStore) => void;
    let closes = 0;
    LcmStore.prototype.close = function (this: LcmStore): void {
      closes += 1;
      Reflect.apply(originalClose, this, []);
    };
    try {
      const session = ctx.sessions.create(SessionId("close-1"), { meta: { cwd: dir } });
      appendConversation(session, ROUTE, "close me ".repeat(20));
      session.append("turn/start", { turn: 3 });
      const path = join(dir, "close-1.sqlite");
      expect(existsSync(path)).toBe(true);
      const mirrored = session.deriveMessages().length;
      expect(mirrored).toBeGreaterThan(0);
      dispose();
      expect(closes).toBeGreaterThan(0);
      dispose();
    } finally {
      LcmStore.prototype.close = originalClose;
    }
    const reopened = new LcmStore(join(dir, "close-1.sqlite"));
    try {
      const session = ctx.sessions.get(SessionId("close-1"));
      expect(reopened.allMessages().length).toBe(session?.deriveMessages().length);
    } finally {
      reopened.close();
    }
  });

  it("forces a manual compaction through /lcm compact", async () => {
    const { ctx } = setupContext(
      ROUTE,
      [textChunks(SUMMARY), textChunks(SUMMARY), textChunks(SUMMARY)],
      { contextWindow: 1_000_000 },
    );
    await mountBase(ctx);
    const dir = tempDir();
    const dispose = applyLossless(ctx, { enabled: true, sidecarDir: dir });
    try {
      const session = ctx.sessions.create(SessionId("live-2"), { meta: { cwd: dir } });
      appendConversation(session, ROUTE, "compact me ".repeat(30));
      session.append("turn/start", { turn: 3 });
      // Manual compaction runs on an idle session: close the turn first.
      session.append("turn/end", { turn: 3, reason: { kind: "completed" } });
      const before = session.deriveMessages().length;
      const definition = lcmCommandDefinition(ctx, {
        stores: () => sidecarMap(dir),
        sidecarDir: dir,
        storePathFor: (sessionId) => join(dir, `${sessionId}.sqlite`),
      });
      const result = await definition.handler({
        agent: fakeAgent(session, ROUTE),
        signal: new AbortController().signal,
        commandId: CommandId("cmd-compact"),
        rawInput: "compact",
        attachments: [],
      });
      if (result.kind !== "success") throw new Error(`compact failed: ${result.text}`);
      expect(result.text).toMatch(/Compacted \d+ history items/);
      expect(session.deriveMessages().length).toBeLessThan(before);
      const logSummaries = session
        .snapshotEvents()
        .filter(
          (event): event is Extract<SessionEvent, { type: "compaction/summary" }> =>
            event.type === "compaction/summary",
        );
      expect(logSummaries.length).toBeGreaterThan(1);
      expect(new Set(logSummaries.map((summary) => summary.data.compactionId)).size).toBe(1);
      const summaries = sidecarMap(dir).get("live-2")?.allSummaries() ?? [];
      expect(summaries.length).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });

  it("carries the checkpoint across two manual compactions", async () => {
    const { ctx } = setupContext(
      ROUTE,
      [textChunks(SUMMARY), textChunks(SUMMARY), textChunks(SUMMARY)],
      { contextWindow: 1_000_000 },
    );
    await mountBase(ctx);
    const dir = tempDir();
    const dispose = applyLossless(ctx, { enabled: true, sidecarDir: dir, summaryTokens: 40 });
    try {
      const session = ctx.sessions.create(SessionId("live-4"), { meta: { cwd: dir } });
      appendConversation(session, ROUTE, "carryover work ".repeat(30));
      session.append("turn/start", { turn: 3 });
      session.append("turn/end", { turn: 3, reason: { kind: "completed" } });
      const definition = lcmCommandDefinition(ctx, {
        stores: () => sidecarMap(dir),
        sidecarDir: dir,
        storePathFor: (sessionId) => join(dir, `${sessionId}.sqlite`),
      });
      const compact = (id: string) =>
        definition.handler({
          agent: fakeAgent(session, ROUTE),
          signal: new AbortController().signal,
          commandId: CommandId(id),
          rawInput: "compact",
          attachments: [],
        });
      const first = await compact("cmd-first");
      if (first.kind !== "success") throw new Error(`first compact failed: ${first.text}`);
      session.append("turn/start", { turn: 4 });
      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: `more work ${".".repeat(600)}` }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      session.append("turn/end", { turn: 4, reason: { kind: "completed" } });
      const second = await compact("cmd-second");
      if (second.kind !== "success") throw new Error(`second compact failed: ${second.text}`);
      const texts = (sidecarMap(dir).get("live-4")?.allMessages() ?? [])
        .map((row) => row.text)
        .filter((text) => text.includes(SUMMARY));
      const bodyOf = (text: string): string => {
        const open = "<compacted-summary>";
        const close = "</compacted-summary>";
        const start = text.indexOf(open);
        const end = text.indexOf(close);
        if (start === -1 || end <= start) throw new Error("checkpoint frame not found");
        return text.slice(start + open.length, end).trim();
      };
      const bodies = texts.map(bodyOf);
      const carryover = bodies.some((outer) =>
        bodies.some((inner) => outer !== inner && outer.includes(inner)),
      );
      expect(carryover).toBe(true);
    } finally {
      dispose();
    }
  });

  it("leaves a quiet session untouched on pressure", async () => {
    const { ctx } = setupContext(ROUTE, [textChunks(SUMMARY)], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    const dispose = applyLossless(ctx, { enabled: true, sidecarDir: dir });
    try {
      const session = ctx.sessions.create(SessionId("live-3"), { meta: { cwd: dir } });
      appendConversation(session, ROUTE, "quiet notes");
      session.append("turn/start", { turn: 3 });
      const eventsBefore = session.snapshotEvents().length;
      const result = await ctx.compaction.compactIfNeeded(
        fakeAgent(session, ROUTE),
        "pressure",
        new AbortController().signal,
      );
      expect(result).toBeNull();
      expect(session.snapshotEvents().length).toBe(eventsBefore);
    } finally {
      dispose();
    }
  });
});
