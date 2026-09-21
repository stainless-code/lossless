import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { test, vi } from "vite-plus/test";

import type { ModelAnswer, Usage } from "../src/host.ts";
import {
  resolveModels,
  describeSummarizerChain,
  makeLlm,
  resetSummarizerState,
  classifyFailure,
  SummarizerFailure,
  SUMMARIZER_FAILURE_CAP,
  FAILED_SPAN_TTL_MS,
  REASONING_HEADROOM,
} from "../src/llm.ts";
import { metricsPath } from "../src/metrics.ts";
import { LcmStore } from "../src/store.ts";
import { fakeHost, scriptedHost } from "./support/fake-host.ts";
import { storedPass } from "./support/pass-outcome.ts";

test("llm: resolveModels resolves a summarizer whose id contains slashes", () => {
  const host = scriptedHost(
    {
      "openrouter/z-ai/glm-5.3-flash": text("named"),
      "anthropic/claude": text("session"),
    },
    "anthropic/claude",
  ).host;
  const { models, unresolved } = resolveModels(host, {
    summarizer: "openrouter/z-ai/glm-5.3-flash",
  });
  assert.deepEqual(
    models.map((m) => m.key),
    ["openrouter/z-ai/glm-5.3-flash", "anthropic/claude"],
  );
  assert.deepEqual(unresolved, []);
});

test("llm: resolveModels appends the session model last when an entry is unknown", () => {
  const host = scriptedHost({ "anthropic/claude": text("session") }, "anthropic/claude").host;
  const { models, unresolved, requested } = resolveModels(host, {
    summarizer: "ghost/unknown-model",
  });
  assert.deepEqual(
    models.map((m) => m.key),
    ["anthropic/claude"],
  );
  assert.deepEqual(unresolved, ["ghost/unknown-model"]);
  assert.deepEqual(requested, ["ghost/unknown-model"]);
});

test("llm: resolveModels without a summarizer returns the session model as auto", () => {
  const host = scriptedHost({ "anthropic/claude": text("session") }, "anthropic/claude").host;
  const { models, requested } = resolveModels(host, {});
  assert.deepEqual(
    models.map((m) => m.key),
    ["anthropic/claude"],
  );
  assert.deepEqual(requested, ["auto"]);
});

test("llm: the port serves a host that is not Pi", async () => {
  resetSummarizerState();
  const { host, calls, told } = fakeHost([{ key: "a/one", answer: "from one" }], "a/one");
  const llm = makeLlm(
    host,
    {},
    {
      session: "sess-fake",
      span: { firstEntryId: "fake0", lastEntryId: "fake0" },
    },
  );
  assert.ok(llm);
  assert.equal(await llm("SYS", "BODY", 12), "from one");
  assert.deepEqual(calls, [
    { model: "a/one", prompt: "SYS\n\n<conversation>\nBODY\n</conversation>", maxTokens: 12 },
  ]);
  assert.deepEqual(told, []);
});

test("llm: makeLlm returns null when no model resolves", () => {
  const host = scriptedHost({}, "s/session").host;
  assert.equal(makeLlm(host, {}, OPTS), null);
});

test("llm: a reasoning model gets headroom on top of the requested cap", async () => {
  const { host, calls } = chainHost({ "p/m": text("ok") }, { reasoning: ["p/m"] });
  const llm = makeLlm(host, { summarizer: "p/m" }, OPTS);
  assert.ok(llm);
  await llm("sys", "body", 1500);
  assert.equal(calls[0]!.maxTokens, 1500 + REASONING_HEADROOM);
});

test("llm: a model without reasoning keeps the requested cap", async () => {
  const { host, calls } = chainHost({ "s/session": text("ok") });
  const llm = makeLlm(host, {}, OPTS);
  assert.ok(llm);
  await llm("sys", "body", 1500);
  assert.equal(calls[0]!.maxTokens, 1500);
});

