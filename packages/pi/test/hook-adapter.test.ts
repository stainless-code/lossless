import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { CHARS_PER_TOKEN } from "lossless-core";
import { contextChars } from "lossless-core";
import { LcmStore } from "lossless-core";
import { metricsPath } from "lossless-core";
import { test, vi } from "vite-plus/test";

import { leaveCrashedRun } from "../../core/test/support/run-holder.ts";
import { removeTestPath, testHomePath } from "../../core/test/support/temp-home.ts";
import mod from "../src/index.ts";
import { LCM_SUBCOMMANDS } from "../src/ui/command.ts";
import { writeLcmConfig } from "../src/ui/config-io.ts";

/** Every path here resolves through the temp home at call time, never at import
 * time, so a run without test/setup.ts fails on the first test instead of
 * writing under the real HOME. */

let sessionSeq = 0;
/** One session file per test case: a shared name leaks one test's store into the next, and only when both run. */
function uniqueSessionFile(): string {
  sessionSeq += 1;
  return testHomePath(`adapter-${sessionSeq}.jsonl`);
}

function lcmDbPath(sessionFile: string): string {
  const h = createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
  return testHomePath(".pi", "agent", "lcm", `${h}.db`);
}

function removeWrittenConfig(): void {
  removeTestPath(".pi", "agent", "lcm.json");
  removeTestPath(".pi", "agent", "lcm.json.bak");
}

interface FakePi {
  pi: unknown;
  handlers: Map<string, (event: never, ctx: never) => Promise<unknown>>;
  tools: Array<{ name: string }>;
  commands: Map<
    string,
    { description: string; handler: (args: string | undefined, ctx: unknown) => Promise<unknown> }
  >;
}

function makeFakePi(): FakePi {
  const handlers = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
  const tools: Array<{ name: string }> = [];
  const commands = new Map<
    string,
    { description: string; handler: (args: string | undefined, ctx: unknown) => Promise<unknown> }
  >();
  const pi = {
    on: (name: string, handler: never) => {
      handlers.set(name, handler);
    },
    registerTool: (tool: { name: string }) => {
      tools.push(tool);
    },
    registerCommand: (name: string, def: { description: string; handler: never }) => {
      commands.set(name, def);
    },
  };
  return { pi: pi as never, handlers, tools, commands };
}

interface FakeEntry {
  id: string;
  type: string;
  message?: { role?: string; content?: unknown; [extra: string]: unknown };
  [extra: string]: unknown;
}

function msgEntry(id: string, role: string, content: unknown): FakeEntry {
  return { id, type: "message", message: { role, content } };
}

/** The session-manager surface the extension reads. A fixture without parentId
 * is a linear session, so its path is the whole list; a fixture that declares
 * parents gets the SDK's own walk, which is what a real /tree navigation makes. */
function sessionManagerOf(entries: FakeEntry[], sessionFile: string | null = null) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const linked = entries.some((e) => typeof e.parentId === "string");
  return {
    getSessionId: () => "pi-test-session",
    getSessionFile: () => sessionFile ?? undefined,
    getEntries: () => entries,
    getLeafId: () => entries[entries.length - 1]?.id ?? null,
    getBranch: (fromId?: string) => {
      if (!linked) return entries;
      const path: FakeEntry[] = [];
      let current = byId.get(fromId ?? entries[entries.length - 1]?.id ?? "");
      while (current) {
        path.push(current);
        const parent: unknown = current.parentId;
        current = typeof parent === "string" ? byId.get(parent) : undefined;
      }
      return path.reverse();
    },
    buildContextEntries: () => entries,
  };
}

function makeStartCtx(entries: FakeEntry[], sessionFile: string | null) {
  return {
    hasUI: false,
    sessionManager: sessionManagerOf(entries, sessionFile),
    model: { provider: "test", id: "test-model" },
  };
}

async function startSession(
  handlers: FakePi["handlers"],
  entries: FakeEntry[],
  sessionFile: string,
) {
  await handlers.get("session_start")!({} as never, makeStartCtx(entries, sessionFile) as never);
}

test("adapter: registration wires the three recall tools and the /lcm command", () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const names = fake.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["lcm_describe", "lcm_expand_query", "lcm_grep"]);
  assert.ok(fake.commands.has("lcm"), "/lcm command should be registered");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    description: string;
  };
  const mentioned = [...new Set(pkg.description.match(/lcm_[a-z_]+/g) ?? [])].sort();
  assert.deepEqual(mentioned, names, "the description names exactly the registered tools");
  assert.equal(
    fake.commands.get("lcm")!.description,
    `LCM ${LCM_SUBCOMMANDS.join(" | ")}`,
    "the description is built from the subcommand list the handler answers",
  );
});

test("adapter: session_start creates the store and backfills pre-existing entries", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = [
    msgEntry("e1", "user", "hello from the past"),
    msgEntry("e2", "assistant", "acknowledged"),
  ];
  await startSession(fake.handlers, entries, sessionFile);

  const dbPath = lcmDbPath(sessionFile);
  assert.ok(existsSync(dbPath), "store file created under redirected HOME");
  const reader = new LcmStore(dbPath);
  assert.equal(reader.stats().messages, 2, "backfill ingested both entries");
  reader.close();
});

test("adapter: session_start collects exactly the entry kinds Pi puts in context", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries: FakeEntry[] = [
    msgEntry("e1", "user", "hello"),
    {
      id: "e2",
      type: "custom_message",
      customType: "x",
      content: "injected by ext",
      display: false,
    },
    { id: "e3", type: "branch_summary", fromId: "e1", summary: "branch summary text" },
    {
      id: "e4",
      type: "compaction",
      summary: "compaction summary text",
      firstKeptEntryId: "e1",
      tokensBefore: 10,
    },
    { id: "e5", type: "custom", customType: "x", data: "extension-private, never in context" },
    { id: "e6", type: "custom", customType: "x", content: "legacy shape, never in context" },
    { id: "e7", type: "model_change", provider: "p", modelId: "m" },
  ];
  await startSession(fake.handlers, entries, sessionFile);

  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(reader.stats().messages, 4);
  assert.deepEqual(
    reader.messagesInSpan("e1", "e4").map((m) => [m.entryId, m.role]),
    [
      ["e1", "user"],
      ["e2", "custom"],
      ["e3", "custom"],
      ["e4", "custom"],
    ],
  );
  assert.equal(reader.grep("injected").length, 1);
  assert.equal(reader.grep("compaction summary").length, 1);
  assert.equal(reader.grep("never").length, 0);
  assert.equal(reader.grep("legacy shape").length, 0);
  reader.close();
});

test("adapter: turn_end ingests only the delta (watermark semantics)", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = [
    msgEntry("e1", "user", "first message"),
    msgEntry("e2", "assistant", "second message"),
  ];
  await startSession(fake.handlers, entries, sessionFile);

  const reader = new LcmStore(lcmDbPath(sessionFile));

  await fake.handlers.get("turn_end")!(
    {} as never,
    { hasUI: false, sessionManager: sessionManagerOf(entries) } as never,
  );
  assert.equal(reader.stats().messages, 2, "no delta → no new rows");

  entries.push(msgEntry("e3", "user", "third message, new"));
  await fake.handlers.get("turn_end")!(
    {} as never,
    { hasUI: false, sessionManager: sessionManagerOf(entries) } as never,
  );
  assert.equal(reader.stats().messages, 3, "only the delta row was added");
  reader.close();
});

