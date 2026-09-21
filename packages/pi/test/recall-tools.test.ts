import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { redactSecrets } from "lossless-core";
import { expandView } from "lossless-core";
import { LcmStore } from "lossless-core";
import { ingestEntries } from "lossless-core";
import { metricsPath } from "lossless-core";
import { test } from "vite-plus/test";

import {
  createExpandQueryTool,
  createGrepTool,
  createDescribeTool,
  type ToolResultShape,
} from "../src/tools/recall.ts";
import { readerFor } from "./support/pi-double.ts";

function seedStore(n = 8): LcmStore {
  const s = new LcmStore(":memory:");
  ingestEntries(
    s,
    Array.from({ length: n }, (_, i) => ({
      entryId: `e${String(i).padStart(2, "0")}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `message ${i}: discussing the ${i % 2 === 0 ? "compaction engine" : "recall pipeline"} in detail ${"filler ".repeat(20)}`,
      timestamp: i,
    })),
  );
  return s;
}

function textOf(r: ToolResultShape): string {
  return r.content[0]!.text;
}

test("grep tool: basic match returns entry id, role, and text", async () => {
  const tool = createGrepTool({
    store: () => seedStore(),
    session: () => "s1",
    redact: redactSecrets,
  });
  const r = await tool.execute("t1", { query: "compaction" });
  const lines = textOf(r).split("\n");
  assert.equal(lines[0], "Found 4 match(es):");
  assert.equal(
    lines[1],
    `[e00] (user) message 0: discussing the compaction engine in detail ${"filler ".repeat(20)}`,
  );
  assert.deepEqual(
    lines.slice(1).map((l) => l.slice(0, 12)),
    ["[e00] (user)", "[e02] (user)", "[e04] (user)", "[e06] (user)"],
  );
  assert.deepEqual(r.details, { hits: 4, offset: 0, total: 4 });
});

test("grep tool: FTS5 prefix queries work", async () => {
  const tool = createGrepTool({
    store: () => seedStore(),
    session: () => "s1",
    redact: redactSecrets,
  });
  const r = await tool.execute("t", { query: "compact*" });
  assert.equal(textOf(r).split("\n")[0], "Found 4 match(es):");
  assert.deepEqual(r.details, { hits: 4, offset: 0, total: 4 });
});

test("grep tool: FTS5 AND queries narrow results", async () => {
  const tool = createGrepTool({
    store: () => seedStore(),
    session: () => "s1",
    redact: redactSecrets,
  });
  const both = await tool.execute("t", { query: "compaction AND pipeline" });
  const one = await tool.execute("t", { query: "compaction" });
  assert.equal(textOf(both), 'No matches for "compaction AND pipeline" in session history.');
  assert.equal(textOf(one).split("\n")[0], "Found 4 match(es):");
});

test("grep tool: quoted phrase query works", async () => {
  const tool = createGrepTool({
    store: () => seedStore(),
    session: () => "s1",
    redact: redactSecrets,
  });
  const r = await tool.execute("t", { query: '"recall pipeline"' });
  const lines = textOf(r).split("\n");
  assert.equal(lines[0], "Found 4 match(es):");
  assert.equal(
    lines[1],
    `[e01] (assistant) message 1: discussing the recall pipeline in detail ${"filler ".repeat(20)}`,
  );
  assert.deepEqual(r.details, { hits: 4, offset: 0, total: 4 });
});

test("grep tool: no match returns helpful message, not a crash", async () => {
  const tool = createGrepTool({
    store: () => seedStore(),
    session: () => "s1",
    redact: redactSecrets,
  });
  const r = await tool.execute("t", { query: "zzz_nonexistent" });
  assert.equal(textOf(r), 'No matches for "zzz_nonexistent" in session history.');
});

test("grep tool: limit parameter caps results", async () => {
  const tool = createGrepTool({
    store: () => seedStore(),
    session: () => "s1",
    redact: redactSecrets,
  });
  const r = await tool.execute("t", { query: "message", limit: 2 });
  const lines = textOf(r)
    .split("\n")
    .filter((l) => l.startsWith("[e"));
  assert.equal(lines.length, 2);
});

test("grep tool: unavailable store degrades gracefully", async () => {
  const tool = createGrepTool({
    store: () => undefined,
    session: () => "s1",
    redact: redactSecrets,
  });
  const r = await tool.execute("t", { query: "anything" });
  assert.ok(
    textOf(r).includes("nothing has been ingested"),
    "the answer names the state, not a missing tool",
  );
});

async function makeStoreWithSummary(): Promise<LcmStore> {
  const { runCompaction } = await import("lossless-core");
  const s = seedStore(6);
  const span = s.messagesInSpan("e00", "e03").map((m) => ({
    entryId: m.entryId,
    role: m.role,
    text: m.text,
  }));
  await runCompaction(s, { span, targetTokens: 200 }, async (_p, conv) =>
    conv.slice(0, Math.floor(conv.length / 3)),
  );
  return s;
}

test("describe tool: returns kind, span, and summary text", async () => {
  const s = await makeStoreWithSummary();
  const summary = s.frontier("e00", "e03")[0]!;
  const tool = createDescribeTool({ store: () => s, session: () => "s1", redact: redactSecrets });
  const r = await tool.execute("t", { id: summary.id });
  const out = textOf(r);
  assert.ok(out.includes(`Summary #${summary.id}`));
  assert.ok(out.includes("leaf"));
  assert.ok(out.includes("e00 .. e03"));
  assert.ok(out.includes(summary.text));
  assert.equal((r.details as { kind: string }).kind, "leaf");
});

function twoLevelStore(): { s: LcmStore; l1: number; l2: number; c: number } {
  const s = seedStore(6);
  const leaf = (first: string, last: string) =>
    s.insertSummary({
      kind: "leaf",
      text: `leaf ${first}..${last}`,
      tokens: 3,
      depth: 0,
      firstEntryId: first,
      lastEntryId: last,
      messageIds: s.messagesInSpan(first, last).map((m) => m.id),
    }).id;
  const l1 = leaf("e00", "e01");
  const l2 = leaf("e02", "e03");
  const c = s.insertSummary({
    kind: "condensed",
    text: "condensed e00..e03",
    tokens: 3,
    depth: 1,
    firstEntryId: "e00",
    lastEntryId: "e03",
    childSummaryIds: [l1, l2],
  }).id;
  return { s, l1, l2, c };
}

test("grep tool: hits name the leaf that covers them; uncovered hits carry no pointer", async () => {
  const { s, l1, l2 } = twoLevelStore();
  const tool = createGrepTool({ store: () => s, session: () => "s1", redact: redactSecrets });
  const r = await tool.execute("t", { query: "compaction" });
  const lines = textOf(r).split("\n");
  assert.equal(lines[0], "Found 3 match(es):");
  assert.deepEqual(
    lines.slice(1).map((l) => l.slice(0, l.indexOf(" message"))),
    [`[e00] (user) #${l1}`, `[e02] (user) #${l2}`, "[e04] (user)"],
  );
  s.close();
});

test("grep tool: summary_id scopes hits to the messages a node covers, at any depth", async () => {
  const { s, l1, c } = twoLevelStore();
  const tool = createGrepTool({ store: () => s, session: () => "s1", redact: redactSecrets });
  const scopedLeaf = await tool.execute("t", { query: "message", summary_id: l1 });
  assert.deepEqual(
    textOf(scopedLeaf)
      .split("\n")
      .slice(1)
      .map((l) => l.slice(0, 5)),
    ["[e00]", "[e01]"],
  );
  const scopedCondensed = await tool.execute("t", { query: "message", summary_id: c });
  assert.equal(textOf(scopedCondensed).split("\n")[0], "Found 4 match(es):");
  const none = await tool.execute("t", { query: "message", summary_id: 999 });
  assert.equal(textOf(none), "No summary with id 999.");
  s.close();
});

test("describe tool: shows children and parents so the DAG can be walked", async () => {
  const { s, l1, l2, c } = twoLevelStore();
  const tool = createDescribeTool({ store: () => s, session: () => "s1", redact: redactSecrets });
  const top = textOf(await tool.execute("t", { id: c }));
  assert.ok(top.includes(`Children: #${l1}, #${l2}`), top);
  assert.ok(!top.includes("Parents:"), top);
  const child = textOf(await tool.execute("t", { id: l1 }));
  assert.ok(child.includes(`Parents: #${c}`), child);
  assert.ok(!child.includes("Children:"), child);
  s.close();
});

test("describe tool: unknown id returns a clean error", async () => {
  const tool = createDescribeTool({
    store: () => seedStore(),
    session: () => "s1",
    redact: redactSecrets,
  });
  const r = await tool.execute("t", { id: 9999 });
  assert.ok(textOf(r).includes("No summary with id 9999"));
});

test("expand view: recovers verbatim original messages", async () => {
  const s = await makeStoreWithSummary();
  const summary = s.frontier("e00", "e03")[0]!;
  const originals = s.messagesInSpan("e00", "e03");
  const view = expandView(s, redactSecrets, {
    mode: "list",
    id: summary.id,
    offset: 0,
    limit: 25,
    maxChars: 4000,
  });
  assert.ok(view.ok);
  if (!view.ok) return;
  assert.ok(view.text.includes(`${originals.length} original messages`));
  for (const m of originals) {
    assert.ok(view.text.includes(`[${m.entryId}]`), `must contain entry ${m.entryId}`);
    assert.ok(view.text.includes("message "), "must contain original text");
  }
  assert.equal(view.details["total"], originals.length);
});

test("expand view: offset pages through results", async () => {
  const s = await makeStoreWithSummary();
  const summary = s.frontier("e00", "e03")[0]!;
  const total = s.coveredMessageIds(summary.id).length;
  const page1 = expandView(s, redactSecrets, {
    mode: "list",
    id: summary.id,
    offset: 0,
    limit: 2,
    maxChars: 4000,
  });
  const page2 = expandView(s, redactSecrets, {
    mode: "list",
    id: summary.id,
    offset: 2,
    limit: 2,
    maxChars: 4000,
  });
  assert.ok(page1.ok && page2.ok);
  if (!page1.ok || !page2.ok) return;
  const idsOn = (text: string) => text.split("\n").filter((l) => /^\[e\d/.test(l)).length;
  assert.equal(page1.details["total"], total);
  assert.equal(idsOn(page1.text), 2);
  assert.equal(idsOn(page2.text), 2);
  const id1 = page1.text.match(/\[(e\d+)\]/)![1];
  const id2 = page2.text.match(/\[(e\d+)\]/)![1];
  assert.notEqual(id1, id2);
});

test("expand view: offset beyond total shows zero messages without crashing", async () => {
  const s = await makeStoreWithSummary();
  const summary = s.frontier("e00", "e03")[0]!;
  const view = expandView(s, redactSecrets, {
    mode: "list",
    id: summary.id,
    offset: 999,
    limit: 25,
    maxChars: 4000,
  });
  assert.ok(view.ok);
  if (!view.ok) return;
  assert.equal(
    view.text,
    `Summary #${summary.id} \u2192 4 original messages (showing 0 from 999)\n\n`,
  );
  assert.deepEqual(view.details, { total: 4, offset: 999 });
});

test("expand view: unknown id returns a clean error", async () => {
  const view = expandView(seedStore(), redactSecrets, {
    mode: "list",
    id: 4242,
    offset: 0,
    limit: 25,
    maxChars: 4000,
  });
  assert.equal(view.ok, false);
  assert.equal(view.ok === false && view.text, "No summary with id 4242.");
});

test("grep tool: natural-language queries never throw raw sqlite errors", async () => {
  const tool = createGrepTool({
    store: () => seedStore(),
    session: () => "s1",
    redact: redactSecrets,
  });
  const expected: Array<[string, string]> = [
    ["don't", `No matches for "don't" in session history.`],
    ["AND", 'No matches for "AND" in session history.'],
    ["(", 'No matches for "(" in session history.'],
    ["a OR", 'No matches for "a OR" in session history.'],
    ['unbalanced"', 'Invalid search query "unbalanced\\""; try simpler keywords.'],
  ];
  for (const [q, message] of expected) {
    const r = await tool.execute("t", { query: q });
    assert.equal(textOf(r), message);
    assert.deepEqual(r.details, message.startsWith("No matches") ? { hits: 0 } : {});
  }
});

function metricMark(): number {
  try {
    return readFileSync(metricsPath(), "utf8").length;
  } catch {
    return 0;
  }
}

function rowsSince(mark: number, kind: string): Array<Record<string, unknown>> {
  const raw = readFileSync(metricsPath(), "utf8").slice(mark).trim();
  return raw
    ? raw
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((r) => r.kind === kind)
    : [];
}

test("grep tool: one recall row per call, with counts and no query text", async () => {
  const mark = metricMark();
  const tool = createGrepTool({
    store: () => seedStore(),
    session: () => "s1",
    redact: redactSecrets,
  });
  await tool.execute("t", { query: "compaction" });
  const rows = rowsSince(mark, "recall");
  assert.equal(rows.length, 1, "one call, one row");
  assert.equal(rows[0]!.tool, "lcm_grep");
  assert.equal(rows[0]!.outcome, "hit");
  assert.equal(rows[0]!.hits, 4);
  assert.equal(rows[0]!.session, "s1");
  assert.ok(
    !JSON.stringify(rows[0]).includes("compaction"),
    "the query text never reaches the metrics file",
  );
});

test("grep tool: a search with no match is recorded as a miss", async () => {
  const mark = metricMark();
  const tool = createGrepTool({
    store: () => seedStore(),
    session: () => "s1",
    redact: redactSecrets,
  });
  await tool.execute("t", { query: "nonexistentterm" });
  const rows = rowsSince(mark, "recall");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "miss");
  assert.equal(rows[0]!.hits, 0);
});

test("describe tool: the row names the node and its size", async () => {
  const mark = metricMark();
  const store = await makeStoreWithSummary();
  const tool = createDescribeTool({
    store: () => store,
    session: () => "s1",
    redact: redactSecrets,
  });
  const summary = store.frontier("e00", "e03")[0]!;
  const ok = await tool.execute("t", { id: summary.id });
  const miss = await tool.execute("t", { id: 999 });
  const rows = rowsSince(mark, "recall");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.tool, "lcm_describe");
  assert.equal(rows[0]!.outcome, "hit");
  assert.equal(rows[0]!.id, summary.id);
  assert.equal(rows[0]!.tokens, summary.tokens);
  assert.equal(rows[1]!.outcome, "miss");
  assert.equal(rows[1]!.id, 999);
  assert.ok(ok.details && miss.details !== undefined);
});

test("recall tools: a session with no store writes no row", async () => {
  const mark = metricMark();
  const grep = createGrepTool({
    store: () => undefined,
    session: () => "s1",
    redact: redactSecrets,
  });
  const describe = createDescribeTool({
    store: () => undefined,
    session: () => "s1",
    redact: redactSecrets,
  });
  await grep.execute("t", { query: "anything" });
  await describe.execute("t", { id: 1 });
  assert.equal(rowsSince(mark, "recall").length, 0);
});

test("grep tool: a hit clipped at the line bound names the call that reads the rest", async () => {
  const s = new LcmStore(":memory:");
  const tail = "z".repeat(600);
  const flat = `haystack ${tail}`;
  ingestEntries(s, [
    { entryId: "e00", role: "user", text: flat, timestamp: 1 },
    { entryId: "e01", role: "user", text: "needle that fits", timestamp: 2 },
  ]);
  const tool = createGrepTool({ store: () => s, session: () => "s1", redact: redactSecrets });
  const clipped = await tool.execute("t", { query: "haystack" });
  assert.equal(
    textOf(clipped),
    `Found 1 match(es):\n[e00] (user) ${flat.slice(0, 400)} [lcm:more ${flat.length - 400} chars; read them with lcm_expand_query({entry_id:"e00"})]`,
  );
  const short = await tool.execute("t", { query: "needle" });
  assert.equal(textOf(short), "Found 1 match(es):\n[e01] (user) needle that fits");
  s.close();
});

test("grep tool: the scope parameter is a plain string enum, not a union", () => {
  const tool = createGrepTool({
    store: () => new LcmStore(":memory:"),
    session: () => "s1",
    redact: redactSecrets,
  });
  const schema = JSON.stringify(tool.parameters);
  assert.ok(!schema.includes("anyOf"), schema);
  assert.ok(!schema.includes('"const"'), schema);
  assert.deepEqual(
    (tool.parameters as { properties: Record<string, unknown> }).properties["scope"],
    {
      type: "string",
      enum: ["session", "sessions", "all_sessions"],
      description:
        "session (default) searches this session. sessions searches past sessions in this project's working directory. all_sessions searches past sessions in every project. A cross-session hit is a pointer labelled [lcm:session <hash>] that lcm_expand_query({session, entry_id}) reads, so a past session's text is never injected into the context on its own.",
    },
  );
});

/** The expand-query cases below drive a registered tool, so they live with the
 * adapter that registers it. Their reader is the Pi double, because what the
 * model was asked is this package's rendering. */
const NO_CTX = {} as never;

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function piCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function usage(input: number): Usage {
  return { ...ZERO_USAGE, input, totalTokens: input, cost: { ...ZERO_USAGE.cost, input } };
}

function piAnswer(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: usage(11),
    stopReason: "stop",
    timestamp: 0,
  };
}

function piReads(calls: ToolCall[]): AssistantMessage {
  return {
    role: "assistant",
    content: calls,
    api: "test",
    provider: "test",
    model: "test-model",
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function seedLeaf(texts: string[]): { store: LcmStore; leaf: number } {
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    texts.map((text, i) => ({
      entryId: `e${String(i).padStart(2, "0")}`,
      role: "user" as const,
      text,
      timestamp: i,
    })),
  );
  const last = `e${String(texts.length - 1).padStart(2, "0")}`;
  const leaf = store.insertSummary({
    kind: "leaf",
    text: "leaf text",
    tokens: 2,
    depth: 0,
    firstEntryId: "e00",
    lastEntryId: last,
    messageIds: store.messagesInSpan("e00", last).map((m) => m.id),
  }).id;
  return { store, leaf };
}

test("expand query tool: returns findings with the arithmetic that produced them", async () => {
  const { store, leaf } = seedLeaf(["the deploy token is abc"]);
  const tool = createExpandQueryTool({
    store: () => store,
    session: () => "test-session",
    redact: redactSecrets,
    reader: () =>
      readerFor((context) => {
        const readAlready = context.messages.some((m) => m.role === "toolResult");
        return readAlready
          ? piAnswer("The deploy token is abc (e00).")
          : piReads([piCall("c1", "lcm_expand", { id: leaf, max_chars: 4000 })]);
      }),
  });
  const r = await tool.execute(
    "t",
    { query: "deploy token", prompt: "What is the deploy token?" },
    undefined,
    undefined,
    NO_CTX,
  );
  const out = r.content[0]!.text;
  assert.ok(out.startsWith("Read stored history in 2 step(s)"), out);
  assert.ok(
    out.includes("<recovered_findings>\nThe deploy token is abc (e00).\n</recovered_findings>"),
  );
  assert.equal(r.details["stop"], "answered");
  assert.equal(r.details["steps"], 2);
  assert.equal(r.details["budgetTokens"], 10_000);
  assert.ok(Number(r.details["retrievedTokens"]) > 0);
  assert.equal(r.usage?.input, 11);
  store.close();
});

test("expand query tool: a failed reader is reported, not thrown", async () => {
  const { store } = seedLeaf(["a"]);
  const tool = createExpandQueryTool({
    store: () => store,
    session: () => "test-session",
    redact: redactSecrets,
    reader: () =>
      readerFor(() => {
        throw new Error("no model available");
      }),
  });
  const r = await tool.execute("t", { query: "a", prompt: "p" }, undefined, undefined, NO_CTX);
  assert.equal(r.content[0]!.text, "Retrieval failed: no model available");
  assert.equal(r.details["stop"], "failed");
  store.close();
});

test("expand query tool: an unavailable store degrades gracefully", async () => {
  const tool = createExpandQueryTool({
    store: () => undefined,
    session: () => "test-session",
    redact: redactSecrets,
    reader: () =>
      readerFor(() => {
        throw new Error("should not be called");
      }),
  });
  const r = await tool.execute("t", { query: "a", prompt: "p" }, undefined, undefined, NO_CTX);
  assert.ok(r.content[0]!.text.includes("nothing has been ingested"));
});

test("expand query tool: the reader's own provider calls land on its retrieval row", async () => {
  const mark = metricMark();
  const { store, leaf } = seedLeaf(["the deploy token is abc"]);
  const tool = createExpandQueryTool({
    store: () => store,
    session: () => "test-session",
    redact: redactSecrets,
    reader: () =>
      readerFor((context) => {
        const readAlready = context.messages.some((m) => m.role === "toolResult");
        return readAlready
          ? piAnswer("The deploy token is abc (e00).")
          : piReads([piCall("c1", "lcm_expand", { id: leaf, max_chars: 4000 })]);
      }),
  });
  const r = await tool.execute(
    "t",
    { query: "deploy token", prompt: "What is the deploy token?" },
    undefined,
    undefined,
    NO_CTX,
  );
  const rows = rowsSince(mark, "retrieval");
  assert.equal(rows.length, 1, "one reader run, one row");
  assert.equal(rows[0]!.input, r.usage?.input);
  assert.equal(rows[0]!.output, r.usage?.output);
  assert.equal(rows[0]!.costTotal, r.usage?.cost?.total);
  assert.equal(rows[0]!.steps, 2);
  assert.equal(rows[0]!.stop, "answered");
  store.close();
});

test("expand query tool: a reader that billed nothing writes no counters", async () => {
  const mark = metricMark();
  const { store } = seedLeaf(["a"]);
  const tool = createExpandQueryTool({
    store: () => store,
    session: () => "test-session",
    redact: redactSecrets,
    reader: () =>
      readerFor(() => {
        throw new Error("no model available");
      }),
  });
  await tool.execute("t", { query: "a", prompt: "p" }, undefined, undefined, NO_CTX);
  const rows = rowsSince(mark, "retrieval");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.stop, "failed");
  assert.ok(!("input" in rows[0]!), "no provider counters, no counter fields");
  assert.ok(!("costTotal" in rows[0]!));
  store.close();
});

test("expand query tool: an address travels into the brief and onto the row", async () => {
  const mark = metricMark();
  const { store, leaf } = seedLeaf(["the deploy token is abc"]);
  const briefs: string[] = [];
  const tool = createExpandQueryTool({
    store: () => store,
    session: () => "test-session",
    redact: redactSecrets,
    reader: () =>
      readerFor((context) => {
        const first = context.messages[0]!;
        briefs.push(
          typeof first.content === "string" ? first.content : JSON.stringify(first.content),
        );
        const readAlready = context.messages.some((m) => m.role === "toolResult");
        return readAlready
          ? piAnswer("The deploy token is abc (e00).")
          : piReads([piCall("c1", "lcm_expand", { id: leaf, max_chars: 4000 })]);
      }),
  });
  const r = await tool.execute(
    "t",
    { query: "deploy token", prompt: "What is the token?", summary_id: leaf },
    undefined,
    undefined,
    NO_CTX,
  );
  assert.ok(r.content[0]!.text.startsWith("Read stored history in 2 step(s)"), r.content[0]!.text);
  assert.ok(briefs[0]!.includes(`Read summary #${leaf}`), briefs[0]!);
  const rows = rowsSince(mark, "retrieval");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.scope, "summary");
  assert.equal(rows[0]!.summaryId, leaf);
  assert.equal(rows[0]!.stop, "answered");
  store.close();
});

