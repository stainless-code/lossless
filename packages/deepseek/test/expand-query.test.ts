import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { LcmStore, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { DshRoute } from "../src/model-host.ts";
import { dshRef } from "../src/model-host.ts";
import { dshReader } from "../src/reader.ts";
import { expandQueryAnswer, registerExpandQueryTool } from "../src/tools.ts";
import { setupContext, textChunks, toolCallChunks } from "./support/script-adapter.ts";

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
});
