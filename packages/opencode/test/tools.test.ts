import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LcmStore, ingestEntries, type AlignedEntry } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { ReaderSession, SessionMessageInfo, ToolExecuteContext } from "../src/host.ts";
import { readMetricRows } from "../src/metrics.ts";
import { runLosslessPass } from "../src/pass.ts";
import { setupOpencodeLossless } from "../src/plugin.ts";
import { createReader } from "../src/reader.ts";
import { Sidecars } from "../src/sidecars.ts";
import { describeAnswer, expandAnswer, grepAnswer } from "../src/tools.ts";
import { fakeHost } from "./support/opencode-fake.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-expand-query-"));
}

function stored(): { store: LcmStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-lossless-tools-"));
  const store = new LcmStore(join(dir, "recall.sqlite"));
  ingestEntries(store, [
    {
      entryId: "ses_1:prompt:msg_1",
      role: "user",
      text: "the lighthouse keeper tallies the lantern oil",
      timestamp: 1,
    },
    { entryId: "ses_1:text:msg_2:0", role: "assistant", text: "oil tallied at dusk", timestamp: 2 },
  ]);
  return { store, dir };
}

function contextOf(sessionID: string): ToolExecuteContext {
  return { sessionID };
}

describe("recall answers", () => {
  it("greps the calling session and explains a missing store", () => {
    const { store } = stored();
    const deps = { store: () => store, redact: (text: string) => text };
    const hit = grepAnswer(deps, contextOf("ses_1"), { query: "lighthouse" });
    expect(hit).toContain("lighthouse");
    const missing = grepAnswer(
      { store: () => undefined, redact: (text: string) => text },
      contextOf("ses_1"),
      { query: "lighthouse" },
    );
    expect(missing).toContain("no stored history");
    store.close();
  });

  it("describes and expands through the same views core serves", () => {
    const { store } = stored();
    const deps = { store: () => store, redact: (text: string) => text };
    expect(describeAnswer(deps, contextOf("ses_1"), {})).toContain("needs a summary id");
    const listed = expandAnswer(deps, contextOf("ses_1"), {
      entry_id: "ses_1:prompt:msg_1",
    });
    expect(listed).toContain("lighthouse");
    store.close();
  });

  it("routes the store by calling session", () => {
    const sidecars = new Sidecars(mkdtempSync(join(tmpdir(), "opencode-lossless-route-")));
    const store = sidecars.for("ses_7");
    ingestEntries(store, [
      { entryId: "ses_7:prompt:msg_1", role: "user", text: "sesame routing check", timestamp: 1 },
    ]);
    const deps = {
      store: (sessionId: string | undefined) =>
        sessionId === undefined ? undefined : sidecars.peek(sessionId),
      redact: (text: string) => text,
    };
    expect(grepAnswer(deps, contextOf("ses_7"), { query: "sesame" })).toContain("sesame");
    expect(grepAnswer(deps, contextOf("other"), { query: "sesame" })).toContain(
      "no stored history",
    );
    sidecars.close();
  });

  it("registers lcm_expand_query only with assembly on", async () => {
    const off = fakeHost({ sidecarDir: tempDir(), assembly: false });
    const offCleanup = await setupOpencodeLossless(off.ctx, off.options);
    try {
      expect(off.tools.map((tool) => tool.name)).not.toContain("lcm_expand_query");
    } finally {
      await offCleanup();
    }

    const on = fakeHost({ sidecarDir: tempDir(), assembly: true });
    const onCleanup = await setupOpencodeLossless(on.ctx, on.options);
    try {
      expect(on.tools.map((tool) => tool.name)).toContain("lcm_expand_query");
      // Direct tools, not code-mode tools: a session that denies `execute`
      // must still see them.
      expect(on.tools.every((tool) => tool.options?.codemode === false)).toBe(true);
    } finally {
      await onCleanup();
    }
  });

  it("validates expand-query params before opening a child", async () => {
    const host = fakeHost({ sidecarDir: tempDir(), assembly: true });
    const cleanup = await setupOpencodeLossless(host.ctx, host.options);
    try {
      const tool = host.tools.find((candidate) => candidate.name === "lcm_expand_query");
      expect(tool).toBeDefined();
      const run = async (input: unknown): Promise<string> => {
        const value = (await tool?.execute(input as never, { sessionID: "ses_1" } as never)) as {
          readonly content: string;
        };
        return value.content;
      };

      expect(await run({ prompt: "what is the code?" })).toContain("needs a query string");
      expect(await run({ query: "vault" })).toContain("needs a prompt string");
      expect(
        await run({
          query: "vault",
          prompt: "code",
          summary_id: 1,
          entry_id: "ses_1:prompt:msg_1",
        }),
      ).toContain("pass summary_id or entry_id, not both");

      // Open the sidecar so a missing address has a store to be checked against.
      host.sessionHooks.prompt?.({
        sessionID: "ses_1",
        messageID: "msg_1",
        prompt: { text: "seed the sidecar" },
      });
      expect(await run({ query: "vault", prompt: "code", summary_id: 9 })).toContain(
        "no summary with id 9",
      );
      expect(host.children).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("points a truncated hit at this adapter's expand tool", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-lossless-expand-"));
    const store = new LcmStore(join(dir, "long.sqlite"));
    ingestEntries(store, [
      {
        entryId: "ses_1:prompt:long",
        role: "user",
        text: `lighthouse ${"x".repeat(900)}`,
        timestamp: 1,
      },
    ]);
    const answer = grepAnswer(
      { store: () => store, redact: (text: string) => text },
      contextOf("ses_1"),
      {
        query: "lighthouse",
      },
    );
    expect(answer).toContain("read them with lcm_expand({entry_id:");
    expect(answer).not.toContain("lcm_expand_query");
    store.close();
  });
});

describe("recall metrics", () => {
  it("records one row per view with the fields the report reads", () => {
    const { store } = stored();
    const rows: Array<Record<string, unknown>> = [];
    const deps = {
      store: () => store,
      redact: (text: string) => text,
      record: (row: Record<string, unknown>) => rows.push(row),
    };
    try {
      grepAnswer(deps, contextOf("ses_1"), { query: "lighthouse" });
      grepAnswer(deps, contextOf("ses_1"), { query: "zebra crossing" });
      grepAnswer(deps, contextOf("ses_1"), {});
      describeAnswer(deps, contextOf("ses_1"), { id: 9 });
      expandAnswer(deps, contextOf("ses_1"), { entry_id: "ses_1:prompt:msg_1" });

      expect(rows[0]).toMatchObject({
        session: "ses_1",
        kind: "recall",
        tool: "lcm_grep",
        outcome: "hit",
        hits: 1,
        queryChars: 10,
      });
      expect(typeof rows[0]?.durationMs).toBe("number");
      expect(rows[1]).toMatchObject({ tool: "lcm_grep", outcome: "miss", hits: 0 });
      expect(rows[2]).toMatchObject({ tool: "lcm_grep", outcome: "error" });
      expect(rows[3]).toMatchObject({
        tool: "lcm_describe",
        outcome: "miss",
        summaryId: 9,
      });
      expect(rows[4]).toMatchObject({
        tool: "lcm_expand",
        outcome: "hit",
        entryId: "ses_1:prompt:msg_1",
      });
    } finally {
      store.close();
    }
  });

  it("refuses an unknown scope before it searches", () => {
    const { store } = stored();
    const rows: Array<Record<string, unknown>> = [];
    const deps = {
      store: () => store,
      redact: (text: string) => text,
      record: (row: Record<string, unknown>) => rows.push(row),
    };
    try {
      const answer = grepAnswer(deps, contextOf("ses_1"), {
        query: "lighthouse",
        scope: "planet",
      });
      expect(answer).toContain("session, sessions, or all_sessions");
      expect(rows[0]).toMatchObject({ outcome: "refused", scope: "planet" });
    } finally {
      store.close();
    }

    const unreachable = grepAnswer(
      { store: () => undefined, redact: (text: string) => text },
      contextOf("ses_1"),
      { query: "lighthouse", scope: "sessions" },
    );
    expect(unreachable).toContain("past sessions are not reachable");
  });

  it("keeps a reader child session-scoped", () => {
    const { store } = stored();
    const rows: Array<Record<string, unknown>> = [];
    const deps = {
      store: () => store,
      redact: (text: string) => text,
      pastSessions: {
        list: () => [{ id: "ses_past", path: "/nonexistent/ses_past.sqlite" }],
      },
      isReader: (sessionID: string) => sessionID === "ses_child",
      record: (row: Record<string, unknown>) => rows.push(row),
    };
    try {
      const grep = grepAnswer(deps, contextOf("ses_child"), {
        query: "lighthouse",
        scope: "sessions",
      });
      expect(grep).toContain("reader is session-scoped");
      expect(rows[0]).toMatchObject({ tool: "lcm_grep", outcome: "refused", scope: "sessions" });

      const expand = expandAnswer(deps, contextOf("ses_child"), {
        session: "ses_past",
        entry_id: "ses_past:prompt:msg_1",
      });
      expect(expand).toContain("reader is session-scoped");
      expect(rows[1]).toMatchObject({ tool: "lcm_expand", outcome: "refused" });
    } finally {
      store.close();
    }
  });

  it("records a reader row with its child, outcome, chars, and citations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-lossless-reader-metrics-"));
    const sidecars = new Sidecars(dir);
    ingestEntries(sidecars.for("ses_p"), [
      { entryId: "ses_p:prompt:msg_1", role: "user", text: "vault ORCHID-7319", timestamp: 1 },
    ]);
    const childMessages: SessionMessageInfo[] = [
      {
        id: "msg_child",
        type: "assistant",
        content: [
          {
            type: "text",
            text: "The code is ORCHID-7319 [ses_p:prompt:msg_1] per [lcm:summary #4 leaf].",
          },
        ],
      },
    ];
    const session: ReaderSession = {
      context: (input) => Promise.resolve(input.sessionID === "ses_p" ? [] : childMessages),
      create: () => Promise.resolve({ id: "ses_child" }),
      prompt: () => Promise.resolve(undefined),
      wait: () => Promise.resolve(),
      interrupt: () => Promise.resolve({ interrupted: true }),
      remove: () => Promise.resolve(),
    };
    const reader = createReader({ session, sidecars, redact: (text) => text });
    try {
      const answer = await reader.expand("ses_p", { query: "code", prompt: "what?" });
      expect(answer).toContain("ORCHID-7319");

      const rows = metricRows(dir, "reader");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        parent: "ses_p",
        child: "ses_child",
        outcome: "answered",
      });
      expect(rows[0]?.answerChars).toBeGreaterThan(0);
      expect(typeof rows[0]?.durationMs).toBe("number");
      expect(rows[0]?.citedIds).toEqual(["#4", "ses_p:prompt:msg_1"]);
    } finally {
      sidecars.close();
    }
  });

  it("records a timeout reader row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-lossless-reader-timeout-"));
    const sidecars = new Sidecars(dir);
    ingestEntries(sidecars.for("ses_p"), [
      { entryId: "ses_p:prompt:msg_1", role: "user", text: "vault ORCHID-7319", timestamp: 1 },
    ]);
    const session: ReaderSession = {
      context: () => Promise.resolve([]),
      create: () => Promise.resolve({ id: "ses_child" }),
      prompt: () => Promise.resolve(undefined),
      wait: () => new Promise<void>(() => undefined),
      interrupt: () => Promise.resolve({ interrupted: true }),
      remove: () => Promise.resolve(),
    };
    const reader = createReader({
      session,
      sidecars,
      redact: (text) => text,
      timeoutMs: 5,
    });
    try {
      await reader.expand("ses_p", { query: "code", prompt: "what?" });
      expect(metricRows(dir, "reader")[0]).toMatchObject({
        parent: "ses_p",
        outcome: "timeout",
        answerChars: 0,
      });
    } finally {
      sidecars.close();
    }
  });

  it("records a pass row for a stored and a failed pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-lossless-pass-metrics-"));
    const host = fakeHost({ sidecarDir: dir });
    const model = { providerID: "test", id: "model" } as const;
    const rows: Array<Record<string, unknown>> = [];
    const passRows = (): Array<Record<string, unknown>> =>
      rows.filter((row) => row.kind === "pass");
    const first = seedPassStore(dir, "ses_pass");
    try {
      const stored = await runLosslessPass(
        {
          store: () => first.store,
          ctx: { ...host.ctx, generate: { text: () => Promise.resolve({ text: "a summary" }) } },
          model,
          record: (row) => rows.push(row),
        },
        "ses_pass",
        first.entries,
        { targetTokens: 200 },
      );
      expect(stored.kind).toBe("stored");
      const storedRow = passRows().find(
        (row) => row.session === "ses_pass" && row.outcome === "stored",
      );
      expect(storedRow).toMatchObject({
        session: "ses_pass",
        kind: "pass",
        stage: "blocking",
        outcome: "stored",
        leaf: 1,
        condensed: 0,
        answers: 1,
      });
      expect(typeof storedRow?.durationMs).toBe("number");
    } finally {
      first.store.close();
    }

    const second = seedPassStore(dir, "ses_fail");
    try {
      await expect(
        runLosslessPass(
          {
            store: () => second.store,
            ctx: {
              ...host.ctx,
              generate: { text: () => Promise.reject(new Error("provider down")) },
            },
            model,
            record: (row) => rows.push(row),
          },
          "ses_fail",
          second.entries,
          { targetTokens: 200 },
        ),
      ).rejects.toThrow(/summarizer did not answer/);
      const failedRow = passRows().find((row) => row.session === "ses_fail");
      expect(failedRow).toMatchObject({
        kind: "pass",
        stage: "blocking",
        outcome: "failed",
      });
      expect(String(failedRow?.error)).toContain("summarizer did not answer");
    } finally {
      second.store.close();
    }
  });
});

function seedPassStore(dir: string, session: string): { store: LcmStore; entries: AlignedEntry[] } {
  const longUser = "the northern passage needs a chart. ".repeat(80);
  const longAssistant = "the chart shows shoals between the islands. ".repeat(80);
  const store = new LcmStore(join(dir, `${session}.sqlite`));
  const entries: AlignedEntry[] = [
    { entryId: `${session}:prompt:msg_1`, role: "user", text: longUser },
    { entryId: `${session}:text:msg_2:0`, role: "assistant", text: longAssistant },
  ];
  ingestEntries(
    store,
    entries.map((entry, index) => ({
      entryId: entry.entryId,
      role: entry.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: entry.text,
      timestamp: index + 1,
    })),
  );
  return { store, entries };
}

function metricRows(dir: string, kind: string): Array<Record<string, unknown>> {
  return readMetricRows(dir).filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" &&
      row !== null &&
      !Array.isArray(row) &&
      "kind" in row &&
      row.kind === kind,
  );
}