test("adapter: turn_end collects only the new entries", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const reads = new Map<string, number>();
  const counting = (id: string, text: string): FakeEntry => ({
    id,
    type: "message",
    message: {
      role: "user",
      get content() {
        reads.set(id, (reads.get(id) ?? 0) + 1);
        return text;
      },
    },
  });
  const entries = [counting("e1", "one"), counting("e2", "two"), counting("e3", "three")];
  await startSession(fake.handlers, entries, sessionFile);
  // Reads per entry during one collect pass (Pi's projection reads content
  // once for its null check, entryToText once more); the invariant is that
  // this count never grows on later turns.
  const perPass = reads.get("e1")!;
  assert.deepEqual([...reads.values()], [perPass, perPass, perPass]);

  const turnEnd = () =>
    fake.handlers.get("turn_end")!(
      {} as never,
      { hasUI: false, sessionManager: sessionManagerOf(entries) } as never,
    );
  entries.push(counting("e4", "four"), { id: "x1", type: "model_change" });
  await turnEnd();

  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(reader.stats().messages, 4, "all four messages in the store");
  const once = { e1: perPass, e2: perPass, e3: perPass, e4: perPass };
  assert.deepEqual(Object.fromEntries(reads), once, "old entries were not re-serialized on turn 2");
  await turnEnd();
  assert.deepEqual(Object.fromEntries(reads), once);
  assert.equal(reader.stats().messages, 4);
  reader.close();
});

test("adapter: turn_end falls back to a full rescan when the watermark id is gone", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = [msgEntry("e1", "user", "one"), msgEntry("e2", "assistant", "two")];
  await startSession(fake.handlers, entries, sessionFile);

  const branch = [
    msgEntry("e1", "user", "one"),
    msgEntry("e5", "user", "five"),
    msgEntry("e6", "assistant", "six"),
  ];
  await fake.handlers.get("turn_end")!(
    {} as never,
    { hasUI: false, sessionManager: sessionManagerOf(branch) } as never,
  );
  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(reader.stats().messages, 4, "e1 kept (idempotent), e5 + e6 added, e2 retained");
  assert.equal(reader.messagesInSpan("e5", "e6").length, 2);
  reader.close();
});

test("adapter: context hook returns undefined below the swap threshold", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = [
    msgEntry("e1", "user", "small talk"),
    msgEntry("e2", "assistant", "small reply"),
  ];
  await startSession(fake.handlers, entries, sessionFile);

  const ctx = {
    hasUI: false,
    sessionManager: sessionManagerOf(entries, sessionFile),
    getContextUsage: () => ({ tokens: 2000, contextWindow: 200_000 }),
    model: { provider: "test", id: "test-model" },
  };
  const res = await fake.handlers.get("context")!({ messages: [] } as never, ctx as never);
  assert.equal(res, undefined, "occupancy 1% of 200k window is quiet: no intervention");

  const tag = basename(lcmDbPath(sessionFile));
  const decisions = readFileSync(metricsPath(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((m) => m.session === tag && m.kind === "context-decision");
  assert.equal(decisions.length, 1);
  const { ts, session, ...fields } = decisions[0]!;
  assert.equal(typeof ts, "number");
  assert.equal(session, tag);
  assert.deepEqual(fields, {
    event: "lcm",
    kind: "context-decision",
    action: "quiet",
    occupancy: 0.01,
    tokens: 2000,
    window: 200_000,
    soft: 0.7,
    commit: 0.85,
    committed: false,
  });
});

test("adapter: context hook cut aligns to entry ids across bash and duplicate-text rows", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries: FakeEntry[] = [
    msgEntry("e1", "user", "same text"),
    {
      id: "e2",
      type: "message",
      message: { role: "bashExecution", command: "ls", output: "file.txt", timestamp: 1 },
    },
    msgEntry("e3", "assistant", "reply one"),
    msgEntry("e4", "user", "x".repeat(81_000)),
    msgEntry("e5", "assistant", "same text"),
  ];
  await startSession(fake.handlers, entries, sessionFile);
  const writer = new LcmStore(lcmDbPath(sessionFile));
  const summaryId = writer.insertSummary({
    kind: "leaf",
    text: "summary of e1..e3",
    tokens: 5,
    depth: 0,
    firstEntryId: "e1",
    lastEntryId: "e3",
  }).id;
  writer.close();

  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));
  assert.equal(messages.length, 5);
  const ctx = {
    hasUI: false,
    sessionManager: sessionManagerOf(entries, sessionFile),
    getContextUsage: () => ({ tokens: 160_000, contextWindow: 200_000 }),
    model: { provider: "test", id: "test-model" },
  };
  const res = (await fake.handlers.get("context")!({ messages } as never, ctx as never)) as
    | { messages: Array<{ role: string; content?: unknown }> }
    | undefined;
  assert.ok(res, "occupancy 80% applies the swap");
  assert.equal(res.messages.length, 3);
  assert.match(String(res.messages[0]!.content), /summary of e1\.\.e3/);
  assert.deepEqual(res.messages.slice(1), messages.slice(3));

  const tag = basename(lcmDbPath(sessionFile));
  const swaps = () =>
    readFileSync(metricsPath(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((m) => m.session === tag && m.kind === "swap-applied");
  assert.equal(swaps().length, 1);
  assert.equal(swaps()[0]!.summaryId, summaryId);
  assert.equal(swaps()[0]!.cutCount, 3);
  assert.equal(swaps()[0]!.distinctBoundary, true, "the first application is the boundary");

  const grown = [...entries, msgEntry("e6", "user", "next question")];
  const grownMessages = grown.flatMap((e) => sessionEntryToContextMessages(e as never));
  const again = (await fake.handlers.get("context")!(
    { messages: grownMessages } as never,
    {
      ...ctx,
      sessionManager: { ...ctx.sessionManager, buildContextEntries: () => grown },
    } as never,
  )) as { messages: unknown[] } | undefined;
  assert.ok(again);
  assert.equal(again.messages.length, 4);
  assert.deepEqual(again.messages.slice(1), grownMessages.slice(3));
  assert.equal(swaps().length, 1);

  const reapply = (await fake.handlers.get("context")!(
    { messages: grownMessages } as never,
    {
      ...ctx,
      getContextUsage: () => ({ tokens: 175_000, contextWindow: 200_000 }),
      sessionManager: { ...ctx.sessionManager, buildContextEntries: () => grown },
    } as never,
  )) as { messages: unknown[] } | undefined;
  assert.ok(reapply);
  assert.equal(reapply.messages.length, 4);
  const rows = swaps();
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.cutCount, 3);
  assert.equal(rows[1]!.distinctBoundary, false, "the same cut re-applied is not new work");
});