test("llm: makeLlm wraps the prompt and text in the conversation block", async () => {
  const { host, calls } = chainHost({ "p/m": text("ok") });
  const llm = makeLlm(host, { summarizer: "p/m" }, OPTS);
  assert.ok(llm);
  await llm("SYSTEM", "BODY", 42);
  const sent = calls[0]!.prompt;
  assert.ok(sent.startsWith("SYSTEM"));
  assert.ok(sent.includes("<conversation>"));
  assert.ok(sent.includes("BODY"));
});

function metricsMark(): number {
  try {
    return readFileSync(metricsPath(), "utf8").length;
  } catch {
    return 0;
  }
}

function metricsSince(mark: number): Array<Record<string, unknown>> {
  let raw = "";
  try {
    raw = readFileSync(metricsPath(), "utf8").slice(mark).trim();
  } catch {
    return [];
  }
  return raw ? raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

const SPAN = { firstEntryId: "e0", lastEntryId: "e1" };
const OPTS = { session: "sess-test", span: SPAN };

type Reply = ModelAnswer | Error | ((key: string) => ModelAnswer | Error);

const text = (value: string, usage?: Usage): ModelAnswer => ({
  outcome: "answer",
  text: value,
  stop: "stop",
  usage,
});

const failed = (reason: string, capped = false, stop = "error", usage?: Usage): ModelAnswer => ({
  outcome: "failed",
  reason,
  capped,
  stop,
  usage,
});

const cut = (usage?: Usage): ModelAnswer =>
  failed("generation hit the token cap and the summary is incomplete", true, "length", usage);

const keys = (calls: readonly { model: string }[]): string[] => calls.map((call) => call.model);

function chainHost(
  replies: Record<string, Reply>,
  options?: { notify?: (m: string, l?: string) => void; reasoning?: readonly string[] },
) {
  return scriptedHost(replies, "s/session", options);
}

test("llm: resolveModels keeps config order, dedupes, and appends the session model", () => {
  const host = scriptedHost(
    { "a/one": text("a"), "b/two": text("b"), "s/session": text("session") },
    "s/session",
  ).host;
  const { models, unresolved, requested } = resolveModels(host, {
    summarizer: ["b/two", "a/one", "b/two"],
  });
  assert.deepEqual(
    models.map((m) => m.key),
    ["b/two", "a/one", "s/session"],
  );
  assert.deepEqual(unresolved, []);
  assert.deepEqual(requested, ["b/two", "a/one"]);
});

test("llm: resolveModels expands auto and reports what the registry cannot find", () => {
  const host = scriptedHost({ "s/session": text("session") }, "s/session").host;
  const { models, unresolved } = resolveModels(host, {
    summarizer: ["ghost/one", "auto", "no-provider", "ghost/two"],
  });
  assert.deepEqual(
    models.map((m) => m.key),
    ["s/session"],
  );
  assert.deepEqual(unresolved, ["ghost/one", "no-provider", "ghost/two"]);
});

test("llm: resolveModels with no session model is empty and reports auto", () => {
  const host = scriptedHost({}, "s/session").host;
  assert.deepEqual(resolveModels(host, {}), {
    models: [],
    unresolved: [],
    requested: ["auto"],
  });
});

test("llm: describeSummarizerChain renders the chain, the config, and the substitution", () => {
  const host = scriptedHost(
    { "a/one": text("ok"), "s/session": text("session") },
    "s/session",
  ).host;
  const clean = describeSummarizerChain(resolveModels(host, { summarizer: "a/one" }));
  assert.deepEqual(clean, {
    level: "info",
    state: "summarizer: a/one → s/session · config: a/one",
  });

  const bad = describeSummarizerChain(resolveModels(host, { summarizer: ["a/one", "ghost/x"] }));
  assert.deepEqual(bad, {
    level: "warning",
    state: "summarizer: a/one → s/session · config: a/one, ghost/x",
    warning: "summarizer model not found: ghost/x; using a/one → s/session",
  });

  const none = describeSummarizerChain(resolveModels(scriptedHost({}, "s/session").host, {}));
  assert.deepEqual(none, {
    level: "info",
    state: "summarizer: (no model resolves) · config: auto",
  });
});

test("llm: a chain falls through a throwing model to the next one", async () => {
  const { host, calls } = chainHost({
    "a/one": new Error("rate limited"),
    "b/two": text("from two"),
    "s/session": text("from session"),
  });
  const mark = metricsMark();
  const llm = makeLlm(host, { summarizer: ["a/one", "b/two"] }, { session: "sess-1", span: SPAN });
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "from two");
  assert.deepEqual(keys(calls), ["a/one", "b/two"]);
  const events = metricsSince(mark).filter((e) => e.kind === "summarizer-fallback");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.used, "b/two");
  assert.equal(events[0]!.session, "sess-1");
  assert.deepEqual(events[0]!.attempts, [
    { model: "a/one", outcome: "threw", error: "rate limited" },
    { model: "b/two", outcome: "ok" },
  ]);
});

