import assert from "node:assert/strict";

import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { LcmStore } from "lossless-core";
import { ingestEntries } from "lossless-core";
import { describeView, grepView, expandView } from "lossless-core";
import { runRetrieval } from "lossless-core";
import { makeRedact, redactSecrets } from "lossless-core";
import { exportTranscript } from "lossless-core";
import { test } from "vite-plus/test";

import { storedPass } from "../../core/test/support/pass-outcome.ts";
import { createDescribeTool, createGrepTool } from "../src/tools/recall.ts";
import { scriptedReader } from "./support/pi-double.ts";

const KEY = "sk-abcdefghij0123456789";
const MASKED = "[REDACTED]";

function rawStore(texts: string[]): LcmStore {
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
  return store;
}

test("egress: a grep line is masked and the stored row is not touched", async () => {
  const store = rawStore([`the deploy key is ${KEY} and nothing else matters`]);
  const view = grepView(store, redactSecrets, { query: "deploy" });
  assert.ok(view.ok);
  assert.ok(view.text.includes(MASKED), view.text);
  assert.equal(view.text.includes(KEY), false, "the key does not survive the line");
  assert.equal(
    store.messageByEntryId("e00")?.text.includes(KEY),
    true,
    "reading does not rewrite the row",
  );
  const tool = createGrepTool({
    store: () => store,
    session: () => "s1",
    redact: redactSecrets,
  });
  const result = await tool.execute("t", { query: "deploy" });
  assert.equal(result.content[0]!.text.includes(KEY), false, "the tool result is masked too");
  store.close();
});

test("egress: the mask runs before the grep line is cut, not after", () => {
  const filler = "context ".repeat(60);
  const store = rawStore([`${filler.slice(0, 390)} ${KEY} trailing words`]);
  const view = grepView(store, redactSecrets, { query: "context" });
  assert.ok(view.ok);
  assert.equal(view.text.includes("sk-"), false, view.text.slice(380, 470));
  assert.equal(view.text.includes("abcdefghij"), false, "no part of the key survives");
  assert.ok(view.text.includes("[REDACT"), view.text.slice(380, 470));
  store.close();
});

test("egress: describe and expand read masked text", () => {
  const store = rawStore([`the deploy key is ${KEY}`, `and again ${KEY} at the tail`]);
  const leaf = store.insertSummary({
    kind: "leaf",
    text: `the key was ${KEY}`,
    tokens: 5,
    depth: 0,
    firstEntryId: "e00",
    lastEntryId: "e01",
    messageIds: store.messagesInSpan("e00", "e01").map((m) => m.id),
  }).id;
  const described = describeView(store, redactSecrets, leaf);
  assert.ok(described.ok);
  assert.ok(described.text.includes(MASKED), described.text);
  assert.equal(described.text.includes(KEY), false, "node text is masked at the read");

  const listed = expandView(store, redactSecrets, {
    mode: "list",
    id: leaf,
    offset: 0,
    limit: 25,
    maxChars: 4000,
  });
  assert.ok(listed.ok);
  assert.equal(listed.text.includes(KEY), false, "no listed body carries the key");

  const read = expandView(store, redactSecrets, {
    mode: "message",
    id: leaf,
    entryId: "e00",
    charOffset: 0,
    maxChars: 4000,
  });
  assert.ok(read.ok);
  assert.ok(read.text.includes(MASKED), read.text);
  assert.equal(read.text.includes(KEY), false);
  store.close();
});

test("egress: the lcm_describe tool result is masked", async () => {
  const store = rawStore(["a body"]);
  const leaf = store.insertSummary({
    kind: "leaf",
    text: `key ${KEY} in the node`,
    tokens: 5,
    depth: 0,
    firstEntryId: "e00",
    lastEntryId: "e00",
    messageIds: store.messagesInSpan("e00", "e00").map((m) => m.id),
  }).id;
  const tool = createDescribeTool({
    store: () => store,
    session: () => "s1",
    redact: redactSecrets,
  });
  const result = await tool.execute("t", { id: leaf });
  assert.equal(result.content[0]!.text.includes(KEY), false, "the describe text is masked");
  store.close();
});

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test-model",
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

