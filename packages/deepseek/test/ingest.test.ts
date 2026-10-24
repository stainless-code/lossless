import {
  ToolCallId,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { LcmStore } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { entryFor, mirrorEvent } from "../src/ingest.ts";

const MODEL = "test-model";

function buildSession(): Session {
  const session = Session.create(SessionId("mirror-1"));
  session.append("turn/start", { turn: 1 });
  session.append(
    "system/message",
    { turn: 1, step: 1, message: createSystemMessage("You are a test.") },
    { surfaceOp: "append" },
  );
  session.append(
    "user/message",
    createUserMessage({
      content: [{ type: "text", text: "start the compaction engine work" }],
      source: { kind: "user" },
    }),
    { surfaceOp: "append" },
  );
  session.append("step/start", { turn: 1, step: 1 });
  session.append("request/header", {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: "initial",
  });
  session.append(
    "assistant/message",
    {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: "assistant",
        content: [{ type: "text", text: "engine work started" }],
        source: { kind: "model", provider: MODEL, model: MODEL },
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 1, step: 1 });
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  session.append("turn/start", { turn: 2 });
  session.append(
    "user/message",
    createUserMessage({
      content: [{ type: "text", text: "read the engine config" }],
      source: { kind: "user" },
    }),
    { surfaceOp: "append" },
  );
  session.append("step/start", { turn: 2, step: 1 });
  const callId = ToolCallId("call-1");
  session.append(
    "assistant/message",
    {
      stream: [],
      turn: 2,
      step: 1,
      message: createMessage({
        role: "assistant",
        content: [
          { type: "text", text: "reading now" },
          { type: "tool-call", id: callId, name: "read", arguments: '{"path":"engine.conf"}' },
        ],
        source: { kind: "model", provider: MODEL, model: MODEL },
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("tool/call", {
    turn: 2,
    step: 1,
    callId,
    name: "read",
    arguments: '{"path":"engine.conf"}',
  });
  session.append(
    "tool/result",
    {
      turn: 2,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: "text", text: "config contents here" }],
        isError: false,
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 2, step: 1 });
  session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
  return session;
}

describe("ingest mirror", () => {
  it("mirrors every derived message and nothing else, idempotently", () => {
    const session = buildSession();
    const store = new LcmStore(":memory:");
    // The snapshot walk is test-only: production code mirrors the live feed.
    const events = session.snapshotEvents();
    let inserted = 0;
    for (const event of events) inserted += mirrorEvent(session, event, store).inserted;
    const derived = session.deriveMessages();
    expect(inserted).toBe(derived.length);
    expect(inserted).toBe(6);
    const stored = new Map(store.allMessages().map((row) => [row.entryId, row]));
    expect(stored.size).toBe(6);
    for (const message of derived) {
      for (const block of message.content) {
        if (block.type !== "text" || block.text.trim().length === 0) continue;
        const kept = [...stored.values()].some((row) => row.text.includes(block.text));
        expect(kept).toBe(true);
      }
    }
    const turnStart = events.find((event) => event.type === "turn/start");
    expect(turnStart).toBeDefined();
    if (turnStart) expect(entryFor(session, turnStart)).toBeUndefined();
    let second = 0;
    let skipped = 0;
    for (const event of events) {
      const stats = mirrorEvent(session, event, store);
      second += stats.inserted;
      skipped += stats.skipped;
    }
    expect(second).toBe(0);
    expect(skipped).toBe(events.length);
  });

  it("keeps shadowed entries when a checkpoint replaces surface nodes", () => {
    const session = buildSession();
    const store = new LcmStore(":memory:");
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store);
    const before = session.deriveMessages().length;
    const firstUser = session.snapshotEvents().find((event) => event.type === "user/message");
    const firstAssistant = session
      .snapshotEvents()
      .find((event) => event.type === "assistant/message");
    expect(firstUser).toBeDefined();
    expect(firstAssistant).toBeDefined();
    if (!firstUser || !firstAssistant) throw new Error("conversation is missing its first turn");
    const checkpoint = session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: "checkpoint: engine work started, config read next" }],
        source: { kind: "user" },
      }),
      {
        surfaceOp: { op: "replace", startSeq: firstUser.seq, endSeq: firstAssistant.seq },
        sourceEventSeqs: [firstUser.seq, firstAssistant.seq],
      },
    );
    const stats = mirrorEvent(session, checkpoint, store);
    expect(stats.inserted).toBe(1);
    expect(session.deriveMessages().length).toBe(before - 1);
    expect(store.allMessages()).toHaveLength(before + 1);
    const texts = store.allMessages().map((row) => row.text);
    expect(texts.some((text) => text.includes("start the compaction engine work"))).toBe(true);
    expect(texts.some((text) => text.includes("engine work started"))).toBe(true);
    expect(texts.some((text) => text.includes("checkpoint: engine work started"))).toBe(true);
  });
});