test("llm: a chain falls through an empty response to the next model", async () => {
  const { host, calls } = chainHost({
    "a/one": text(""),
    "b/two": text("from two"),
    "s/session": text("from session"),
  });
  const llm = makeLlm(host, { summarizer: ["a/one", "b/two"] }, OPTS);
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "from two");
  assert.deepEqual(keys(calls), ["a/one", "b/two"]);
});

test("llm: the session model is the last resort of the chain", async () => {
  const { host, calls } = chainHost({
    "a/one": new Error("down"),
    "b/two": text(""),
    "s/session": text("from session"),
  });
  const mark = metricsMark();
  const llm = makeLlm(host, { summarizer: ["a/one", "b/two"] }, OPTS);
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "from session");
  assert.deepEqual(keys(calls), ["a/one", "b/two", "s/session"]);
  const events = metricsSince(mark).filter((e) => e.kind === "summarizer-fallback");
  assert.equal(events[0]!.used, "s/session");
});

test("llm: a healthy first model is the only call and records nothing", async () => {
  const { host, calls } = chainHost({
    "a/one": text("from one"),
    "b/two": text("from two"),
    "s/session": text("from session"),
  });
  const mark = metricsMark();
  const llm = makeLlm(host, { summarizer: ["a/one", "b/two"] }, OPTS);
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "from one");
  assert.deepEqual(keys(calls), ["a/one"]);
  assert.equal(metricsSince(mark).filter((e) => e.kind === "summarizer-fallback").length, 0);
});

test("llm: every model empty keeps the empty-response contract", async () => {
  const { host, calls } = chainHost({
    "a/one": text(""),
    "b/two": text("   "),
    "s/session": text(""),
  });
  const mark = metricsMark();
  const llm = makeLlm(host, { summarizer: ["a/one", "b/two"] }, OPTS);
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "");
  assert.deepEqual(keys(calls), ["a/one", "b/two", "s/session"]);
  const events = metricsSince(mark).filter((e) => e.kind === "summarizer-fallback");
  assert.equal(events[0]!.used, null);
  assert.deepEqual(events[0]!.attempts, [
    { model: "a/one", outcome: "empty" },
    { model: "b/two", outcome: "empty" },
    { model: "s/session", outcome: "empty" },
  ]);
});

test("llm: every model throwing is one error that names them all", async () => {
  const { host } = chainHost({
    "a/one": new Error("down"),
    "b/two": new Error("busy"),
    "s/session": new Error("gone"),
  });
  const llm = makeLlm(host, { summarizer: ["a/one", "b/two"] }, OPTS);
  assert.ok(llm);
  await assert.rejects(
    () => llm("sys", "body", 100),
    /a\/one: down; b\/two: busy; s\/session: gone/,
  );
});

test("llm: an entry the registry cannot find is reported once, not per call", () => {
  const notified: string[] = [];
  const { host } = chainHost(
    { "s/session": text("from session") },
    {
      notify: (m, l) => notified.push(`${l}: ${m}`),
    },
  );
  const mark = metricsMark();
  const config = { summarizer: ["ghost/warn-once", "auto"] };
  assert.ok(makeLlm(host, config, OPTS));
  assert.ok(makeLlm(host, config, OPTS));
  const events = metricsSince(mark).filter((e) => e.kind === "summarizer-model");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.unresolved, ["ghost/warn-once"]);
  assert.deepEqual(events[0]!.chain, ["s/session"]);
  assert.deepEqual(events[0]!.requested, ["ghost/warn-once", "auto"]);
  assert.deepEqual(notified, [
    "warning: LCM: summarizer model not found: ghost/warn-once; using s/session",
  ]);
});

