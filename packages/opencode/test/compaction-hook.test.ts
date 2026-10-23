import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LcmStore, cutIndexFor, ingestEntries, normalizeRole } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { SessionCompactionEvent, SessionMessageInfo } from "../src/host.ts";
import { storedEntries } from "../src/map.ts";
import { setupOpencodeLossless } from "../src/plugin.ts";
import { fakeHost, type FakeHost } from "./support/opencode-fake.ts";

const SESSION = "ses_compaction_hook";
const MODEL = { providerID: "test", id: "model" } as const;
const CONTEXT_WINDOW = 1000;

const USER_1 = "the first request asks about the northern passage. ".repeat(24);
const ASSISTANT_1 = "the first answer charts the shoals. ".repeat(24);
const USER_2 = "the second request asks about the southern route. ".repeat(24);
const ASSISTANT_2 = "the second answer names the southern harbor. ".repeat(24);

const HISTORY: SessionMessageInfo[] = [
  { id: "msg_u1", type: "user", text: USER_1 },
  {
    id: "msg_a1",
    type: "assistant",
    content: [{ type: "text", text: ASSISTANT_1 }],
    tokens: { input: 500, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  { id: "msg_u2", type: "user", text: USER_2 },
  {
    id: "msg_a2",
    type: "assistant",
    content: [{ type: "text", text: ASSISTANT_2 }],
    tokens: { input: 700, output: 10, reasoning: 0, cache: { read: 100, write: 0 } },
  },
];

/** The prepared request the host would hand the hook: the full transcript, as
 * `toLLMMessages` builds it. */
function transcript(): unknown[] {
  return [
    { id: "msg_u1", role: "user", content: [{ type: "text", text: USER_1 }] },
    { id: "msg_a1", role: "assistant", content: [{ type: "text", text: ASSISTANT_1 }] },
    { id: "msg_u2", role: "user", content: [{ type: "text", text: USER_2 }] },
    { id: "msg_a2", role: "assistant", content: [{ type: "text", text: ASSISTANT_2 }] },
  ];
}

function event(messages: unknown[]): SessionCompactionEvent {
  return {
    sessionID: SESSION,
    model: MODEL,
    system: [],
    messages,
    options: {},
    agent: "build",
    tools: {},
  };
}

function sidecarPath(dir: string): string {
  return join(dir, `${SESSION}.sqlite`);
}

function keepFor(wanted: number): number {
  const wrapped = storedEntries(SESSION, HISTORY).entries.map((entry) => ({
    role: entry.role,
    content: entry.text,
  }));
  for (let keep = 1; keep <= 20_000; keep++) {
    if (cutIndexFor(wrapped, keep) === wanted) return keep;
  }
  throw new Error(`no keep budget cuts at ${wanted} entries`);
}

function committedSummaries(path: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM summaries WHERE status = 'committed'")
      .get() as { count: number };
    return Number(row.count);
  } finally {
    db.close();
  }
}

interface MetricRow {
  readonly kind?: string;
  readonly action?: string;
  readonly reason?: string;
  readonly source?: string;
  readonly cutCount?: number;
  readonly summaryIds?: number[];
  readonly checkpoint?: string;
}

function lastMetric(dir: string): MetricRow {
  const rows = readFileSync(join(dir, "metrics.jsonl"), "utf8").trim().split("\n");
  return JSON.parse(rows[rows.length - 1] ?? "{}") as MetricRow;
}

type Mode = "covered" | "uncovered" | "failing";

interface Seeded {
  readonly dir: string;
  readonly host: FakeHost;
  readonly cleanup: () => Promise<void>;
  readonly calls: () => number;
  readonly summaryId?: number;
}

async function setup(mode: Mode, keep?: number): Promise<Seeded> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-lossless-compact-hook-"));
  const mapped = storedEntries(SESSION, HISTORY);
  const budget = keep ?? keepFor(2);
  const store = new LcmStore(sidecarPath(dir));
  let summaryId: number | undefined;
  try {
    ingestEntries(
      store,
      mapped.entries.map((entry) => ({
        entryId: entry.entryId,
        role: normalizeRole(entry.role),
        text: entry.text,
        timestamp: 1,
      })),
    );
    if (mode === "covered") {
      const first = mapped.entries[0];
      const last = mapped.entries[1];
      if (!first || !last) throw new Error("no aged set");
      summaryId = store.insertSummary({
        kind: "leaf",
        text: "the first two entries, summarized",
        tokens: 6,
        depth: 1,
        firstEntryId: first.entryId,
        lastEntryId: last.entryId,
        messageIds: store.messagesInSpan(first.entryId, last.entryId).map((message) => message.id),
      }).id;
    }
  } finally {
    store.close();
  }

  let calls = 0;
  const host = fakeHost(
    {
      sidecarDir: dir,
      assembly: true,
      contextWindow: CONTEXT_WINDOW,
      keepRecentTokens: budget,
      summaryTokens: 400,
    },
    {
      history: [...HISTORY],
      model: {
        list: () =>
          Promise.resolve({
            data: [
              { providerID: MODEL.providerID, id: MODEL.id, limit: { context: CONTEXT_WINDOW } },
            ],
          }),
      },
      generate: {
        text: () => {
          calls++;
          return mode === "failing"
            ? Promise.reject(new Error("the summarizer is down"))
            : Promise.resolve({ text: "the blocking summary" });
        },
      },
    },
  );
  const cleanup = await setupOpencodeLossless(host.ctx, host.options);
  return { dir, host, cleanup, calls: () => calls, summaryId };
}