test("adapter: two context observations calibrate the estimator against Pi's count", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries: FakeEntry[] = [
    msgEntry("e1", "user", "hello there"),
    msgEntry("e2", "assistant", "hi"),
  ];
  await startSession(fake.handlers, entries, sessionFile);
  const tag = basename(lcmDbPath(sessionFile));
  const mark = metricsMark();
  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));
  const chars = messages.reduce((n, m) => n + (JSON.stringify(m)?.length ?? 0), 0);
  const observe = (turns: number, reported: number) =>
    fake.handlers.get("context")!(
      { messages: Array.from({ length: turns }, () => messages).flat() } as never,
      {
        hasUI: false,
        sessionManager: sessionManagerOf(entries, sessionFile),
        getContextUsage: () => ({ tokens: reported, contextWindow: 1_000_000 }),
        model: { provider: "test", id: "test-model" },
      } as never,
    );
  await observe(1, 10_000);
  assert.deepEqual(
    metricsSince(tag, mark).filter((m) => m.kind === "estimate-calibrated"),
    [],
  );
  const step = Math.round(chars / 5);
  const implied = Math.round((chars / step) * 100) / 100;
  await observe(2, 10_000 + step);
  await observe(3, 10_000 + step * 2);
  await observe(4, 10_000 + step * 3);
  const rows = metricsSince(tag, mark).filter((m) => m.kind === "estimate-calibrated");
  assert.equal(rows.length, 3, "one row per observation after the baseline");
  assert.equal(rows[0]!.samples, 1);
  assert.equal(rows[0]!.charsPerToken, null, "one sample cannot support a ratio");
  assert.equal(rows[2]!.samples, 3);
  assert.equal(rows[2]!.charsPerToken, implied);
  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.deepEqual(reader.getModelState("test/test-model"), {
    charsPerToken: implied,
    samples: 3,
    contextWindow: null,
    windowSource: null,
  });
  reader.close();
});

test("adapter: an error that names the window stores it and re-centers the thresholds", async () => {
  const usage = { tokens: 150_000, contextWindow: 400_000 };
  const turn = async (correct: boolean): Promise<Record<string, unknown>> => {
    const fake = makeFakePi();
    mod(fake.pi as never);
    const sessionFile = uniqueSessionFile();
    const entries: FakeEntry[] = [
      msgEntry("e1", "user", "hello there"),
      msgEntry("e2", "assistant", "hi"),
    ];
    await startSession(fake.handlers, entries, sessionFile);
    const tag = basename(lcmDbPath(sessionFile));
    const mark = metricsMark();
    if (correct) {
      await fake.handlers.get("message_end")!(
        {
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
          },
        } as never,
        {} as never,
      );
    }
    await fake.handlers.get("context")!(
      { messages: entries.flatMap((e) => sessionEntryToContextMessages(e as never)) } as never,
      {
        hasUI: false,
        sessionManager: sessionManagerOf(entries, sessionFile),
        getContextUsage: () => usage,
        model: { provider: "test", id: "test-model" },
      } as never,
    );
    const decision = metricsSince(tag, mark).find((m) => m.kind === "context-decision");
    assert.ok(decision, "every turn records a decision");
    if (correct) {
      const corrected = metricsSince(tag, mark).find((m) => m.kind === "window-corrected");
      assert.ok(corrected, "the statement is recorded");
      assert.equal(corrected.window, 200_000);
      assert.equal(corrected.source, "provider-error");
      const reader = new LcmStore(lcmDbPath(sessionFile));
      assert.equal(reader.getModelState("test/test-model")?.contextWindow, 200_000);
      assert.equal(reader.getModelState("test/test-model")?.windowSource, "provider-error");
      reader.close();
    }
    return decision;
  };
  const believing = await turn(false);
  assert.equal(believing.occupancy, 0.375);
  assert.equal(believing.action, "quiet", "37% of the belief is below every line");
  assert.equal(believing.window, 400_000, "the row still names what Pi believes");
  const corrected = await turn(true);
  assert.equal(corrected.occupancy, 0.75, "occupancy is measured against the stated window");
  assert.equal(corrected.action, "consider-apply", "75% of the statement is over the swap line");
});

test("adapter: an overflow that names no window arms a floor for one turn", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries: FakeEntry[] = [
    msgEntry("e1", "user", "hello there"),
    msgEntry("e2", "assistant", "hi"),
  ];
  await startSession(fake.handlers, entries, sessionFile);
  const tag = basename(lcmDbPath(sessionFile));
  const mark = metricsMark();
  await fake.handlers.get("session_before_compact")!(
    { reason: "overflow", preparation: { tokensBefore: 120_000 }, branchEntries: entries } as never,
    {
      hasUI: false,
      sessionManager: sessionManagerOf(entries, sessionFile),
      model: { provider: "test", id: "test-model" },
    } as never,
  );
  const observe = async (tokens: number): Promise<Record<string, unknown>> => {
    const before = metricsMark();
    await fake.handlers.get("context")!(
      { messages: entries.flatMap((e) => sessionEntryToContextMessages(e as never)) } as never,
      {
        hasUI: false,
        sessionManager: sessionManagerOf(entries, sessionFile),
        getContextUsage: () => ({ tokens, contextWindow: 400_000 }),
        model: { provider: "test", id: "test-model" },
      } as never,
    );
    const decision = metricsSince(tag, before).find((m) => m.kind === "context-decision");
    assert.ok(decision);
    return decision;
  };
  const floor = await observe(100_000);
  assert.equal(
    floor.occupancy,
    Math.round((100_000 / 120_000) * 1000) / 1000,
    "floored at what was refused",
  );
  assert.equal(floor.action, "consider-apply");
  const after = await observe(100_000);
  assert.equal(after.occupancy, 0.25, "the floor is gone");
  assert.equal(after.action, "quiet");
  const rows = metricsSince(tag, mark);
  assert.equal(rows.filter((m) => m.kind === "window-floor").length, 1);
  assert.equal(rows.filter((m) => m.kind === "window-corrected").length, 0, "nothing was stated");
  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(reader.getModelState("test/test-model")?.contextWindow ?? null, null);
  reader.close();
});

test("adapter: a calibrated floor ages more of the head than the constant would", async () => {
  writeLcmConfig({ keepRecentTokens: 250 });
  const run = async (charsPerToken: number | null): Promise<string> => {
    const fake = makeFakePi();
    mod(fake.pi as never);
    const sessionFile = uniqueSessionFile();
    const entries: FakeEntry[] = [];
    for (let i = 0; i < 4; i++) {
      entries.push(msgEntry(`e${i * 2}`, "user", `question ${i} ${"x".repeat(340)}`));
      entries.push(msgEntry(`e${i * 2 + 1}`, "assistant", `answer ${i} ${"y".repeat(350)}`));
    }
    if (charsPerToken !== null) {
      const writer = new LcmStore(lcmDbPath(sessionFile));
      writer.setModelState("test/test-model", { charsPerToken, samples: 4 });
      writer.close();
    }
    await startSession(fake.handlers, entries, sessionFile);
    const tag = basename(lcmDbPath(sessionFile));
    const mark = metricsMark();
    const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));
    const hook = () =>
      fake.handlers.get("context")!(
        { messages } as never,
        {
          hasUI: false,
          sessionManager: sessionManagerOf(entries, sessionFile),
          getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_000_000 }),
          model: { provider: "test", id: "test-model" },
          modelRegistry: {
            find: () => ({ provider: "test", id: "test-model" }),
            complete: async () => ({ content: [{ type: "text", text: "leaf text" }] }),
          },
        } as never,
      );
    await hook();
    await settle();
    const blocked = metricsSince(tag, mark).find((m) => m.kind === "swap-blocked");
    assert.equal(blocked?.reason, "summary-missing");
    const stored = metricsSince(tag, mark).find((m) => m.kind === "compaction-complete");
    assert.ok(stored, `no pass in ${JSON.stringify(metricsSince(tag, mark))}`);
    return String((stored.span as string[])[1]);
  };
  try {
    const constant = await run(null);
    assert.equal(constant, "e3", "the constant's floor ages two turns");
    const calibrated = await run(2);
    assert.equal(calibrated, "e5", "2 chars per token ages three");
  } finally {
    removeWrittenConfig();
  }
});

