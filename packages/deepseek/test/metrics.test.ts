import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LcmStore, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { MessageIndex } from "../src/ingest.ts";
import { runLadder } from "../src/ladder.ts";
import { createRecord, metricsPath, readMetricRows } from "../src/metrics.ts";
import { dshRef } from "../src/model-host.ts";
import type { DshRoute } from "../src/model-host.ts";
import { dshReader } from "../src/reader.ts";
import { expandQueryAnswer } from "../src/tools.ts";
import { setupContext, textChunks, toolCallChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };
const SUMMARY = "Checkpoint: metrics slice writes its rows beside the sidecar.";
const identity = (text: string): string => text;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deepseek-metrics-"));
}

function seedStore(): LcmStore {
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    Array.from({ length: 8 }, (_, i) => ({
      entryId: `e${String(i).padStart(2, "0")}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `message ${i}: deciding the ${i % 2 === 0 ? "compaction engine" : "recall pipeline"} rollout ${"detail ".repeat(20)}`,
      timestamp: i,
    })),
  );
  return store;
}

describe("metrics sink", () => {
  it("appends valid JSONL lines with 0600 mode", () => {
    const dir = tempDir();
    const record = createRecord(dir);
    record({ event: "lcm", kind: "pass", session: "s1", outcome: "stored", leaf: 1, condensed: 1 });
    record({ event: "lcm", kind: "retrieval", session: "s1", stop: "answered" });

    const path = metricsPath(dir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const rows = readMetricRows(dir).map((row) => row as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "pass", outcome: "stored" });
    expect(typeof rows[0]?.ts).toBe("number");
    expect(rows[1]).toMatchObject({ kind: "retrieval", stop: "answered" });
  });

  it("emits exactly one run row per ladder run with the stored outcome", async () => {
    const store = new LcmStore(":memory:");
    const rows: Record<string, unknown>[] = [];
    const { ctx } = setupContext(ROUTE, [
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
      textChunks(SUMMARY),
    ]);
    const outcome = await runLadder(
      ctx,
      {
        store: () => store,
        index: () => new MessageIndex(),
        redact: identity,
        record: (row) => rows.push(row),
      },
      ROUTE,
      "metrics-ladder-1",
      [
        { entryId: "ladder:e1", role: "user", text: `ladder notes ${"detail ".repeat(60)}` },
        { entryId: "ladder:e2", role: "assistant", text: `ladder reply ${"detail ".repeat(60)}` },
      ],
    );
    expect(outcome.leafSummaryIds.length).toBeGreaterThan(0);
    const passRows = rows.filter((row) => row.kind === "pass");
    expect(passRows).toHaveLength(1);
    expect(passRows[0]).toMatchObject({
      event: "lcm",
      session: "metrics-ladder-1",
      outcome: "stored",
      leaf: outcome.leafSummaryIds.length,
      condensed: outcome.condensedSummaryIds.length,
    });
    const usage = passRows[0]?.usage as { inputTokens?: number } | undefined;
    expect(usage?.inputTokens).toBeGreaterThan(0);
  });

  it("records a recall call through the wired recorder", async () => {
    const dir = tempDir();
    const store = seedStore();
    const { ctx } = setupContext(ROUTE, [
      toolCallChunks("call-1", "lcm_grep", { query: "recall pipeline rollout" }),
      textChunks("The recall pipeline rollout was approved for next week [e01]."),
    ]);
    const answer = await expandQueryAnswer(
      store,
      identity,
      dshReader(ctx, { ref: dshRef(ROUTE) }),
      "session-1",
      {
        query: "recall pipeline rollout",
        prompt: "What did we decide about the recall pipeline rollout?",
      },
      createRecord(dir),
    );
    expect(answer).toContain("<recovered_findings>");
    const rows = readMetricRows(dir).map((row) => row as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "lcm",
      kind: "retrieval",
      session: "session-1",
      stop: "answered",
    });
  });
});
