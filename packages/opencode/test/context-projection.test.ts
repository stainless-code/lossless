import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LcmStore,
  cutIndexFor,
  ingestEntries,
  normalizeRole,
  type AlignedEntry,
} from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { SessionMessageInfo } from "../src/host.ts";
import { storedEntries, type StoredEntries } from "../src/map.ts";
import { setupOpencodeLossless } from "../src/plugin.ts";
import { fakeHost, type FakeHost } from "./support/opencode-fake.ts";

const SESSION = "ses_projection";
const MODEL = { providerID: "test", id: "model" } as const;
const CONTEXT_WINDOW = 1000;

const USER_1 = "the first request asks about the northern passage. ".repeat(24);
const ASSISTANT_1 = "the first answer charts the shoals. ".repeat(24);
const TOOL_RESULT = "the chart names three shoals and a reef. ".repeat(12);
const USER_2 = "the second request asks about the southern route. ".repeat(24);
const ASSISTANT_2 = "the second answer names the southern harbor. ".repeat(24);
const USER_3 = "the third request asks about the eastern current. ".repeat(24);
const ASSISTANT_3 = "the third answer names the eastern tide. ".repeat(24);

interface TokenPair {
  readonly input: number;
  readonly cacheRead: number;
}

const MEASURED: TokenPair = { input: 700, cacheRead: 50 };
const BELOW: TokenPair = { input: 100, cacheRead: 0 };

function tokensOf(pair: TokenPair): unknown {
  return {
    input: pair.input,
    output: 10,
    reasoning: 0,
    cache: { read: pair.cacheRead, write: 0 },
  };
}

function toolPart(): unknown {
  return {
    type: "tool",
    id: "call_1",
    name: "read",
    state: {
      status: "completed",
      input: { path: "chart.ts" },
      content: [{ type: "text", text: TOOL_RESULT }],
    },
  };
}

function history(pair: TokenPair): SessionMessageInfo[] {
  return [
    { id: "msg_u1", type: "user", text: USER_1 },
    {
      id: "msg_a1",
      type: "assistant",
      content: [{ type: "text", text: ASSISTANT_1 }, toolPart()],
      tokens: tokensOf({ input: 400, cacheRead: 0 }),
    },
    { id: "msg_u2", type: "user", text: USER_2 },
    {
      id: "msg_a2",
      type: "assistant",
      content: [{ type: "text", text: ASSISTANT_2 }],
      tokens: tokensOf(pair),
    },
  ];
}

function laterTurns(): SessionMessageInfo[] {
  return [
    { id: "msg_u3", type: "user", text: USER_3 },
    {
      id: "msg_a3",
      type: "assistant",
      content: [{ type: "text", text: ASSISTANT_3 }],
      tokens: tokensOf({ input: 880, cacheRead: 20 }),
    },
  ];
}

function userMessage(id: string, text: string): unknown {
  return { id, role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(id: string, text: string): unknown {
  return { id, role: "assistant", content: [{ type: "text", text }] };
}

function toolMessage(): unknown {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        id: "call_1",
        name: "read",
        result: { type: "text", value: TOOL_RESULT },
      },
    ],
  };
}

function outgoing(): unknown[] {
  return [
    userMessage("msg_u1", USER_1),
    {
      id: "msg_a1",
      role: "assistant",
      content: [
        { type: "text", text: ASSISTANT_1 },
        { type: "tool-call", id: "call_1", name: "read", input: { path: "chart.ts" } },
      ],
    },
    toolMessage(),
    userMessage("msg_u2", USER_2),
    assistantMessage("msg_a2", ASSISTANT_2),
  ];
}

function laterOutgoing(): unknown[] {
  return [...outgoing(), userMessage("msg_u3", USER_3), assistantMessage("msg_a3", ASSISTANT_3)];
}

function sidecarPath(dir: string): string {
  return join(dir, `${SESSION}.sqlite`);
}

interface Seeded {
  readonly dir: string;
  readonly host: FakeHost;
  readonly cleanup: () => Promise<void>;
  readonly mapped: StoredEntries;
  readonly keep: number;
  readonly summaryId?: number;
}

/** Ingest the mapped entries the way the mirror would, optionally covering the
 * first `cover` entries with one committed leaf. */
function seedStore(
  dir: string,
  mapped: StoredEntries,
  cover: number | undefined,
): number | undefined {
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
    if (cover === undefined || cover <= 0) return undefined;
    const first = mapped.entries[0];
    const last = mapped.entries[cover - 1];
    if (!first || !last) return undefined;
    return store.insertSummary({
      kind: "leaf",
      text: "the first two entries, summarized",
      tokens: 6,
      depth: 1,
      firstEntryId: first.entryId,
      lastEntryId: last.entryId,
      messageIds: store.messagesInSpan(first.entryId, last.entryId).map((message) => message.id),
    }).id;
  } finally {
    store.close();
  }
}

