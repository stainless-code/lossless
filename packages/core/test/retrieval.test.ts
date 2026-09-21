import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import type { Reader, ReaderCall, ReaderReply, Usage } from "../src/host.ts";
import { ingestEntries } from "../src/ingest.ts";
import { describeView, expandView, historyManifest } from "../src/recall-view.ts";
import { redactSecrets } from "../src/redact.ts";
import { runRetrieval } from "../src/retrieval.ts";
import { LcmStore } from "../src/store.ts";
import { fakeReader } from "./support/fake-host.ts";

const ZERO: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function usage(input: number): Usage {
  return { ...ZERO, input, totalTokens: input, cost: { ...ZERO.cost, input } };
}

function reads(calls: ReaderCall[], messageUsage: Usage = ZERO): ReaderReply {
  return { outcome: "reads", calls, text: "", usage: messageUsage };
}

function call(id: string, name: string, args: Record<string, unknown>): ReaderCall {
  return { id, name, arguments: args };
}

function answer(text: string): ReaderReply {
  return { outcome: "answered", text, usage: usage(11) };
}

function seed(texts: string[]): { store: LcmStore; leaf: number } {
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

test("retrieval: answers from the stored originals it read", async () => {
  const { store, leaf } = seed(["the cache key is rot13", "unrelated chatter"]);
  const { reader, handed } = fakeReader([
    reads([call("c1", "lcm_expand", { id: leaf, max_chars: 4000 })]),
    answer("The cache key is rot13 (e00)."),
  ]);
  const run = await runRetrieval(
    store,
    {
      query: "cache key",
      prompt: "What is the cache key?",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: redactSecrets,
    },
    reader,
  );
  assert.equal(run.kind, "answered");
  assert.equal(run.text, "The cache key is rot13 (e00).");
  assert.equal(run.steps, 2);
  assert.ok(run.retrievedTokens > 0, "the read is charged");
  assert.equal(run.usage?.input, 11, "usage is summed across turns");
  const first = handed[1]![0]!.text;
  assert.ok(first.includes("the cache key is rot13"), first);
  store.close();
});

test("retrieval: the brief names the frontier with costs, not the transcript", async () => {
  const { store } = seed(["SECRETBODYONE", "SECRETBODYTWO"]);
  const { reader, requests } = fakeReader([answer("done")]);
  await runRetrieval(
    store,
    {
      query: "alpha",
      prompt: "find alpha",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: redactSecrets,
    },
    reader,
  );
  const brief = requests[0]!.brief;
  assert.ok(brief.includes("Question: alpha"));
  assert.ok(brief.includes("What to find out: find alpha"));
  assert.ok(brief.includes("1 top-level summaries cover messages e00 .. e01"));
  assert.ok(brief.includes("source"), brief);
  assert.ok(!brief.includes("SECRETBODY"), "the brief carries no stored message text");
  store.close();
});

test("retrieval: a message longer than one window is reachable in full", async () => {
  const body = `${"m".repeat(11_993)}TAILMARK`;
  const { store, leaf } = seed([body]);
  const { reader, handed } = fakeReader([
    reads([
      call("c1", "lcm_expand", { id: leaf, entry_id: "e00", char_offset: 0, max_chars: 8000 }),
    ]),
    reads([
      call("c2", "lcm_expand", { id: leaf, entry_id: "e00", char_offset: 8000, max_chars: 8000 }),
    ]),
    answer("The message ends with TAILMARK."),
  ]);
  const run = await runRetrieval(
    store,
    {
      query: "tailmark",
      prompt: "How does it end?",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: redactSecrets,
    },
    reader,
  );
  assert.equal(run.kind, "answered");
  const first = handed[1]![0]!.text;
  const second = handed[2]![0]!.text;
  assert.ok(first.startsWith("[e00] (user) chars 0..8000 of "), first.slice(0, 60));
  assert.ok(!first.includes("TAILMARK"), "the first window stops short of the tail");
  assert.ok(second.includes("TAILMARK"), "the second window reaches the tail");
  assert.equal(second.includes("[lcm:budget"), false, "a window inside the budget is not clipped");
  store.close();
});

test("retrieval: the budget clips a read and the run reports it", async () => {
  const { store } = seed(["needle ".repeat(50)]);
  const { reader, handed } = fakeReader([
    reads([call("c1", "lcm_grep", { query: "needle", limit: 5 })]),
    answer("Read what I could."),
  ]);
  const run = await runRetrieval(
    store,
    { query: "needle", prompt: "read", budgetTokens: 20, maxSteps: 6, redact: redactSecrets },
    reader,
  );
  assert.equal(run.kind, "stopped");
  assert.equal(run.kind === "stopped" && run.reason, "budget");
  assert.ok(run.retrievedTokens <= 20, `charged ${run.retrievedTokens} of 20`);
  assert.ok(handed[1]![0]!.text.includes("[lcm:budget"), "the clip is named");
  store.close();
});

test("retrieval: a spent budget refuses further reads", async () => {
  const { store, leaf } = seed(["z".repeat(400)]);
  const { reader, handed } = fakeReader([
    reads([call("c1", "lcm_expand", { id: leaf, max_chars: 400 })]),
    reads([call("c2", "lcm_expand", { id: leaf, entry_id: "e00", max_chars: 400 })]),
    answer("Nothing left to read."),
  ]);
  const run = await runRetrieval(
    store,
    { query: "z", prompt: "read", budgetTokens: 1, maxSteps: 6, redact: redactSecrets },
    reader,
  );
  assert.equal(run.kind, "stopped");
  assert.ok(run.retrievedTokens <= 1, `charged ${run.retrievedTokens} of 1`);
  assert.ok(handed[2]![0]!.text.includes("Retrieval budget reached"), "the refusal says so");
  store.close();
});

test("retrieval: running out of steps stops with what was read so far", async () => {
  const { store, leaf } = seed(["keep me"]);
  const { reader } = fakeReader([
    reads([call("c1", "lcm_describe", { id: leaf })]),
    reads([call("c2", "lcm_describe", { id: leaf })]),
  ]);
  const run = await runRetrieval(
    store,
    { query: "keep", prompt: "read", budgetTokens: 8000, maxSteps: 2, redact: redactSecrets },
    reader,
  );
  assert.equal(run.kind, "stopped");
  assert.equal(run.kind === "stopped" && run.reason, "steps");
  assert.equal(run.steps, 2);
  store.close();
});

test("retrieval: the port serves a host that is not Pi", async () => {
  const { store } = seed(["the cache key is rot13"]);
  const { reader, requests, handed } = fakeReader([
    {
      outcome: "reads",
      calls: [{ id: "c1", name: "lcm_expand", arguments: { entry_id: "e00", max_chars: 4000 } }],
      text: "",
      usage: undefined,
    },
    { outcome: "answered", text: "the cache key is rot13", usage: undefined },
  ]);
  const run = await runRetrieval(
    store,
    {
      query: "cache key",
      prompt: "what is it?",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: redactSecrets,
    },
    reader,
  );
  assert.equal(run.kind, "answered");
  assert.equal(run.kind === "answered" && run.text, "the cache key is rot13");
  assert.equal(run.steps, 2);
  assert.equal(requests.length, 1);
  assert.ok(
    requests[0]!.systemPrompt.startsWith("You answer questions"),
    requests[0]!.systemPrompt,
  );
  assert.ok(requests[0]!.brief.includes("what is it?"), requests[0]!.brief);
  assert.equal(requests[0]!.tools.length, 3);
  assert.deepEqual(handed[0], []);
  assert.equal(handed[1]!.length, 1);
  assert.equal(handed[1]![0]!.call.name, "lcm_expand");
  assert.match(handed[1]![0]!.text, /rot13/);
  store.close();
});

test("retrieval: a throwing reader fails with its message", async () => {
  const { store } = seed(["a"]);
  const reader: Reader = {
    begin: () => ({
      next: async () => {
        throw new Error("provider refused");
      },
    }),
  };
  const run = await runRetrieval(
    store,
    { query: "a", prompt: "read", budgetTokens: 8000, maxSteps: 6, redact: redactSecrets },
    reader,
  );
  assert.equal(run.kind, "failed");
  assert.equal(run.kind === "failed" && run.reason, "provider refused");
  store.close();
});

test("retrieval: a reader that reports a failure fails the run with its reason", async () => {
  const { store } = seed(["a"]);
  const { reader } = fakeReader([{ outcome: "failed", reason: "rate limited", usage: undefined }]);
  const run = await runRetrieval(
    store,
    { query: "a", prompt: "read", budgetTokens: 8000, maxSteps: 6, redact: redactSecrets },
    reader,
  );
  assert.equal(run.kind, "failed");
  assert.equal(run.kind === "failed" && run.reason, "rate limited");
  store.close();
});

test("retrieval: an unknown tool name is reported back, not fatal", async () => {
  const { store } = seed(["a"]);
  const { reader, handed } = fakeReader([
    reads([call("c1", "lcm_delete_everything", {})]),
    answer("Recovered."),
  ]);
  const run = await runRetrieval(
    store,
    { query: "a", prompt: "read", budgetTokens: 8000, maxSteps: 6, redact: redactSecrets },
    reader,
  );
  assert.equal(run.kind, "answered");
  assert.ok(handed[1]![0]!.text.includes("Unknown tool lcm_delete_everything"));
  store.close();
});

test("describe view: reports what an expansion would cost, at both levels", async () => {
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    Array.from({ length: 6 }, (_, i) => ({
      entryId: `e${i}`,
      role: "user" as const,
      text: "w".repeat(400),
      timestamp: i,
    })),
  );
  const leaf = (first: string, last: string) =>
    store.insertSummary({
      kind: "leaf",
      text: `leaf ${first}`,
      tokens: 10,
      depth: 0,
      firstEntryId: first,
      lastEntryId: last,
      messageIds: store.messagesInSpan(first, last).map((m) => m.id),
    }).id;
  const left = leaf("e0", "e1");
  const right = leaf("e2", "e3");
  const top = store.insertSummary({
    kind: "condensed",
    text: "top text",
    tokens: 20,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e3",
    childSummaryIds: [left, right],
  }).id;
  const view = describeView(store, redactSecrets, top);
  assert.ok(view.ok);
  if (!view.ok) return;
  assert.ok(view.text.includes("source 400 tokens across 4 messages"), view.text);
  assert.ok(view.text.includes("subtree 40 tokens"), view.text);
  assert.ok(view.text.includes(`Children: #${left}, #${right}`));
  assert.ok(view.text.includes("Child costs:"));
  assert.ok(view.text.includes(`#${left} leaf depth 0, 10 tokens, source 200`));
  store.close();
});

