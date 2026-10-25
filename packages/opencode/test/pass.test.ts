import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ingestEntries, LcmStore, metricsPath, type AlignedEntry } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { GenerateText, ModelDomain, OpencodeContext } from "../src/host.ts";
import { runLosslessPass } from "../src/pass.ts";
import { fakeHost } from "./support/opencode-fake.ts";

const SESSION = "ses_pass";
const MODEL = { providerID: "test", id: "model" } as const;

const LONG_USER = "the northern passage needs a chart. ".repeat(80);
const LONG_ASSISTANT = "the chart shows shoals between the islands. ".repeat(80);

function sidecarPath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-lossless-pass-")), "sidecar.sqlite");
}

function seeded(session: string = SESSION): {
  store: LcmStore;
  path: string;
  entries: AlignedEntry[];
} {
  const path = sidecarPath();
  const store = new LcmStore(path);
  ingestEntries(store, [
    {
      entryId: `${session}:prompt:msg_1`,
      role: "user",
      text: LONG_USER,
      timestamp: 1,
    },
    {
      entryId: `${session}:text:msg_2:0`,
      role: "assistant",
      text: LONG_ASSISTANT,
      timestamp: 2,
    },
  ]);
  return {
    store,
    path,
    entries: [
      { entryId: `${session}:prompt:msg_1`, role: "user", text: LONG_USER },
      { entryId: `${session}:text:msg_2:0`, role: "assistant", text: LONG_ASSISTANT },
    ],
  };
}

function ctxWith(generate: GenerateText, model?: ModelDomain): OpencodeContext {
  const fake = fakeHost({ sidecarDir: tempDir() });
  return { ...fake.ctx, generate, ...(model === undefined ? {} : { model }) };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-pass-ctx-"));
}

