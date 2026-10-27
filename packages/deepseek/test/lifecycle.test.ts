import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import { CommandId } from "@deepseek-ai/dsh-commands/brand";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { LcmStore, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { lcmCommandDefinition, type LcmCommandDeps } from "../src/command.ts";
import { createRecord } from "../src/metrics.ts";
import type { DshRoute } from "../src/model-host.ts";
import { fakeAgent } from "./support/agent-fake.ts";
import { appendConversation } from "./support/conversation.ts";
import { setupContext } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deepseek-lcm-"));
}

async function mountBase(ctx: Context): Promise<void> {
  await ctx.plugin(SystemPrompt, {});
  void new ToolRuntime(ctx);
  void new CommandRuntime(ctx);
  void new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  void new TokenMeter(ctx);
}

function depsFor(dir: string, stores: Map<string, LcmStore>): LcmCommandDeps {
  return {
    stores: () => stores,
    sidecarDir: dir,
    storePathFor: (sessionId) => join(dir, `${sessionId}.sqlite`),
  };
}

function seedStore(dir: string, sessionId: string, texts: string[]): LcmStore {
  const store = new LcmStore(join(dir, `${sessionId}.sqlite`));
  ingestEntries(
    store,
    texts.map((text, i) => ({
      entryId: `e${String(i).padStart(2, "0")}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text,
      timestamp: i,
    })),
  );
  return store;
}

function invoke(
  ctx: Context,
  deps: LcmCommandDeps,
  sessionId: string,
  rawInput: string,
): Promise<{ kind: string; text?: string }> {
  const session = ctx.sessions.get(SessionId(sessionId));
  if (!session) throw new Error(`no session ${sessionId}`);
  const definition = lcmCommandDefinition(ctx, deps);
  return definition.handler({
    agent: fakeAgent(session, ROUTE),
    signal: new AbortController().signal,
    commandId: CommandId(`cmd-${rawInput.split(" ")[0] || "status"}`),
    rawInput,
    attachments: [],
  }) as Promise<{ kind: string; text?: string }>;
}

describe("lcm read-only verbs", () => {
  it("status keeps counts and adds window, thresholds, and the last pass", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    const session = ctx.sessions.create(SessionId("status-1"), { meta: { cwd: dir } });
    appendConversation(session, ROUTE, "status notes");
    const store = seedStore(dir, "status-1", ["status hello"]);
    createRecord(dir)({
      kind: "pass",
      session: "status-1",
      outcome: "stored",
      leaf: 2,
      condensed: 1,
    });
    const result = await invoke(
      ctx,
      depsFor(dir, new Map([["status-1", store]])),
      "status-1",
      "status",
    );
    expect(result.kind).toBe("success");
    expect(result.text).toContain("status-1: 1 messages, 0 summaries");
    expect(result.text).toContain("window (status-1):");
    expect(result.text).toContain("thresholds: swap 70% / recut 85%");
    expect(result.text).toContain("last pass (status-1): stored (2 leaf, 1 condensed)");
  });

  it("status reports the configured pressure threshold instead of the default", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    const session = ctx.sessions.create(SessionId("status-cfg"), { meta: { cwd: dir } });
    appendConversation(session, ROUTE, "status notes");
    const store = seedStore(dir, "status-cfg", ["status hello"]);
    const deps: LcmCommandDeps = {
      ...depsFor(dir, new Map([["status-cfg", store]])),
      thresholdRatio: 0.5,
    };
    const result = await invoke(ctx, deps, "status-cfg", "status");
    expect(result.kind).toBe("success");
    expect(result.text).toContain("thresholds: swap 50% / recut 85%");
    expect(result.text).not.toContain("swap 70%");
  });

  it("status applies the routed model policy over the base zone", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    const session = ctx.sessions.create(SessionId("status-pol"), { meta: { cwd: dir } });
    appendConversation(session, ROUTE, "status notes");
    const store = seedStore(dir, "status-pol", ["status hello"]);
    const deps: LcmCommandDeps = {
      ...depsFor(dir, new Map([["status-pol", store]])),
      thresholdRatio: 0.5,
      modelPolicies: [{ provider: ROUTE.provider, model: ROUTE.model, thresholdRatio: 0.3 }],
    };
    const result = await invoke(ctx, deps, "status-pol", "status");
    expect(result.kind).toBe("success");
    expect(result.text).toContain("thresholds: swap 30% / recut 85%");
    expect(result.text).not.toContain("swap 50%");
  });

  it("diagnose reports the configured pressure threshold", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("diag-cfg"), { meta: { cwd: dir } });
    const store = seedStore(dir, "diag-cfg", ["diagnose hello"]);
    const deps: LcmCommandDeps = {
      ...depsFor(dir, new Map([["diag-cfg", store]])),
      thresholdRatio: 0.5,
    };
    const result = await invoke(ctx, deps, "diag-cfg", "diagnose");
    expect(result.kind).toBe("success");
    expect(result.text).toContain("swap 50%");
    expect(result.text).toContain('"swapAtRatio":0.5');
    expect(result.text).not.toContain("swap 70%");
  });

  it("report rolls up seeded pass, checkpoint, recall, and retrieval rows", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("rep-1"), { meta: { cwd: dir } });
    const record = createRecord(dir);
    record({ kind: "pass", session: "rep-1", outcome: "stored", leaf: 2, condensed: 1 });
    record({ kind: "pass", session: "rep-1", outcome: "nothing", reason: "span covered" });
    record({ kind: "compaction-checkpoint", session: "rep-1", summarySeqs: [1], leafSeqs: [2] });
    record({ kind: "recall", session: "rep-1", tool: "lcm_grep", outcome: "hit" });
    record({
      kind: "retrieval",
      session: "rep-1",
      stop: "answered",
      steps: 2,
      retrievedTokens: 10,
    });
    record({ kind: "backfill", session: "rep-1", ingested: 3, skipped: 1 });
    record({ kind: "backfill", session: "rep-1", ingested: 4, skipped: 0 });
    const result = await invoke(ctx, depsFor(dir, new Map()), "rep-1", "report");
    expect(result.kind).toBe("success");
    expect(result.text).toContain("passes: 2 (stored 1, nothing 1, failed 0); 2 leaf, 1 condensed");
    expect(result.text).toContain("checkpoints: 1 commit(s)");
    expect(result.text).toContain("backfill: 2 session(s), 7 ingested");
    expect(result.text).toContain("recall: 1 (hit 1)");
    expect(result.text).toContain("retrieval: 1 (answered 1)");
    expect(result.text).toContain("last pass: nothing (span covered)");
  });

  it("backup writes a timestamped copy of the calling session sidecar", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("bak-1"), { meta: { cwd: dir } });
    const store = seedStore(dir, "bak-1", ["backup hello"]);
    const target = join(dir, "manual-backup.sqlite");
    const result = await invoke(
      ctx,
      depsFor(dir, new Map([["bak-1", store]])),
      "bak-1",
      `backup ${target}`,
    );
    expect(result.kind).toBe("success");
    expect(result.text).toContain("LCM backup written:");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("export writes JSONL with 0600 mode", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("exp-1"), { meta: { cwd: dir } });
    const store = seedStore(dir, "exp-1", ["export one", "export two"]);
    const target = join(dir, "out.jsonl");
    const result = await invoke(
      ctx,
      depsFor(dir, new Map([["exp-1", store]])),
      "exp-1",
      `export ${target}`,
    );
    expect(result.kind).toBe("success");
    expect(result.text).toContain("LCM export: 2 messages + 0 summaries");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const lines = readFileSync(target, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const row = JSON.parse(line) as { rowType?: string };
      expect(row.rowType).toBe("message");
    }
  });

  it("diagnose redacts secret material from the bundle", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("diag-1"), { meta: { cwd: dir } });
    const store = seedStore(dir, "diag-1", ["diagnose hello"]);
    const secret = `sk-ant-${"A".repeat(20)}`;
    createRecord(dir)({ kind: "pass", session: "diag-1", outcome: "failed", error: secret });
    const result = await invoke(
      ctx,
      depsFor(dir, new Map([["diag-1", store]])),
      "diag-1",
      "diagnose",
    );
    expect(result.kind).toBe("success");
    expect(result.text).toContain("LCM diagnose bundle:");
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain("[REDACTED]");
  });

  it("diagnose names the calling provider and model", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("diag-model"), { meta: { cwd: dir } });
    const store = seedStore(dir, "diag-model", ["diagnose model hello"]);
    const result = await invoke(
      ctx,
      depsFor(dir, new Map([["diag-model", store]])),
      "diag-model",
      "diagnose",
    );
    expect(result.kind).toBe("success");
    expect(result.text).toContain("test-provider/test-model");
  });

  it("report caps the rows it reads", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("cap-1"), { meta: { cwd: dir } });
    const record = createRecord(dir);
    for (let i = 0; i < 650; i += 1) {
      record({ kind: "pass", session: "cap-1", outcome: "stored", leaf: 1, condensed: 0, seq: i });
    }
    const result = await invoke(ctx, depsFor(dir, new Map()), "cap-1", "report");
    expect(result.kind).toBe("success");
    expect(result.text).toContain("500 row(s) for session cap-1");
    expect(result.text).not.toContain("650 row(s)");
  });

  it("diagnose --save writes the bundle to a file", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("diag-2"), { meta: { cwd: dir } });
    const store = seedStore(dir, "diag-2", ["diagnose save hello"]);
    const target = join(dir, "diag.txt");
    const deps = depsFor(dir, new Map([["diag-2", store]]));
    const missing = await invoke(ctx, deps, "diag-2", "diagnose --save");
    expect(missing.kind).toBe("error");
    expect(missing.text).toContain("name the file to write");
    const result = await invoke(ctx, deps, "diag-2", `diagnose --save ${target}`);
    expect(result.kind).toBe("success");
    expect(result.text).toContain("mode 0600");
    expect(readFileSync(target, "utf8")).toContain("LCM diagnose bundle:");
  });
});

describe("lcm dump verb", () => {
  it("dump prints the calling session sidecar and answers a free-text query", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("dump-1"), { meta: { cwd: dir } });
    const store = seedStore(dir, "dump-1", ["dump hello world"]);
    const result = await invoke(
      ctx,
      depsFor(dir, new Map([["dump-1", store]])),
      "dump-1",
      "dump hello",
    );
    expect(result.kind).toBe("success");
    expect(result.text).toContain("LCM sidecar dump: dump-1");
    expect(result.text).toContain("dump hello world");
  });

  it("dump --save writes the dump to a file with 0600 mode", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("dump-2"), { meta: { cwd: dir } });
    const store = seedStore(dir, "dump-2", ["dump save hello"]);
    const target = join(dir, "dump-out.txt");
    const deps = depsFor(dir, new Map([["dump-2", store]]));
    const result = await invoke(ctx, deps, "dump-2", `dump --save ${target}`);
    expect(result.kind).toBe("success");
    expect(result.text).toContain("mode 0600");
    expect(result.text).toContain(target);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toContain("LCM sidecar dump: dump-2");
  });

  it("dump --save without a path errors", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("dump-3"), { meta: { cwd: dir } });
    const store = seedStore(dir, "dump-3", ["dump missing hello"]);
    const deps = depsFor(dir, new Map([["dump-3", store]]));
    const result = await invoke(ctx, deps, "dump-3", "dump --save");
    expect(result.kind).toBe("error");
    expect(result.text).toContain("name the file to write");
  });

  it("dump --include-removed surfaces removed rows the default dump hides", async () => {
    const { ctx } = setupContext(ROUTE, []);
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("dump-4"), { meta: { cwd: dir } });
    const store = seedStore(dir, "dump-4", ["dump keeper alpha", "dump hidden beta"]);
    store.setRemoved(["e01"], Date.now());
    const deps = depsFor(dir, new Map([["dump-4", store]]));
    const plain = await invoke(ctx, deps, "dump-4", "dump beta");
    expect(plain.kind).toBe("success");
    expect(plain.text).not.toContain("dump hidden beta");
    const kept = await invoke(ctx, deps, "dump-4", "dump beta --include-removed");
    expect(kept.kind).toBe("success");
    expect(kept.text).toContain("dump hidden beta");
  });
});

describe("lcm command shape", () => {
  it("claims spaced verbs through an input hint and keeps bare dispatch on status", async () => {
    const { ctx } = setupContext(ROUTE, [], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const dir = tempDir();
    ctx.sessions.create(SessionId("shape-1"), { meta: { cwd: dir } });
    const store = seedStore(dir, "shape-1", ["shape hello"]);
    const deps = depsFor(dir, new Map([["shape-1", store]]));
    const definition = lcmCommandDefinition(ctx, deps);
    expect(definition.name).toBe("lcm");
    expect(definition.input?.hint).toBe(
      "[status|report|dump|backup|export|import|gc|migrate|heal|diagnose|compact] ...",
    );
    const disposeCommand = ctx.commands.register(definition);
    try {
      const bare = await invoke(ctx, deps, "shape-1", "");
      expect(bare.kind).toBe("success");
      expect(bare.text).toContain("shape-1");
      const spaced = await invoke(ctx, deps, "shape-1", " status");
      expect(spaced.kind).toBe("success");
      expect(spaced.text).toContain("shape-1");
      const dump = await invoke(ctx, deps, "shape-1", " dump hello");
      expect(dump.kind).toBe("success");
      expect(dump.text).toContain("shape hello");
    } finally {
      disposeCommand();
    }
  });
});