test("llm: without a UI the unresolved warning still reaches the metrics log", () => {
  const { host } = chainHost({ "s/session": text("from session") });
  const mark = metricsMark();
  assert.ok(makeLlm(host, { summarizer: "ghost/no-ui" }, OPTS));
  const events = metricsSince(mark).filter((e) => e.kind === "summarizer-model");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.unresolved, ["ghost/no-ui"]);
});

test("llm: a later session hears about the same broken chain again", () => {
  const notified: string[] = [];
  const { host } = chainHost(
    { "s/session": text("from session") },
    {
      notify: (m, l) => notified.push(`${l}: ${m}`),
    },
  );
  const config = { summarizer: "ghost/again" };
  assert.ok(makeLlm(host, config, OPTS));
  assert.ok(makeLlm(host, config, OPTS));
  assert.equal(notified.length, 1);
  resetSummarizerState();
  assert.ok(makeLlm(host, config, OPTS));
  assert.equal(notified.length, 2);
});

test("llm: two configs that resolve to the same chain are recorded separately", () => {
  const mark = metricsMark();
  const { host } = chainHost({ "s/session": text("from session") });
  assert.ok(makeLlm(host, { summarizer: "ghost/one" }, OPTS));
  assert.ok(makeLlm(host, { summarizer: ["ghost/one", "auto"] }, OPTS));
  const events = metricsSince(mark).filter((e) => e.kind === "summarizer-model");
  assert.deepEqual(
    events.map((e) => e.requested),
    [["ghost/one"], ["ghost/one", "auto"]],
  );
});

test("llm: an error stop and a length stop both give way to the next model", async () => {
  const { host, calls } = chainHost({
    "a/one": failed("rate limited"),
    "b/two": cut(),
    "s/session": text("from session"),
  });
  const llm = makeLlm(host, { summarizer: ["a/one", "b/two"] }, OPTS);
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "from session");
  assert.deepEqual(keys(calls), ["a/one", "b/two", "s/session"]);
});

test("llm: a chain where every call failed throws with each reason", async () => {
  const { host } = chainHost({
    "a/one": cut(),
    "s/session": failed("rate limited"),
  });
  const llm = makeLlm(host, { summarizer: "a/one" }, OPTS);
  const mark = metricsMark();
  assert.ok(llm);
  await assert.rejects(
    () => llm("sys", "body", 100),
    /a\/one: generation hit the token cap and the summary is incomplete; s\/session: rate limited/,
  );
  const events = metricsSince(mark).filter((e) => e.kind === "summarizer-fallback");
  assert.deepEqual(events[0]!.attempts, [
    {
      model: "a/one",
      outcome: "threw",
      error: "generation hit the token cap and the summary is incomplete",
    },
    { model: "s/session", outcome: "threw", error: "rate limited" },
  ]);
});

test("llm: a failed entry is demoted for the rest of the pass", async () => {
  const { host, calls } = chainHost({
    "a/one": new Error("rate limited"),
    "b/two": text("from two"),
    "s/session": text("from session"),
  });
  const mark = metricsMark();
  const llm = makeLlm(host, { summarizer: ["a/one", "b/two"] }, OPTS);
  assert.ok(llm);
  assert.equal(await llm("sys", "chunk 1", 100), "from two");
  assert.equal(await llm("sys", "chunk 2", 100), "from two");
  assert.deepEqual(keys(calls), ["a/one", "b/two", "b/two"]);
  const events = metricsSince(mark).filter((e) => e.kind === "summarizer-fallback");
  assert.equal(events.length, 1, "only the call that demoted walked two models");
  assert.equal(events[0]!.used, "b/two");
});