test("expand view: listing a clipped message names how to read the rest", async () => {
  const body = `${"q".repeat(3000)}` + "ENDMARK";
  const { store, leaf } = seed([body]);
  const view = expandView(store, redactSecrets, {
    mode: "list",
    id: leaf,
    offset: 0,
    limit: 25,
    maxChars: 1000,
  });
  assert.ok(view.ok);
  if (!view.ok) return;
  assert.ok(
    view.text.includes('[lcm:more 2007 chars; read them with entry_id "e00" and char_offset 1000]'),
    view.text,
  );
  const rest = expandView(store, redactSecrets, {
    mode: "message",
    id: leaf,
    entryId: "e00",
    charOffset: 1000,
    maxChars: 3000,
  });
  assert.ok(rest.ok);
  if (!rest.ok) return;
  assert.ok(rest.text.includes("ENDMARK"), "the window reaches the end");
  store.close();
});

test("expand view: an unknown entry and an unknown summary are clean errors", async () => {
  const { store, leaf } = seed(["a"]);
  const missing = expandView(store, redactSecrets, {
    mode: "message",
    id: leaf,
    entryId: "nope",
    charOffset: 0,
    maxChars: 100,
  });
  assert.equal(missing.ok, false);
  assert.equal(
    missing.ok === false && missing.text,
    `Message nope is not covered by summary #${leaf}.`,
  );
  const noSummary = expandView(store, redactSecrets, {
    mode: "list",
    id: 999,
    offset: 0,
    limit: 25,
    maxChars: 100,
  });
  assert.equal(noSummary.ok === false && noSummary.text, "No summary with id 999.");
  store.close();
});

