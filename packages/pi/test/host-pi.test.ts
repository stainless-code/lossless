import assert from "node:assert/strict";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { test } from "vite-plus/test";

import { piModelHost, piModelKey, piReader } from "../src/host.ts";
import { piDouble, piHost } from "./support/pi-double.ts";

const ZERO = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function reply(
  stopReason: AssistantMessage["stopReason"],
  text: string,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text.length > 0 ? [{ type: "text", text }] : [],
    api: "test",
    provider: "test",
    model: "m",
    usage: ZERO,
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 0,
  };
}

function reading(replyWith: AssistantMessage) {
  return piReader(
    piDouble({ model: { provider: "p", id: "m" }, reply: () => replyWith }).ctx,
    undefined,
  ).begin({ systemPrompt: "s", brief: "b", tools: [] });
}

test("host: the model key is the spelling config zones and rows use", () => {
  assert.equal(piModelKey({ model: { provider: "openrouter", id: "glm" } }), "openrouter/glm");
  assert.equal(piModelKey({ model: { provider: "openrouter" } }), "");
  assert.equal(piModelKey({}), "");
  assert.equal(piModelKey({ model: undefined }), "");
});

test("host: a summary keeps the text blocks and drops the rest", async () => {
  const host = piHost({
    model: { provider: "p", id: "m" },
    registry: {
      find: () => ({ provider: "p", id: "m" }),
      complete: async () => ({
        ...reply("stop", "first"),
        content: [
          { type: "text", text: "first" },
          { type: "tool_use", name: "read", input: { path: "x.ts" } },
          { type: "text", text: "second" },
          { type: "image", url: "http://example.invalid/x.png" },
        ],
      }),
    },
  });
  const ref = host.session();
  assert.ok(ref);
  const answer = await host.complete(ref, { prompt: "p", maxTokens: 10 });
  assert.equal(answer.outcome === "answer" && answer.text, "first\nsecond");
});

test("host: an answer with no text blocks is empty, not missing", async () => {
  const host = piHost({
    model: { provider: "p", id: "m" },
    registry: {
      find: () => ({ provider: "p", id: "m" }),
      complete: async () => reply("stop", ""),
    },
  });
  const ref = host.session();
  assert.ok(ref);
  const answer = await host.complete(ref, { prompt: "p", maxTokens: 10 });
  assert.equal(answer.outcome === "answer" && answer.text, "");
});

test("host: a length stop is a cut summary and an acceptable read", async () => {
  const cut = reply("length", "partial");
  const host = piHost({
    model: { provider: "p", id: "m" },
    registry: { find: () => ({ provider: "p", id: "m" }), complete: async () => cut },
  });
  const ref = host.session();
  assert.ok(ref);
  const answer = await host.complete(ref, { prompt: "p", maxTokens: 10 });
  assert.equal(answer.outcome, "failed");
  assert.equal(answer.outcome === "failed" && answer.capped, true);
  assert.equal(answer.stop, "length");

  const step = await reading(cut).next([]);
  assert.equal(step.outcome, "answered");
  assert.equal(step.text, "partial");
});

test("host: an error stop keeps the provider's own words", async () => {
  const host = piHost({
    model: { provider: "p", id: "m" },
    registry: {
      find: () => ({ provider: "p", id: "m" }),
      complete: async () => reply("error", "", "upstream 502"),
    },
  });
  const ref = host.session();
  assert.ok(ref);
  const answer = await host.complete(ref, { prompt: "p", maxTokens: 10 });
  assert.equal(answer.outcome, "failed");
  assert.equal(answer.outcome === "failed" && answer.reason, "upstream 502");
  assert.equal(answer.outcome === "failed" && answer.capped, false);
});

test("host: an aborted read fails, and reads only come from a tool-use stop", async () => {
  assert.deepEqual(await reading(reply("aborted", "half")).next([]), {
    outcome: "failed",
    reason: "aborted",
    usage: ZERO,
  });

  const stopping = reading({
    ...reply("stop", "done"),
    content: [
      { type: "text", text: "done" },
      { type: "toolCall", id: "c1", name: "lcm_grep", arguments: {} },
    ],
  });
  const step = await stopping.next([]);
  assert.equal(step.outcome, "answered");
  assert.equal(step.text, "done");
});

test("host: a read asks for its calls, and the next step carries their text", async () => {
  const toolCall = {
    type: "toolCall" as const,
    id: "c1",
    name: "lcm_grep",
    arguments: { query: "cache" },
  };
  const { ctx, contexts } = piDouble({
    model: { provider: "p", id: "m" },
    reply: (context) =>
      context.messages.some((m) => m.role === "toolResult")
        ? reply("stop", "the cache key is rot13")
        : {
            ...reply("toolUse", "reading"),
            content: [{ type: "text", text: "reading" }, toolCall],
          },
  });
  const reading = piReader(ctx, undefined).begin({ systemPrompt: "S", brief: "B", tools: [] });
  const first = await reading.next([]);
  assert.equal(first.outcome, "reads");
  assert.deepEqual(first.outcome === "reads" && first.calls, [
    { id: "c1", name: "lcm_grep", arguments: { query: "cache" } },
  ]);
  const second = await reading.next([
    { call: { id: "c1", name: "lcm_grep", arguments: { query: "cache" } }, text: "one hit" },
  ]);
  assert.equal(second.outcome, "answered");
  assert.equal(second.text, "the cache key is rot13");
  assert.deepEqual(
    contexts.map((context) => context.messages.map((m) => m.role)),
    [["user"], ["user", "assistant", "toolResult"]],
  );
  assert.equal(contexts[1]!.systemPrompt, "S");
});

test("host: notices come from a UI when there is one", () => {
  const told: string[] = [];
  const withUi = piHost({
    model: { provider: "p", id: "m" },
    notify: (message) => told.push(message),
  });
  assert.equal(withUi.notices.kind, "ui");
  if (withUi.notices.kind === "ui") withUi.notices.notify("LCM: careful", "warning");
  assert.deepEqual(told, ["LCM: careful"]);
  assert.equal(piHost({ model: { provider: "p", id: "m" } }).notices.kind, "none");
});

test("host: background calls carry the pi session id providers route on", async () => {
  const double = piDouble({
    model: { provider: "p", id: "m" },
    registry: {
      find: () => ({ provider: "p", id: "m" }),
      complete: async () => reply("stop", "summary"),
    },
  });
  const ref = piModelHost(double.ctx).session();
  assert.ok(ref);
  const answer = await piModelHost(double.ctx).complete(ref, { prompt: "p", maxTokens: 10 });
  assert.equal(answer.outcome, "answer");
  const step = await piReader(double.ctx, undefined)
    .begin({ systemPrompt: "s", brief: "b", tools: [] })
    .next([]);
  assert.equal(step.outcome, "answered");
  assert.deepEqual(
    double.seenOptions.map((opts) => (opts as { sessionId?: unknown }).sessionId),
    ["pi-test-session", "pi-test-session"],
  );
});