test("adapter: session_before_compact stores a redacted summary", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const secret = "aaaabbbbccccddddeeeeffff";
  const spanText = `user pasted API_KEY=${secret} into the terminal and asked for help debugging the build pipeline failure`;
  const branchEntries: FakeEntry[] = [
    msgEntry("e1", "user", spanText),
    {
      id: "e1b",
      type: "message",
      message: { role: "bashExecution", command: "ls", output: "file.txt", timestamp: 1 },
    },
    msgEntry("e1c", "user", "continue"),
    msgEntry("e2", "user", "continue"),
  ];
  await startSession(fake.handlers, branchEntries, sessionFile);

  const ctx = {
    hasUI: false,
    model: { provider: "test", id: "test-model" },
    sessionManager: sessionManagerOf(branchEntries, sessionFile),
    modelRegistry: {
      find: () => ({ provider: "test", id: "test-model" }),
      // Fake LLM leaks the secret back in ASSIGNMENT shape: redaction
      // is pattern-based best-effort, so it can only catch this shape.
      complete: async () => ({
        content: [{ type: "text", text: `short summary about API_KEY=${secret} setup` }],
        stopReason: "stop",
        usage: {
          input: 700,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.004, output: 0.001, total: 0.005 },
        },
      }),
    },
  };
  const event = {
    branchEntries,
    preparation: {
      messagesToSummarize: [],
      turnPrefixMessages: [],
      firstKeptEntryId: "e2",
      tokensBefore: 5000,
    },
  };
  const res = (await fake.handlers.get("session_before_compact")!(event as never, ctx as never)) as
    | { compaction?: { summary?: string; firstKeptEntryId?: string } }
    | undefined;

  assert.ok(res?.compaction, "blocking compaction produced a payload");
  assert.equal(res!.compaction!.firstKeptEntryId, "e2");
  assert.ok(
    res!.compaction!.summary!.includes("[lcm:summary #1 depth 0 span e1..e1c]\n"),
    `summary carries the engine pointer: ${res!.compaction!.summary}`,
  );

  const reader = new LcmStore(lcmDbPath(sessionFile));
  const summaries = reader.allSummaries();
  assert.equal(summaries.length, 1, "one leaf summary stored");
  assert.equal(summaries[0]!.firstEntryId, "e1");
  assert.equal(summaries[0]!.lastEntryId, "e1c");
  assert.ok(
    !summaries[0]!.text.includes("aaaabbbbccccddddeeeeffff"),
    "stored summary is redacted even though the fake LLM leaked the secret",
  );
  const spanMsgs = reader.messagesInSpan("e1", "e1c");
  assert.deepEqual(
    spanMsgs.map((m) => [m.entryId, m.role]),
    [
      ["e1", "user"],
      ["e1b", "custom"],
      ["e1c", "user"],
    ],
  );
  assert.ok(
    spanMsgs[0]!.text.includes("aaaabbbbccccddddeeeeffff"),
    "stored span message is verbatim: the store keeps what the user pasted",
  );
  reader.close();

  const tag = basename(lcmDbPath(sessionFile));
  const spend = readFileSync(metricsPath(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((m) => m.session === tag && m.kind === "summarizer-usage");
  assert.equal(spend.length, 1, "one summarizer call, one spend row");
  assert.equal(spend[0]!.stage, "blocking");
  assert.equal(spend[0]!.outcome, "ok");
  assert.equal(spend[0]!.model, "test/test-model");
  assert.equal(spend[0]!.input, 700);
  assert.equal(spend[0]!.costTotal, 0.005);
});

