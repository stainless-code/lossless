import {
  ToolCallId,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import type { FileBlock, ImageBlock } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { LcmStore } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { MessageIndex, entryFor, mirrorEvent } from "../src/ingest.ts";

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

  it("mirrors an image-only message as one descriptor row", () => {
    const session = Session.create(SessionId("mirror-image"));
    session.append("turn/start", { turn: 1 });
    const imageEvent = session.append(
      "user/message",
      createUserMessage({
        content: [
          {
            type: "image",
            attachment: {
              attachmentId:
                "sha256:test-image-1" as unknown as ImageBlock["attachment"]["attachmentId"],
              mediaType: "image/png",
              bytes: 1234,
              width: 800,
              height: 600,
              name: "photo.png",
            },
          },
        ],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const store = new LcmStore(":memory:");
    let inserted = 0;
    for (const event of session.snapshotEvents())
      inserted += mirrorEvent(session, event, store).inserted;
    expect(inserted).toBe(1);
    const rows = store.allMessages();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("expected one descriptor row");
    expect(row.entryId).toBe(`${session.id}:${imageEvent.seq}`);
    expect(row.role).toBe("user");
    expect(row.timestamp).toBe(imageEvent.time);
    expect(row.text).toContain("image");
    expect(row.text).toContain("photo.png");
    expect(row.text).toContain("descriptor only");
  });

  it("mirrors a file-only message as one descriptor row", () => {
    const session = Session.create(SessionId("mirror-file"));
    session.append(
      "user/message",
      createUserMessage({
        content: [
          {
            type: "file",
            attachment: {
              attachmentId:
                "sha256:test-file-1" as unknown as FileBlock["attachment"]["attachmentId"],
              name: "notes.pdf",
              bytes: 5678,
            },
          },
        ],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    const store = new LcmStore(":memory:");
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store);
    const rows = store.allMessages();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("expected one descriptor row");
    expect(row.text).toContain("file");
    expect(row.text).toContain("notes.pdf");
  });

  it("maps a span containing a non-text message instead of throwing", () => {
    const session = buildSession();
    session.append("turn/start", { turn: 3 });
    session.append(
      "user/message",
      createUserMessage({
        content: [
          {
            type: "image",
            attachment: {
              attachmentId:
                "sha256:test-image-1" as unknown as ImageBlock["attachment"]["attachmentId"],
              mediaType: "image/png",
              bytes: 1234,
              width: 800,
              height: 600,
              name: "photo.png",
            },
          },
        ],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    session.append("turn/end", { turn: 3, reason: { kind: "completed" } });
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const derived = session.deriveMessages();
    expect(derived.length).toBe(7);
    for (const message of derived) {
      const entryId = index.entryId(message.id);
      expect(entryId).toBeDefined();
      if (entryId === undefined) throw new Error(`no sidecar entry for ${message.id}`);
      expect(store.messageByEntryId(entryId)).toBeDefined();
    }
  });

  it("keeps no row for a message with no content at all", () => {
    const session = Session.create(SessionId("mirror-empty"));
    const event = session.append(
      "user/message",
      createUserMessage({ content: [], source: { kind: "user" } }),
      { surfaceOp: "append" },
    );
    expect(entryFor(session, event)).toBeUndefined();
    const store = new LcmStore(":memory:");
    expect(mirrorEvent(session, event, store).inserted).toBe(0);
    expect(store.allMessages()).toHaveLength(0);
  });

  it("keeps leading indentation, trailing spaces, and outer blank lines verbatim", () => {
    const session = Session.create(SessionId("mirror-ws"));
    const original = "\n\n  indented line\nsecond line  \n\n";
    const event = session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: original }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    const store = new LcmStore(":memory:");
    expect(mirrorEvent(session, event, store).inserted).toBe(1);
    const rows = store.allMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe(original);
  });

  it("maps whitespace-only text through a descriptor row", () => {
    const session = Session.create(SessionId("mirror-ws-keep"));
    const original = "   \n  ";
    const event = session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: original }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    expect(entryFor(session, event)?.text).toBe("[lcm:whitespace 6 chars]");
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    expect(mirrorEvent(session, event, store, index).inserted).toBe(1);
    const rows = store.allMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("[lcm:whitespace 6 chars]");
    for (const message of session.deriveMessages()) {
      const entryId = index.entryId(message.id);
      expect(entryId).toBeDefined();
      if (entryId === undefined) throw new Error(`no sidecar entry for ${message.id}`);
      expect(store.messageByEntryId(entryId)).toBeDefined();
    }
  });

  it("mirrors a blank tool output as one descriptor row and maps its span", () => {
    const session = Session.create(SessionId("mirror-blank-tool"));
    session.append("turn/start", { turn: 1 });
    const callId = ToolCallId("call-blank");
    session.append(
      "assistant/message",
      {
        stream: [],
        turn: 1,
        step: 1,
        message: createMessage({
          role: "assistant",
          content: [
            { type: "tool-call", id: callId, name: "read", arguments: '{"path":"blank.txt"}' },
          ],
          source: { kind: "model", provider: MODEL, model: MODEL },
        }),
      },
      { surfaceOp: "append" },
    );
    session.append("tool/call", {
      turn: 1,
      step: 1,
      callId,
      name: "read",
      arguments: '{"path":"blank.txt"}',
    });
    const blank = "   \n  ";
    const resultEvent = session.append(
      "tool/result",
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: "text", text: blank }],
          isError: false,
        }),
      },
      { surfaceOp: "append" },
    );
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
    const row = store.messageByEntryId(`${session.id}:${resultEvent.seq}`);
    expect(row).toBeDefined();
    expect(row?.text).toBe("tool read\n[lcm:whitespace 6 chars]");
    for (const message of session.deriveMessages()) {
      const entryId = index.entryId(message.id);
      expect(entryId).toBeDefined();
      if (entryId === undefined) throw new Error(`no sidecar entry for ${message.id}`);
      expect(store.messageByEntryId(entryId)).toBeDefined();
    }
  });

  it("keeps the tool name on a result even when the assistant mixes prose with the call", () => {
    const session = Session.create(SessionId("mirror-mixed-tool"));
    session.append("turn/start", { turn: 1 });
    const callId = ToolCallId("call-mixed");
    session.append(
      "assistant/message",
      {
        stream: [],
        turn: 1,
        step: 1,
        message: createMessage({
          role: "assistant",
          content: [
            { type: "text", text: "reading now" },
            { type: "tool-call", id: callId, name: "read", arguments: '{"path":"a.txt"}' },
          ],
          source: { kind: "model", provider: MODEL, model: MODEL },
        }),
      },
      { surfaceOp: "append" },
    );
    session.append("tool/call", {
      turn: 1,
      step: 1,
      callId,
      name: "read",
      arguments: '{"path":"a.txt"}',
    });
    const resultEvent = session.append(
      "tool/result",
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: "text", text: "file body here" }],
          isError: false,
        }),
      },
      { surfaceOp: "append" },
    );
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const store = new LcmStore(":memory:");
    const index = new MessageIndex();
    try {
      for (const event of session.snapshotEvents()) mirrorEvent(session, event, store, index);
      const assistantRow = store.allMessages().find((row) => row.role === "assistant");
      expect(assistantRow?.text).toContain("reading now");
      expect(assistantRow?.text).toContain("tool-call: read");
      const resultRow = store.messageByEntryId(`${session.id}:${resultEvent.seq}`);
      expect(resultRow?.role).toBe("toolResult");
      expect(resultRow?.text).toBe("tool read\nfile body here");
    } finally {
      store.close();
    }
  });

  it("skips a message with an unknown harness role instead of throwing", () => {
    const session = {
      id: "mirror-unknown-role",
      deriveEventMessage: () => ({
        id: "m-unknown",
        role: "harness-new-role",
        content: [{ type: "text", text: "future role text" }],
      }),
    } as unknown as Session;
    const event = { seq: 1 } as unknown as Parameters<typeof entryFor>[1];
    expect(entryFor(session, event)).toBeUndefined();
    const store = new LcmStore(":memory:");
    expect(mirrorEvent(session, event, store).inserted).toBe(0);
  });
});