test("llm: a recovered head is tried first by the next completer", async () => {
  let headDown = true;
  const { host, calls } = chainHost({
    "a/one": () => {
      if (headDown) throw new Error("rate limited");
      return text("from one");
    },
    "b/two": text("from two"),
    "s/session": text("from session"),
  });
  const config = { summarizer: ["a/one", "b/two"] };
  const first = makeLlm(host, config, OPTS);
  assert.ok(first);
  assert.equal(await first("sys", "chunk 1", 100), "from two");
  headDown = false;
  const second = makeLlm(host, config, OPTS);
  assert.ok(second);
  assert.equal(await second("sys", "chunk 2", 100), "from one");
  assert.deepEqual(keys(calls), ["a/one", "b/two", "a/one"]);
});

test("llm: a demoted entry answers again once the head that replaced it fails", async () => {
  let headDown = true;
  let sessionDown = false;
  const { host, calls } = chainHost({
    "a/one": () => {
      if (headDown) throw new Error("down");
      return text("from one");
    },
    "s/session": () => {
      if (sessionDown) throw new Error("busy");
      return text("from session");
    },
  });
  const llm = makeLlm(host, { summarizer: ["a/one", "s/session"] }, OPTS);
  assert.ok(llm);
  assert.equal(await llm("sys", "chunk 1", 100), "from session");
  headDown = false;
  sessionDown = true;
  assert.equal(await llm("sys", "chunk 2", 100), "from one");
  assert.deepEqual(keys(calls), ["a/one", "s/session", "s/session", "a/one"]);
});

test("llm: a provider call writes one summarizer-usage row with its counters", async () => {
  const usage = {
    input: 1200,
    output: 300,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1500,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
  const { host } = chainHost({ "a/one": text("summary", usage) });
  const mark = metricsMark();
  const llm = makeLlm(
    host,
    { summarizer: "a/one" },
    { session: "sess-usage", stage: "async", span: SPAN },
  );
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "summary");
  const rows = metricsSince(mark).filter((e) => e.kind === "summarizer-usage");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.session, "sess-usage");
  assert.equal(rows[0]!.model, "a/one");
  assert.equal(rows[0]!.stage, "async");
  assert.equal(rows[0]!.outcome, "ok");
  assert.equal(rows[0]!.stopReason, "stop");
  assert.equal(rows[0]!.input, 1200);
  assert.equal(rows[0]!.output, 300);
  assert.equal(rows[0]!.cacheRead, 0);
  assert.equal(rows[0]!.costTotal, 0.003);
  assert.equal(rows[0]!.costInput, 0.001);
});

test("llm: a rejected call is billed and named, and a fallback reports both models", async () => {
  const usage = {
    input: 900,
    output: 40,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 940,
    cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
  };
  const { host, calls } = chainHost({
    "a/one": cut(usage),
    "b/two": text("from two", usage),
  });
  const mark = metricsMark();
  const llm = makeLlm(
    host,
    { summarizer: ["a/one", "b/two"] },
    { session: "sess-usage", span: SPAN },
  );
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "from two");
  assert.deepEqual(keys(calls), ["a/one", "b/two"]);
  const rows = metricsSince(mark).filter((e) => e.kind === "summarizer-usage");
  assert.equal(rows.length, 2, "a rejected call was billed and must be recorded");
  assert.equal(rows[0]!.outcome, "failure");
  assert.equal(rows[0]!.stopReason, "length");
  assert.equal(rows[1]!.outcome, "ok");
  assert.equal(rows[0]!.stage, undefined, "an unlabelled completer records no stage");
  assert.equal(rows[0]!.input, 900);
});

test("llm: a call the provider reports no counters for writes no spend row", async () => {
  const { host } = chainHost({ "a/one": text("summary") });
  const mark = metricsMark();
  const llm = makeLlm(host, { summarizer: "a/one" }, { session: "sess-usage", span: SPAN });
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "summary");
  assert.deepEqual(
    metricsSince(mark).filter((e) => e.kind === "summarizer-usage"),
    [],
  );
});

