import { Context } from "@deepseek-ai/cordis";
import { ToolCallId, type StreamChunk } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { LcmStore, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { DshRoute } from "../src/model-host.ts";
import { dshRef } from "../src/model-host.ts";
import { dshReader } from "../src/reader.ts";
import { expandQueryAnswer, registerExpandQueryTool } from "../src/tools.ts";
import { errorChunks, setupContext, textChunks, toolCallChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };

function seedStore(): LcmStore {
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    Array.from({ length: 8 }, (_, i) => ({
      entryId: `e${String(i).padStart(2, "0")}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `message ${i}: deciding the ${i % 2 === 0 ? "compaction engine" : "recall pipeline"} rollout ${"detail ".repeat(20)}`,
      timestamp: i,
    })),
  );
  return store;
}

function seedStoreWithSummary(): { store: LcmStore; summaryId: number } {
  const store = seedStore();
  const messageIds = store.messagesInSpan("e00", "e01").map((message) => message.id);
  const summaryId = store.insertSummary({
    kind: "leaf",
    text: "leaf over the rollout decision",
    tokens: 4,
    depth: 0,
    firstEntryId: "e00",
    lastEntryId: "e01",
    messageIds,
  }).id;
  return { store, summaryId };
}

const identity = (text: string): string => text;

/** One step carrying both findings text and a tool call, so the run can
 * exhaust its steps with a partial answer in hand. */
function textAndCallChunks(
  text: string,
  callId: string,
  name: string,
  args: unknown,
): StreamChunk[] {
  const id = ToolCallId(callId);
  const json = JSON.stringify(args);
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    { type: "tool-call-delta", index: 1, id, name, argumentsDelta: json },
    { type: "block-end", index: 1, block: { type: "tool-call", id, name, arguments: json } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

describe("lcm_expand_query", () => {
  it("registers the fourth tool whose schema names every param", async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, {});
    void new ToolRuntime(ctx);
    const store = seedStore();
    const dispose = registerExpandQueryTool(ctx, { store: () => store, redact: identity });
    const schemas = ctx.tools.schemas();
    expect(schemas.map((schema) => schema.name)).toContain("lcm_expand_query");
    const params = schemas.find((schema) => schema.name === "lcm_expand_query");
    expect(Object.keys(params?.parameters.properties ?? {})).toEqual(
      expect.arrayContaining([
        "query",
        "prompt",
        "summary_id",
        "entry_id",
        "session",
        "max_tokens",
      ]),
    );
    expect(params?.parameters.required).toContain("query");
    dispose();
    expect(ctx.tools.schemas().map((schema) => schema.name)).not.toContain("lcm_expand_query");
  });

  it("answers from aged history and cites the entry id", async () => {
    const store = seedStore();
    const { ctx } = setupContext(ROUTE, [
      toolCallChunks("call-1", "lcm_grep", { query: "recall pipeline rollout" }),
      textChunks("The recall pipeline rollout was approved for next week [e01]."),
    ]);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      {
        query: "recall pipeline rollout",
        prompt: "What did we decide about the recall pipeline rollout?",
      },
      (row) => rows.push(row),
    );
    expect(answer).toContain("<recovered_findings>");
    expect(answer).toContain("[e01]");
    expect(answer).toContain("Read stored history in 2 step(s)");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "lcm", kind: "retrieval", stop: "answered" });
    expect(rows[0]?.["steps"]).toBe(2);
  });

  it("reads a named summary and cites the summary id", async () => {
    const { store, summaryId } = seedStoreWithSummary();
    const { ctx } = setupContext(ROUTE, [
      toolCallChunks("call-1", "lcm_expand", { id: summaryId }),
      textChunks(`Summary #${summaryId} covers the compaction engine decision [e00].`),
    ]);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      {
        query: "compaction engine decision",
        prompt: "What did summary cover?",
        summary_id: summaryId,
      },
      (row) => rows.push(row),
    );
    expect(answer).toContain(`#${summaryId}`);
    expect(answer).toContain("<recovered_findings>");
    expect(rows[0]).toMatchObject({
      kind: "retrieval",
      stop: "answered",
      scope: "summary",
      summaryId,
    });
  });

  it("reads a named session through the same store lookup", async () => {
    const store = seedStore();
    const { ctx } = setupContext(ROUTE, [
      toolCallChunks("call-1", "lcm_grep", { query: "recall pipeline rollout" }),
      textChunks("The recall pipeline rollout was approved for next week [e01]."),
    ]);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      { query: "recall pipeline rollout", session: "other-session" },
      (row) => rows.push(row),
    );
    expect(answer).toContain("[e01]");
    expect(rows[0]).toMatchObject({ kind: "retrieval", stop: "answered" });
  });

  it("refuses a call that names both a summary and an entry", async () => {
    const store = seedStore();
    const { ctx } = setupContext(ROUTE, []);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      { query: "recall pipeline rollout", summary_id: 1, entry_id: "e01" },
      (row) => rows.push(row),
    );
    expect(answer).toBe("Nothing was read: pass summary_id or entry_id, not both.");
    expect(rows[0]).toMatchObject({ kind: "retrieval", stop: "refused" });
  });

  it("refuses an entry id the store does not hold", async () => {
    const store = seedStore();
    const { ctx } = setupContext(ROUTE, []);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      { query: "recall pipeline rollout", entry_id: "missing" },
      (row) => rows.push(row),
    );
    expect(answer).toBe("Nothing was read: no stored message with entry id missing.");
    expect(rows[0]).toMatchObject({ kind: "retrieval", stop: "refused" });
  });

  it("answers the no-history text when no store resolves", async () => {
    const { ctx } = setupContext(ROUTE, []);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      undefined,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      undefined,
      { query: "recall pipeline rollout" },
      (row) => rows.push(row),
    );
    expect(answer).toContain("no stored history");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "lcm", kind: "retrieval", stop: "refused" });
  });

  it("reports a reader failure with its reason and billed counters", async () => {
    const store = seedStore();
    const { ctx } = setupContext(ROUTE, [
      toolCallChunks("call-1", "lcm_grep", { query: "recall pipeline rollout" }),
      errorChunks(),
    ]);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      { query: "recall pipeline rollout" },
      (row) => rows.push(row),
    );
    expect(answer).toBe("Retrieval failed: AUTH: bad key");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "retrieval",
      stop: "failed",
      reason: "AUTH: bad key",
      steps: 2,
      input: 10,
      output: 5,
    });
  });

  it("stops with partial findings when the steps run out", async () => {
    const store = seedStore();
    const scripts = Array.from({ length: 6 }, (_, i) =>
      textAndCallChunks(`partial note ${i} [e01]`, `call-${i}`, "lcm_grep", {
        query: "recall pipeline rollout",
      }),
    );
    const { ctx } = setupContext(ROUTE, scripts);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      { query: "recall pipeline rollout" },
      (row) => rows.push(row),
    );
    expect(answer).toContain("stopped: steps");
    expect(answer).toContain("<recovered_findings>");
    expect(rows[0]).toMatchObject({ kind: "retrieval", stop: "stopped", steps: 6 });
  });

  it("stops empty when no step left an answer", async () => {
    const store = seedStore();
    const scripts = Array.from({ length: 6 }, (_, i) =>
      toolCallChunks(`call-${i}`, "lcm_grep", { query: "recall pipeline rollout" }),
    );
    const { ctx } = setupContext(ROUTE, scripts);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      { query: "recall pipeline rollout" },
      (row) => rows.push(row),
    );
    expect(answer).toContain("Retrieval stopped (steps) after 6 step(s) without an answer");
    expect(rows[0]).toMatchObject({ kind: "retrieval", stop: "stopped", reason: "steps" });
  });

  it("refuses an empty entry id", async () => {
    const store = seedStore();
    const { ctx } = setupContext(ROUTE, []);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      { query: "recall pipeline rollout", entry_id: "" },
      (row) => rows.push(row),
    );
    expect(answer).toBe("Nothing was read: entry_id is empty.");
    expect(rows[0]).toMatchObject({ kind: "retrieval", stop: "refused" });
  });

  it("refuses a summary id the store does not hold", async () => {
    const store = seedStore();
    const { ctx } = setupContext(ROUTE, []);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      { query: "recall pipeline rollout", summary_id: 4242 },
      (row) => rows.push(row),
    );
    expect(answer).toBe("Nothing was read: no summary with id 4242.");
    expect(rows[0]).toMatchObject({
      kind: "retrieval",
      stop: "refused",
      reason: "no summary with id 4242",
    });
  });

  it("refuses an empty session string", async () => {
    const store = seedStore();
    const { ctx } = setupContext(ROUTE, []);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      { query: "recall pipeline rollout", session: "" },
      (row) => rows.push(row),
    );
    expect(answer).toBe("Nothing was read: session must be a non-empty session id.");
    expect(rows[0]).toMatchObject({ kind: "retrieval", stop: "refused" });
  });

  it("refuses a past session no sidecar holds", async () => {
    const store = seedStore();
    const { ctx } = setupContext(ROUTE, []);
    const rows: Record<string, unknown>[] = [];
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      { query: "recall pipeline rollout", session: "ghost" },
      (row) => rows.push(row),
      { list: () => [] },
    );
    expect(answer).toBe("Nothing was read: no stored session with id ghost.");
    expect(rows[0]).toMatchObject({ kind: "retrieval", stop: "refused" });
  });

  it("fails the tool run when no provider backs the reader", async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, {});
    void new ToolRuntime(ctx);
    const store = seedStore();
    const rows: Record<string, unknown>[] = [];
    const dispose = registerExpandQueryTool(ctx, {
      store: () => store,
      redact: identity,
      record: (row) => rows.push(row),
    });
    try {
      const tool = ctx.tools.get("lcm_expand_query");
      expect(tool).toBeDefined();
      const exec = {
        agent: undefined,
        signal: new AbortController().signal,
      } as unknown as ToolRunContext;
      const answer = await tool?.execute({ query: "recall pipeline rollout" }, exec);
      expect(answer).toBe(
        "lossless retrieval: no provider/model available for the reader: route one request or set both agent options fields.",
      );
      expect(rows[0]).toMatchObject({
        kind: "retrieval",
        stop: "failed",
        reason: "no provider/model available for the reader",
        steps: 0,
      });
    } finally {
      dispose();
    }
  });
});
