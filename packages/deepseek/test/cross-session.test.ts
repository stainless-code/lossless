import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LcmStore, SidecarStores, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { DshRoute } from "../src/model-host.ts";
import { dshRef } from "../src/model-host.ts";
import { dshReader } from "../src/reader.ts";
import {
  CROSS_SESSION_DEADLINE_MS,
  CROSS_SESSION_HITS_LIMIT,
  CROSS_SESSION_PER_STORE_HITS,
  CROSS_SESSION_STORE_LIMIT,
  answerGrep,
  expandAnswer,
  expandQueryAnswer,
  searchPastSessions,
  type RecallDeps,
} from "../src/tools.ts";
import { setupContext, textChunks, toolCallChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };

const CURRENT = "ses_current";
const PAST = "ses_past";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deepseek-lossless-cross-"));
}

function seed(dir: string, sessionId: string, texts: readonly string[]): void {
  const store = new LcmStore(join(dir, `${sessionId}.sqlite`));
  try {
    ingestEntries(
      store,
      texts.map((text, index) => ({
        entryId: `${sessionId}:prompt:msg_${index + 1}`,
        role: "user" as const,
        text,
        timestamp: index + 1,
      })),
    );
  } finally {
    store.close();
  }
}

const identity = (text: string): string => text;

function deps(
  dir: string,
  current: LcmStore | undefined,
): { sidecars: SidecarStores; recall: RecallDeps } {
  const sidecars = new SidecarStores({ dir });
  return {
    sidecars,
    recall: {
      store: () => current,
      redact: identity,
      pastSessions: { list: (exclude?: string) => sidecars.list(exclude) },
    },
  };
}

