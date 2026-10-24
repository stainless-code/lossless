import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LcmStore } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import {
  compactionMark,
  messageRole,
  mirror,
  mirrorBusEvent,
  renderPart,
  summaryEntry,
  summaryEntryFrom,
  textEntry,
  textEntryFrom,
  toolEntry,
  userEntry,
} from "../src/ingest.ts";
import { Sidecars } from "../src/sidecars.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-"));
}

describe("userEntry", () => {
  it("stores the prompt text under a stable id", () => {
    const entry = userEntry("ses_1", {
      sessionID: "ses_1",
      messageID: "msg_1",
      prompt: { text: "fix the leak" },
    });
    expect(entry?.entryId).toBe("ses_1:prompt:msg_1");
    expect(entry?.role).toBe("user");
    expect(entry?.text).toBe("fix the leak");
  });

  it("names attached files", () => {
    const entry = userEntry("ses_1", {
      sessionID: "ses_1",
      messageID: "msg_2",
      prompt: { text: "review", files: [{ uri: "file:///a.ts", name: "a.ts" }] },
    });
    expect(entry?.text).toContain("a.ts");
  });

  it("skips a blank prompt", () => {
    const entry = userEntry("ses_1", {
      sessionID: "ses_1",
      messageID: "msg_3",
      prompt: { text: "  " },
    });
    expect(entry).toBeUndefined();
  });
});

describe("textEntry", () => {
  it("stores assistant text at the ordinal boundary", () => {
    const entry = textEntry({
      type: "session.text.ended",
      sessionID: "ses_1",
      assistantMessageID: "msg_9",
      ordinal: 0,
      text: "done",
    });
    expect(entry?.entryId).toBe("ses_1:text:msg_9:0");
    expect(entry?.role).toBe("assistant");
  });

  it("rejects a malformed bus payload", () => {
    expect(textEntryFrom({ data: { sessionID: "ses_1", text: "no ids" } })).toBeUndefined();
    expect(textEntryFrom({})).toBeUndefined();
  });
});

describe("toolEntry", () => {
  it("keeps the call input with a completed result", () => {
    const entry = toolEntry({
      tool: "read",
      sessionID: "ses_1",
      messageID: "msg_4",
      id: "call_1",
      input: { path: "a.ts" },
      status: "completed",
      result: { content: "hello" },
    });
    expect(entry?.role).toBe("toolResult");
    expect(entry?.text).toContain("read");
    expect(entry?.text).toContain("a.ts");
    expect(entry?.text).toContain("hello");
  });

  it("renders a failed call as an error line", () => {
    const entry = toolEntry({
      tool: "bash",
      sessionID: "ses_1",
      messageID: "msg_5",
      id: "call_2",
      input: { command: "exit 1" },
      status: "error",
      error: { message: "boom" },
    });
    expect(entry?.text).toContain("error: boom");
  });
});