function countRows(path: string, where: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM summaries WHERE ${where}`).get() as {
      c: number;
    };
    return Number(row.c);
  } finally {
    db.close();
  }
}

function coreLogMark(): number {
  try {
    return readFileSync(metricsPath(), "utf8").length;
  } catch {
    return 0;
  }
}

function coreRowsForSince(mark: number, session: string): Array<Record<string, unknown>> {
  let raw = "";
  try {
    raw = readFileSync(metricsPath(), "utf8").slice(mark).trim();
  } catch {
    return [];
  }
  if (raw.length === 0) return [];
  return raw
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.session === session);
}

describe("runLosslessPass", () => {
  it("stores a leaf summary and reports the model answer", async () => {
    const { store, path, entries } = seeded();
    try {
      const ctx = ctxWith({ text: () => Promise.resolve({ text: "a terse summary" }) });
      const outcome = await runLosslessPass(
        { store: () => store, ctx, model: MODEL },
        SESSION,
        entries,
        { targetTokens: 200, summarizer: { summarizer: "auto" } },
      );
      expect(outcome.kind).toBe("stored");
      if (outcome.kind !== "stored") return;
      expect(outcome.leafSummaryIds).toHaveLength(1);
      expect(outcome.condensedSummaryIds).toHaveLength(0);
      expect(outcome.summaryText).toContain("a terse summary");
      expect(store.stats().summaries).toBe(1);
      expect(countRows(path, "status = 'committed'")).toBe(1);
      expect(countRows(path, "status = 'pending'")).toBe(0);
    } finally {
      store.close();
    }
  });

  it("routes every pass row through deps.record and never the core log", async () => {
    const session = "ses_pass_sink";
    const { store, entries } = seeded(session);
    try {
      const rows: Array<Record<string, unknown>> = [];
      const mark = coreLogMark();
      const outcome = await runLosslessPass(
        {
          store: () => store,
          ctx: ctxWith({ text: () => Promise.resolve({ text: "a terse summary" }) }),
          model: MODEL,
          record: (row) => rows.push(row),
        },
        session,
        entries,
        { targetTokens: 200, stage: "direct" },
      );
      expect(outcome.kind).toBe("stored");
      for (const kind of ["summary-stored", "summarizer-usage", "compaction-complete", "pass"]) {
        expect(rows.some((row) => row.kind === kind)).toBe(true);
      }
      expect(rows.every((row) => row.session === session)).toBe(true);
      expect(coreRowsForSince(mark, session)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("labels completer and engine rows with the direct stage", async () => {
    const session = "ses_pass_direct";
    const { store, entries } = seeded(session);
    try {
      const rows: Array<Record<string, unknown>> = [];
      const outcome = await runLosslessPass(
        {
          store: () => store,
          ctx: ctxWith({ text: () => Promise.resolve({ text: "x".repeat(2000) }) }),
          model: MODEL,
          record: (row) => rows.push(row),
        },
        session,
        entries,
        { targetTokens: 10, stage: "direct" },
      );
      expect(outcome.kind).toBe("stored");
      const usage = rows.filter((row) => row.kind === "summarizer-usage");
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.map((row) => row.stage)).toEqual(usage.map(() => "direct"));
      expect(usage.every((row) => row.estimated === true)).toBe(true);
      const truncated = rows.filter((row) => row.kind === "summary-final-truncated");
      expect(truncated).toHaveLength(1);
      expect(truncated[0]?.stage).toBe("direct");
      expect(rows.filter((row) => row.stage === "blocking")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("passes the per-call budget into the completer and records the cap", async () => {
    const session = "ses_pass_budget";
    const { store, entries } = seeded(session);
    try {
      const rows: Array<Record<string, unknown>> = [];
      await expect(
        runLosslessPass(
          {
            store: () => store,
            ctx: ctxWith({ text: () => Promise.resolve({ text: "unused" }) }),
            model: MODEL,
            record: (row) => rows.push(row),
          },
          session,
          entries,
          {
            targetTokens: 200,
            stage: "direct",
            summarizer: { summarizerTokensPerCall: 1 },
          },
        ),
      ).rejects.toThrow(/summarizer did not answer/);
      expect(rows.find((row) => row.kind === "summarizer-capped")).toMatchObject({
        session,
        stage: "direct",
        source: "budget",
        reason: "call",
        budgetTokens: 1,
      });
      expect(rows.filter((row) => row.kind === "summarizer-usage")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("abandons the run when the model fails and stores nothing", async () => {
    const { store, path, entries } = seeded();
    try {
      const rows: Array<Record<string, unknown>> = [];
      const ctx = ctxWith({
        text: () => Promise.reject(new Error("provider down")),
      });
      await expect(
        runLosslessPass(
          { store: () => store, ctx, model: MODEL, record: (row) => rows.push(row) },
          SESSION,
          entries,
          { targetTokens: 200 },
        ),
      ).rejects.toThrow(/summarizer did not answer/);
      expect(countRows(path, "status = 'pending'")).toBe(0);
      expect(countRows(path, "status = 'committed'")).toBe(0);
      expect(store.stats().summaries).toBe(0);
      expect(rows.find((row) => row.kind === "compaction-abandoned")).toMatchObject({
        session: SESSION,
        stage: "blocking",
        dropped: 1,
      });
    } finally {
      store.close();
    }
  });

  it("forwards mechanicalTools so a listed tool skips the model", async () => {
    const session = "ses_pass_mechanical";
    const path = sidecarPath();
    const store = new LcmStore(path);
    try {
      const prose = `decide the plan ${"x".repeat(400)}`;
      const entries: AlignedEntry[] = [
        { entryId: `${session}:prompt:msg_1`, role: "user", text: prose },
        {
          entryId: `${session}:tool:msg_2:call_1`,
          role: "toolResult",
          text: `tool noisy-read {"path":"/a"}\n${"z".repeat(3000)}`,
        },
      ];
      const prompts: string[] = [];
      const ctx = ctxWith({
        text: async (input: { prompt: string }) => {
          prompts.push(input.prompt);
          return { text: "prose summary" };
        },
      });
      const outcome = await runLosslessPass(
        { store: () => store, ctx, model: MODEL },
        session,
        entries,
        { targetTokens: 1500, summarizer: { mechanicalTools: ["noisy-read"] } },
      );
      expect(outcome.kind).toBe("stored");
      if (outcome.kind !== "stored") return;
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("decide the plan");
      expect(prompts[0]).not.toContain("noisy-read");
      const leaves = outcome.leafSummaryIds.map((id) => store.getSummary(id)!);
      expect(leaves).toHaveLength(2);
      expect(leaves.map((leaf) => leaf.quality).sort()).toEqual(["clean", "mechanical"]);
    } finally {
      store.close();
    }
  });

  it("commits a mechanical-only span without a model answer", async () => {
    const session = "ses_pass_mechanical_only";
    const path = sidecarPath();
    const store = new LcmStore(path);
    try {
      const entries: AlignedEntry[] = [
        {
          entryId: `${session}:tool:msg_1:call_1`,
          role: "toolResult",
          text: `tool noisy-read {"path":"/a"}\n${"z".repeat(2000)}`,
        },
        {
          entryId: `${session}:tool:msg_2:call_2`,
          role: "toolResult",
          text: `tool noisy-read {"path":"/b"}\n${"z".repeat(2000)}`,
        },
      ];
      const ctx = ctxWith({
        text: () => Promise.reject(new Error("model must not be called")),
      });
      const outcome = await runLosslessPass(
        { store: () => store, ctx, model: MODEL },
        session,
        entries,
        { targetTokens: 1500, summarizer: { mechanicalTools: ["noisy-read"] } },
      );
      expect(outcome.kind).toBe("stored");
      if (outcome.kind !== "stored") return;
      expect(outcome.leafSummaryIds.length).toBeGreaterThan(0);
      expect(outcome.mechanicalLeaves).toBe(outcome.leafSummaryIds.length);
      expect(outcome.mechanicalCondensed ?? 0).toBe(outcome.condensedSummaryIds.length);
      for (const id of outcome.leafSummaryIds) {
        expect(store.getSummary(id)?.quality).toBe("mechanical");
      }
      expect(countRows(path, "status = 'committed'")).toBeGreaterThan(0);
      expect(countRows(path, "status = 'pending'")).toBe(0);
    } finally {
      store.close();
    }
  });

  it("still throws when a prose span fails with mechanicalTools configured", async () => {
    const session = "ses_pass_mechanical_prose_fail";
    const { store, path, entries } = seeded(session);
    try {
      const ctx = ctxWith({ text: () => Promise.reject(new Error("provider down")) });
      await expect(
        runLosslessPass({ store: () => store, ctx, model: MODEL }, session, entries, {
          targetTokens: 200,
          summarizer: { mechanicalTools: ["noisy-read"] },
        }),
      ).rejects.toThrow(/summarizer did not answer/);
      expect(countRows(path, "status = 'committed'")).toBe(0);
      expect(countRows(path, "status = 'pending'")).toBe(0);
    } finally {
      store.close();
    }
  });

  it("returns a no-entries outcome without opening a run", async () => {
    const { store } = seeded();
    try {
      const outcome = await runLosslessPass(
        {
          store: () => store,
          ctx: ctxWith({ text: () => Promise.resolve({ text: "unused" }) }),
          model: MODEL,
        },
        SESSION,
        [],
        {},
      );
      expect(outcome).toEqual({ kind: "nothing", reason: "no-entries", ingested: 0 });
    } finally {
      store.close();
    }
  });
});