describe("compaction checkpoint", () => {
  it("returns the covered frontier without calling a model", async () => {
    const seeded = await setup("covered");
    try {
      const request = event(transcript());
      await seeded.host.sessionHooks.compaction?.(request);

      expect(seeded.calls()).toBe(0);
      const result = request.result;
      expect(result).toBeDefined();
      expect(result?.summary).toContain("[LCM session memory");
      expect(result?.summary).toContain("the first two entries, summarized");
      expect(result?.metadata).toEqual({
        lcm: true,
        summaryIds: [seeded.summaryId],
        cutCount: 2,
        checkpoint: expect.any(String),
        keepID: "msg_u2",
      });
      expect(result?.tokens).toBeUndefined();
      expect(result?.native).toBeUndefined();
      expect(lastMetric(seeded.dir)).toMatchObject({
        kind: "compaction-checkpoint",
        action: "checkpoint",
        source: "frontier",
        cutCount: 2,
        summaryIds: [seeded.summaryId],
      });
    } finally {
      await seeded.cleanup();
    }
  });

  it("runs one blocking pass for an uncovered span and returns its frontier", async () => {
    const seeded = await setup("uncovered");
    try {
      const request = event(transcript());
      await seeded.host.sessionHooks.compaction?.(request);

      expect(seeded.calls()).toBe(1);
      expect(request.result?.summary).toContain("[LCM session memory");
      expect(request.result?.summary).toContain("the blocking summary");
      const ids = request.result?.metadata?.summaryIds;
      expect(Array.isArray(ids)).toBe(true);
      expect(ids).toHaveLength(1);
      expect(request.result?.metadata?.cutCount).toBe(2);
      expect(committedSummaries(sidecarPath(seeded.dir))).toBe(1);
      expect(lastMetric(seeded.dir)).toMatchObject({
        action: "checkpoint",
        source: "pass",
        cutCount: 2,
      });
    } finally {
      await seeded.cleanup();
    }
  });

  it("leaves the result unset and records a failure when the pass fails", async () => {
    const seeded = await setup("failing");
    try {
      const request = event(transcript());
      await seeded.host.sessionHooks.compaction?.(request);

      expect(request.result).toBeUndefined();
      expect(committedSummaries(sidecarPath(seeded.dir))).toBe(0);
      const row = lastMetric(seeded.dir);
      expect(row).toMatchObject({
        kind: "compaction-checkpoint",
        action: "fail",
        reason: "pass-failed",
      });
      expect(row.checkpoint).toBeUndefined();
    } finally {
      await seeded.cleanup();
    }
  });

  it("leaves the result unset when there is nothing to age", async () => {
    const seeded = await setup("covered", 1_000_000);
    try {
      const request = event(transcript());
      await seeded.host.sessionHooks.compaction?.(request);

      expect(seeded.calls()).toBe(0);
      expect(request.result).toBeUndefined();
      expect(lastMetric(seeded.dir)).toMatchObject({
        action: "skip",
        reason: "nothing-to-age",
      });
    } finally {
      await seeded.cleanup();
    }
  });

  it("does not adopt a host checkpoint without this adapter's marker", async () => {
    const seeded = await setup("covered");
    try {
      const hostCheckpoint = {
        id: "msg_host_compact",
        role: "user",
        content: [
          {
            type: "text",
            text: "<conversation-checkpoint>\na host summary\n</conversation-checkpoint>",
          },
        ],
      };
      seeded.host.history.unshift({
        id: "msg_host_compact",
        type: "compaction",
        status: "completed",
        summary: "a host summary",
      });
      const request = event([hostCheckpoint, ...transcript()]);
      await seeded.host.sessionHooks.compaction?.(request);

      expect(seeded.calls()).toBe(0);
      expect(request.result).toBeUndefined();
      expect(lastMetric(seeded.dir)).toMatchObject({
        action: "skip",
        reason: "host-checkpoint",
      });
    } finally {
      await seeded.cleanup();
    }
  });
});