test("history manifest: names the frontier newest first and admits an empty store", async () => {
  const empty = new LcmStore(":memory:");
  assert.equal(historyManifest(empty, 20), "No history is stored yet.");
  ingestEntries(empty, [{ entryId: "e0", role: "user", text: "no summary yet", timestamp: 0 }]);
  assert.match(historyManifest(empty, 20), /no summaries yet/);
  const { store } = seed(["a", "b", "c"]);
  assert.match(
    historyManifest(store, 20),
    /1 top-level summaries cover messages e00 .. e02:\n#\d+ leaf depth 0/,
  );
  store.close();
  empty.close();
});

test("retrieval: a run only reads the store", async () => {
  const { store, leaf } = seed(["read only", "second message"]);
  const before = {
    stats: store.stats(),
    summaries: store.allSummaries().length,
    text: store.messagesByIds(store.coveredMessageIds(leaf)).map((m) => m.text),
  };
  const { reader } = fakeReader([
    reads([call("c1", "lcm_describe", { id: leaf })]),
    reads([call("c2", "lcm_expand", { id: leaf, max_chars: 4000 })]),
    answer("read"),
  ]);
  const run = await runRetrieval(
    store,
    { query: "read", prompt: "read", budgetTokens: 8000, maxSteps: 6, redact: redactSecrets },
    reader,
  );
  assert.equal(run.kind, "answered");
  const after = store.stats();
  assert.equal(after.messages, before.stats.messages);
  assert.equal(after.summaries, before.stats.summaries);
  assert.equal(store.allSummaries().length, before.summaries);
  assert.deepEqual(
    store.messagesByIds(store.coveredMessageIds(leaf)).map((m) => m.text),
    before.text,
  );
  store.close();
});

