import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import { CommandId } from "@deepseek-ai/dsh-commands/brand";
import type { BasicCompactionConfig } from "@deepseek-ai/dsh-compaction-basic";
import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { LcmStore, TRUNCATED_SUMMARY_PREFIX, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { lcmCommandDefinition, type LcmCommandDeps } from "../src/command.ts";
import { LosslessSummarizerEngine } from "../src/engine.ts";
import type { LosslessEngineDeps } from "../src/engine.ts";
import { MessageIndex, mirrorEvent } from "../src/ingest.ts";
import { healLlmConfig, healRunBudgets, passLlmConfig, runLadder } from "../src/ladder.ts";
import type { DshRoute } from "../src/model-host.ts";
import { applyLossless } from "../src/plugin.ts";
import { fakeAgent } from "./support/agent-fake.ts";
import { appendConversation } from "./support/conversation.ts";
import { setupContext, textChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deepseek-lcm-cal-"));
}

async function mountBase(ctx: Context): Promise<void> {
  await ctx.plugin(SystemPrompt, {});
  void new ToolRuntime(ctx);
  void new CommandRuntime(ctx);
  void new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  void new TokenMeter(ctx);
}

function mountMeter(ctx: Context): void {
  new SessionProjectionRegistry(ctx);
  void new TokenMeter(ctx);
}

function engineOf(ctx: Context): LosslessSummarizerEngine {
  const engine = ctx.compaction as unknown as LosslessSummarizerEngine;
  expect(engine).toBeInstanceOf(LosslessSummarizerEngine);
  return engine;
}

const identity = (text: string): string => text;

describe("seam policy knobs", () => {
  it("forwards threshold, retain, headroom, and model policies into the resolved seam config", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dispose = applyLossless(ctx, {
      enabled: true,
      sidecarDir: tempDir(),
      thresholdRatio: 0.5,
      retainTokens: 100,
      headroomTokens: 4096,
      modelPolicies: [{ provider: ROUTE.provider, model: ROUTE.model, thresholdRatio: 0.9 }],
    });
    try {
      const config = engineOf(ctx).config;
      expect(config.thresholdRatio).toBe(0.5);
      expect(config.retainTokens).toBe(100);
      expect(config.headroomTokens).toBe(4096);
      expect(config.maxTokens).toBe(4096);
      expect(config.modelPolicies).toHaveLength(1);
      expect(config.modelPolicies[0]).toMatchObject({
        provider: ROUTE.provider,
        model: ROUTE.model,
        thresholdRatio: 0.9,
      });
    } finally {
      dispose();
    }
  });

  it("forwards the retain ratio form when set", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dispose = applyLossless(ctx, {
      enabled: true,
      sidecarDir: tempDir(),
      retainRatio: 0.1,
    });
    try {
      const config = engineOf(ctx).config;
      expect(config.retainRatio).toBe(0.1);
      expect(config.retainTokens).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("keeps seam defaults when the plugin config omits the knobs", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dispose = applyLossless(ctx, { enabled: true, sidecarDir: tempDir() });
    try {
      const config = engineOf(ctx).config;
      expect(config.thresholdRatio).toBe(0.8);
      expect(config.retainRatio).toBe(0.16);
      expect(config.retainTokens).toBeUndefined();
      expect(config.headroomTokens).toBe(65_536);
      expect(config.maxTokens).toBe(65_536);
      expect(config.modelPolicies).toEqual([]);
      expect(config.auto).toBe(false);
    } finally {
      dispose();
    }
  });

  it("rejects adapter-only keys on the seam config", async () => {
    const { ctx } = setupContext(ROUTE, []);
    mountMeter(ctx);
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    expect(
      () =>
        new LosslessSummarizerEngine(
          ctx,
          { auto: false, bracketAuto: true } as unknown as BasicCompactionConfig,
          { store: () => store, index: () => index, redact: identity },
        ),
    ).toThrow('unknown key "bracketAuto"');
  });
});

describe("summarizer caps", () => {
  it("leaves the pass llm config empty when caps are unset", () => {
    expect(passLlmConfig({})).toEqual({});
    expect(healLlmConfig({})).toEqual({ summarizerTokensPerPass: 120_000 });
    expect(healRunBudgets({})).toEqual({
      maxTokens: 120_000,
      targetTokens: 1500,
      callBudgetTokens: 60_000,
    });
  });

  it("records a capped run through a tiny per-call cap", async () => {
    const session = Session.create(SessionId("cap-1"));
    appendConversation(session, ROUTE, "working notes ".repeat(20));
    session.append("turn/start", { turn: 3 });
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [textChunks("never used")]);
    mountMeter(ctx);
    const rows: Record<string, unknown>[] = [];
    const engine = new LosslessSummarizerEngine(
      ctx,
      { auto: false },
      {
        store: () => store,
        index: () => index,
        redact: identity,
        summarizerTokensPerCall: 10,
        record: (row) => rows.push(row),
      },
    );
    const nodes = session.surface.nodes;
    // A refused pass stores nothing billable, so the run may succeed
    // mechanical or fail the shrink check; the capped row is the assertion.
    await engine
      .compactRegion(nodes[1]!, nodes[nodes.length - 1]!, fakeAgent(session, ROUTE))
      .catch(() => undefined);
    const capped = rows.filter((row) => row.kind === "summarizer-capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({ reason: "call", budgetTokens: 10 });
  });
});

describe("summarizer budgets", () => {
  function losslessOf(ctx: Context): LosslessEngineDeps {
    const engine = engineOf(ctx);
    return (engine as unknown as { lossless: LosslessEngineDeps }).lossless;
  }

  it("forwards non-empty budgets through plugin wiring", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dispose = applyLossless(ctx, {
      enabled: true,
      sidecarDir: tempDir(),
      summaryTokens: 40,
      leafChunkTokens: 500,
      summarizerTokensPerPass: 1_000,
      summarizerTokensPerHeal: 2_000,
    });
    try {
      const lossless = losslessOf(ctx);
      expect(lossless.summaryTokens).toBe(40);
      expect(lossless.leafChunkTokens).toBe(500);
      expect(lossless.summarizerTokensPerPass).toBe(1_000);
      expect(lossless.summarizerTokensPerHeal).toBe(2_000);
      expect(passLlmConfig(lossless)).toEqual({ summarizerTokensPerPass: 1_000 });
      expect(healLlmConfig(lossless)).toEqual({ summarizerTokensPerPass: 2_000 });
      expect(healRunBudgets(lossless)).toMatchObject({ maxTokens: 2_000, targetTokens: 40 });
    } finally {
      dispose();
    }
  });

  it("keeps bracketAuto off unless configured", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dispose = applyLossless(ctx, { enabled: true, sidecarDir: tempDir() });
    try {
      expect(losslessOf(ctx).bracketAuto ?? false).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe("mechanical tools", () => {
  const TOOL_TEXT = `tool noisy-read {"path":"/a"}\n${"x".repeat(2000)}`;

  function toolSpan(
    sessionId: string,
  ): Array<{ entryId: string; role: "toolResult"; text: string }> {
    return [
      { entryId: `${sessionId}:1`, role: "toolResult", text: TOOL_TEXT },
      { entryId: `${sessionId}:2`, role: "toolResult", text: TOOL_TEXT },
    ];
  }

  it("compacts a listed tool-only span with zero model calls", async () => {
    const { ctx, adapter } = setupContext(ROUTE, []);
    const store = new LcmStore(":memory:");
    try {
      const outcome = await runLadder(
        ctx,
        {
          store: () => store,
          index: () => new MessageIndex(),
          redact: identity,
          mechanicalTools: ["noisy-read"],
        },
        ROUTE,
        "mech-listed",
        toolSpan("mech-listed"),
      );
      expect(adapter.requests).toHaveLength(0);
      expect(outcome.leafSummaryIds.length).toBeGreaterThan(0);
      for (const id of outcome.leafSummaryIds) {
        expect(store.getSummary(id)?.quality).toBe("mechanical");
      }
    } finally {
      store.close();
    }
  });

  it("still calls the model for unlisted tools", async () => {
    const { ctx, adapter } = setupContext(ROUTE, [
      textChunks("prose summary"),
      textChunks("prose summary"),
      textChunks("prose summary"),
      textChunks("prose summary"),
    ]);
    const store = new LcmStore(":memory:");
    try {
      await runLadder(
        ctx,
        {
          store: () => store,
          index: () => new MessageIndex(),
          redact: identity,
          mechanicalTools: ["other-tool"],
        },
        ROUTE,
        "mech-unlisted",
        toolSpan("mech-unlisted"),
      );
      expect(adapter.requests.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("keeps the LLM path when the list is empty or unset", async () => {
    for (const mechanicalTools of [undefined, []] as const) {
      const { ctx, adapter } = setupContext(ROUTE, [
        textChunks("prose summary"),
        textChunks("prose summary"),
        textChunks("prose summary"),
        textChunks("prose summary"),
      ]);
      const store = new LcmStore(":memory:");
      try {
        await runLadder(
          ctx,
          {
            store: () => store,
            index: () => new MessageIndex(),
            redact: identity,
            ...(mechanicalTools === undefined ? {} : { mechanicalTools }),
          },
          ROUTE,
          "mech-default",
          toolSpan("mech-default"),
        );
        expect(adapter.requests.length).toBeGreaterThan(0);
      } finally {
        store.close();
      }
    }
  });

  it("forwards the plugin list and drops an empty one", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dispose = applyLossless(ctx, {
      enabled: true,
      sidecarDir: tempDir(),
      mechanicalTools: ["noisy-read", " noisy-read ", ""],
    });
    try {
      expect(losslessDepsOf(ctx).mechanicalTools).toEqual(["noisy-read"]);
    } finally {
      dispose();
    }
    const again = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(again.ctx);
    const disposeEmpty = applyLossless(again.ctx, {
      enabled: true,
      sidecarDir: tempDir(),
      mechanicalTools: [],
    });
    try {
      expect(losslessDepsOf(again.ctx).mechanicalTools).toBeUndefined();
    } finally {
      disposeEmpty();
    }
  });

  function losslessDepsOf(ctx: Context): LosslessEngineDeps {
    const engine = engineOf(ctx);
    return (engine as unknown as { lossless: LosslessEngineDeps }).lossless;
  }
});

describe("heal source default", () => {
  function depsFor(dir: string, stores: Map<string, LcmStore>, extra?: Partial<LcmCommandDeps>) {
    return {
      stores: () => stores,
      storeFor: (sessionId: string) => {
        let store = stores.get(sessionId);
        if (!store) {
          store = new LcmStore(join(dir, `${sessionId}.sqlite`));
          stores.set(sessionId, store);
        }
        return store;
      },
      sidecarDir: dir,
      storePathFor: (sessionId: string) => join(dir, `${sessionId}.sqlite`),
      ...extra,
    };
  }

  function seedHealTarget(store: LcmStore): void {
    ingestEntries(
      store,
      [
        `heal source alpha ${"detail ".repeat(60)}`,
        `heal source beta ${"context ".repeat(60)}`,
      ].map((text, i) => ({
        entryId: `e${String(i).padStart(2, "0")}`,
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        text,
        timestamp: i,
      })),
    );
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
  }

  async function dryHeal(
    sessionId: string,
    extra?: Partial<LcmCommandDeps>,
  ): Promise<{ kind: string; text?: string }> {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId(sessionId), { meta: { cwd: dir } });
    const stores = new Map<string, LcmStore>();
    const deps = depsFor(dir, stores, extra);
    seedHealTarget(deps.storeFor(sessionId));
    const definition = lcmCommandDefinition(ctx, deps);
    return definition.handler({
      agent: fakeAgent(ctx.sessions.get(SessionId(sessionId))!, ROUTE),
      signal: new AbortController().signal,
      commandId: CommandId("cmd-heal"),
      rawInput: "heal",
      attachments: [],
    }) as Promise<{ kind: string; text?: string }>;
  }

  it("derives 8x the summary target when the source window is unset", async () => {
    const dry = await dryHeal("heal-default");
    expect(dry.kind).toBe("success");
    expect(dry.text).toContain("12000 source tokens");
  });

  it("clamps a small summary target to the 3000 floor", async () => {
    const dry = await dryHeal("heal-floor", { summaryTokens: 40 });
    expect(dry.kind).toBe("success");
    expect(dry.text).toContain("3000 source tokens");
  });

  it("honors an explicit heal source window", async () => {
    const dry = await dryHeal("heal-explicit", { healSourceTokens: 5000 });
    expect(dry.kind).toBe("success");
    expect(dry.text).toContain("5000 source tokens");
  });
});