test("adapter: session_before_compact hands a span with no stored rows to Pi, and says so", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const branchEntries: FakeEntry[] = [
    msgEntry("e1", "user", "   "),
    msgEntry("e2", "user", "kept"),
  ];
  await startSession(fake.handlers, branchEntries, sessionFile);

  let calls = 0;
  const ctx = {
    hasUI: false,
    model: { provider: "test", id: "test-model" },
    modelRegistry: {
      find: () => ({ provider: "test", id: "test-model" }),
      complete: async () => {
        calls += 1;
        return { content: [{ type: "text", text: "unused" }], stopReason: "stop" };
      },
    },
  };
  const event = {
    branchEntries,
    preparation: {
      messagesToSummarize: [],
      turnPrefixMessages: [],
      firstKeptEntryId: "e2",
      tokensBefore: 5000,
    },
  };
  const res = await fake.handlers.get("session_before_compact")!(event as never, ctx as never);
  assert.equal(res, undefined, "Pi default: no text of lcm's own to hand back");
  assert.equal(calls, 0, "a span with no stored rows never reaches a model");

  const tag = basename(lcmDbPath(sessionFile));
  const rows = readFileSync(metricsPath(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((m) => m.session === tag && m.kind === "compaction-noop");
  assert.equal(rows.length, 1, "the state is recorded once");
  assert.equal(rows[0]!.stage, "blocking");
  assert.equal(rows[0]!.reason, "no-entries");
  assert.equal(rows[0]!.ingested, 0);
  const errors = readFileSync(metricsPath(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((m) => m.session === tag && m.kind === "compaction-error");
  assert.deepEqual(errors, [], "a state is not a failure");
});

test("adapter: session_before_compact summarizes only the new span and returns the whole-branch frontier", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const branchEntries: FakeEntry[] = [
    msgEntry("e1", "user", "first question, long ago"),
    msgEntry("e2", "assistant", "kept by the first compaction"),
    {
      id: "c1",
      type: "compaction",
      summary: "pi's own first summary",
      firstKeptEntryId: "e2",
      tokensBefore: 100,
      timestamp: 1,
    },
    msgEntry("e3", "user", "second question"),
    msgEntry("e4", "assistant", "tail, kept this time"),
  ];
  await startSession(fake.handlers, branchEntries, sessionFile);
  const writer = new LcmStore(lcmDbPath(sessionFile));
  const oldLeaf = writer.insertSummary({
    kind: "leaf",
    text: "old leaf over e1",
    tokens: 4,
    depth: 0,
    firstEntryId: "e1",
    lastEntryId: "e1",
    messageIds: writer.messagesInSpan("e1", "e1").map((m) => m.id),
  }).id;
  writer.close();

  const summarized: string[] = [];
  const ctx = {
    hasUI: false,
    model: { provider: "test", id: "test-model" },
    sessionManager: sessionManagerOf(branchEntries, sessionFile),
    modelRegistry: {
      find: () => ({ provider: "test", id: "test-model" }),
      complete: async (_m: unknown, req: { messages: Array<{ content: unknown }> }) => {
        summarized.push(JSON.stringify(req.messages));
        return { content: [{ type: "text", text: "new leaf" }] };
      },
    },
  };
  const res = (await fake.handlers.get("session_before_compact")!(
    {
      branchEntries,
      preparation: {
        messagesToSummarize: [],
        turnPrefixMessages: [],
        firstKeptEntryId: "e4",
        previousSummary: "pi's own first summary",
        tokensBefore: 5000,
      },
    } as never,
    ctx as never,
  )) as { compaction?: { summary?: string } } | undefined;

  assert.equal(summarized.length, 1);
  assert.ok(summarized[0]!.includes("second question"), summarized[0]);
  assert.ok(!summarized[0]!.includes("long ago"), summarized[0]);
  const reader = new LcmStore(lcmDbPath(sessionFile));
  const nodes = reader.allSummaries();
  assert.deepEqual(
    nodes.map((n) => [n.id, n.firstEntryId, n.lastEntryId]),
    [
      [oldLeaf, "e1", "e1"],
      [oldLeaf + 1, "e2", "e3"],
    ],
  );
  reader.close();
  assert.equal(
    res?.compaction?.summary,
    `[lcm:summary #${oldLeaf} depth 0 span e1..e1]\nold leaf over e1\n\n` +
      `[lcm:summary #${oldLeaf + 1} depth 0 span e2..e3]\nnew leaf`,
  );
});

test("adapter: the injected projection masks a key a stored node carries", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries: FakeEntry[] = [
    msgEntry("e1", "user", "same text"),
    msgEntry("e2", "assistant", "reply one"),
    msgEntry("e3", "user", "a third entry the node covers"),
    msgEntry("e4", "user", "x".repeat(81_000)),
    msgEntry("e5", "assistant", "same text"),
  ];
  await startSession(fake.handlers, entries, sessionFile);

  const secret = "sk-abcdefghijklmnop1234567890";
  const writer = new LcmStore(lcmDbPath(sessionFile));
  writer.insertSummary({
    kind: "leaf",
    text: `the key is ${secret} and the rest is noise`,
    tokens: 12,
    depth: 0,
    firstEntryId: "e1",
    lastEntryId: "e3",
  });
  writer.close();

  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));
  const res = (await fake.handlers.get("context")!(
    { messages } as never,
    {
      hasUI: false,
      sessionManager: sessionManagerOf(entries, sessionFile),
      getContextUsage: () => ({ tokens: 160_000, contextWindow: 200_000 }),
      model: { provider: "test", id: "test-model" },
    } as never,
  )) as { messages: Array<{ role: string; content?: unknown }> } | undefined;
  assert.ok(res, "occupancy 80% applies the swap");
  const injected = String(res.messages[0]!.content);
  assert.ok(injected.includes("[REDACTED]"), injected);
  assert.ok(!injected.includes(secret), "the stored key never reaches the model");
});

test("adapter: session_shutdown closes the store; later hooks no-op", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = [msgEntry("e1", "user", "one message")];
  await startSession(fake.handlers, entries, sessionFile);

  await fake.handlers.get("session_shutdown")!({} as never, {} as never);
  entries.push(msgEntry("e2", "assistant", "arrived after shutdown"));
  await fake.handlers.get("turn_end")!(
    {} as never,
    { hasUI: false, sessionManager: sessionManagerOf(entries) } as never,
  );
  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(reader.stats().messages, 1);
  assert.deepEqual(
    reader.messagesInSpan("e1", "e1").map((m) => m.text),
    ["one message"],
  );
  assert.equal(reader.grep("shutdown").length, 0);
  reader.close();
});

function turnCtx(entries: FakeEntry[]) {
  return { hasUI: false, sessionManager: sessionManagerOf(entries) } as never;
}

test("adapter: a session that ingests nothing leaves no store", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries: FakeEntry[] = [];
  await startSession(fake.handlers, entries, sessionFile);
  assert.equal(existsSync(lcmDbPath(sessionFile)), false, "an empty session writes no database");

  // Pi records the turn even when the model said nothing addressable.
  entries.push(msgEntry("e1", "assistant", "   "), msgEntry("e2", "assistant", ""));
  await fake.handlers.get("turn_end")!({} as never, turnCtx(entries));
  assert.equal(existsSync(lcmDbPath(sessionFile)), false, "whitespace alone writes no database");
});

test("adapter: reading a session with no store answers without creating one", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  await startSession(fake.handlers, [], sessionFile);

  const grep = fake.tools.find((t) => t.name === "lcm_grep") as unknown as {
    execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
  };
  const answer = await grep.execute("t", { query: "anything" });
  assert.match(answer.content[0]!.text, /nothing has been ingested/);

  const notified: Array<[string, string]> = [];
  await fake.commands.get("lcm")!.handler("status", {
    mode: "tui",
    ui: { notify: (message: string, level: string) => void notified.push([message, level]) },
    sessionManager: sessionManagerOf([], sessionFile),
  } as never);
  assert.equal(notified.length, 1);
  assert.match(notified[0]![0], /nothing has been ingested/);

  assert.equal(
    await fake.handlers.get("context")!({ messages: [] } as never, {} as never),
    undefined,
  );
  assert.equal(
    await fake.handlers.get("session_before_compact")!(
      { preparation: { firstKeptEntryId: "e0" }, branchEntries: [] } as never,
      {} as never,
    ),
    undefined,
  );
  assert.equal(existsSync(lcmDbPath(sessionFile)), false, "a question is not a reason to write");
});

test("adapter: the store appears on the first turn that carries something", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries: FakeEntry[] = [];
  await startSession(fake.handlers, entries, sessionFile);

  entries.push(msgEntry("e1", "assistant", "\n\t "));
  await fake.handlers.get("turn_end")!({} as never, turnCtx(entries));
  assert.equal(existsSync(lcmDbPath(sessionFile)), false);

  entries.push(msgEntry("e2", "user", "the first real message"));
  await fake.handlers.get("turn_end")!({} as never, turnCtx(entries));
  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(
    reader.stats().messages,
    1,
    "the whitespace turn stored nothing and was not replayed",
  );
  assert.deepEqual(
    reader.messagesInSpan("e2", "e2").map((m) => m.text),
    ["the first real message"],
  );
  reader.close();
});

