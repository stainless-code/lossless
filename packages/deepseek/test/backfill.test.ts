import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import {
  ToolCallId,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { LcmStore, readMetricRows } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import {
  BACKFILL_MAX_EVENTS,
  backfillSession,
  historySourceFrom,
  mirrorEvent,
  type SessionHistorySource,
} from "../src/ingest.ts";
import type { DshRoute } from "../src/model-host.ts";
import { applyLossless } from "../src/plugin.ts";
import { appendConversation } from "./support/conversation.ts";
import { setupContext, textChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };

function buildSession() {
  const session = Session.create(SessionId("backfill-1"));
  session.append("turn/start", { turn: 1 });
  session.append(
    "system/message",
    { turn: 1, step: 1, message: createSystemMessage("You are a test.") },
    { surfaceOp: "append" },
  );
  session.append(
    "user/message",
    createUserMessage({
      content: [{ type: "text", text: "start the backfill work" }],
      source: { kind: "user" },
    }),
    { surfaceOp: "append" },
  );
  session.append("step/start", { turn: 1, step: 1 });
  const callId = ToolCallId("call-1");
  session.append(
    "assistant/message",
    {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: "assistant",
        content: [
          { type: "text", text: "reading now" },
          { type: "tool-call", id: callId, name: "read", arguments: '{"path":"backfill.conf"}' },
        ],
        source: { kind: "model", provider: ROUTE.provider, model: ROUTE.model },
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("tool/call", {
    turn: 1,
    step: 1,
    callId,
    name: "read",
    arguments: '{"path":"backfill.conf"}',
  });
  session.append(
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: "text", text: "config contents here" }],
        isError: false,
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 1, step: 1 });
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  return session;
}

/** N closed single-exchange turns: user plus assistant per turn. */
function buildLongSession(turns: number) {
  const session = Session.create(SessionId("backfill-long"));
  for (let turn = 1; turn <= turns; turn++) {
    session.append("turn/start", { turn });
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: `request ${turn}` }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    session.append(
      "assistant/message",
      {
        stream: [],
        turn,
        step: 1,
        message: createMessage({
          role: "assistant",
          content: [{ type: "text", text: `response ${turn}` }],
          source: { kind: "model", provider: ROUTE.provider, model: ROUTE.model },
        }),
      },
      { surfaceOp: "append" },
    );
    session.append("turn/end", { turn, reason: { kind: "completed" } });
  }
  return session;
}

