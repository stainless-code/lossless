import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ingestEntries, LcmStore, type AlignedEntry } from "lossless-core";
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

function seeded(): { store: LcmStore; path: string; entries: AlignedEntry[] } {
  const path = sidecarPath();
  const store = new LcmStore(path);
  ingestEntries(store, [
    {
      entryId: `${SESSION}:prompt:msg_1`,
      role: "user",
      text: LONG_USER,
      timestamp: 1,
    },
    {
      entryId: `${SESSION}:text:msg_2:0`,
      role: "assistant",
      text: LONG_ASSISTANT,
      timestamp: 2,
    },
  ]);
  return {
    store,
    path,
    entries: [
      { entryId: `${SESSION}:prompt:msg_1`, role: "user", text: LONG_USER },
      { entryId: `${SESSION}:text:msg_2:0`, role: "assistant", text: LONG_ASSISTANT },
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

  it("abandons the run when the model fails and stores nothing", async () => {
    const { store, path, entries } = seeded();
    try {
      const ctx = ctxWith({
        text: () => Promise.reject(new Error("provider down")),
      });
      await expect(
        runLosslessPass({ store: () => store, ctx, model: MODEL }, SESSION, entries, {
          targetTokens: 200,
        }),
      ).rejects.toThrow(/summarizer did not answer/);
      expect(countRows(path, "status = 'pending'")).toBe(0);
      expect(countRows(path, "status = 'committed'")).toBe(0);
      expect(store.stats().summaries).toBe(0);
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
