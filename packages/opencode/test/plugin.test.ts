import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  LcmStore,
  SUMMARIZER_CALL_TOKENS,
  SUMMARIZER_PASS_TOKENS,
  ingestEntries,
} from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { statusCommand } from "../src/command.ts";
import type { SessionCompactionEvent } from "../src/host.ts";
import { PLUGIN_ID, readOptions, setupOpencodeLossless } from "../src/plugin.ts";
import { SUMMARIZER_HEAL_TOKENS } from "../src/summarizer.ts";
import { fakeHost, tick } from "./support/opencode-fake.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-plugin-"));
}

/** The prepared compaction request the hook receives. Only `sessionID` and
 * `messages` matter to the mirror; the rest is the context slice every request
 * carries. */
function compactionEvent(sessionID: string, messages: unknown[]): SessionCompactionEvent {
  return {
    sessionID,
    model: { providerID: "test", id: "model" },
    system: [],
    messages,
    options: {},
    agent: "build",
    tools: {},
  };
}

function messageTexts(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("SELECT text FROM messages ORDER BY rowid").all() as Array<{
      text: string;
    }>;
    return rows.map((row) => row.text);
  } finally {
    db.close();
  }
}

function seedTruncatedSummary(dir: string, sessionID: string, text: string): void {
  const store = new LcmStore(join(dir, `${sessionID}.sqlite`));
  try {
    const entryId = `${sessionID}:prompt:msg_1`;
    ingestEntries(store, [{ entryId, role: "user", text, timestamp: 1 }]);
    const message = store.messageByEntryId(entryId);
    if (message === undefined) throw new Error(`missing seeded message ${entryId}`);
    store.insertSummary({
      kind: "leaf",
      text: "[lcm:truncated]\nmechanical",
      tokens: 5,
      depth: 0,
      firstEntryId: entryId,
      lastEntryId: entryId,
      messageIds: [message.id],
    });
  } finally {
    store.close();
  }
}

function summaryText(dir: string, sessionID: string): string | undefined {
  const store = new LcmStore(join(dir, `${sessionID}.sqlite`));
  try {
    return store.allSummaries()[0]?.text;
  } finally {
    store.close();
  }
}