test("adapter: a config problem reaches the UI with one and the metrics log without one", async () => {
  writeLcmConfig({ summarizer: ["a/one", "a/one"] });
  try {
    const fake = makeFakePi();
    mod(fake.pi as never);
    const sessionFile = uniqueSessionFile();

    await startSession(fake.handlers, [], sessionFile);
    const tag = basename(lcmDbPath(sessionFile));
    const problems = readFileSync(metricsPath(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((m) => m.session === tag && m.kind === "config-problem");
    assert.equal(problems.length, 1);
    assert.deepEqual(problems[0]!.problems, ['summarizer[1] repeats "a/one"; entry dropped']);

    const notified: string[] = [];
    const uiCtx = {
      ...makeStartCtx([], sessionFile),
      hasUI: true,
      ui: { notify: (message: string) => void notified.push(message) },
    };
    await fake.handlers.get("session_start")!({} as never, uiCtx as never);
    assert.equal(notified.length, 1);
    assert.match(notified[0]!, /summarizer\[1\] repeats "a\/one"/);
  } finally {
    removeWrittenConfig();
  }
});

function metricsSince(tag: string, mark: number): Array<Record<string, unknown>> {
  const raw = readFileSync(metricsPath(), "utf8").slice(mark).trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((m) => m.session === tag);
}

function metricsMark(): number {
  try {
    return readFileSync(metricsPath(), "utf8").length;
  } catch {
    return 0;
  }
}

function gatedCompleter() {
  let open = false;
  const parked: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  return {
    complete: async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (!open) await new Promise<void>((resolve) => parked.push(resolve));
      inFlight--;
      return { content: [{ type: "text", text: `summary ${calls}` }] };
    },
    release: () => {
      open = true;
      for (const resolve of parked.splice(0)) resolve();
    },
    stats: () => ({ calls, maxInFlight }),
  };
}

function agedEntries(): FakeEntry[] {
  return [
    msgEntry("e1", "user", "aged question"),
    msgEntry("e2", "assistant", "aged answer"),
    msgEntry("e3", "user", "aged follow-up"),
    msgEntry("e4", "user", "x".repeat(81_000)),
    msgEntry("e5", "assistant", "kept"),
  ];
}

function kickCtx(sessionFile: string, entries: FakeEntry[], complete: () => Promise<unknown>) {
  return {
    hasUI: false,
    sessionManager: sessionManagerOf(entries, sessionFile),
    getContextUsage: () => ({ tokens: 160_000, contextWindow: 200_000 }),
    model: { provider: "test", id: "test-model" },
    modelRegistry: { find: () => ({ provider: "test", id: "test-model" }), complete },
  };
}

function blockingEvent(entries: FakeEntry[]) {
  return {
    branchEntries: entries,
    preparation: {
      messagesToSummarize: [],
      turnPrefixMessages: [],
      firstKeptEntryId: "e4",
      tokensBefore: 5000,
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
}

test("adapter: async compaction is single-flight and drains the newest queued span", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = agedEntries();
  await startSession(fake.handlers, entries, sessionFile);
  const tag = basename(lcmDbPath(sessionFile));
  const mark = metricsMark();
  const gated = gatedCompleter();
  const ctx = kickCtx(sessionFile, entries, gated.complete);
  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));
  const kick = () => fake.handlers.get("context")!({ messages } as never, ctx as never);

  await kick();
  assert.equal(gated.stats().calls, 1, "the first kick starts a pass");
  await kick();
  await kick();
  assert.equal(gated.stats().calls, 1, "kicks while a pass runs do not start another");

  gated.release();
  await settle();
  const events = metricsSince(tag, mark);
  assert.equal(gated.stats().maxInFlight, 1, "passes never overlap");
  const queued = events.filter((m) => m.kind === "compaction-queued");
  assert.equal(queued.length, 1, "one record for the drained queue");
  assert.equal(queued[0]!.queued, 2, "both kicks that arrived during the pass are counted");
  assert.equal(
    events.filter((m) => m.kind === "compaction-complete").length,
    2,
    "exactly one follow-up pass ran",
  );
});

test("adapter: a pass whose model changed under it is discarded and re-run", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = agedEntries();
  await startSession(fake.handlers, entries, sessionFile);
  const tag = basename(lcmDbPath(sessionFile));
  const mark = metricsMark();
  const gated = gatedCompleter();
  const ctx = kickCtx(sessionFile, entries, gated.complete);
  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));

  await fake.handlers.get("context")!({ messages } as never, ctx as never);
  assert.equal(gated.stats().calls, 1, "the pass is parked in the model call");

  const switched = { ...ctx, model: { provider: "test", id: "other-model" } };
  await fake.handlers.get("context")!({ messages } as never, switched as never);
  assert.equal(gated.stats().calls, 1, "the parked pass still owns the slot");

  gated.release();
  await settle();

  const stale = metricsSince(tag, mark).filter((m) => m.kind === "compaction-stale");
  assert.equal(stale.length, 1, "one row for the pass that was dropped");
  assert.equal(stale[0]!.reason, "model-changed");
  assert.deepEqual(stale[0]!.changed, []);
  assert.equal(stale[0]!.stage, "async");
  assert.equal(stale[0]!.entryId, "e3", "the last entry the pass reached");
  assert.ok(Number(stale[0]!.dropped) >= 1, "the rows it wrote were deleted");
  assert.equal(
    metricsSince(tag, mark).filter((m) => m.kind === "compaction-abandoned").length,
    0,
    "a stale pass is counted as stale, not as abandoned",
  );

  const complete = metricsSince(tag, mark).filter((m) => m.kind === "compaction-complete");
  assert.equal(complete.length, 2, "the queued pass summarized the span again");
  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.ok(reader.stats().summaries > 0, "the second pass left its rows in place");
  reader.close();
});

test("adapter: a pass whose summarizer fails stores its fallback through the run", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = agedEntries();
  await startSession(fake.handlers, entries, sessionFile);
  const tag = basename(lcmDbPath(sessionFile));
  const mark = metricsMark();
  const ctx = kickCtx(sessionFile, entries, () => Promise.reject(new Error("summarizer down")));
  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));

  await fake.handlers.get("context")!({ messages } as never, ctx as never);
  await settle();

  const rows = metricsSince(tag, mark);
  assert.ok(
    rows.some((m) => m.kind === "summary-fallback-stored"),
    "the ladder dropped to a mechanical fallback",
  );
  assert.equal(
    rows.filter((m) => m.kind === "compaction-error").length,
    0,
    "a fallback is a pass that finished, not one that threw",
  );
  assert.equal(rows.filter((m) => m.kind === "compaction-complete").length, 1);

  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.ok(reader.stats().summaries >= 1, "the fallback is committed, not pending");
  assert.equal(reader.uncoveredMessagesInSpan("e1", "e3").length, 0, "its span is covered");
  reader.close();
});

test("adapter: rows a dead process left are reaped by the next pass and counted", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = agedEntries();
  await startSession(fake.handlers, entries, sessionFile);
  const tag = basename(lcmDbPath(sessionFile));
  const mark = metricsMark();

  leaveCrashedRun(lcmDbPath(sessionFile), { first: "e1", last: "e3" });

  const gated = gatedCompleter();
  const ctx = kickCtx(sessionFile, entries, gated.complete);
  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));
  await fake.handlers.get("context")!({ messages } as never, ctx as never);
  gated.release();
  await settle();

  const abandoned = metricsSince(tag, mark).filter((m) => m.kind === "compaction-abandoned");
  assert.equal(abandoned.length, 1, "the reap is recorded once, by the pass that ran it");
  assert.ok(Number(abandoned[0]!.dropped) >= 1, "the dead process's row is the count");
  assert.equal(abandoned[0]!.stage, "async");

  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(reader.stats().summaries, 1, "only the pass's own leaf is memory");
  assert.notEqual(
    reader.frontier("e1", "e3")[0]?.text,
    "a row nobody will commit",
    "the dead row is gone, not committed",
  );
  reader.close();
});

