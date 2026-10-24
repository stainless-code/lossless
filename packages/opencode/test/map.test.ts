import { describe, expect, it } from "vite-plus/test";

import type { SessionMessageInfo } from "../src/host.ts";
import { storedEntries } from "../src/map.ts";

const SESSION = "ses_map";

function user(id: string, text: string, files?: readonly unknown[]): SessionMessageInfo {
  return { id, type: "user", text, ...(files === undefined ? {} : { files }) };
}

function assistant(id: string, content: readonly unknown[]): SessionMessageInfo {
  return { id, type: "assistant", content };
}

describe("storedEntries", () => {
  it("maps user and assistant parts to the ids the mirror wrote", () => {
    const messages: SessionMessageInfo[] = [
      user("msg_u", "read the chart"),
      assistant("msg_a", [
        { type: "text", text: "checking" },
        {
          type: "tool",
          id: "call_9",
          name: "read",
          state: {
            status: "completed",
            input: { path: "chart.ts" },
            content: [{ type: "text", text: "shoals" }],
          },
        },
      ]),
    ];
    const mapped = storedEntries(SESSION, messages);
    expect(mapped.entries.map((entry) => entry.entryId)).toEqual([
      `${SESSION}:prompt:msg_u`,
      `${SESSION}:tool:msg_a:call_9`,
    ]);
    expect(mapped.entries[1]?.text).toBe('checking\n\ntool read {"path":"chart.ts"}\nshoals');
    expect(mapped.entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
  });

  it("keeps the text part ordinal aligned when an earlier text part is empty", () => {
    const mapped = storedEntries(SESSION, [
      assistant("msg_a", [
        { type: "text", text: "" },
        { type: "text", text: "the answer" },
      ]),
    ]);
    expect(mapped.entries.map((entry) => entry.entryId)).toEqual([`${SESSION}:text:msg_a:1`]);
  });

  it("names a span by the last part of its last message", () => {
    const mapped = storedEntries(SESSION, [
      user("msg_u", "first"),
      assistant("msg_a", [
        { type: "text", text: "text part" },
        {
          type: "tool",
          id: "call_1",
          name: "grep",
          state: {
            status: "error",
            input: { pattern: "x" },
            error: { message: "no match" },
          },
        },
      ]),
    ]);
    const last = mapped.entries[mapped.entries.length - 1];
    expect(last?.entryId).toBe(`${SESSION}:tool:msg_a:call_1`);
    expect(last?.text).toBe('text part\n\ntool grep {"pattern":"x"}\nerror: no match');
  });

  it("carries attachments the way the mirror stores them", () => {
    const mapped = storedEntries(SESSION, [
      user("msg_u", "look", [{ uri: "file:///a.ts", name: "a.ts" }, { uri: "file:///b.md" }]),
    ]);
    expect(mapped.entries[0]?.text).toBe("look\n[attachments: a.ts, file:///b.md]");
  });

  it("skips switches, compaction, and system messages", () => {
    const mapped = storedEntries(SESSION, [
      { id: "msg_agent", type: "agent-switched", text: "builder" },
      {
        id: "msg_model",
        type: "model-switched",
        model: { providerID: "p", id: "m" },
      },
      user("msg_u", "real prompt"),
      { id: "msg_compact", type: "compaction", text: "a summary is not a branch message" },
      { id: "msg_system", type: "system", text: "instructions" },
      { id: "msg_synthetic", type: "synthetic", text: "a note" },
      assistant("msg_r", [{ type: "reasoning", text: "thinking only" }]),
    ]);
    expect(mapped.entries.map((entry) => entry.entryId)).toEqual([`${SESSION}:prompt:msg_u`]);
    expect(mapped.raw).toHaveLength(1);
    expect(mapped.sources.size).toBe(1);
  });

  it("maps the wrapper back to the stored message", () => {
    const stored = user("msg_u", "hello");
    const mapped = storedEntries(SESSION, [stored]);
    const wrapper = mapped.raw[0];
    expect(wrapper?.role).toBe("user");
    expect(wrapper?.content).toBe("hello");
    expect(mapped.sources.get(wrapper!)).toBe(stored);
  });

  it("returns empty structures for an empty history", () => {
    const mapped = storedEntries(SESSION, []);
    expect(mapped.entries).toEqual([]);
    expect(mapped.raw).toEqual([]);
    expect(mapped.sources.size).toBe(0);
  });

  it("counts a completed or unmarked compaction as a host checkpoint", () => {
    expect(
      storedEntries(SESSION, [
        { id: "msg_compact", type: "compaction", status: "completed", summary: "older" },
        user("msg_u", "after it"),
      ]).hostCheckpoint,
    ).toBe(true);
    // A fixture written before statuses existed still bounds the history.
    expect(
      storedEntries(SESSION, [
        { id: "msg_compact", type: "compaction", text: "older" },
        user("msg_u", "after it"),
      ]).hostCheckpoint,
    ).toBe(true);
  });

  it("ignores the running compaction the host is about to fill", () => {
    const mapped = storedEntries(SESSION, [
      user("msg_u", "the prompt being compacted"),
      { id: "msg_compact", type: "compaction", status: "running", summary: "" },
    ]);
    expect(mapped.hostCheckpoint).toBe(false);
    expect(mapped.checkpoint).toBeUndefined();
  });

  it("reads a marked checkpoint with a validated marker", () => {
    const mapped = storedEntries(SESSION, [
      {
        id: "msg_compact",
        type: "compaction",
        status: "completed",
        summary: "the frontier",
        metadata: { lcm: true, summaryIds: [4, 7], cutCount: 6, checkpoint: "sha256:abc" },
      },
      user("msg_u", "after it"),
    ]);
    expect(mapped.checkpoint).toEqual({
      messageID: "msg_compact",
      summaryIds: [4, 7],
      cutCount: 6,
      marker: "sha256:abc",
    });
  });

  it("rejects a marker with a malformed field", () => {
    const markers: unknown[] = [
      { lcm: "true", summaryIds: [1], cutCount: 1, checkpoint: "c" },
      { lcm: true, summaryIds: [], cutCount: 1, checkpoint: "c" },
      { lcm: true, summaryIds: [1.5], cutCount: 1, checkpoint: "c" },
      { lcm: true, summaryIds: [1], cutCount: -1, checkpoint: "c" },
      { lcm: true, summaryIds: [1], cutCount: 1, checkpoint: "" },
    ];
    for (const metadata of markers) {
      const mapped = storedEntries(SESSION, [
        {
          id: "msg_compact",
          type: "compaction",
          status: "completed",
          summary: "the frontier",
          metadata: metadata as Record<string, unknown>,
        },
        user("msg_u", "after it"),
      ]);
      expect(mapped.checkpoint).toBeUndefined();
      expect(mapped.hostCheckpoint).toBe(true);
    }
  });

  it("records the host-only message before each entry", () => {
    const mapped = storedEntries(SESSION, [
      user("msg_u1", "one"),
      { id: "msg_s1", type: "synthetic", text: "continue after the output limit" },
      user("msg_u2", "two"),
    ]);
    expect([...mapped.hostOnly]).toEqual(["msg_s1"]);
    expect(mapped.hostOnlyBefore.get(1)).toBe("msg_s1");
  });
});