test("egress: the reader reads masked text and its findings are masked", async () => {
  const store = rawStore([`the deploy key is ${KEY} and the cache key is rot13`]);
  const { reader, contexts } = scriptedReader([
    assistant([call("c1", "lcm_grep", { query: "deploy" })]),
    assistant([call("c2", "lcm_expand", { entry_id: "e00", max_chars: 4000 })]),
    assistant([{ type: "text", text: `The deploy key is ${KEY}.` }]),
  ]);
  const run = await runRetrieval(
    store,
    {
      query: "deploy key",
      prompt: "quote it verbatim",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: redactSecrets,
    },
    reader,
  );
  assert.equal(run.kind, "answered");
  assert.equal(run.text.includes(KEY), false, "the findings are masked");
  assert.ok(run.text.includes(MASKED), run.text);
  const reads = contexts
    .flatMap((c) => c.messages)
    .flatMap((m) =>
      m.role === "toolResult" ? m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])) : [],
    );
  assert.ok(reads.length >= 2, "both reads landed in the reader's context");
  for (const read of reads) {
    assert.equal(read.includes(KEY), false, "the reader never holds the key");
  }
  store.close();
});

test("egress: the summarizer input is masked, the stored summary stays masked", async () => {
  const store = rawStore([`the deploy key is ${KEY}`]);
  const prompts: string[] = [];
  const outcome = await storedPass(
    store,
    {
      span: [{ entryId: "e00", role: "user", text: `the deploy key is ${KEY}` }],
      targetTokens: 2000,
    },
    async (systemPrompt, userText) => {
      prompts.push(userText);
      return `summary of ${KEY}`;
    },
    { redact: redactSecrets },
  );
  assert.equal(prompts.length > 0, true, "the summarizer ran");
  for (const prompt of prompts) {
    assert.equal(prompt.includes(KEY), false, "the span reaches the model masked");
    assert.ok(prompt.includes(MASKED), prompt);
  }
  assert.equal(
    outcome.summaryText.includes(KEY),
    false,
    "a summary is derived, so it is stored masked",
  );
  store.close();
});

test("egress: a file preview reaches the summarizer masked", async () => {
  const body = `/x/notes.md body\nnotes line with ${KEY} in it\n${"filler\n".repeat(200)}`;
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    [
      {
        entryId: "e00",
        role: "toolResult" as const,
        text: body,
        timestamp: 1,
        fileHint: { path: "/x/notes.md" },
      },
    ],
    { externalize: { largeFileChars: 100 } },
  );
  const ref = store.filesForMessages(store.messagesInSpan("e00", "e00").map((m) => m.id));
  assert.equal(ref.length, 1, "the body was externalized");
  assert.ok(ref[0]!.preview.includes(KEY), "the stored descriptor keeps the raw preview");
  let seen = "";
  await storedPass(
    store,
    { span: [{ entryId: "e00", role: "toolResult", text: body }], targetTokens: 2000 },
    async (_systemPrompt, userText) => {
      seen = userText;
      return "described";
    },
    { redact: redactSecrets },
  );
  assert.equal(seen.includes(KEY), false, "the preview is masked on its way to the model");
  assert.ok(seen.includes(MASKED), seen.slice(0, 200));
  store.close();
});

