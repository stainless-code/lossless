import { Context } from "@deepseek-ai/cordis";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { createMessage, createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { LcmStore } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import {
  LosslessSummarizerEngine,
  SpanAlreadyMemoryError,
  checkpointMemory,
} from "../src/engine.ts";
import type { LosslessEngineDeps } from "../src/engine.ts";
import { MessageIndex, mirrorEvent } from "../src/ingest.ts";
import type { DshRoute } from "../src/model-host.ts";
import { fakeAgent } from "./support/agent-fake.ts";
import { appendConversation } from "./support/conversation.ts";
import { setupContext, textChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };
const SUMMARY = "Checkpoint: engine work started and the config was read.";

function buildSession(text: string): Session {
  const session = Session.create(SessionId("engine-1"));
  appendConversation(session, ROUTE, text);
  // The engine writes automatic compaction events into an open turn.
  session.append("turn/start", { turn: 3 });
  return session;
}

function mountMeter(ctx: Context): void {
  new SessionProjectionRegistry(ctx);
  void new TokenMeter(ctx);
}

const identity = (text: string): string => text;

describe("LosslessSummarizerEngine", () => {
  function engineFor(
    ctx: Context,
    store: LcmStore,
    index: MessageIndex,
    extra?: Pick<LosslessEngineDeps, "bracketAuto" | "memory">,
  ): LosslessSummarizerEngine {
    return new LosslessSummarizerEngine(
      ctx,
      { auto: false },
      { store: () => store, index: () => index, redact: identity, ...extra },
    );
  }

  it("compacts a region through the ladder and stores leaves in the sidecar", async () => {
    const session = buildSession("working notes ".repeat(20));
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
    ]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const engine = new LosslessSummarizerEngine(
      ctx,
      { auto: false },
      { store: () => store, index: () => index, redact: identity },
    );
    const nodes = session.surface.nodes;
    const before = session.deriveMessages().length;
    const result = await engine.compactRegion(nodes[1]!, nodes[nodes.length - 1]!, agent);
    expect(result.summary).toHaveLength(1);
    expect(result.summary[0]?.type).toBe("text");
    const summaryEvent = session
      .snapshotEvents()
      .find((event) => event.type === "compaction/summary");
    expect(summaryEvent?.data.provider).toBe(ROUTE.provider);
    expect(summaryEvent?.data.model).toBe(ROUTE.model);
    expect(summaryEvent?.data.usage?.outputTokens).toBeGreaterThan(0);
    expect(result.shadowedSeqs.length).toBeGreaterThan(0);
    const derived = session.deriveMessages();
    expect(derived.length).toBeLessThan(before);
    expect(
      derived.some((message) =>
        message.content.some((block) => block.type === "text" && block.text.includes(SUMMARY)),
      ),
    ).toBe(true);
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    expect(store.allSummaries().length).toBeGreaterThan(0);
    expect(store.allMessages().some((row) => row.text.includes(SUMMARY))).toBe(true);
    const checkpoint = derived.find((message) =>
      message.content.some((block) => block.type === "text" && block.text.includes(SUMMARY)),
    );
    const refs = checkpoint
      ? checkpoint.content.flatMap((block) =>
          block.type === "text" ? [...block.text.matchAll(/\[lcm:summary #(\d+)\]/g)] : [],
        )
      : [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(store.getSummary(Number(ref[1]))).toBeDefined();
    }
  });

  it("carries the previous checkpoint into the next ladder", async () => {
    const session = buildSession("carryover notes ".repeat(20));
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const FIRST = "First checkpoint alpha.";
    const SECOND = "Second checkpoint beta.";
    const { ctx } = setupContext(ROUTE, [
      textChunks(FIRST),
      textChunks(SECOND),
      textChunks(SECOND),
    ]);
    mountMeter(ctx);
    const memory = checkpointMemory();
    const agent = fakeAgent(session, ROUTE);
    const engine = new LosslessSummarizerEngine(
      ctx,
      { auto: false },
      { store: () => store, index: () => index, memory, redact: identity, summaryTokens: 40 },
    );
    const nodes = session.surface.nodes;
    const first = await engine.compactRegion(nodes[1]!, nodes[2]!, agent);
    const firstBlock = first.summary[0];
    if (!firstBlock || firstBlock.type !== "text") throw new Error("first summary is not text");
    expect(firstBlock.text).toContain(FIRST);
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const afterFirst = session.surface.nodes;
    const second = await engine.compactRegion(
      afterFirst[1]!,
      afterFirst[afterFirst.length - 1]!,
      agent,
    );
    const secondBlock = second.summary[0];
    if (!secondBlock || secondBlock.type !== "text") throw new Error("second summary is not text");
    expect(secondBlock.text).toContain(SECOND);
    expect(secondBlock.text.startsWith(firstBlock.text)).toBe(true);
  });

  it("rejects an already-covered span as memory instead of failing the summary", async () => {
    const session = buildSession("covered live ".repeat(30));
    // A third turn inside the open turn 3: rows the later checkpoint lands
    // after, which is what makes them covered-but-live intruders.
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: `${"covered live ".repeat(30)} third request` }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    session.append("step/start", { turn: 3, step: 1 });
    session.append("request/header", {
      header: { config: { provider: ROUTE.provider, model: ROUTE.model } },
      reason: "initial",
    });
    session.append(
      "assistant/message",
      {
        stream: [],
        turn: 3,
        step: 1,
        message: createMessage({
          role: "assistant",
          content: [{ type: "text", text: `${"covered live ".repeat(30)} third response` }],
          source: { kind: "model", provider: ROUTE.provider, model: ROUTE.model },
        }),
      },
      { surfaceOp: "append" },
    );
    session.append("step/end", { turn: 3, step: 1 });
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [
      textChunks("First span."),
      textChunks("Second span."),
      textChunks("Third span."),
    ]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const engine = new LosslessSummarizerEngine(
      ctx,
      { auto: false },
      {
        store: () => store,
        index: () => index,
        memory: checkpointMemory(),
        redact: identity,
        summaryTokens: 40,
      },
    );
    const nodes = session.surface.nodes;
    await engine.compactRegion(nodes[1]!, nodes[2]!, agent);
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const afterFirst = session.surface.nodes;
    await engine.compactRegion(afterFirst[1]!, afterFirst[3]!, agent);
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const covered = session.surface.nodes;
    const before = session.deriveMessages().length;
    await expect(
      engine.compactRegion(covered[covered.length - 2]!, covered[covered.length - 1]!, agent),
    ).rejects.toThrow(SpanAlreadyMemoryError);
    expect(session.deriveMessages().length).toBe(before);
  });

  it("fails closed when the span is not mirrored", async () => {
    const session = buildSession("unmirrored notes ".repeat(20));
    const store = new LcmStore(":memory:");
    const { ctx } = setupContext(ROUTE, [textChunks(SUMMARY)]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const engine = new LosslessSummarizerEngine(
      ctx,
      { auto: false },
      { store: () => store, index: () => new MessageIndex(), redact: identity },
    );
    const nodes = session.surface.nodes;
    await expect(engine.compactRegion(nodes[1]!, nodes[nodes.length - 1]!, agent)).rejects.toThrow(
      "has no sidecar row",
    );
  });

  describe("compactNow", () => {
    // The durability flush needs a live session, so these build on
    // ctx.sessions instead of the detached buildSession helper.
    function idleSession(ctx: Context, id: string, text: string): Session {
      const session = ctx.sessions.create(SessionId(id));
      appendConversation(session, ROUTE, text);
      session.append("turn/start", { turn: 3 });
      session.append("turn/end", { turn: 3, reason: { kind: "completed" } });
      return session;
    }

    it("commits the manual path through the DAG bracket", async () => {
      const { ctx } = setupContext(ROUTE, [
        textChunks(SUMMARY),
        textChunks(SUMMARY),
        textChunks(SUMMARY),
        textChunks(SUMMARY),
        textChunks(SUMMARY),
      ]);
      mountMeter(ctx);
      void new SessionStore(ctx);
      const session = idleSession(ctx, "compact-now-1", "manual notes ".repeat(20));
      const store = new LcmStore(":memory:");
      const index = new MessageIndex();
      for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
      const before = session.deriveMessages().length;
      const result = await engineFor(ctx, store, index).compactNow(
        fakeAgent(session, ROUTE),
        new AbortController().signal,
      );
      expect(result).not.toBeNull();
      expect(result?.shadowedSeqs.length).toBeGreaterThan(0);
      expect(result?.summarySeqs).toHaveLength((result?.leafSeqs.length ?? 0) + 1);
      expect(result?.summarySeq).toBe(result?.summarySeqs[0]);
      expect(session.deriveMessages().length).toBeLessThan(before);
      const events = session.snapshotEvents();
      expect(events.filter((event) => event.type === "compaction/start")).toHaveLength(1);
      const ends = events.filter((event) => event.type === "compaction/end");
      expect(ends).toHaveLength(1);
      expect(ends[0]?.type).toBe("compaction/end");
    });

    it("returns null when no safe range exists", async () => {
      const session = Session.create(SessionId("compact-now-empty"));
      session.append(
        "system/message",
        { turn: 1, step: 1, message: createSystemMessage("You are a test.") },
        { surfaceOp: "append" },
      );
      const { ctx } = setupContext(ROUTE, []);
      mountMeter(ctx);
      void new SessionStore(ctx);
      const result = await engineFor(ctx, new LcmStore(":memory:"), new MessageIndex()).compactNow(
        fakeAgent(session, ROUTE),
        new AbortController().signal,
      );
      expect(result).toBeNull();
    });

    it("reports busy when the session still has an open turn", async () => {
      const session = buildSession("open turn ".repeat(20));
      const { ctx } = setupContext(ROUTE, []);
      mountMeter(ctx);
      void new SessionStore(ctx);
      const failure = await engineFor(ctx, new LcmStore(":memory:"), new MessageIndex())
        .compactNow(fakeAgent(session, ROUTE), new AbortController().signal)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ManualCompactionError);
      expect((failure as ManualCompactionError).code).toBe("busy");
    });

    it("reports busy when the agent refuses maintenance", async () => {
      const { ctx } = setupContext(ROUTE, []);
      mountMeter(ctx);
      void new SessionStore(ctx);
      const session = idleSession(ctx, "compact-now-4", "refused notes ".repeat(20));
      const agent = {
        ...fakeAgent(session, ROUTE),
        runMaintenance(): Promise<never> {
          throw new Error("waking work queued");
        },
      };
      // A synchronous admission refusal throws before any promise exists,
      // so .catch cannot see it; take it with try/catch instead.
      let failure: unknown;
      try {
        await engineFor(ctx, new LcmStore(":memory:"), new MessageIndex()).compactNow(
          agent,
          new AbortController().signal,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ManualCompactionError);
      expect((failure as ManualCompactionError).code).toBe("busy");
    });

    describe("checkpointMemory", () => {
      it("hydrates the last checkpoint from the sidecar on a fresh instance", async () => {
        const { ctx } = setupContext(ROUTE, [
          textChunks(SUMMARY),
          textChunks(SUMMARY),
          textChunks(SUMMARY),
          textChunks(SUMMARY),
          textChunks(SUMMARY),
        ]);
        mountMeter(ctx);
        void new SessionStore(ctx);
        const sessionId = "compact-memory-1";
        const session = idleSession(ctx, sessionId, "hydrated notes ".repeat(20));
        const store = new LcmStore(":memory:");
        const index = new MessageIndex();
        for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
        const first = checkpointMemory(() => store);
        const engine = engineFor(ctx, store, index, { memory: first });
        const result = await engine.compactNow(
          fakeAgent(session, ROUTE),
          new AbortController().signal,
        );
        expect(result).not.toBeNull();
        const noted = first.previous(sessionId);
        expect(noted).toBeDefined();
        // A fresh instance over the same sidecar rebuilds continuity: the
        // narrative plus refs that all resolve. (A single-leaf run replaces
        // its row's text on condensation, so the rebuilt text is the stored
        // form, not byte-identical to the noted form.)
        const resumed = checkpointMemory(() => store);
        const rebuilt = resumed.previous(sessionId);
        expect(rebuilt).toBeDefined();
        expect(rebuilt).toContain("Checkpoint: engine work started");
        const ids = [...rebuilt!.matchAll(/\[lcm:summary #(\d+)\]/g)].map((match) =>
          Number(match[1]),
        );
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(store.getSummary(id)).toBeDefined();
        // And a new checkpoint overwrites the hydrated text.
        resumed.note(sessionId, "fresh checkpoint");
        expect(resumed.previous(sessionId)).toBe("fresh checkpoint");
      });

      it("stays absent without a store or without a condensed summary", () => {
        expect(checkpointMemory().previous("ghost")).toBeUndefined();
        expect(checkpointMemory(() => new LcmStore(":memory:")).previous("ghost")).toBeUndefined();
      });
    });

    it("reports cancelled when the maintenance signal aborts", async () => {
      // No scripts: the first ladder call fails past the aborted signal.
      const { ctx } = setupContext(ROUTE, []);
      mountMeter(ctx);
      void new SessionStore(ctx);
      const session = idleSession(ctx, "compact-now-5", "cancelled notes ".repeat(20));
      const store = new LcmStore(":memory:");
      const index = new MessageIndex();
      for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
      const controller = new AbortController();
      controller.abort(new Error("waking"));
      const agent = {
        ...fakeAgent(session, ROUTE),
        runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
          return task(controller.signal);
        },
      };
      const failure = await engineFor(ctx, store, index)
        .compactNow(agent, new AbortController().signal)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ManualCompactionError);
      expect((failure as ManualCompactionError).code).toBe("cancelled");
    });
  });

  describe("compactRegion with bracketAuto", () => {
    it("commits the auto path through the bracket on an open turn", async () => {
      const session = buildSession("auto bracket ".repeat(20));
      const store = new LcmStore(":memory:");
      const index = new MessageIndex();
      for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
      const { ctx } = setupContext(ROUTE, [
        textChunks(SUMMARY),
        textChunks(SUMMARY),
        textChunks(SUMMARY),
        textChunks(SUMMARY),
        textChunks(SUMMARY),
      ]);
      mountMeter(ctx);
      const agent = fakeAgent(session, ROUTE);
      const engine = engineFor(ctx, store, index, { bracketAuto: true });
      const nodes = session.surface.nodes;
      const before = session.deriveMessages().length;
      const result = await engine.compactRegion(nodes[1]!, nodes[nodes.length - 1]!, agent);
      expect(result.shadowedSeqs.length).toBeGreaterThan(0);
      expect(result.summarySeq).toBeDefined();
      expect(session.deriveMessages().length).toBeLessThan(before);
      const summaries = session
        .snapshotEvents()
        .filter((event) => event.type === "compaction/summary");
      expect(summaries.length).toBeGreaterThan(1);
    });

    it("lets a ladder failure through unwrapped on the auto path", async () => {
      const session = buildSession("unmirrored auto ".repeat(20));
      const { ctx } = setupContext(ROUTE, [textChunks(SUMMARY)]);
      mountMeter(ctx);
      const agent = fakeAgent(session, ROUTE);
      const engine = engineFor(ctx, new LcmStore(":memory:"), new MessageIndex(), {
        bracketAuto: true,
      });
      const nodes = session.surface.nodes;
      const failure = await engine
        .compactRegion(nodes[1]!, nodes[nodes.length - 1]!, agent)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ManualCompactionError);
      expect(String((failure as Error).message)).toMatch(/sidecar holds no row/);
    });
  });

  it("lets the engine shrink check fire on a span the ladder cannot reduce", async () => {
    const session = buildSession("hi");
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
    ]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const engine = new LosslessSummarizerEngine(
      ctx,
      { auto: false },
      { store: () => store, index: () => index, redact: identity },
    );
    const nodes = session.surface.nodes;
    await expect(engine.compactRegion(nodes[1]!, nodes[nodes.length - 1]!, agent)).rejects.toThrow(
      "not smaller than the shadowed content",
    );
  });
});
