import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LcmStore, cutIndexFor, ingestEntries, normalizeRole } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { SessionMessageInfo } from "../src/host.ts";
import { storedEntries } from "../src/map.ts";
import { setupOpencodeLossless } from "../src/plugin.ts";
import { fakeHost, tick, type FakeHost } from "./support/opencode-fake.ts";

const SESSION = "ses_async";
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

function outgoing(): unknown[] {
  return [
    { id: "msg_u1", role: "user", content: [{ type: "text", text: USER_1 }] },
    { id: "msg_a1", role: "assistant", content: [{ type: "text", text: ASSISTANT_1 }] },
    { id: "msg_u2", role: "user", content: [{ type: "text", text: USER_2 }] },
    { id: "msg_a2", role: "assistant", content: [{ type: "text", text: ASSISTANT_2 }] },
  ];
}

function sidecarPath(dir: string): string {
  return join(dir, `${SESSION}.sqlite`);
}

function keepFor(): number {
  const wrapped = storedEntries(SESSION, HISTORY).entries.map((entry) => ({
    role: entry.role,
    content: entry.text,
  }));
  for (let keep = 1; keep <= 20_000; keep++) {
    if (cutIndexFor(wrapped, keep) === 2) return keep;
  }
  throw new Error("no keep budget cuts at two entries");
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

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not hold");
}

interface Seeded {
  readonly dir: string;
  readonly host: FakeHost;
  readonly cleanup: () => Promise<void>;
  readonly calls: () => number;
  readonly release: () => void;
}

async function setup(): Promise<Seeded> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-lossless-async-"));
  const mapped = storedEntries(SESSION, HISTORY);
  const store = new LcmStore(sidecarPath(dir));
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
  } finally {
    store.close();
  }

  let calls = 0;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = fakeHost(
    {
      sidecarDir: dir,
      assembly: true,
      contextWindow: CONTEXT_WINDOW,
      keepRecentTokens: keepFor(),
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
        text: async () => {
          calls++;
          await gate;
          return { text: "the asynchronous summary" };
        },
      },
    },
  );
  const cleanup = await setupOpencodeLossless(host.ctx, host.options);
  host.sessionHooks.prompt?.({
    sessionID: SESSION,
    messageID: "msg_open",
    prompt: { text: "open the sidecar" },
  });
  return { dir, host, cleanup, calls: () => calls, release };
}

function event(messages: unknown[]): {
  sessionID: string;
  model: { providerID: string; id: string };
  system: unknown[];
  messages: unknown[];
  options: Record<string, unknown>;
  agent: string;
  tools: Record<string, { description: string; input: unknown }>;
} {
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

function lastAction(dir: string): { action: string; reason?: string; cutCount?: number } {
  const lines = readFileSync(join(dir, "metrics.jsonl"), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}") as {
    action: string;
    reason?: string;
    cutCount?: number;
  };
}

describe("async pass", () => {
  it("starts one pass per boundary and applies its frontier on the next request", async () => {
    const seeded = await setup();
    try {
      const first = event(outgoing());
      await seeded.host.sessionHooks.context?.(first);
      expect(seeded.calls()).toBe(1);
      expect(first.messages).toHaveLength(4);
      expect(lastAction(seeded.dir)).toMatchObject({
        action: "kick",
        reason: "summary-missing",
      });

      const second = event(outgoing());
      await seeded.host.sessionHooks.context?.(second);
      expect(seeded.calls()).toBe(1);
      expect(second.messages).toHaveLength(4);
      expect(lastAction(seeded.dir)).toMatchObject({
        action: "kick",
        reason: "kick-in-flight",
      });

      seeded.release();
      await waitFor(() => committedSummaries(sidecarPath(seeded.dir)) > 0);
      await tick();

      const third = event(outgoing());
      await seeded.host.sessionHooks.context?.(third);
      expect(third.messages).toHaveLength(3);
      const head = third.messages[0] as { content: Array<{ text: string }> };
      expect(head.content[0]?.text).toContain("[LCM session memory");
      expect(head.content[0]?.text).toContain("the asynchronous summary");
      expect(lastAction(seeded.dir)).toMatchObject({ action: "swap", cutCount: 2 });
    } finally {
      seeded.release();
      await seeded.cleanup();
    }
  });
});