describe("compaction entries", () => {
  it("marks the compacted span with its boundary roles", () => {
    const entry = compactionMark("ses_1", {
      sessionID: "ses_1",
      messages: [
        { role: "user", content: [] },
        { role: "assistant", content: [] },
      ],
    });
    expect(entry.entryId).toMatch(/^ses_1:compaction:[0-9a-f-]{36}$/);
    expect(entry.role).toBe("custom");
    expect(entry.text).toContain("2 messages compacted");
    expect(entry.text).toContain("first user");
  });

  it("gives the same boundary the same id", () => {
    const event = {
      sessionID: "ses_1",
      messages: [{ id: "msg_1", role: "user", content: [] }],
    } as const;
    expect(compactionMark("ses_1", event).entryId).toBe(compactionMark("ses_1", event).entryId);
  });

  it("gives a different boundary a different mark", () => {
    const first = {
      sessionID: "ses_1",
      messages: [{ id: "msg_1", role: "user", content: [] }],
    } as const;
    const second = {
      sessionID: "ses_1",
      messages: [{ id: "msg_2", role: "user", content: [] }],
    } as const;
    expect(compactionMark("ses_1", first).entryId).not.toBe(
      compactionMark("ses_1", second).entryId,
    );
  });

  it("stores a finished summary with its reason under the event id", () => {
    const entry = summaryEntry("ses_1", "evt_1", {
      type: "session.compaction.ended",
      sessionID: "ses_1",
      reason: "auto",
      text: "the work so far",
    });
    expect(entry?.entryId).toBe("ses_1:summary:evt_1");
    expect(entry?.text).toContain("compaction summary (auto)");
    expect(entry?.text).toContain("the work so far");
  });

  it("keeps two events under distinct entry ids", () => {
    const event = {
      type: "session.compaction.ended",
      sessionID: "ses_1",
      reason: "manual",
      text: "summary",
    } as const;
    const first = summaryEntry("ses_1", "evt_1", event);
    const second = summaryEntry("ses_1", "evt_2", event);
    expect(first?.entryId).toBe("ses_1:summary:evt_1");
    expect(second?.entryId).toBe("ses_1:summary:evt_2");
    expect(first?.entryId).not.toBe(second?.entryId);
  });

  it("skips a native checkpoint with empty text", () => {
    const entry = summaryEntry("ses_1", "evt_1", {
      type: "session.compaction.ended",
      sessionID: "ses_1",
      reason: "auto",
      text: "",
    });
    expect(entry).toBeUndefined();
  });

  it("reads a summary off the raw bus event", () => {
    const entry = summaryEntryFrom({
      id: "evt_7",
      data: { sessionID: "ses_1", reason: "manual", text: "summary" },
    });
    expect(entry?.entryId).toBe("ses_1:summary:evt_7");
  });

  it("skips a summary event with no id", () => {
    expect(
      summaryEntryFrom({
        data: { sessionID: "ses_1", reason: "manual", text: "summary" },
      }),
    ).toBeUndefined();
  });
});

describe("mirrorBusEvent", () => {
  it("stores text.ended and skips unknown types", () => {
    const sidecars = new Sidecars(tempDir());
    const store = sidecars.for("ses_9");
    const stored = mirrorBusEvent(store, {
      id: "evt_text",
      type: "session.text.ended",
      data: {
        sessionID: "ses_9",
        assistantMessageID: "msg_1",
        ordinal: 0,
        text: "hello from the loop",
      },
    });
    expect(stored.inserted).toBe(1);
    const skipped = mirrorBusEvent(store, { type: "session.idle" });
    expect(skipped).toMatchObject({ inserted: 0, skipped: 1 });
    sidecars.close();
  });

  it("keeps a redelivered compaction event deduped and a new one stored", () => {
    const sidecars = new Sidecars(tempDir());
    const store = sidecars.for("ses_9");
    const data = { sessionID: "ses_9", reason: "manual", text: "first" };
    expect(
      mirrorBusEvent(store, { id: "evt_1", type: "session.compaction.ended", data }).inserted,
    ).toBe(1);
    expect(
      mirrorBusEvent(store, { id: "evt_1", type: "session.compaction.ended", data }).inserted,
    ).toBe(0);
    expect(
      mirrorBusEvent(store, {
        id: "evt_2",
        type: "session.compaction.ended",
        data: { ...data, text: "second" },
      }).inserted,
    ).toBe(1);
    expect(store.entryCountWithPrefix("ses_9:summary:")).toBe(2);
    sidecars.close();
  });

  it("dedups a redelivered event on the entry id", () => {
    const store = new LcmStore(join(tempDir(), "dedup.sqlite"));
    const entry = textEntry({
      type: "session.text.ended",
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      ordinal: 0,
      text: "once",
    });
    expect(mirror(store, entry).inserted).toBe(1);
    expect(mirror(store, entry).inserted).toBe(0);
    store.close();
  });
});

describe("renderPart", () => {
  it("passes text through and names tool calls", () => {
    expect(renderPart({ type: "text", text: "hi" })).toBe("hi");
    expect(renderPart({ type: "tool-call", name: "read", input: { path: "x" } })).toContain("read");
    expect(renderPart({ type: "media" })).toBeUndefined();
    expect(renderPart({ type: "reasoning", text: "hmm" })).toBeUndefined();
  });
});

describe("messageRole", () => {
  it("folds system to custom", () => {
    expect(messageRole("system")).toBe("custom");
    expect(messageRole("tool")).toBe("toolResult");
  });
});