test("egress: the toggle changes what leaves, never what is stored", async () => {
  const span = [{ entryId: "e00", role: "user" as const, text: `the deploy key is ${KEY}` }];
  const masked = new LcmStore(":memory:");
  const plain = new LcmStore(":memory:");
  const answering = async (): Promise<string> => `summary of ${KEY}`;
  await storedPass(masked, { span, targetTokens: 2000 }, answering, { redact: redactSecrets });
  await storedPass(plain, { span, targetTokens: 2000 }, answering, { redact: (t) => t });
  assert.equal(
    masked.messageByEntryId("e00")!.text,
    plain.messageByEntryId("e00")!.text,
    "the flag does not reach the messages table",
  );
  assert.equal(masked.messageByEntryId("e00")!.text, span[0]!.text);
  assert.equal(masked.allSummaries()[0]!.text.includes(KEY), false);
  assert.equal(plain.allSummaries()[0]!.text.includes(KEY), true);
  masked.close();
  plain.close();
});

test("egress: an export carries the stored bytes, key included", () => {
  const store = rawStore([`the deploy key is ${KEY}`]);
  const jsonl = exportTranscript(store).toJSONL();
  assert.ok(jsonl.includes(KEY), "an export is a store surface, so it is verbatim");
  store.close();
});

test("egress: the toggle disables every mask on the way out", async () => {
  const off = makeRedact(() => ({ redactSecrets: false }));
  const store = rawStore([`the deploy key is ${KEY}`]);
  assert.equal(grepView(store, off, { query: "deploy" }).text.includes(KEY), true);
  const leaf = store.insertSummary({
    kind: "leaf",
    text: `key ${KEY}`,
    tokens: 5,
    depth: 0,
    firstEntryId: "e00",
    lastEntryId: "e00",
    messageIds: store.messagesInSpan("e00", "e00").map((m) => m.id),
  }).id;
  assert.equal(describeView(store, off, leaf).text.includes(KEY), true);
  const read = expandView(store, off, {
    mode: "message",
    id: leaf,
    entryId: "e00",
    charOffset: 0,
    maxChars: 4000,
  });
  assert.ok(read.ok);
  assert.equal(read.text.includes(KEY), true, "a message read is unmasked with the toggle off");
  const { reader, contexts } = scriptedReader([
    assistant([call("c1", "lcm_expand", { entry_id: "e00", max_chars: 4000 })]),
    assistant([{ type: "text", text: `The deploy key is ${KEY}.` }]),
  ]);
  const run = await runRetrieval(
    store,
    {
      query: "deploy key",
      prompt: "quote it verbatim",
      budgetTokens: 8000,
      maxSteps: 6,
      redact: off,
    },
    reader,
  );
  assert.equal(run.kind, "answered");
  assert.equal(run.text.includes(KEY), true, "the findings pass through unmasked");
  const reads = contexts
    .flatMap((c) => c.messages)
    .flatMap((m) =>
      m.role === "toolResult" ? m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])) : [],
    );
  assert.equal(
    reads.some((text) => text.includes(KEY)),
    true,
    "the reader holds the key",
  );
  const fresh = rawStore([`the deploy key is ${KEY}`]);
  let seen = "";
  await storedPass(
    fresh,
    {
      span: [{ entryId: "e00", role: "user", text: `the deploy key is ${KEY}` }],
      targetTokens: 2000,
    },
    async (_systemPrompt, userText) => {
      seen = userText;
      return "plain";
    },
    { redact: off },
  );
  assert.equal(seen.includes(KEY), true, "the toggle moves the mask rather than removing it");

  const body = `notes with ${KEY} in the head\n${"filler\n".repeat(200)}`;
  const fileStore = new LcmStore(":memory:");
  ingestEntries(
    fileStore,
    [
      {
        entryId: "e00",
        role: "toolResult" as const,
        text: body,
        timestamp: 1,
        fileHint: { path: "/x/notes.md" },
      },
    ],
    { externalize: { largeFileChars: 100 } },
  );
  let previewPrompt = "";
  await storedPass(
    fileStore,
    { span: [{ entryId: "e00", role: "toolResult", text: body }], targetTokens: 2000 },
    async (_systemPrompt, userText) => {
      previewPrompt = userText;
      return "described";
    },
    { redact: off },
  );
  assert.equal(previewPrompt.includes(KEY), true, "a preview follows the same flag");
  store.close();
  fresh.close();
  fileStore.close();
});
