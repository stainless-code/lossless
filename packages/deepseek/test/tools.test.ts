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
    expect(Object.keys(grep?.parameters.properties ?? {})).toEqual(
      expect.arrayContaining([
        "query",
        "pattern",
        "case_sensitive",
        "offset",
        "after",
        "limit",
        "summary_id",
        "include_removed",
        "scope",
      ]),
    );
    const expand = ctx.tools.schemas().find((schema) => schema.name === "lcm_expand");
    expect(Object.keys(expand?.parameters.properties ?? {})).toContain("session");
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

  it("greps with a pattern, case sensitivity, and an offset", () => {
    const store = seedStore();
    const insensitive = grepAnswer(store, identity, { pattern: "MESSAGE" });
    expect(insensitive).toContain("[e0 (user)]");
    expect(insensitive).toContain("[e3 (user)]");
    const sensitiveMiss = grepAnswer(store, identity, {
      pattern: "MESSAGE",
      case_sensitive: true,
    });
    expect(sensitiveMiss).toContain("No matches for pattern");
    const paged = grepAnswer(store, identity, { pattern: "MESSAGE", offset: 1 });
    expect(paged).not.toContain("[e0 (user)]");
    expect(paged).toContain("[e1 (user)]");
  });

  it("scopes grep to one summary id", () => {
    const store = seedStore();
    const messageIds = store.messagesInSpan("e0", "e1").map((message) => message.id);
    const summaryId = store.insertSummary({
      kind: "leaf",
      text: "leaf over the first two messages",
      tokens: 4,
      depth: 0,
      firstEntryId: "e0",
      lastEntryId: "e1",
      messageIds,
    }).id;
    const scoped = grepAnswer(store, identity, { query: "compaction", summary_id: summaryId });
    expect(scoped).toContain("[e0]");
    expect(scoped).not.toContain("[e2]");
  });

  it("hides removed branch hits unless include_removed is set", () => {
    const store = seedStore();
    store.setRemoved(["e1"], 100);
    const hidden = grepAnswer(store, identity, { query: "recall pipeline" });
    expect(hidden).toContain("[e3]");
    expect(hidden).not.toContain("[e1]");
    const shown = grepAnswer(store, identity, {
      query: "recall pipeline",
      include_removed: true,
    });
    expect(shown).toContain("[e1]");
    expect(shown).toContain("[removed]");
    expect(shown).toContain("[e3]");
  });
});