/** Scripted pagination source over a frozen fixture array. */
function fakeSource(
  events: readonly SessionEvent[],
  seen?: { calls: number },
): SessionHistorySource {
  return {
    observe: async () => {
      if (seen) seen.calls += 1;
      return { events };
    },
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deepseek-backfill-"));
}

async function mountBase(ctx: Context): Promise<void> {
  await ctx.plugin(SystemPrompt, {});
  void new ToolRuntime(ctx);
  void new CommandRuntime(ctx);
  void new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  void new TokenMeter(ctx);
}

describe("pre-mount backfill", () => {
  it("ingests pre-mount messages including tool calls through one async read", async () => {
    const session = buildSession();
    const store = new LcmStore(":memory:");
    const rows: Record<string, unknown>[] = [];
    const seen = { calls: 0 };
    // The snapshot walk is test-only: production reads the frozen cut through
    // the async observation seam the fake stands in for.
    const result = await backfillSession(
      session,
      store,
      fakeSource(session.snapshotEvents(), seen),
      undefined,
      {
        record: (row) => rows.push(row),
      },
    );
    const derived = session.deriveMessages();
    expect(seen.calls).toBe(1);
    expect(result.ingested).toBe(derived.length);
    expect(result.capped).toBe(false);
    expect(store.allMessages()).toHaveLength(derived.length);
    expect(store.allMessages().some((row) => row.text.includes("tool-call: read"))).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "lcm",
      kind: "backfill",
      session: "backfill-1",
      ingested: derived.length,
      capped: false,
    });
  });

  it("re-mirroring the same span inserts nothing", async () => {
    const session = buildSession();
    const store = new LcmStore(":memory:");
    const events = session.snapshotEvents();
    const first = await backfillSession(session, store, fakeSource(events));
    expect(first.ingested).toBe(session.deriveMessages().length);
    const second = await backfillSession(session, store, fakeSource(events));
    expect(second.ingested).toBe(0);
    expect(second.skipped).toBe(events.length);
    let liveInserted = 0;
    for (const event of events) liveInserted += mirrorEvent(session, event, store).inserted;
    expect(liveInserted).toBe(0);
    expect(store.allMessages()).toHaveLength(session.deriveMessages().length);
  });

  it("live events after mount append normally", async () => {
    const session = buildSession();
    const store = new LcmStore(":memory:");
    await backfillSession(session, store, fakeSource(session.snapshotEvents()));
    const before = store.allMessages().length;
    const followup = session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: "live followup after backfill" }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    const stats = mirrorEvent(session, followup, store);
    expect(stats.inserted).toBe(1);
    expect(store.allMessages()).toHaveLength(before + 1);
    expect(
      store.allMessages().some((row) => row.text.includes("live followup after backfill")),
    ).toBe(true);
  });

  it("respects the cap on an oversized history", async () => {
    const session = buildLongSession(30);
    const events = session.snapshotEvents();
    expect(events.length).toBeGreaterThan(25);
    const store = new LcmStore(":memory:");
    const rows: Record<string, unknown>[] = [];
    const seen = { calls: 0 };
    const result = await backfillSession(session, store, fakeSource(events, seen), undefined, {
      pageSize: 10,
      maxEvents: 25,
      record: (row) => rows.push(row),
    });
    expect(seen.calls).toBe(1);
    expect(result.capped).toBe(true);
    expect(result.ingested + result.skipped).toBe(25);
    expect(result.throughSeq).toBe(Number(events[24]?.seq));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "backfill",
      capped: true,
      throughSeq: result.throughSeq,
    });
  });

  it("honors the default cap on a log larger than BACKFILL_MAX_EVENTS", async () => {
    const session = buildLongSession(200);
    const events = session.snapshotEvents();
    expect(events.length).toBeGreaterThan(BACKFILL_MAX_EVENTS);
    const store = new LcmStore(":memory:");
    const result = await backfillSession(session, store, fakeSource(events));
    expect(result.capped).toBe(true);
    expect(result.ingested + result.skipped).toBe(BACKFILL_MAX_EVENTS);
  });
});

describe("history source seam", () => {
  it("is absent without the query backend and reads through it when mounted", async () => {
    const ctx = new Context();
    expect(historySourceFrom(ctx)).toBeUndefined();
    const session = buildSession();
    const events = session.snapshotEvents();
    let disposed = false;
    const disposeKey = (Symbol as unknown as { dispose: symbol }).dispose;
    (ctx as unknown as Record<string, unknown>).sessionQuery = {
      observeSession: async () => ({
        events,
        cursor: events.at(-1)?.seq ?? -1,
        [disposeKey]: () => {
          disposed = true;
        },
      }),
    };
    const source = historySourceFrom(ctx);
    expect(source).toBeDefined();
    const observation = await source?.observe(SessionId("backfill-1"));
    expect(observation?.events).toHaveLength(events.length);
    expect(disposed).toBe(true);
  });

  it("backfills pre-mount sessions at plugin mount and records the row", async () => {
    const { ctx } = setupContext(ROUTE, [textChunks("summary")], { contextWindow: 1_000_000 });
    await mountBase(ctx);
    const session = ctx.sessions.create(SessionId("premout-1"), { meta: { cwd: tmpdir() } });
    appendConversation(session, ROUTE, "premount notes");
    const derived = session.deriveMessages().length;
    const events = session.snapshotEvents();
    (ctx as unknown as Record<string, unknown>).sessionQuery = {
      observeSession: async () => ({ events }),
    };
    const dir = tempDir();
    const dispose = applyLossless(ctx, { enabled: true, sidecarDir: dir });
    try {
      const path = join(dir, "premout-1.sqlite");
      let stored = 0;
      for (let i = 0; i < 100 && stored !== derived; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (existsSync(path)) stored = new LcmStore(path).allMessages().length;
      }
      expect(stored).toBe(derived);
      const backfills = readMetricRows(dir)
        .map((row) => row as Record<string, unknown>)
        .filter((row) => row.kind === "backfill");
      expect(backfills).toHaveLength(1);
      expect(backfills[0]).toMatchObject({
        session: "premout-1",
        ingested: derived,
        capped: false,
      });
      void readdirSync(dir);
    } finally {
      dispose();
    }
  });
});
