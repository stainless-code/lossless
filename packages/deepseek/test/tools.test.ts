import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { LcmStore, SidecarStores, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import {
  answerGrep,
  describeAnswer,
  expandAnswer,
  grepAnswer,
  registerRecallTools,
  searchPastSessions,
  stopNote,
} from "../src/tools.ts";

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

function seedPast(dir: string, sessionId: string, texts: readonly string[]): void {
  const store = new LcmStore(join(dir, `${sessionId}.sqlite`));
  try {
    ingestEntries(
      store,
      texts.map((text, index) => ({
        entryId: `${sessionId}:prompt:msg_${index + 1}`,
        role: "user" as const,
        text,
        timestamp: index + 1,
      })),
    );
  } finally {
    store.close();
  }
}

function hitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("["));
}

function seedSpan(): { store: LcmStore; leaf: number } {
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    Array.from({ length: 10 }, (_, i) => ({
      entryId: `a${i}`,
      role: "user" as const,
      text: `span message ${i} about the harbor relay`,
      timestamp: i,
    })),
  );
  const messageIds = store.messagesInSpan("a0", "a9").map((message) => message.id);
  const leaf = store.insertSummary({
    kind: "leaf",
    text: "leaf over the whole span",
    tokens: 4,
    depth: 0,
    firstEntryId: "a0",
    lastEntryId: "a9",
    messageIds,
  }).id;
  return { store, leaf };
}

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

  it("names the caller limit in the hit-cap note", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-lossless-hitcap-"));
    seedPast(
      dir,
      "ses_a",
      Array.from({ length: 12 }, () => "narwhal sighted near the floe edge"),
    );
    seedPast(
      dir,
      "ses_b",
      Array.from({ length: 12 }, () => "narwhal sighted near the floe edge"),
    );
    const sidecars = new SidecarStores({ dir });
    try {
      const result = searchPastSessions(
        {
          past: { list: (exclude?: string) => sidecars.list(exclude) },
          redact: identity,
          now: () => 0,
        },
        "ses_current",
        "narwhal",
        { limit: 5 },
      );
      expect(result.hits).toBe(5);
      expect(result.stoppedBy).toBe("hits");
      expect(result.text).toContain("5-hit cap");
      expect(result.text).not.toContain("40-hit cap");
      expect(stopNote("hits", 5)).toContain("5-hit cap");
      expect(stopNote("hits")).toContain("40-hit cap");
    } finally {
      sidecars.close();
    }
  });

  it("clamps a session grep limit to at least one hit", () => {
    const store = seedStore();
    try {
      for (const limit of [0, -4, 1.7]) {
        const rows: Record<string, unknown>[] = [];
        const text = grepAnswer(
          store,
          identity,
          { query: "message", limit },
          { record: (row) => rows.push(row) },
        );
        expect(hitLines(text)).toHaveLength(1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ tool: "lcm_grep", outcome: "hit", hits: 1 });
      }
      const floored = grepAnswer(store, identity, { query: "message", limit: 2.7 });
      expect(hitLines(floored)).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("treats a quoted query as a phrase miss and still counts unreadable stores", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-lossless-rejected-"));
    seedPast(dir, "ses_past", ["hello world"]);
    const sidecars = new SidecarStores({ dir });
    try {
      const past = { list: (exclude?: string) => sidecars.list(exclude) };
      // Embedded quotes phrase-escape instead of failing: a miss, scanned.
      const result = searchPastSessions(
        { past, redact: identity, now: () => 0 },
        "ses_current",
        `foo"bar`,
      );
      expect(result.scanned).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.text).toContain("No matches");
      const rows: Record<string, unknown>[] = [];
      const text = answerGrep(
        {
          store: () => undefined,
          redact: identity,
          record: (row) => rows.push(row),
          pastSessions: past,
        },
        "ses_current",
        { query: `foo"bar`, scope: "sessions" },
      );
      expect(text).toContain("No matches");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tool: "lcm_grep", outcome: "miss", sessionsScanned: 1 });
      // A sidecar that cannot be opened still counts skipped, not scanned.
      const ghost = searchPastSessions(
        {
          past: { list: () => [{ id: "ghost", path: join(dir, "no-such-dir", "ghost.sqlite") }] },
          redact: identity,
          now: () => 0,
        },
        "ses_current",
        "hello",
      );
      expect(ghost.skipped).toBe(1);
      expect(ghost.scanned).toBe(0);
    } finally {
      sidecars.close();
    }
  });

  it("records recall rows for session grep outcomes", () => {
    const store = seedStore();
    try {
      const hitRows: Record<string, unknown>[] = [];
      expect(
        grepAnswer(
          store,
          identity,
          { query: "compaction" },
          { record: (row) => hitRows.push(row) },
        ),
      ).toContain("Found 2 match(es):");
      expect(hitRows).toHaveLength(1);
      expect(hitRows[0]).toMatchObject({
        tool: "lcm_grep",
        outcome: "hit",
        hits: 2,
        queryChars: 10,
      });

      const missRows: Record<string, unknown>[] = [];
      expect(
        grepAnswer(
          store,
          identity,
          { query: "no-such-token-xyz" },
          { record: (row) => missRows.push(row) },
        ),
      ).toContain("No matches");
      expect(missRows).toHaveLength(1);
      expect(missRows[0]).toMatchObject({ tool: "lcm_grep", outcome: "miss", hits: 0 });

      const missingRows: Record<string, unknown>[] = [];
      expect(grepAnswer(store, identity, {}, { record: (row) => missingRows.push(row) })).toContain(
        "needs a query string",
      );
      expect(missingRows).toHaveLength(1);
      expect(missingRows[0]).toMatchObject({ tool: "lcm_grep", outcome: "error", queryChars: 0 });

      const refusedRows: Record<string, unknown>[] = [];
      expect(
        grepAnswer(
          store,
          identity,
          { query: "compaction", scope: "bogus" },
          { record: (row) => refusedRows.push(row) },
        ),
      ).toContain("must be session");
      expect(refusedRows).toHaveLength(1);
      expect(refusedRows[0]).toMatchObject({
        tool: "lcm_grep",
        outcome: "refused",
        scope: "bogus",
      });

      const bothRows: Record<string, unknown>[] = [];
      expect(
        grepAnswer(
          store,
          identity,
          { query: "compaction", pattern: "foo" },
          { record: (row) => bothRows.push(row) },
        ),
      ).toContain("not both");
      expect(bothRows).toHaveLength(1);
      expect(bothRows[0]).toMatchObject({ tool: "lcm_grep", outcome: "error", hits: 0 });

      const phraseRows: Record<string, unknown>[] = [];
      expect(
        grepAnswer(
          store,
          identity,
          { query: `foo"bar` },
          { record: (row) => phraseRows.push(row) },
        ),
      ).toContain("No matches");
      expect(phraseRows).toHaveLength(1);
      expect(phraseRows[0]).toMatchObject({ tool: "lcm_grep", outcome: "miss", hits: 0 });
    } finally {
      store.close();
    }
  });

  it("forwards after and limit through session grep", () => {
    const store = seedStore();
    try {
      const refused = grepAnswer(store, identity, { query: "message", after: "e0" });
      expect(refused).toContain("after resumes a pattern scan");

      const resumed = grepAnswer(store, identity, { pattern: "message", after: "e1" });
      expect(resumed).toContain("[e2 (user)]");
      expect(resumed).toContain("[e3 (user)]");
      expect(resumed).not.toContain("[e0 (user)]");
      expect(resumed).not.toContain("[e1 (user)]");

      const paged = grepAnswer(store, identity, { pattern: "message", after: "e0", limit: 1 });
      expect(paged).toContain("[e1 (user)]");
      expect(paged).not.toContain("[e2 (user)]");

      const first = grepAnswer(store, identity, { query: "message", limit: 1 });
      expect(first).toContain("1..1 of 4");
      expect(hitLines(first)).toHaveLength(1);
      const second = grepAnswer(store, identity, { query: "message", limit: 1, offset: 1 });
      expect(second).toContain("2..2 of 4");
      expect(hitLines(second)).toHaveLength(1);
      expect(second).not.toBe(first);
    } finally {
      store.close();
    }
  });

  it("exposes role, date, tool, and anchor params in the tool schemas", async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, {});
    void new ToolRuntime(ctx);
    const store = seedStore();
    const dispose = registerRecallTools(ctx, { store: () => store, redact: identity });
    try {
      const schemas = ctx.tools.schemas();
      const grep = schemas.find((schema) => schema.name === "lcm_grep");
      expect(Object.keys(grep?.parameters.properties ?? {})).toEqual(
        expect.arrayContaining(["role", "date_start", "date_end", "tool_name"]),
      );
      const expand = schemas.find((schema) => schema.name === "lcm_expand");
      expect(Object.keys(expand?.parameters.properties ?? {})).toContain("anchor");
    } finally {
      dispose();
      store.close();
    }
  });

  it("forwards role, date, and tool filters through session grep", () => {
    const store = new LcmStore(":memory:");
    try {
      ingestEntries(store, [
        { entryId: "f0", role: "user", text: "zephyr routing decision", timestamp: 100 },
        {
          entryId: "f1",
          role: "assistant",
          text: "zephyr routing decision confirmed",
          timestamp: 200,
        },
        {
          entryId: "f2",
          role: "assistant",
          text: "[tool:Read] zephyr routing decision file",
          timestamp: 300,
        },
        {
          entryId: "f3",
          role: "toolResult",
          text: "[tool:Read] zephyr routing decision contents",
          timestamp: 400,
        },
      ]);
      const role = grepAnswer(store, identity, { query: "zephyr", role: "assistant" });
      expect(role).toContain("[f1]");
      expect(role).toContain("[f2]");
      expect(role).not.toContain("[f0]");
      expect(role).not.toContain("[f3]");
      const window = grepAnswer(store, identity, {
        query: "zephyr",
        date_start: 150,
        date_end: 250,
      });
      expect(window).toContain("[f1]");
      expect(window).not.toContain("[f0]");
      expect(window).not.toContain("[f2]");
      const scoped = grepAnswer(store, identity, { query: "zephyr", tool_name: "Read" });
      expect(scoped).toContain("[f2]");
      expect(scoped).toContain("[f3]");
      expect(scoped).not.toContain("[f0]");
      expect(scoped).not.toContain("[f1]");
      const both = grepAnswer(store, identity, {
        query: "zephyr",
        role: "assistant",
        tool_name: "Read",
      });
      expect(both).toContain("[f2]");
      expect(both).not.toContain("[f3]");
    } finally {
      store.close();
    }
  });

  it("refuses a pattern scoped to a tool and a pattern over past sessions", () => {
    const store = seedStore();
    try {
      expect(grepAnswer(store, identity, { pattern: "message", tool_name: "Read" })).toContain(
        "toolName scopes a query search",
      );
      expect(
        answerGrep(
          {
            store: () => store,
            redact: identity,
            pastSessions: { list: () => [] },
          },
          "ses_current",
          { pattern: "message", scope: "sessions" },
        ),
      ).toContain("a pattern scan searches this session");
    } finally {
      store.close();
    }
  });

  it("centers a summary listing on an anchor", () => {
    const { store, leaf } = seedSpan();
    try {
      const centered = expandAnswer(store, identity, { id: leaf, anchor: "a5", limit: 5 });
      expect(centered).toContain("anchored at a5");
      for (const id of ["a3", "a4", "a5", "a6", "a7"]) {
        expect(centered).toContain(`[${id}]`);
      }
      expect(centered).not.toContain("[a0]");
    } finally {
      store.close();
    }
  });

  it("refuses an anchor without an id and an anchor with an entry id", () => {
    const { store, leaf } = seedSpan();
    try {
      expect(expandAnswer(store, identity, { anchor: "a5" })).toContain(
        "anchor centers a summary listing",
      );
      expect(expandAnswer(store, identity, { id: leaf, entry_id: "a5", anchor: "a5" })).toContain(
        "pass anchor or entry_id",
      );
    } finally {
      store.close();
    }
  });
});
