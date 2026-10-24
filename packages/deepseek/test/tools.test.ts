import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { LcmStore, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { describeAnswer, expandAnswer, grepAnswer, registerRecallTools } from "../src/tools.ts";

function seedStore(): LcmStore {
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    Array.from({ length: 4 }, (_, i) => ({
      entryId: `e${i}`,
      role: "user" as const,
      text: `message ${i}: the ${i % 2 === 0 ? "compaction engine" : "recall pipeline"} decision ${"detail ".repeat(10)}`,
      timestamp: i,
    })),
  );
  return store;
}

const identity = (text: string): string => text;

describe("recall tools", () => {
  it("registers three tools whose schemas reach the wire projection", async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, {});
    void new ToolRuntime(ctx);
    const store = seedStore();
    const dispose = registerRecallTools(ctx, { store: () => store, redact: identity });
    const names = ctx.tools.schemas().map((schema) => schema.name);
    expect(names).toContain("lcm_grep");
    expect(names).toContain("lcm_describe");
    expect(names).toContain("lcm_expand");
    const grep = ctx.tools.schemas().find((schema) => schema.name === "lcm_grep");
    expect(Object.keys(grep?.parameters.properties ?? {})).toContain("query");
    dispose();
    expect(ctx.tools.schemas().map((schema) => schema.name)).not.toContain("lcm_grep");
  });

  it("answers grep, describe, and expand from a real store", () => {
    const store = seedStore();
    const grep = grepAnswer(store, identity, { query: "compaction" });
    expect(grep).toContain("Found 2 match(es):");
    expect(grep).toContain("[e0]");
    expect(grepAnswer(undefined, identity, { query: "compaction" })).toContain("no stored history");
    expect(describeAnswer(store, identity, { id: 999 })).toBe("No summary with id 999.");
    const expanded = expandAnswer(store, identity, { entry_id: "e1" });
    expect(expanded).toContain("recall pipeline");
    expect(expandAnswer(store, identity, {})).toContain("needs an id");
  });
});