/** A keep budget that makes the core cut at exactly `wanted` entries. */
function keepFor(entries: readonly AlignedEntry[], wanted: number): number {
  for (let keep = 1; keep <= 20_000; keep++) {
    if (
      cutIndexFor(
        entries.map((entry) => ({ role: entry.role, content: entry.text })),
        keep,
      ) === wanted
    ) {
      return keep;
    }
  }
  throw new Error(`no keep budget cuts at ${wanted}`);
}

interface SetupOptions {
  readonly cover?: number;
  readonly pair?: TokenPair;
  readonly extraTurns?: boolean;
  readonly synthetic?: boolean;
}

async function setup(options: SetupOptions = {}): Promise<Seeded> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-lossless-projection-"));
  const stored =
    options.extraTurns === true
      ? [...history(options.pair ?? MEASURED), ...laterTurns()]
      : history(options.pair ?? MEASURED);
  if (options.synthetic === true) {
    stored.push({ id: "msg_s1", type: "synthetic", text: "continue after the output limit" });
  }
  const mapped = storedEntries(SESSION, stored);
  const keep = keepFor(mapped.entries, 2);
  const summaryId = seedStore(dir, mapped, options.cover);
  const host = fakeHost(
    {
      sidecarDir: dir,
      assembly: true,
      contextWindow: CONTEXT_WINDOW,
      keepRecentTokens: keep,
      summaryTokens: 400,
    },
    {
      history: [...stored],
      model: {
        list: () =>
          Promise.resolve({
            data: [
              { providerID: MODEL.providerID, id: MODEL.id, limit: { context: CONTEXT_WINDOW } },
            ],
          }),
      },
      generate: { text: () => Promise.resolve({ text: "scripted summary" }) },
    },
  );
  const cleanup = await setupOpencodeLossless(host.ctx, host.options);
  // A prompt in this session is what opens the same sidecar the mirror writes;
  // the projector reads through that open handle.
  host.sessionHooks.prompt?.({
    sessionID: SESSION,
    messageID: "msg_open",
    prompt: { text: "open the sidecar" },
  });
  return { dir, host, cleanup, mapped, keep, summaryId };
}

