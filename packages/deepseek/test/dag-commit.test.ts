import { Context } from "@deepseek-ai/cordis";
import { isCompactCheckpointSource, ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { createMessage, createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { LcmStore } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { commitDagTransaction, selectDagRange } from "../src/dag-commit.ts";
import type { DagCommitDeps } from "../src/dag-commit.ts";
import { LosslessSummarizerEngine } from "../src/engine.ts";
import { MessageIndex, mirrorEvent } from "../src/ingest.ts";
import { resolveSummarizationTarget, SpanAlreadyMemoryError } from "../src/ladder.ts";
import type { DshRoute } from "../src/model-host.ts";
import { fakeAgent } from "./support/agent-fake.ts";
import { appendConversation } from "./support/conversation.ts";
import { errorChunks, setupContext, textChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };
const SUMMARY = "Checkpoint: engine work started and the config was read.";

function buildSession(text: string): Session {
  const session = Session.create(SessionId("dag-commit-1"));
  appendConversation(session, ROUTE, text);
  session.append("turn/start", { turn: 3 });
  return session;
}

function mountMeter(ctx: Context): void {
  new SessionProjectionRegistry(ctx);
  void new TokenMeter(ctx);
}

function ofType<T extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

function deps(ctx: Context, store: LcmStore, index: MessageIndex): DagCommitDeps {
  return {
    ctx,
    summarizationProvider: "",
    summarizationModel: "",
    store: () => store,
    index: () => index,
    redact: (text) => text,
  };
}

describe("selectDagRange", () => {
  it("returns null when only the retained system head exists", () => {
    const session = Session.create(SessionId("dag-range-1"));
    session.append(
      "system/message",
      { turn: 1, step: 1, message: createSystemMessage("You are a test.") },
      { surfaceOp: "append" },
    );
    const { ctx } = setupContext(ROUTE, []);
    mountMeter(ctx);
    expect(selectDagRange(session, ctx.tokenMeter.measure(session), 0)).toBeNull();
  });

  it("starts after the system head and leaves the tail edge", () => {
    const session = buildSession("ranged notes ".repeat(20));
    const { ctx } = setupContext(ROUTE, []);
    mountMeter(ctx);
    const nodes = session.surface.nodes;
    const range = selectDagRange(session, ctx.tokenMeter.measure(session), 0);
    expect(range).not.toBeNull();
    expect(range?.start).toBe(nodes[1]);
    expect(range?.end).toBe(nodes[nodes.length - 2]);
  });

  it("fails closed when the surface moved under the measurement", () => {
    const session = buildSession("drift notes ".repeat(20));
    const { ctx } = setupContext(ROUTE, []);
    mountMeter(ctx);
    const measurement = ctx.tokenMeter.measure(session);
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: "drift intruder" }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    expect(() => selectDagRange(session, measurement, 0)).toThrow(/does not match/);
  });
});

describe("commitDagTransaction", () => {
  it("commits one condensed summary in a single bracket with leaves sidecar only", async () => {
    const session = buildSession("working notes ".repeat(20));
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
    ]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const nodes = session.surface.nodes;
    const before = session.deriveMessages().length;
    const result = await commitDagTransaction(
      deps(ctx, store, index),
      agent,
      { start: nodes[1]!, end: nodes[nodes.length - 1]! },
      { owner: "current-turn", stability: "whole-surface" },
    );
    expect(result.compactionId.length).toBeGreaterThan(0);
    expect(result.summarySeqs).toHaveLength(1);
    expect(result.summarySeqs[0]).toBe(result.summarySeq);
    expect(result.leafSeqs).toHaveLength(0);
    expect(result.leafSummaryIds.length).toBeGreaterThan(0);
    expect(result.leafSummaryIds.length + result.condensedSummaryIds.length).toBeGreaterThan(0);
    expect(result.startSeq).toBeLessThan(result.summarySeqs[0]!);
    expect(result.summarySeqs[result.summarySeqs.length - 1]!).toBeLessThan(result.endSeq);
    const events = session.snapshotEvents();
    const starts = ofType(events, "compaction/start");
    const ends = ofType(events, "compaction/end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]?.data.compactionId).toBe(result.compactionId);
    expect(ends[0]?.data.compactionId).toBe(result.compactionId);
    expect(ends[0]?.data.error).toBeUndefined();
    const summaries = ofType(events, "compaction/summary");
    expect(summaries).toHaveLength(1);
    expect(summaries).toHaveLength(result.summarySeqs.length);
    for (const summary of summaries) {
      expect(summary.data.compactionId).toBe(result.compactionId);
    }
    const checkpoints = ofType(events, "user/message").filter((event) =>
      isCompactCheckpointSource(event.data.source),
    );
    expect(checkpoints).toHaveLength(1);
    expect(session.deriveMessages().length).toBeLessThan(before);
    let depth = 0;
    for (const event of events) {
      if (event.type === "compaction/start") depth += 1;
      if (event.type === "compaction/end") depth -= 1;
    }
    expect(depth).toBe(0);
  });

  it("writes exactly one session log summary per bracket across two compactions", async () => {
    const session = buildSession("repeat notes ".repeat(20));
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
    ]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const firstNodes = session.surface.nodes;
    const first = await commitDagTransaction(
      deps(ctx, store, index),
      agent,
      { start: firstNodes[1]!, end: firstNodes[2]! },
      { owner: "current-turn", stability: "whole-surface" },
    );
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const pre = [...session.surface.nodes];
    const second = await commitDagTransaction(
      deps(ctx, store, index),
      agent,
      { start: pre[1]!, end: pre[pre.length - 1]! },
      { owner: "current-turn", stability: "whole-surface" },
    );
    const events = session.snapshotEvents();
    const summaries = ofType(events, "compaction/summary");
    expect(summaries).toHaveLength(2);
    expect(new Set(summaries.map((summary) => summary.data.compactionId)).size).toBe(2);
    expect(summaries.map((summary) => summary.seq)).toEqual([first.summarySeq, second.summarySeq]);
    expect(first.summarySeqs).toHaveLength(1);
    expect(second.summarySeqs).toHaveLength(1);
    expect(first.leafSeqs).toHaveLength(0);
    expect(second.leafSeqs).toHaveLength(0);
  });

  it("emits one compaction-checkpoint row carrying the committed seq plus sidecar ids", async () => {
    const session = buildSession("checkpoint notes ".repeat(20));
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
    ]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const nodes = session.surface.nodes;
    const rows: Record<string, unknown>[] = [];
    const result = await commitDagTransaction(
      { ...deps(ctx, store, index), record: (row) => rows.push(row) },
      agent,
      { start: nodes[1]!, end: nodes[nodes.length - 1]! },
      { owner: "current-turn", stability: "whole-surface" },
    );
    const checkpoints = rows.filter((row) => row.kind === "compaction-checkpoint");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      event: "lcm",
      session: "dag-commit-1",
      summarySeqs: [...result.summarySeqs],
      leafSeqs: [...result.leafSeqs],
      leaf: result.leafSummaryIds.length,
      condensed: result.condensedSummaryIds.length,
      leafSummaryIds: [...result.leafSummaryIds],
      condensedSummaryIds: [...result.condensedSummaryIds],
    });
    expect(result.summarySeqs).toHaveLength(1);
    expect(result.leafSeqs).toHaveLength(0);
    expect(result.leafSummaryIds.length).toBeGreaterThan(0);
    expect(typeof checkpoints[0]?.ts).toBe("number");
  });

  it("orders the prepared span by seq when rows landed out of order", async () => {
    const session = buildSession("backfill order ".repeat(20));
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    const events = session.snapshotEvents();
    // Two mirror batches shaped like a real catch-up: the first batch holds
    // a prefix plus newer live rows, the second backfills the gap in order,
    // so gap rows land on newer rowids than the newer rows they precede.
    const gap = events.slice(4, 7);
    const rest = events.filter((event) => !gap.includes(event));
    for (const event of rest) mirrorEvent(session, event, store, index);
    for (const event of gap) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
    ]);
    mountMeter(ctx);
    const rows: Record<string, unknown>[] = [];
    const agent = fakeAgent(session, ROUTE);
    const pre = [...session.surface.nodes];
    await commitDagTransaction(
      { ...deps(ctx, store, index), record: (row) => rows.push(row) },
      agent,
      { start: pre[1]!, end: pre[pre.length - 1]! },
      { owner: "current-turn", stability: "whole-surface" },
    );
    const seqs = pre.slice(1).map(Number);
    const sid = String(session.id);
    const pass = rows.find((row) => row.kind === "pass");
    expect(pass?.span).toEqual([`${sid}:${Math.min(...seqs)}`, `${sid}:${Math.max(...seqs)}`]);
  });

  it("keeps the checkpoint at its seq position after a replace", async () => {
    const session = buildSession("checkpoint order ".repeat(20));
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
    ]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const firstNodes = session.surface.nodes;
    await commitDagTransaction(
      deps(ctx, store, index),
      agent,
      { start: firstNodes[1]!, end: firstNodes[2]! },
      { owner: "current-turn", stability: "whole-surface" },
    );
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const rows: Record<string, unknown>[] = [];
    const pre = [...session.surface.nodes];
    await commitDagTransaction(
      { ...deps(ctx, store, index), record: (row) => rows.push(row) },
      agent,
      { start: pre[1]!, end: pre[pre.length - 1]! },
      { owner: "current-turn", stability: "whole-surface" },
    );
    const seqs = pre.slice(1).map(Number);
    const sid = String(session.id);
    const pass = rows.find((row) => row.kind === "pass");
    expect(pass?.span).toEqual([`${sid}:${Math.min(...seqs)}`, `${sid}:${Math.max(...seqs)}`]);
  });

  it("closes the bracket with the error and releases the lock when the ladder fails", async () => {
    const session = buildSession("failing notes ".repeat(20));
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [errorChunks()]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const nodes = session.surface.nodes;
    await expect(
      commitDagTransaction(
        deps(ctx, store, index),
        agent,
        { start: nodes[1]!, end: nodes[nodes.length - 1]! },
        { owner: "current-turn", stability: "whole-surface" },
      ),
    ).rejects.toThrow();
    const events = session.snapshotEvents();
    const ends = ofType(events, "compaction/end");
    expect(ends).toHaveLength(1);
    expect(typeof ends[0]?.data.error).toBe("string");
    await expect(
      commitDagTransaction(
        deps(ctx, store, index),
        agent,
        { start: nodes[1]!, end: nodes[nodes.length - 1]! },
        { owner: "current-turn", stability: "whole-surface" },
      ),
    ).rejects.toThrow(/^(?!.*already in progress).*$/s);
  });

  it("maps a ladder failure to the manual summary taxonomy on an idle session", async () => {
    const session = buildSession("manual notes ".repeat(20));
    session.append("turn/end", { turn: 3, reason: { kind: "completed" } });
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [errorChunks()]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const nodes = session.surface.nodes;
    const failure = await commitDagTransaction(
      deps(ctx, store, index),
      agent,
      { start: nodes[1]!, end: nodes[nodes.length - 1]! },
      { owner: null, stability: "selected-span" },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ManualCompactionError);
    expect((failure as ManualCompactionError).code).toBe("summary");
    const ends = ofType(session.snapshotEvents(), "compaction/end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.data.turn).toBeNull();
  });

  it("leaves memory untouched when the shrink check fails", async () => {
    const session = buildSession("ok ");
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const bloated = "bloated summary ".repeat(400);
    const { ctx } = setupContext(ROUTE, [
      textChunks(bloated),
      textChunks(bloated),
      textChunks(bloated),
      textChunks(bloated),
      textChunks(bloated),
      textChunks(bloated),
      textChunks(bloated),
      textChunks(bloated),
    ]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const nodes = session.surface.nodes;
    let notes = 0;
    const memory = {
      previous: (_sessionId: string) => undefined,
      note: (_sessionId: string, _text: string) => {
        notes += 1;
      },
    };
    await expect(
      commitDagTransaction(
        { ...deps(ctx, store, index), memory },
        agent,
        { start: nodes[1]!, end: nodes[2]! },
        { owner: "current-turn", stability: "whole-surface" },
      ),
    ).rejects.toThrow(/not smaller/);
    expect(notes).toBe(0);
  });

  it("notes memory exactly once when the bracket commits", async () => {
    const session = buildSession("working notes ".repeat(20));
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const { ctx } = setupContext(ROUTE, [
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
    ]);
    mountMeter(ctx);
    const agent = fakeAgent(session, ROUTE);
    const nodes = session.surface.nodes;
    let notes = 0;
    let noted: string | undefined;
    const memory = {
      previous: (_sessionId: string) => undefined,
      note: (_sessionId: string, text: string) => {
        notes += 1;
        noted = text;
      },
    };
    await commitDagTransaction(
      { ...deps(ctx, store, index), memory },
      agent,
      { start: nodes[1]!, end: nodes[nodes.length - 1]! },
      { owner: "current-turn", stability: "whole-surface" },
    );
    expect(notes).toBe(1);
    expect(noted).toContain(SUMMARY);
  });

  it("heals a gapped mirror with one backfill catch-up instead of throwing", async () => {
    const session = buildSession("catchup notes ".repeat(20));
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    const events = session.snapshotEvents();
    for (const event of events.slice(0, 3)) mirrorEvent(session, event, store, index);
    expect(store.allMessages().length).toBeGreaterThan(0);
    const { ctx } = setupContext(ROUTE, [
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
    ]);
    mountMeter(ctx);
    const liveEvents = session.snapshotEvents();
    (ctx as unknown as Record<string, unknown>).sessionQuery = {
      observeSession: async () => ({ events: liveEvents }),
    };
    const rows: Record<string, unknown>[] = [];
    const agent = fakeAgent(session, ROUTE);
    const nodes = session.surface.nodes;
    const result = await commitDagTransaction(
      { ...deps(ctx, store, index), record: (row) => rows.push(row) },
      agent,
      { start: nodes[1]!, end: nodes[nodes.length - 1]! },
      { owner: "current-turn", stability: "whole-surface" },
    );
    expect(result.summarySeqs).toHaveLength(1);
    expect(rows.some((row) => row.kind === "backfill")).toBe(true);
  });

  it("rethrows already-memory on the manual path instead of mapping it to summary", async () => {
    const session = buildSession("covered live ".repeat(30));
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
      { store: () => store, index: () => index, redact: (text) => text },
    );
    const nodes = session.surface.nodes;
    await engine.compactRegion(nodes[1]!, nodes[2]!, agent);
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const afterFirst = session.surface.nodes;
    await engine.compactRegion(afterFirst[1]!, afterFirst[3]!, agent);
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    session.append("turn/end", { turn: 3, reason: { kind: "completed" } });
    const covered = session.surface.nodes;
    const failure = await commitDagTransaction(
      deps(ctx, store, index),
      agent,
      { start: covered[covered.length - 2]!, end: covered[covered.length - 1]! },
      { owner: null, stability: "selected-span" },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SpanAlreadyMemoryError);
  });
});

describe("resolveSummarizationTarget", () => {
  it("falls back to the agent route when only one field is set", () => {
    const session = Session.create(SessionId("summ-target-1"));
    const agent = fakeAgent(session, ROUTE);
    expect(
      resolveSummarizationTarget(
        { summarizationProvider: "cfg-provider", summarizationModel: "cfg-model" },
        agent,
      ),
    ).toEqual({ provider: "cfg-provider", model: "cfg-model" });
    expect(
      resolveSummarizationTarget(
        { summarizationProvider: "cfg-provider", summarizationModel: "" },
        agent,
      ),
    ).toEqual(ROUTE);
    expect(
      resolveSummarizationTarget(
        { summarizationProvider: "", summarizationModel: "cfg-model" },
        agent,
      ),
    ).toEqual(ROUTE);
    expect(
      resolveSummarizationTarget({ summarizationProvider: "", summarizationModel: "" }, agent),
    ).toEqual(ROUTE);
  });
});
