import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { statusCommand } from "../src/command.ts";
import type { SessionCompactionEvent } from "../src/host.ts";
import { PLUGIN_ID, setupOpencodeLossless } from "../src/plugin.ts";
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