test("adapter: a pass whose conditions still hold writes no stale row", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = agedEntries();
  await startSession(fake.handlers, entries, sessionFile);
  const tag = basename(lcmDbPath(sessionFile));
  const mark = metricsMark();
  const gated = gatedCompleter();
  const ctx = kickCtx(sessionFile, entries, gated.complete);
  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));

  await fake.handlers.get("context")!({ messages } as never, ctx as never);
  gated.release();
  await settle();

  const events = metricsSince(tag, mark);
  assert.equal(events.filter((m) => m.kind === "compaction-stale").length, 0);
  assert.equal(events.filter((m) => m.kind === "compaction-complete").length, 1);
});

test("adapter: the blocking pass waits for the async pass instead of racing it", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = agedEntries();
  await startSession(fake.handlers, entries, sessionFile);
  const tag = basename(lcmDbPath(sessionFile));
  const mark = metricsMark();
  const gated = gatedCompleter();
  const ctx = kickCtx(sessionFile, entries, gated.complete);
  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));

  await fake.handlers.get("context")!({ messages } as never, ctx as never);
  assert.equal(gated.stats().calls, 1, "an async pass is in flight");
  const blocking = fake.handlers.get("session_before_compact")!(
    blockingEvent(entries) as never,
    ctx as never,
  );
  await settle();
  assert.equal(
    gated.stats().calls,
    1,
    "the blocking pass waited rather than starting a second pass",
  );

  gated.release();
  const res = (await blocking) as { compaction?: { summary?: string } } | undefined;
  assert.ok(res?.compaction, "the blocking pass ran once the async pass settled");
  assert.equal(gated.stats().maxInFlight, 1, "no two passes were ever in flight together");
  const awaited = metricsSince(tag, mark).filter((m) => m.kind === "compaction-awaited");
  assert.equal(awaited.length, 1);
  assert.equal(awaited[0]!.timedOut, false);
  assert.ok(Number(awaited[0]!.elapsedMs) >= 0);
});

test("adapter: a pass that never settles is cleared after the watchdog interval", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const fake = makeFakePi();
    mod(fake.pi as never);
    const sessionFile = uniqueSessionFile();
    const entries = agedEntries();
    await startSession(fake.handlers, entries, sessionFile);
    const tag = basename(lcmDbPath(sessionFile));
    const mark = metricsMark();
    const gated = gatedCompleter();
    const ctx = kickCtx(sessionFile, entries, gated.complete);
    const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));

    vi.setSystemTime(1_000_000);
    await fake.handlers.get("context")!({ messages } as never, ctx as never);
    assert.equal(gated.stats().calls, 1, "the pass is parked in the model call");
    vi.setSystemTime(1_000_000 + 5 * 60_000 + 1);
    await fake.handlers.get("context")!({ messages } as never, ctx as never);
    const cleared = metricsSince(tag, mark).filter((m) => m.kind === "compaction-timeout-cleared");
    assert.equal(cleared.length, 1);
    assert.ok(Number(cleared[0]!.elapsedMs) >= 5 * 60_000);
    assert.equal(gated.stats().calls, 2);
    gated.release();
    vi.useRealTimers();
    await settle();
  } finally {
    vi.useRealTimers();
  }
});

test("adapter: the blocking pass gives up waiting at the bound and records the timeout", async () => {
  vi.useFakeTimers();
  try {
    const fake = makeFakePi();
    mod(fake.pi as never);
    const sessionFile = uniqueSessionFile();
    const entries = agedEntries();
    await startSession(fake.handlers, entries, sessionFile);
    const tag = basename(lcmDbPath(sessionFile));
    const mark = metricsMark();
    const gated = gatedCompleter();
    const ctx = kickCtx(sessionFile, entries, gated.complete);
    const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));

    await fake.handlers.get("context")!({ messages } as never, ctx as never);
    const blocking = fake.handlers.get("session_before_compact")!(
      blockingEvent(entries) as never,
      ctx as never,
    );
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(gated.stats().calls, 1, "still waiting inside the bound");
    await vi.advanceTimersByTimeAsync(20_000);
    gated.release();
    const res = (await blocking) as { compaction?: { summary?: string } } | undefined;
    assert.ok(res?.compaction, "the blocking pass proceeds on its own after the bound");
    assert.match(
      String(res?.compaction?.summary),
      /lcm:summary/,
      "the span another live run claimed is rendered from the text that run wrote",
    );
    assert.equal(
      metricsSince(tag, mark).filter((m) => m.kind === "compaction-error").length,
      0,
      "losing a span to a live run is a collision, not an error",
    );
    const awaited = metricsSince(tag, mark).filter((m) => m.kind === "compaction-awaited");
    assert.equal(awaited.length, 1);
    assert.equal(awaited[0]!.timedOut, true);
    assert.ok(Number(awaited[0]!.elapsedMs) >= 20_000);
    await vi.advanceTimersByTimeAsync(1000);
  } finally {
    vi.useRealTimers();
  }
});

test("adapter: Pi's own head compaction is recorded once, with the occupancy of that turn", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries: FakeEntry[] = [
    msgEntry("e0", "user", "a turn before pi compacted"),
    {
      id: "c0",
      type: "message",
      message: { role: "compactionSummary", summary: "pi compacted the head" },
    },
  ];
  const usage = { tokens: 120_000, contextWindow: 128_000 };
  await fake.handlers.get("session_start")!(
    {} as never,
    {
      ...makeStartCtx(entries, sessionFile),
      getContextUsage: () => usage,
    } as never,
  );

  const tag = basename(lcmDbPath(sessionFile));
  const rows = (kind: string) =>
    readFileSync(metricsPath(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((m) => m.kind === kind && m.session === tag);
  const sightings = rows("pi-compaction");
  assert.equal(sightings.length, 1, "one head compaction, one row");
  assert.equal(sightings[0]!.entryId, "c0");
  assert.equal(sightings[0]!.tokens, 120_000);
  assert.equal(sightings[0]!.window, 128_000);

  await fake.handlers.get("session_start")!(
    {} as never,
    {
      ...makeStartCtx(entries, sessionFile),
      getContextUsage: () => usage,
    } as never,
  );
  assert.equal(rows("pi-compaction").length, 1, "a re-ingest adds no row");
});

test("adapter: a large tool result whose call named a path is externalized at ingest", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const body = JSON.stringify(
    Array.from({ length: 1500 }, (_, i) => ({ id: i, name: `row ${i}` })),
  );
  assert.ok(body.length > 32_000, "over the default threshold, so the test states why it fires");
  const entries: FakeEntry[] = [
    msgEntry("e1", "assistant", [
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x/big.json" } },
    ]),
    {
      id: "e2",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: body }],
      },
    },
    msgEntry("e3", "assistant", [
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "/x/small.json" } },
    ]),
    {
      id: "e4",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "read",
        content: [{ type: "text", text: "{}" }],
      },
    },
  ];
  const mark = metricsMark();
  await startSession(fake.handlers, entries, sessionFile);
  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(reader.stats().files, 1, "only the body over the threshold got a handle");
  assert.equal(reader.allFiles()[0]!.path, "/x/big.json");
  assert.equal(reader.allFiles()[0]!.kind, "json");
  assert.equal(reader.messageByEntryId("e2")!.text, body);
  assert.deepEqual(reader.fileIdsForMessages([reader.messageByEntryId("e4")!.id]), []);
  reader.close();
  const tag = basename(lcmDbPath(sessionFile));
  const events = metricsSince(tag, mark);
  const rows = events.filter((m) => m.kind === "file-externalized");
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0]!.entryId, rows[0]!.path, rows[0]!.fileKind, rows[0]!.bytes],
    ["e2", "/x/big.json", "json", body.length],
  );
});

