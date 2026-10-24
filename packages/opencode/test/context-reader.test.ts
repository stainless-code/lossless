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
import { storedEntries } from "../src/map.ts";
import { setupOpencodeLossless } from "../src/plugin.ts";
import { READER_SYSTEM } from "../src/reader.ts";
import { fakeHost } from "./support/opencode-fake.ts";

const PARENT = "ses_parent";
const MODEL = { providerID: "test", id: "model" } as const;
const CONTEXT_WINDOW = 1000;

const USER_1 = "the first request asks about the northern passage. ".repeat(24);
const ASSISTANT_1 = "the first answer charts the shoals. ".repeat(24);

const parentHistory: SessionMessageInfo[] = [
  { id: "msg_u1", type: "user", text: USER_1 },
  {
    id: "msg_a1",
    type: "assistant",
    content: [{ type: "text", text: ASSISTANT_1 }],
    tokens: { input: 700, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  },
];

const childHistory: SessionMessageInfo[] = [
  { id: "msg_child", type: "assistant", content: [{ type: "text", text: "the code is ORCHID" }] },
];

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

function seedStore(dir: string): void {
  const mapped = storedEntries(PARENT, parentHistory);
  const store = new LcmStore(join(dir, `${PARENT}.sqlite`));
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
    const first = mapped.entries[0];
    if (!first) throw new Error("no entry to cover");
    store.insertSummary({
      kind: "leaf",
      text: "the first entry, summarized",
      tokens: 6,
      depth: 1,
      firstEntryId: first.entryId,
      lastEntryId: first.entryId,
      messageIds: store.messagesInSpan(first.entryId, first.entryId).map((message) => message.id),
    });
  } finally {
    store.close();
  }
}

function event(sessionID: string, messages: unknown[], system: unknown[]) {
  return {
    sessionID,
    model: MODEL,
    system,
    messages,
    options: {},
    agent: sessionID === PARENT ? "build" : "explore",
    tools: {},
  };
}

function metrics(dir: string): Array<{ action?: string }> {
  const text = readFileSync(join(dir, "metrics.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { action?: string });
}

/** The last projection decision. Recall, reader, and pass rows now share the
 * log, so an assertion about a decision names the rows that are decisions. */
function lastAction(dir: string): string | undefined {
  return metrics(dir)
    .filter((row) => row.action !== undefined)
    .at(-1)?.action;
}

describe("reader context hook", () => {
  it("replaces a reader child's system and leaves the parent's projection alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-lossless-context-reader-"));
    const mapped = storedEntries(PARENT, parentHistory);
    const keep = keepFor(mapped.entries, 1);
    seedStore(dir);

    const host = fakeHost(
      {
        sidecarDir: dir,
        assembly: true,
        contextWindow: CONTEXT_WINDOW,
        keepRecentTokens: keep,
        summaryTokens: 400,
      },
      {
        history: [...parentHistory],
        model: {
          list: () =>
            Promise.resolve({
              data: [
                { providerID: MODEL.providerID, id: MODEL.id, limit: { context: CONTEXT_WINDOW } },
              ],
            }),
        },
        generate: { text: () => Promise.resolve({ text: "scripted summary" }) },
        session: {
          context: (input) =>
            Promise.resolve(input.sessionID === PARENT ? parentHistory : childHistory),
        },
      },
    );
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    try {
      // Open the parent sidecar through the same mirror the host drives.
      host.sessionHooks.prompt?.({
        sessionID: PARENT,
        messageID: "msg_open",
        prompt: { text: "open the parent sidecar" },
      });

      const buildSystem = { type: "text", text: "build agent instructions" };
      const parentMessages: unknown[] = [
        { id: "msg_u1", role: "user", content: [{ type: "text", text: USER_1 }] },
        { id: "msg_a1", role: "assistant", content: [{ type: "text", text: ASSISTANT_1 }] },
      ];
      const parentEvent = event(PARENT, parentMessages, [buildSystem]);
      await host.sessionHooks.context?.(parentEvent);
      expect(parentEvent.system).toEqual([buildSystem]);
      expect(lastAction(dir)).toBe("swap");

      const expand = host.tools.find((tool) => tool.name === "lcm_expand_query");
      expect(expand).toBeDefined();
      const answer = (await expand?.execute(
        { query: "vault", prompt: "What is the code?" } as never,
        { sessionID: PARENT } as never,
      )) as { readonly content: string };
      expect(answer.content).toContain("ORCHID");

      const childSystem = [{ type: "text", text: "explore agent instructions" }];
      const childMessages: unknown[] = [];
      const childEvent = event("ses_child", childMessages, childSystem);
      await host.sessionHooks.context?.(childEvent);

      expect(childEvent.system).toEqual([{ type: "text", text: READER_SYSTEM }]);
      expect(childEvent.messages).toBe(childMessages);
      expect(childEvent.messages).toHaveLength(0);
      // The child hook returned before the projector: no new metric row.
      expect(lastAction(dir)).toBe("swap");
    } finally {
      await cleanup();
    }
  });
});
