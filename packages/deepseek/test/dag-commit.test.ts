import { Context } from "@deepseek-ai/cordis";
import { isCompactCheckpointSource, ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { LcmStore } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { commitDagTransaction, selectDagRange } from "../src/dag-commit.ts";
import type { DagCommitDeps } from "../src/dag-commit.ts";
import { MessageIndex, mirrorEvent } from "../src/ingest.ts";
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
  it("commits one condensed replace plus log-only leaf records in a single bracket", async () => {
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
    expect(result.summarySeqs).toHaveLength(result.leafSeqs.length + 1);
    expect(result.leafSeqs.length).toBeGreaterThan(0);
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

  it("emits one compaction-checkpoint row carrying the committed seqs", async () => {
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
    });
    expect(typeof checkpoints[0]?.ts).toBe("number");
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
});