test("llm: a pass pays for three failed walks, then stops asking the provider", async () => {
  resetSummarizerState();
  assert.equal(SUMMARIZER_FAILURE_CAP, 3, "the documented bound is three walks");
  const { host, calls } = chainHost({ "s/session": new Error("429 rate limit exceeded") });
  const mark = metricsMark();
  const llm = makeLlm(host, {}, OPTS);
  assert.ok(llm);
  for (let i = 0; i < SUMMARIZER_FAILURE_CAP; i++) {
    await assert.rejects(llm("sys", "body", 100), /every summarizer model failed/);
  }
  assert.equal(calls.length, SUMMARIZER_FAILURE_CAP, "the third walk is the last one paid for");
  await assert.rejects(llm("sys", "body", 100), (error: unknown) => {
    assert.ok(error instanceof SummarizerFailure, String(error));
    assert.equal(error.category, "capped");
    return true;
  });
  assert.equal(calls.length, SUMMARIZER_FAILURE_CAP, "a refusal is not a provider call");
  const rows = metricsSince(mark).filter((r) => r.kind === "summarizer-capped");
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.deepEqual(
    [rows[0]!.source, rows[0]!.failedWalks, rows[0]!.category, rows[0]!.fingerprint],
    ["pass", 3, "rate-limit", "e0..e1|s/session"],
  );
  assert.deepEqual(rows[0]!.span, ["e0", "e1"]);
});

test("llm: a usable answer resets the failure budget", async () => {
  resetSummarizerState();
  let n = 0;
  const { host, calls } = chainHost({
    "s/session": () => {
      n++;
      return n === 3 ? text("summary") : new Error("429 rate limit exceeded");
    },
  });
  const mark = metricsMark();
  const llm = makeLlm(host, {}, OPTS);
  assert.ok(llm);
  await assert.rejects(llm("sys", "body", 100));
  await assert.rejects(llm("sys", "body", 100));
  assert.equal(await llm("sys", "body", 100), "summary");
  await assert.rejects(llm("sys", "body", 100));
  await assert.rejects(llm("sys", "body", 100));
  assert.equal(calls.length, 5, "the reset bought a fresh budget, so the fifth walk is paid for");
  assert.deepEqual(
    metricsSince(mark).filter((r) => r.kind === "summarizer-capped"),
    [],
    "two failures are below the cap, so the pass never gave up",
  );
});

test("llm: only a transport failure earns a retry, and one of them", async () => {
  const cases: Array<[string, Reply, number]> = [
    ["unavailable", new Error("503 Service Unavailable"), 2],
    ["timeout", new Error("request timed out"), 2],
    ["rate-limit", new Error("429 rate limit exceeded"), 1],
    ["auth", new Error("401 unauthorized: invalid api key"), 1],
    ["length", cut(), 1],
    ["empty", text(""), 1],
    ["unknown", new Error("something odd happened"), 1],
  ];
  for (const [name, reply, expected] of cases) {
    resetSummarizerState();
    const { host, calls } = chainHost({ "s/session": reply });
    const llm = makeLlm(host, {}, OPTS);
    assert.ok(llm);
    if (name === "empty") assert.equal(await llm("sys", "body", 100), "");
    else await assert.rejects(llm("sys", "body", 100), `${name} ends the walk`);
    assert.equal(calls.length, expected, `${name} attempts`);
    assert.deepEqual(
      new Set(keys(calls)),
      new Set(["s/session"]),
      `${name} retries the same model`,
    );
  }
});

test("llm: a request larger than the call budget is refused before it is paid for", async () => {
  resetSummarizerState();
  const { host, calls } = chainHost({ "s/session": text("summary") });
  const mark = metricsMark();
  const llm = makeLlm(host, { summarizerTokensPerCall: 100 }, OPTS);
  assert.ok(llm);
  await assert.rejects(llm("sys", "x".repeat(4000), 100), /budget reached .*call/);
  assert.equal(calls.length, 0, "a refused request never reaches a provider");
  const row = metricsSince(mark).find((r) => r.kind === "summarizer-capped");
  assert.ok(row, "the refusal is recorded");
  assert.equal(row.source, "budget");
  assert.equal(row.reason, "call");
  assert.equal(row.budgetTokens, 100);
  assert.equal(row.spentTokens, 0);
});