test("expand query tool: an entry address puts its entry id on the row", async () => {
  const mark = metricMark();
  const { store } = seedLeaf(["the cache key is rot13"]);
  const tool = createExpandQueryTool({
    store: () => store,
    session: () => "test-session",
    redact: redactSecrets,
    reader: () => readerFor(() => piAnswer("The cache key is rot13.")),
  });
  await tool.execute(
    "t",
    { query: "cache key", prompt: "What is the cache key?", entry_id: "e00" },
    undefined,
    undefined,
    NO_CTX,
  );
  const rows = rowsSince(mark, "retrieval");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.scope, "entry");
  assert.equal(rows[0]!.entryId, "e00");
  assert.equal(rows[0]!.summaryId, undefined);
  store.close();
});

test("expand query tool: both addresses at once are refused without a model call", async () => {
  const mark = metricMark();
  const { store, leaf } = seedLeaf(["a"]);
  let called = 0;
  const tool = createExpandQueryTool({
    store: () => store,
    session: () => "test-session",
    redact: redactSecrets,
    reader: () =>
      readerFor(() => {
        called += 1;
        return piAnswer("never");
      }),
  });
  const r = await tool.execute(
    "t",
    { query: "q", prompt: "p", summary_id: leaf, entry_id: "e00" },
    undefined,
    undefined,
    NO_CTX,
  );
  assert.equal(r.content[0]!.text, "Nothing was read: pass summary_id or entry_id, not both.");
  assert.equal(called, 0);
  const rows = rowsSince(mark, "retrieval");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.stop, "refused");
  assert.equal(rows[0]!.steps, 0);
  store.close();
});

test("expand query tool: an unknown address is refused, and no provider was billed", async () => {
  const mark = metricMark();
  const { store } = seedLeaf(["a"]);
  let called = 0;
  const tool = createExpandQueryTool({
    store: () => store,
    session: () => "test-session",
    redact: redactSecrets,
    reader: () =>
      readerFor(() => {
        called += 1;
        return piAnswer("never");
      }),
  });
  const r = await tool.execute(
    "t",
    { query: "q", prompt: "p", summary_id: 4242 },
    undefined,
    undefined,
    NO_CTX,
  );
  assert.equal(r.content[0]!.text, "Nothing was read: no summary with id 4242.");
  assert.equal(r.details["steps"], 0);
  assert.equal(r.usage, undefined);
  assert.equal(called, 0);
  const rows = rowsSince(mark, "retrieval");
  assert.equal(rows[0]!.reason, "no summary with id 4242");
  assert.ok(!("input" in rows[0]!), "a refusal bills nothing");
  store.close();
});