describe("cross-session recall", () => {
  it("labels a hit from another sidecar and never reads the calling session", () => {
    const dir = tempDir();
    seed(dir, CURRENT, ["the passphrase is MARIGOLD-4421"]);
    seed(dir, PAST, ["the passphrase is ORCHID-7319"]);
    const { sidecars, recall } = deps(dir, undefined);
    try {
      const found = answerGrep(recall, CURRENT, { query: "ORCHID", scope: "sessions" });
      expect(found).toContain("ORCHID-7319");
      expect(found).toContain(`[lcm:session ${PAST}]`);
      expect(found).toContain("lcm_expand({session, entry_id})");

      const own = answerGrep(recall, CURRENT, { query: "MARIGOLD", scope: "sessions" });
      expect(own).not.toContain("MARIGOLD-4421");
      expect(own).toContain("No matches");

      const all = answerGrep(recall, CURRENT, { query: "ORCHID", scope: "all_sessions" });
      expect(all).toContain(`[lcm:session ${PAST}]`);
    } finally {
      sidecars.close();
    }
  });

  it("records sessionsScanned on a cross-session hit", () => {
    const dir = tempDir();
    seed(dir, PAST, ["the passphrase is ORCHID-7319"]);
    const { sidecars, recall } = deps(dir, undefined);
    const rows: Record<string, unknown>[] = [];
    try {
      const found = answerGrep({ ...recall, record: (row) => rows.push(row) }, CURRENT, {
        query: "ORCHID",
        scope: "sessions",
      });
      expect(found).toContain("ORCHID-7319");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tool: "lcm_grep", scope: "sessions" });
      expect(typeof rows[0]?.["sessionsScanned"]).toBe("number");
      expect(rows[0]?.["sessionsScanned"] as number).toBeGreaterThanOrEqual(1);
    } finally {
      sidecars.close();
    }
  });

  it("keeps the default scope on the current session", () => {
    const dir = tempDir();
    seed(dir, PAST, ["the passphrase is ORCHID-7319"]);
    const current = new LcmStore(":memory:");
    try {
      ingestEntries(current, [
        { entryId: "cur-1", role: "user", text: "the passphrase is MARIGOLD-4421", timestamp: 1 },
      ]);
      const { sidecars, recall } = deps(dir, current);
      try {
        const found = answerGrep(recall, CURRENT, { query: "MARIGOLD" });
        expect(found).toContain("MARIGOLD-4421");
        expect(found).not.toContain(`[lcm:session ${PAST}]`);
        const scoped = answerGrep(recall, CURRENT, { query: "MARIGOLD", scope: "session" });
        expect(scoped).toBe(found);
      } finally {
        sidecars.close();
      }
    } finally {
      current.close();
    }
  });

  it("reads a past entry through lcm_expand and refuses a missing session or entry", () => {
    const dir = tempDir();
    seed(dir, PAST, ["the passphrase is ORCHID-7319"]);
    const { sidecars, recall } = deps(dir, undefined);
    try {
      const entryId = `${PAST}:prompt:msg_1`;
      const past = { pastSessions: recall.pastSessions };
      const read = expandAnswer(undefined, identity, { session: PAST, entry_id: entryId }, past);
      expect(read).toContain(`[lcm:session ${PAST}]`);
      expect(read).toContain("past session's history");
      expect(read).toContain("ORCHID-7319");

      const ghost = expandAnswer(
        undefined,
        identity,
        { session: "ses_ghost", entry_id: "ses_ghost:prompt:msg_1" },
        past,
      );
      expect(ghost).toContain("no stored session with id ses_ghost");
      expect(existsSync(join(dir, "ses_ghost.sqlite"))).toBe(false);

      const missing = expandAnswer(
        undefined,
        identity,
        { session: PAST, entry_id: `${PAST}:prompt:msg_404` },
        past,
      );
      expect(missing).toContain("No stored message with entry id");
      expect(missing).not.toContain("ORCHID-7319");

      const empty = expandAnswer(undefined, identity, { session: "   ", entry_id: entryId }, past);
      expect(empty).toContain("session must be a non-empty session id");
    } finally {
      sidecars.close();
    }
  });

  it("answers expand_query from a past sidecar through the listing", async () => {
    const dir = tempDir();
    seed(dir, PAST, ["deciding the recall pipeline rollout for next week"]);
    const sidecars = new SidecarStores({ dir });
    try {
      const { ctx } = setupContext(ROUTE, [
        toolCallChunks("call-1", "lcm_grep", { query: "recall pipeline rollout" }),
        textChunks(
          "The recall pipeline rollout was approved for next week [ses_past:prompt:msg_1].",
        ),
      ]);
      const rows: Record<string, unknown>[] = [];
      const answer = await expandQueryAnswer(
        undefined,
        identity,
        dshReader(ctx, { ref: dshRef(ROUTE) }),
        CURRENT,
        { query: "recall pipeline rollout", session: PAST },
        (row) => rows.push(row),
        { list: (exclude?: string) => sidecars.list(exclude) },
      );
      expect(answer).toContain("a past session's history (session ses_past)");
      expect(answer).toContain(`session="ses_past"`);
      expect(answer).toContain("recall pipeline rollout");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "retrieval", stop: "answered" });
      expect(existsSync(join(dir, `${CURRENT}.sqlite`))).toBe(false);
    } finally {
      sidecars.close();
    }
  });

  it("does not modify a past store", () => {
    const dir = tempDir();
    seed(dir, PAST, ["the passphrase is ORCHID-7319"]);
    const path = join(dir, `${PAST}.sqlite`);
    const before = {
      bytes: readFileSync(path),
      mtimeMs: statSync(path).mtimeMs,
    };
    const { sidecars, recall } = deps(dir, undefined);
    try {
      expect(answerGrep(recall, CURRENT, { query: "ORCHID", scope: "sessions" })).toContain(
        "ORCHID-7319",
      );
      expect(
        expandAnswer(
          undefined,
          identity,
          { session: PAST, entry_id: `${PAST}:prompt:msg_1` },
          { pastSessions: recall.pastSessions },
        ),
      ).toContain("ORCHID-7319");
    } finally {
      sidecars.close();
    }
    expect(readFileSync(path).equals(before.bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(dir, `${CURRENT}.sqlite`))).toBe(false);
  });

  it("forwards role, date, and tool filters to past sessions", () => {
    const dir = tempDir();
    const past = new LcmStore(join(dir, `${PAST}.sqlite`));
    try {
      ingestEntries(past, [
        {
          entryId: `${PAST}:prompt:msg_1`,
          role: "user",
          text: "zephyr routing decision from a user",
          timestamp: 100,
        },
        {
          entryId: `${PAST}:prompt:msg_2`,
          role: "assistant",
          text: "zephyr routing decision from the assistant",
          timestamp: 200,
        },
        {
          entryId: `${PAST}:prompt:msg_3`,
          role: "assistant",
          text: "[tool:Read] zephyr routing decision file",
          timestamp: 300,
        },
        {
          entryId: `${PAST}:prompt:msg_4`,
          role: "toolResult",
          text: "[tool:Read] zephyr routing decision contents",
          timestamp: 400,
        },
      ]);
    } finally {
      past.close();
    }
    const { sidecars, recall } = deps(dir, undefined);
    try {
      const role = answerGrep(recall, CURRENT, {
        query: "zephyr",
        scope: "sessions",
        role: "assistant",
      });
      expect(role).toContain("msg_2");
      expect(role).toContain("msg_3");
      expect(role).not.toContain("msg_1");
      expect(role).not.toContain("msg_4");
      const window = answerGrep(recall, CURRENT, {
        query: "zephyr",
        scope: "sessions",
        date_start: 150,
        date_end: 250,
      });
      expect(window).toContain("msg_2");
      expect(window).not.toContain("msg_1");
      expect(window).not.toContain("msg_3");
      const scoped = answerGrep(recall, CURRENT, {
        query: "zephyr",
        scope: "sessions",
        tool_name: "Read",
      });
      expect(scoped).toContain("msg_3");
      expect(scoped).toContain("msg_4");
      expect(scoped).not.toContain("msg_1");
      expect(scoped).not.toContain("msg_2");
    } finally {
      sidecars.close();
    }
  });
});