test("llm: the pass budget counts what the provider reported, not the estimate", async () => {
  resetSummarizerState();
  const billed = text("summary", {
    input: 6_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 6_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const { host, calls } = chainHost({ "s/session": billed });
  const mark = metricsMark();
  const llm = makeLlm(host, { summarizerTokensPerPass: 5_000 }, OPTS);
  assert.ok(llm);
  assert.equal(await llm("sys", "body", 100), "summary");
  await assert.rejects(llm("sys", "body", 100), /budget reached .*pass/);
  assert.equal(calls.length, 1, "the second call is refused rather than paid");
  const row = metricsSince(mark).find((r) => r.kind === "summarizer-capped");
  assert.ok(row, "the refusal is recorded");
  assert.equal(row.source, "budget");
  assert.equal(row.reason, "pass");
  assert.equal(row.spentTokens, 6_000, "the reported usage is the spend");
  assert.equal(row.budgetTokens, 5_000);
  const usage = metricsSince(mark).filter((r) => r.kind === "summarizer-usage");
  assert.equal(usage.length, 1, "one call was billed");
});

test("llm: a span whose calls were capped is not paid for twice inside the minute", async () => {
  resetSummarizerState();
  const { host, calls } = chainHost({ "s/session": new Error("ECONNRESET") });
  const mark = metricsMark();
  const first = makeLlm(host, {}, OPTS);
  assert.ok(first);
  for (let i = 0; i < SUMMARIZER_FAILURE_CAP; i++) await assert.rejects(first("sys", "body", 100));
  const paid = calls.length;
  const second = makeLlm(host, {}, OPTS);
  assert.ok(second);
  await assert.rejects(second("sys", "body", 100), /stopped \(unavailable\)/);
  assert.equal(calls.length, paid, "the remembered span is not asked again");
  const other = makeLlm(
    host,
    {},
    { session: "sess-test", span: { firstEntryId: "e2", lastEntryId: "e3" } },
  );
  assert.ok(other);
  await assert.rejects(other("sys", "body", 100), /every summarizer model failed/);
  assert.equal(calls.length, paid + 2, "a span that did not fail is still summarized by a model");
  const rows = metricsSince(mark).filter((r) => r.kind === "summarizer-capped");
  assert.deepEqual(
    rows.map((r) => [r.source, r.failedWalks, r.category]),
    [
      ["pass", SUMMARIZER_FAILURE_CAP, "unavailable"],
      ["span-memory", 0, "unavailable"],
    ],
  );
});

test("llm: the span memory expires, so a later pass probes the model again", async () => {
  resetSummarizerState();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(2_000_000);
    const { host, calls } = chainHost({ "s/session": new Error("ECONNRESET") });
    const first = makeLlm(host, {}, OPTS);
    assert.ok(first);
    for (let i = 0; i < SUMMARIZER_FAILURE_CAP; i++)
      await assert.rejects(first("sys", "body", 100));
    const paid = calls.length;
    vi.setSystemTime(2_000_000 + FAILED_SPAN_TTL_MS + 1);
    const later = makeLlm(host, {}, OPTS);
    assert.ok(later);
    await assert.rejects(later("sys", "body", 100), /every summarizer model failed/);
    assert.equal(calls.length, paid + 2, "a span remembered for a minute is probed again after it");
  } finally {
    vi.useRealTimers();
    resetSummarizerState();
  }
});

test("llm: a completer refused from span memory stays mechanical past the TTL", async () => {
  resetSummarizerState();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(3_000_000);
    const { host, calls } = chainHost({ "s/session": new Error("429 rate limit exceeded") });
    const mark = metricsMark();
    const first = makeLlm(host, {}, OPTS);
    assert.ok(first);
    for (let i = 0; i < SUMMARIZER_FAILURE_CAP; i++)
      await assert.rejects(first("sys", "body", 100));
    const capped = makeLlm(host, {}, OPTS);
    assert.ok(capped);
    await assert.rejects(capped("sys", "body", 100), /stopped \(rate-limit\)/);
    vi.setSystemTime(3_000_000 + FAILED_SPAN_TTL_MS + 1);
    for (let i = 0; i < SUMMARIZER_FAILURE_CAP; i++) {
      await assert.rejects(capped("sys", "body", 100), (error: unknown) => {
        assert.ok(error instanceof SummarizerFailure, String(error));
        assert.equal(error.category, "capped");
        return true;
      });
    }
    assert.equal(calls.length, 3, "the TTL does not reopen a completer that was refused");
    assert.deepEqual(
      metricsSince(mark)
        .filter((r) => r.kind === "summarizer-capped")
        .map((r) => [r.source, r.failedWalks]),
      [
        ["pass", 3],
        ["span-memory", 0],
      ],
    );
  } finally {
    vi.useRealTimers();
    resetSummarizerState();
  }
});