describe("setupOpencodeLossless", () => {
  it("registers nothing until enabled", async () => {
    const host = fakeHost({ enabled: false });
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    expect(host.sessionHooks.prompt).toBeUndefined();
    expect(host.sessionHooks.compaction).toBeUndefined();
    expect(host.tools.length).toBe(0);
    expect(host.commands.length).toBe(0);
    await cleanup();
  });

  it("resolves the summarizer budgets and keeps the default on an invalid value", () => {
    const configured = readOptions({
      summarizerTokensPerCall: 1234,
      summarizerTokensPerPass: 5678,
      summarizerTokensPerHeal: 9012,
    });
    expect([
      configured.summarizerTokensPerCall,
      configured.summarizerTokensPerPass,
      configured.summarizerTokensPerHeal,
    ]).toEqual([1234, 5678, 9012]);

    for (const raw of [
      { summarizerTokensPerCall: 0, summarizerTokensPerPass: -1, summarizerTokensPerHeal: 0 },
      { summarizerTokensPerCall: -5, summarizerTokensPerPass: "many", summarizerTokensPerHeal: -3 },
      { summarizerTokensPerCall: 1.5, summarizerTokensPerPass: 2.5, summarizerTokensPerHeal: 1.5 },
    ]) {
      const options = readOptions(raw);
      expect([
        options.summarizerTokensPerCall,
        options.summarizerTokensPerPass,
        options.summarizerTokensPerHeal,
      ]).toEqual([SUMMARIZER_CALL_TOKENS, SUMMARIZER_PASS_TOKENS, SUMMARIZER_HEAL_TOKENS]);
    }
  });

  it("resolves healSourceTokens and ignores an override above the hard cap", () => {
    expect(readOptions({ healSourceTokens: 18_000 }).healSourceTokens).toBe(18_000);
    for (const raw of [0, -1, 1.5, 24_001, "many"]) {
      expect(readOptions({ healSourceTokens: raw }).healSourceTokens).toBeUndefined();
    }
  });

  it("mounts the mirror, the recall tools, and the status command", async () => {
    const host = fakeHost({ sidecarDir: tempDir(), assembly: false });
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    expect(host.sessionHooks.prompt).toBeDefined();
    expect(host.sessionHooks.compaction).toBeDefined();
    expect(host.sessionHooks.context).toBeUndefined();
    expect(host.toolHooks["execute.after"]).toBeDefined();
    expect(host.tools.map((tool) => tool.name).sort()).toEqual([
      "lcm_describe",
      "lcm_expand",
      "lcm_grep",
    ]);
    expect(host.commands.map((command) => command.name)).toEqual([
      "lossless-status",
      "lossless-report",
      "lossless-backup",
      "lossless-export",
      "lossless-import",
      "lossless-diagnose",
      "lossless-migrate",
      "lossless-gc",
      "lossless-heal",
    ]);
    await cleanup();
    expect(host.disposals.length).toBe(6);
  });

  it("mirrors a prompt, assistant text, and tool traffic into the sidecar", async () => {
    const dir = tempDir();
    const host = fakeHost({ sidecarDir: dir });
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);

    host.sessionHooks.prompt?.({
      sessionID: "ses_1",
      messageID: "msg_1",
      prompt: { text: "chart the northern passage" },
    });
    host.toolHooks["execute.after"]?.({
      tool: "read",
      sessionID: "ses_1",
      messageID: "msg_2",
      id: "call_1",
      input: { path: "chart.ts" },
      status: "completed",
      result: { content: "shoals ahead" },
    });
    host.events.push({
      type: "session.text.ended",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_3",
        ordinal: 0,
        text: "passage charted",
      },
    });
    await tick();
    await tick();
    await cleanup();

    const texts = messageTexts(join(dir, "ses_1.sqlite"));
    expect(texts.some((text) => text.includes("northern passage"))).toBe(true);
    expect(texts.some((text) => text.includes("shoals ahead"))).toBe(true);
    expect(texts.some((text) => text.includes("passage charted"))).toBe(true);
  });

  it("marks a compaction and stores its summary", async () => {
    const dir = tempDir();
    const host = fakeHost({ sidecarDir: dir });
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);

    await host.sessionHooks.compaction?.(
      compactionEvent("ses_2", [
        { role: "user", content: [] },
        { role: "assistant", content: [] },
      ]),
    );
    host.events.push({
      id: "evt_1",
      type: "session.compaction.ended",
      data: {
        sessionID: "ses_2",
        reason: "auto",
        text: "the passage plan",
      },
    });
    await tick();
    await tick();
    await cleanup();

    const texts = messageTexts(join(dir, "ses_2.sqlite"));
    expect(texts.some((text) => text.includes("compaction checkpoint"))).toBe(true);
    expect(texts.some((text) => text.includes("the passage plan"))).toBe(true);
  });

  it("keeps compaction ids distinct across a plugin reload", async () => {
    const dir = tempDir();
    const sidecar = join(dir, "ses_3.sqlite");

    const first = fakeHost({ sidecarDir: dir });
    const firstCleanup = await setupOpencodeLossless(first.ctx, first.options);
    await first.sessionHooks.compaction?.(
      compactionEvent("ses_3", [{ role: "user", content: [] }]),
    );
    first.events.push({
      id: "evt_1",
      type: "session.compaction.ended",
      data: { sessionID: "ses_3", reason: "manual", text: "first summary" },
    });
    await tick();
    await tick();
    await firstCleanup();

    // A reload builds fresh setup state. The second compaction must land on
    // new ids, or ingest skips both rows and the summary becomes unsearchable.
    const second = fakeHost({ sidecarDir: dir });
    const secondCleanup = await setupOpencodeLossless(second.ctx, second.options);
    await second.sessionHooks.compaction?.(
      compactionEvent("ses_3", [{ role: "assistant", content: [] }]),
    );
    second.events.push({
      id: "evt_2",
      type: "session.compaction.ended",
      data: { sessionID: "ses_3", reason: "manual", text: "second summary" },
    });
    await tick();
    await tick();
    await secondCleanup();

    const db = new DatabaseSync(sidecar);
    let ids: string[];
    try {
      const rows = db
        .prepare(
          "SELECT entry_id FROM messages WHERE entry_id LIKE '%:compaction:%' OR entry_id LIKE '%:summary:%' ORDER BY rowid",
        )
        .all() as Array<{ entry_id: string }>;
      ids = rows.map((row) => row.entry_id);
    } finally {
      db.close();
    }
    expect(ids.filter((id) => id.includes(":compaction:"))).toHaveLength(2);
    expect(ids.filter((id) => id.includes(":summary:"))).toHaveLength(2);
    expect(new Set(ids).size).toBe(4);
  });

  it("registers neither the projection nor the pass command while assembly is off", async () => {
    const host = fakeHost({ sidecarDir: tempDir(), assembly: false });
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    expect(host.sessionHooks.context).toBeUndefined();
    expect(host.commands.map((command) => command.name)).toEqual([
      "lossless-status",
      "lossless-report",
      "lossless-backup",
      "lossless-export",
      "lossless-import",
      "lossless-diagnose",
      "lossless-migrate",
      "lossless-gc",
      "lossless-heal",
    ]);
    await cleanup();
  });

  it("registers the projection and the pass command when assembly is on", async () => {
    const host = fakeHost({ sidecarDir: tempDir(), assembly: true });
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    expect(host.sessionHooks.context).toBeDefined();
    expect(host.commands.map((command) => command.name)).toEqual([
      "lossless-status",
      "lossless-report",
      "lossless-backup",
      "lossless-export",
      "lossless-import",
      "lossless-diagnose",
      "lossless-migrate",
      "lossless-gc",
      "lossless-heal",
      "lossless-pass",
    ]);
    await cleanup();
  });

  it("turns assembly on by default", async () => {
    const host = fakeHost({ sidecarDir: tempDir() });
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    expect(host.sessionHooks.context).toBeDefined();
    expect(host.tools.map((tool) => tool.name)).toContain("lcm_expand_query");
    expect(host.commands.map((command) => command.name)).toContain("lossless-pass");
    await cleanup();
  });

  it("reports an empty history from the pass command without calling a model", async () => {
    const host = fakeHost({ sidecarDir: tempDir(), assembly: true });
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    const command = host.commands.find((candidate) => candidate.name === "lossless-pass");
    await command?.execute({
      sessionID: "ses_1",
      prompt: { text: "" },
      delivery: "steer",
    } as never);
    expect(host.prompts).toEqual([
      {
        sessionID: "ses_1",
        text: "LCM pass: nothing stored (no-entries); 0 messages ingested.",
      },
    ]);
    await cleanup();
  });

  it("reports heal candidates in a dry run without a provider call", async () => {
    const dir = tempDir();
    const sessionID = "ses_heal_dry";
    seedTruncatedSummary(dir, sessionID, `SOURCE-0 ${"z".repeat(700)}`);
    let calls = 0;
    const host = fakeHost(
      { sidecarDir: dir },
      {
        generate: {
          text: async () => {
            calls++;
            return { text: "healed leaf" };
          },
        },
        history: [{ id: "m1", type: "assistant", model: { providerID: "test", id: "model" } }],
      },
    );
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    try {
      const command = host.commands.find((candidate) => candidate.name === "lossless-heal");
      expect(command).toBeDefined();
      await command?.execute({
        sessionID,
        prompt: { text: "/lossless-heal" },
        delivery: "steer",
      } as never);
      expect(calls).toBe(0);
      expect(host.prompts).toEqual([
        {
          sessionID,
          text: "LCM heal dry-run: 1 candidate(s), 1 tainted, 12000 source tokens; run `/lossless-heal --apply` to repair.",
        },
      ]);
    } finally {
      await cleanup();
    }
    expect(summaryText(dir, sessionID)).toBe("[lcm:truncated]\nmechanical");
  });

  it("repairs a truncated summary with --apply through the session model", async () => {
    const dir = tempDir();
    const sessionID = "ses_heal_apply";
    seedTruncatedSummary(dir, sessionID, `SOURCE-0 ${"z".repeat(700)}`);
    const prompts: string[] = [];
    let calls = 0;
    const host = fakeHost(
      {
        sidecarDir: dir,
        summarizerTokensPerPass: 1,
        summarizerTokensPerHeal: 50_000,
      },
      {
        generate: {
          text: async (input) => {
            calls++;
            prompts.push(input.prompt);
            return { text: "healed leaf" };
          },
        },
        history: [{ id: "m1", type: "assistant", model: { providerID: "test", id: "model" } }],
      },
    );
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    try {
      const command = host.commands.find((candidate) => candidate.name === "lossless-heal");
      expect(command).toBeDefined();
      await command?.execute({
        sessionID,
        prompt: { text: "/lossless-heal --apply --max-nodes 1" },
        delivery: "steer",
      } as never);
      expect(calls).toBe(1);
      expect(prompts[0]).toContain("SOURCE-0");
      expect(host.prompts).toEqual([
        {
          sessionID,
          text: "LCM heal: repaired 1 clean, improved 0, failed 0, blocked 0, remaining 0; 1 model call(s).",
        },
      ]);
    } finally {
      await cleanup();
    }
    expect(summaryText(dir, sessionID)).toBe("healed leaf");
  });

  it("answers the status command through a session prompt", async () => {
    const dir = tempDir();
    const host = fakeHost({ sidecarDir: dir });
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    const command = statusCommand({
      lines: () => ["ses_1: 3 messages, 0 summaries (sidecar)"],
      prompt: (sessionID, text) => {
        host.prompts.push({ sessionID, text });
        return Promise.resolve(undefined);
      },
    });
    await command.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" });
    expect(host.prompts.length).toBe(1);
    await cleanup();
    expect(PLUGIN_ID).toBe("opencode-lossless");
  });
});