describe("cross-session caps", () => {
  it("stops at the store cap and names it", () => {
    const dir = tempDir();
    for (let i = 0; i < CROSS_SESSION_STORE_LIMIT + 5; i += 1) {
      seed(dir, `ses_cap_${String(i).padStart(2, "0")}`, ["the passphrase is ORCHID-7319"]);
    }
    const { sidecars, recall } = deps(dir, undefined);
    try {
      const result = searchPastSessions(
        { past: recall.pastSessions!, redact: identity },
        CURRENT,
        "ORCHID",
      );
      expect(result.stoppedBy).toBe("stores");
      expect(result.scanned).toBe(CROSS_SESSION_STORE_LIMIT);
      expect(result.text).toContain(`${CROSS_SESSION_STORE_LIMIT}-store cap`);
    } finally {
      sidecars.close();
    }
  });

  it("stops at the hit cap with at most ten hits per store", () => {
    const dir = tempDir();
    for (let s = 0; s < 5; s += 1) {
      seed(
        dir,
        `ses_hits_${s}`,
        Array.from({ length: 12 }, (_, i) => `ORCHID marker s${s} m${i}`),
      );
    }
    const { sidecars, recall } = deps(dir, undefined);
    try {
      const result = searchPastSessions(
        { past: recall.pastSessions!, redact: identity },
        CURRENT,
        "ORCHID",
      );
      expect(result.stoppedBy).toBe("hits");
      expect(result.hits).toBe(CROSS_SESSION_HITS_LIMIT);
      expect(result.text).toContain(`${CROSS_SESSION_HITS_LIMIT}-hit cap`);
    } finally {
      sidecars.close();
    }
  });

  it("caps one chatty store at ten hits", () => {
    const dir = tempDir();
    seed(
      dir,
      PAST,
      Array.from({ length: 15 }, (_, i) => `ORCHID marker m${i}`),
    );
    const { sidecars, recall } = deps(dir, undefined);
    try {
      const result = searchPastSessions(
        { past: recall.pastSessions!, redact: identity },
        CURRENT,
        "ORCHID",
      );
      expect(result.stoppedBy).toBeUndefined();
      expect(result.hits).toBe(CROSS_SESSION_PER_STORE_HITS);
      expect(result.scanned).toBe(1);
    } finally {
      sidecars.close();
    }
  });

  it("stops at the deadline when the clock runs past it", () => {
    const dir = tempDir();
    seed(dir, PAST, ["the passphrase is ORCHID-7319"]);
    const { sidecars, recall } = deps(dir, undefined);
    try {
      let calls = 0;
      const now = (): number => {
        calls += 1;
        return calls <= 1 ? 1_000 : 1_000 + CROSS_SESSION_DEADLINE_MS + 1;
      };
      const result = searchPastSessions(
        { past: recall.pastSessions!, redact: identity },
        CURRENT,
        "ORCHID",
        { now },
      );
      expect(result.stoppedBy).toBe("deadline");
      expect(result.scanned).toBe(0);
      expect(result.text).toContain(`${CROSS_SESSION_DEADLINE_MS} ms deadline`);
    } finally {
      sidecars.close();
    }
  });

  it("counts an unreadable sidecar as skipped", () => {
    const dir = tempDir();
    seed(dir, PAST, ["the passphrase is ORCHID-7319"]);
    const { sidecars, recall } = deps(dir, undefined);
    try {
      const good = recall.pastSessions!.list(CURRENT).find((ref) => ref.id === PAST);
      expect(good).toBeDefined();
      const corruptPath = join(dir, "ses_corrupt.sqlite");
      writeFileSync(corruptPath, "not a database");
      const result = searchPastSessions(
        {
          past: { list: () => [good!, { id: "ses_corrupt", path: corruptPath }] },
          redact: identity,
        },
        CURRENT,
        "ORCHID",
      );
      expect(result.skipped).toBe(1);
      expect(result.scanned).toBe(1);
      expect(result.hits).toBe(1);
      expect(result.stoppedBy).toBeUndefined();
      expect(result.text).toContain("skipped 1 unreadable");
    } finally {
      sidecars.close();
    }
  });
});