test("llm: the failure category is the provider's own word, or unknown", () => {
  const cases: Array<[string, string]> = [
    ["401 Unauthorized: invalid api key", "auth"],
    ["429 Too Many Requests", "rate-limit"],
    ["request failed: ECONNRESET", "unavailable"],
    ["502 Bad Gateway", "unavailable"],
    ["model not found: ghost/model", "unavailable"],
    ["request timed out after 60s", "timeout"],
    ["the request was aborted", "timeout"],
    ["generation hit the token cap and the summary is incomplete", "length"],
    ["something else entirely", "unknown"],
    ["", "unknown"],
  ];
  for (const [text, expected] of cases) assert.equal(classifyFailure(text), expected, text);
  assert.equal(classifyFailure(undefined), "unknown");
});

test("llm: a length stop is a length failure, not an unknown one", async () => {
  resetSummarizerState();
  const { host } = chainHost({ "s/session": cut() });
  const llm = makeLlm(
    host,
    {},
    { session: "sess-test", span: { firstEntryId: "l0", lastEntryId: "l0" } },
  );
  assert.ok(llm);
  await assert.rejects(llm("sys", "body", 100), (error: unknown) => {
    assert.ok(error instanceof SummarizerFailure, String(error));
    assert.equal(error.category, "length");
    return true;
  });
});

test("llm: a pass over many chunks pays the cap, not two walks per chunk", async () => {
  resetSummarizerState();
  const { host, calls } = chainHost({ "s/session": new Error("503 Service Unavailable") });
  const mark = metricsMark();
  const span = Array.from({ length: 8 }, (_, i) => ({
    entryId: `c${i}`,
    role: "user" as const,
    text: "q".repeat(12_000),
  }));
  const llm = makeLlm(
    host,
    {},
    {
      session: "sess-cap",
      stage: "async",
      span: { firstEntryId: "c0", lastEntryId: "c7" },
    },
  );
  assert.ok(llm);
  const store = new LcmStore(":memory:");
  const outcome = await storedPass(store, { span, targetTokens: 500 }, llm, {
    leafChunkTokens: 3000,
    session: "sess-cap",
    stage: "async",
  });
  assert.equal(calls.length, SUMMARIZER_FAILURE_CAP * 2, "the pass paid three walks, not sixteen");
  assert.equal(
    outcome.leafSummaryIds.length,
    8,
    "the fixture is eight chunks, so the count is not incidental to the claim",
  );
  assert.ok(outcome.leafSummaryIds.length > 0, "the span is still covered");
  for (const id of outcome.leafSummaryIds) {
    assert.ok(store.getSummary(id)!.text.startsWith("[lcm:truncated]"));
  }
  const rows = metricsSince(mark);
  assert.equal(rows.filter((r) => r.kind === "summarizer-error").length, SUMMARIZER_FAILURE_CAP);
  assert.equal(rows.filter((r) => r.kind === "summarizer-capped").length, 1);
  assert.ok(
    rows.some((r) => r.kind === "compaction-complete"),
    "the pass completes rather than throwing",
  );
  store.close();
});