function contextEvent(messages: unknown[]): {
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

interface MetricRow {
  readonly action: string;
  readonly cutCount?: number;
  readonly summaryIds?: number[];
  readonly reason?: string;
}

function metrics(dir: string): MetricRow[] {
  const text = readFileSync(join(dir, "metrics.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as MetricRow);
}

function last(dir: string): MetricRow | undefined {
  const rows = metrics(dir);
  return rows[rows.length - 1];
}

describe("context projection", () => {
  it("leaves a request below the swap point untouched", async () => {
    const seeded = await setup({ cover: 2, pair: BELOW });
    try {
      const messages = outgoing();
      const event = contextEvent(messages);
      await seeded.host.sessionHooks.context?.(event);
      expect(event.messages).toBe(messages);
      expect(event.messages).toHaveLength(5);
      expect(last(seeded.dir)?.action).toBe("quiet");
    } finally {
      await seeded.cleanup();
    }
  });

  it("swaps to the synthetic plus the outgoing tail at the committed cut", async () => {
    const seeded = await setup({ cover: 2 });
    try {
      const oldSystem = { role: "system", content: [{ type: "text", text: "old instruction" }] };
      const newSystem = { role: "system", content: [{ type: "text", text: "new instruction" }] };
      const messages = outgoing();
      // One system update sits in the aged region and one after the cut; only
      // the second belongs to the kept tail.
      messages.splice(3, 0, oldSystem);
      messages.splice(5, 0, newSystem);
      const keptUser = messages[4];
      const keptAssistant = messages[6];
      const event = contextEvent(messages);
      await seeded.host.sessionHooks.context?.(event);

      expect(event.messages).toHaveLength(5);
      const head = event.messages[0] as {
        readonly role?: unknown;
        readonly content?: Array<{ readonly text?: unknown }>;
      };
      expect(head.role).toBe("user");
      expect(head.content?.[0]?.text).toContain("[LCM session memory");
      expect(head.content?.[0]?.text).toContain("first two entries, summarized");
      // The tail is the host's own objects, not copies. Both system updates
      // survive: the summary covers only the first two entries, and a system
      // message between the cut and the first kept entry is not summarized.
      expect(event.messages[1]).toBe(oldSystem);
      expect(event.messages[2]).toBe(keptUser);
      expect(event.messages[3]).toBe(newSystem);
      expect(event.messages[4]).toBe(keptAssistant);
      expect(event.messages).toContain(oldSystem);

      const row = last(seeded.dir);
      expect(row?.action).toBe("swap");
      expect(row?.cutCount).toBe(2);
      expect(row?.summaryIds).toEqual([seeded.summaryId]);
    } finally {
      await seeded.cleanup();
    }
  });

  it("keeps a host-only message in the tail instead of bailing", async () => {
    const seeded = await setup({ cover: 2, synthetic: true });
    try {
      const synthetic = {
        id: "msg_s1",
        role: "user",
        content: [{ type: "text", text: "continue after the output limit" }],
      };
      const messages = [...outgoing(), synthetic];
      const event = contextEvent(messages);
      await seeded.host.sessionHooks.context?.(event);

      expect(last(seeded.dir)?.action).toBe("swap");
      expect(event.messages).toContain(synthetic);
    } finally {
      await seeded.cleanup();
    }
  });

  it("re-applies the identical synthetic on the next request", async () => {
    const seeded = await setup({ cover: 2 });
    try {
      const first = contextEvent(outgoing());
      await seeded.host.sessionHooks.context?.(first);
      const synthetic = (first.messages[0] as { content: Array<{ text: string }> }).content[0]
        ?.text;

      const second = contextEvent(outgoing());
      await seeded.host.sessionHooks.context?.(second);
      expect(second.messages).toHaveLength(3);
      expect((second.messages[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe(
        synthetic,
      );
      expect(last(seeded.dir)?.action).toBe("reapply");
    } finally {
      await seeded.cleanup();
    }
  });

  it("re-cuts when the request crosses the recut point", async () => {
    const seeded = await setup({ cover: 2 });
    try {
      const first = contextEvent(outgoing());
      await seeded.host.sessionHooks.context?.(first);
      const firstSynthetic = (first.messages[0] as { content: Array<{ text: string }> }).content[0]
        ?.text;

      // A new turn appends to the stored history and to the sidecar, and the
      // wider summary covers the new aged set.
      const later = laterTurns();
      for (const message of later) seeded.host.history.push(message);
      const remapped = storedEntries(SESSION, seeded.host.history);
      const cut = cutIndexFor(remapped.raw, seeded.keep);
      expect(cut).toBe(4);
      if (cut === null) throw new Error("the recut has no boundary");
      const store = new LcmStore(sidecarPath(seeded.dir));
      let summaryId: number;
      try {
        ingestEntries(
          store,
          remapped.entries.slice(2).map((entry) => ({
            entryId: entry.entryId,
            role: normalizeRole(entry.role),
            text: entry.text,
            timestamp: 2,
          })),
        );
        const firstEntry = remapped.entries[0];
        const lastEntry = remapped.entries[cut - 1];
        if (!firstEntry || !lastEntry) throw new Error("no aged set");
        summaryId = store.insertSummary({
          kind: "leaf",
          text: "the first four entries, summarized",
          tokens: 7,
          depth: 1,
          firstEntryId: firstEntry.entryId,
          lastEntryId: lastEntry.entryId,
          messageIds: store
            .messagesInSpan(firstEntry.entryId, lastEntry.entryId)
            .map((message) => message.id),
        }).id;
      } finally {
        store.close();
      }

      const second = contextEvent(laterOutgoing());
      await seeded.host.sessionHooks.context?.(second);
      expect(second.messages).toHaveLength(3);
      const synthetic = (second.messages[0] as { content: Array<{ text: string }> }).content[0]
        ?.text;
      expect(synthetic).not.toBe(firstSynthetic);
      expect(synthetic).toContain("the first four entries, summarized");
      const row = last(seeded.dir);
      expect(row?.action).toBe("swap");
      expect(row?.cutCount).toBe(4);
      expect(row?.summaryIds).toEqual([summaryId]);
    } finally {
      await seeded.cleanup();
    }
  });

  it("leaves the event untouched when the assistant and tool groups do not line up", async () => {
    const seeded = await setup({ cover: 2 });
    try {
      // An unexpected user message sits between a stored user and assistant
      // turn, so the next head cannot be the entry the stored history names.
      const messages = outgoing();
      messages.splice(1, 0, userMessage("msg_unknown", "a message the sidecar never stored"));
      const event = contextEvent(messages);
      await seeded.host.sessionHooks.context?.(event);
      expect(event.messages).toBe(messages);
      expect(event.messages).toHaveLength(6);
      const row = last(seeded.dir);
      expect(row?.action).toBe("bail");
      expect(row?.reason).toBe("unaligned-outgoing");
    } finally {
      await seeded.cleanup();
    }
  });

  it("leaves a history with a host checkpoint untouched", async () => {
    const seeded = await setup({ cover: 2 });
    try {
      seeded.host.history.unshift({
        id: "msg_compact",
        type: "compaction",
        text: "a host checkpoint our sidecar did not produce",
      });
      const messages = outgoing();
      const event = contextEvent(messages);
      await seeded.host.sessionHooks.context?.(event);
      expect(event.messages).toBe(messages);
      const row = last(seeded.dir);
      expect(row?.action).toBe("bail");
      expect(row?.reason).toBe("host-checkpoint");
    } finally {
      await seeded.cleanup();
    }
  });
});