test("retrieval: an addressed summary is named in the brief, question and all", async () => {
  const { store, leaf } = seed(["the cache key is rot13", "unrelated chatter"]);
  const { reader, requests } = fakeReader([
    reads([call("c1", "lcm_expand", { id: leaf, max_chars: 4000 })]),
    answer("The cache key is rot13 (e00)."),
  ]);
  const run = await runRetrieval(
    store,
    {
      query: "cache key",
      prompt: "quote it verbatim",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: redactSecrets,
      scope: { kind: "summary", summaryId: leaf },
    },
    reader,
  );
  assert.equal(run.kind, "answered");
  const brief = requests[0]!.brief;
  assert.ok(brief.startsWith("Question: cache key"), brief);
  assert.ok(brief.includes(`Read summary #${leaf} (leaf, depth 0, span e00..e01)`), brief);
  assert.ok(brief.includes("2 original message(s)"), brief);
  assert.ok(brief.includes(`lcm_expand {id: ${leaf}}`), brief);
  store.close();
});

test("retrieval: an address the store does not hold is refused before any model call", async () => {
  const { store } = seed(["one message"]);
  const { reader, requests } = fakeReader([]);
  const run = await runRetrieval(
    store,
    {
      query: "q",
      prompt: "p",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: redactSecrets,
      scope: { kind: "summary", summaryId: 999 },
    },
    reader,
  );
  assert.equal(run.kind, "refused");
  if (run.kind !== "refused") return;
  assert.equal(run.reason, "no summary with id 999");
  assert.equal(run.steps, 0);
  assert.equal(run.retrievedTokens, 0);
  assert.equal(requests.length, 0, "the provider was never called");
  store.close();
});

test("retrieval: an entry that no summary covers is readable by id", async () => {
  const store = new LcmStore(":memory:");
  ingestEntries(store, [
    { entryId: "e00", role: "user", text: "the uncovered decision", timestamp: 0 },
  ]);
  assert.equal(store.coveringSummaryId("e00"), undefined, "nothing covers it yet");
  const { reader, requests, handed } = fakeReader([
    reads([call("c1", "lcm_expand", { entry_id: "e00", max_chars: 4000 })]),
    answer("It said: the uncovered decision (e00)."),
  ]);
  const run = await runRetrieval(
    store,
    {
      query: "decision",
      prompt: "quote it",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: redactSecrets,
      scope: { kind: "entry", entryId: "e00" },
    },
    reader,
  );
  assert.equal(run.kind, "answered");
  const brief = requests[0]!.brief;
  assert.ok(brief.includes("Read entry e00."), brief);
  assert.ok(brief.includes("No summary covers it yet"), brief);
  const read = handed[1]![0]!.text;
  assert.ok(read.includes("the uncovered decision"), read);
  assert.ok(read.startsWith("[e00] (user) chars 0.."), read.slice(0, 40));
  const leaf = store.insertSummary({
    kind: "leaf",
    text: "leaf",
    tokens: 1,
    depth: 0,
    firstEntryId: "e00",
    lastEntryId: "e00",
    messageIds: [1],
  }).id;
  assert.equal(store.coveringSummaryId("e00"), leaf);
  store.close();
});

test("retrieval: an addressed entry names its covering summary, and an unknown one is refused", async () => {
  const { store, leaf } = seed(["the cache key is rot13"]);
  const { reader, requests } = fakeReader([answer("done")]);
  const run = await runRetrieval(
    store,
    {
      query: "q",
      prompt: "p",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: redactSecrets,
      scope: { kind: "entry", entryId: "e00" },
    },
    reader,
  );
  assert.equal(run.kind, "answered");
  const brief = requests[0]!.brief;
  assert.ok(brief.includes(`It is covered by summary #${leaf}`), brief);
  assert.equal(store.coveringSummaryId("nope"), undefined);

  const { reader: never } = fakeReader([]);
  const refused = await runRetrieval(
    store,
    {
      query: "q",
      prompt: "p",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: redactSecrets,
      scope: { kind: "entry", entryId: "nope" },
    },
    never,
  );
  assert.equal(refused.kind, "refused");
  if (refused.kind !== "refused") return;
  assert.equal(refused.reason, "no stored message with entry id nope");
  store.close();
});