function branchedEntries(): FakeEntry[] {
  return [
    { id: "r", type: "message", parentId: null, message: { role: "user", content: "root" } },
    {
      id: "a1",
      type: "message",
      parentId: "r",
      message: { role: "assistant", content: "branch A" },
    },
    {
      id: "a2",
      type: "message",
      parentId: "a1",
      message: { role: "user", content: "abandoned fact" },
    },
    { id: "b1", type: "message", parentId: "r", message: { role: "assistant", content: "kept" } },
  ];
}

test("adapter: session_start tombstones the entries outside the active path", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = branchedEntries();
  await startSession(fake.handlers, entries, sessionFile);
  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(reader.stats().messages, 4, "every entry is still ingested");
  assert.equal(reader.stats().removedMessages, 2);
  assert.deepEqual(reader.grep("abandoned"), [], "search skips it");
  assert.equal(reader.grep("abandoned", { includeRemoved: true }).length, 1);
  reader.close();
});

test("adapter: session_tree flips the marks and records what changed", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = branchedEntries();
  await startSession(fake.handlers, entries, sessionFile);
  const mark = metricsMark();
  const tag = basename(lcmDbPath(sessionFile));
  const ctx = makeStartCtx(entries, sessionFile);

  await fake.handlers.get("session_tree")!(
    { oldLeafId: "b1", newLeafId: "a2" } as never,
    ctx as never,
  );
  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(reader.stats().removedMessages, 1, "b1 is the only removed entry now");
  assert.deepEqual(reader.grep("abandoned").length, 1, "the restored branch is searchable");
  assert.equal(reader.grep("kept").length, 0);
  reader.close();
  const rows = metricsSince(tag, mark).filter((m) => m.kind === "branch-removed");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.removed, rows[0]!.restored], [1, 2]);

  const after = metricsMark();
  await fake.handlers.get("session_tree")!(
    { oldLeafId: "a2", newLeafId: "a2" } as never,
    ctx as never,
  );
  assert.deepEqual(
    metricsSince(tag, after).filter((m) => m.kind === "branch-removed"),
    [],
  );
});

test("adapter: a compaction-trimmed context list is not a tombstone signal", async () => {
  // The trap: buildContextEntries drops the summarized head, so reconciling
  // against it would tombstone everything Pi compacted. The walk is getBranch.
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries = branchedEntries();
  const ctx = {
    ...makeStartCtx(entries, sessionFile),
    sessionManager: {
      ...sessionManagerOf(entries, sessionFile),
      buildContextEntries: () => entries.slice(-1),
    },
  };
  await fake.handlers.get("session_start")!({} as never, ctx as never);
  const reader = new LcmStore(lcmDbPath(sessionFile));
  assert.equal(reader.stats().messages, 4);
  assert.equal(
    reader.stats().removedMessages,
    2,
    "only the abandoned branch, not the trimmed head",
  );
  assert.deepEqual(reader.grep("root").length, 1);
  reader.close();
});

test("adapter: a reported count from another turn is replaced by the estimate", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries: FakeEntry[] = [
    msgEntry("e1", "user", "x".repeat(700_000)),
    msgEntry("e2", "assistant", "done"),
  ];
  await startSession(fake.handlers, entries, sessionFile);
  const tag = basename(lcmDbPath(sessionFile));
  const mark = metricsMark();
  const messages = entries.flatMap((e) => sessionEntryToContextMessages(e as never));
  await fake.handlers.get("context")!(
    { messages } as never,
    {
      hasUI: false,
      sessionManager: sessionManagerOf(entries, sessionFile),
      getContextUsage: () => ({ tokens: 5_000, contextWindow: 200_000 }),
      model: { provider: "test", id: "test-model" },
    } as never,
  );
  const rows = metricsSince(tag, mark);
  const decision = rows.find((m) => m.kind === "context-decision");
  assert.ok(decision, "the turn records a decision");
  const expected = Math.ceil(contextChars(messages) / CHARS_PER_TOKEN);
  assert.ok(expected > 150_000, "the fixture dwarfs the reported count");
  assert.equal(decision.tokens, expected, "the estimate stands in for the stale count");
  assert.equal(decision.tokensEstimated, true);
  assert.ok(
    Number(decision.occupancy) > 0.8,
    "the occupancy the thresholds read is the estimate's, not the stale count's",
  );
  assert.equal(
    rows.filter((m) => m.kind === "estimate-calibrated").length,
    0,
    "a substituted pair is not a calibration sample",
  );
});

test("adapter: a reported count that fits the context on hand is used as it arrives", async () => {
  const fake = makeFakePi();
  mod(fake.pi as never);
  const sessionFile = uniqueSessionFile();
  const entries: FakeEntry[] = [
    msgEntry("e1", "user", "small talk"),
    msgEntry("e2", "assistant", "small reply"),
  ];
  await startSession(fake.handlers, entries, sessionFile);
  const tag = basename(lcmDbPath(sessionFile));
  const mark = metricsMark();
  const usage = { tokens: 100_000, contextWindow: 200_000 };
  const drive = async () =>
    fake.handlers.get("context")!(
      { messages: entries.flatMap((e) => sessionEntryToContextMessages(e as never)) } as never,
      {
        hasUI: false,
        sessionManager: sessionManagerOf(entries, sessionFile),
        getContextUsage: () => usage,
        model: { provider: "test", id: "test-model" },
      } as never,
    );
  await drive();
  entries.push(msgEntry("e3", "user", "b".repeat(400_000)));
  usage.tokens = 200_000;
  await drive();
  const rows = metricsSince(tag, mark);
  const decisions = rows.filter((m) => m.kind === "context-decision");
  assert.deepEqual(
    decisions.map((d) => d.tokens),
    [100_000, 200_000],
    "a count that fits the context on hand is the number the thresholds read",
  );
  assert.equal(
    decisions.some((d) => "tokensEstimated" in d),
    false,
    "and no decision says its number was estimated",
  );
  const calibrated = rows.find((m) => m.kind === "estimate-calibrated");
  assert.ok(calibrated, "the pair is still a calibration sample");
  assert.equal(calibrated.tokens, 100_000);
  assert.equal(calibrated.samples, 1);
  assert.ok(
    Number(calibrated.chars) > 400_000 && Number(calibrated.chars) < 400_100,
    "the growth is the 400k characters added, plus the message wrapper",
  );
});
