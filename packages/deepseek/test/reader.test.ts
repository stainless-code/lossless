import { LcmStore, ingestEntries, runRetrieval } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { dshRef } from "../src/model-host.ts";
import type { DshRoute } from "../src/model-host.ts";
import { dshReader } from "../src/reader.ts";
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

describe("dshReader retrieval", () => {
  it("answers one query through a real grep call and a real store", async () => {
    const store = seedStore();
    const { ctx, adapter } = setupContext(ROUTE, [
      toolCallChunks("call-1", "lcm_grep", { query: "compaction" }),
      textChunks("The rollout decision is recorded under the compaction engine entries."),
    ]);
    const run = await runRetrieval(
      store,
      {
        query: "compaction engine rollout",
        prompt: "What did we decide about the compaction engine rollout?",
        budgetTokens: 10000,
        maxSteps: 6,
        redact: (text) => text,
      },
      dshReader(ctx, { ref: dshRef(ROUTE) }),
    );
    expect(run.kind).toBe("answered");
    if (run.kind !== "answered") throw new Error(`retrieval did not answer: ${run.kind}`);
    expect(run.steps).toBe(2);
    expect(run.text).toContain("compaction engine entries");
    expect(adapter.requests).toHaveLength(2);
    const first = adapter.requests[0];
    const tools = first?.tools?.map((tool) => tool.name) ?? [];
    expect(tools).toContain("lcm_grep");
    expect(tools).toContain("lcm_describe");
    expect(tools).toContain("lcm_expand");
    const second = adapter.requests[1];
    const roles = second?.messages.map((message) => message.role) ?? [];
    expect(roles).toEqual(["user", "assistant", "tool"]);
  });
});
