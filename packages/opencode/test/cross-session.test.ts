import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LcmStore, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import {
  CROSS_SESSION_DEADLINE_MS,
  CROSS_SESSION_HITS_LIMIT,
  CROSS_SESSION_STORE_LIMIT,
  searchPastSessions,
} from "../src/cross-session.ts";
import type { ToolExecuteContext } from "../src/host.ts";
import { Sidecars } from "../src/sidecars.ts";
import { expandAnswer, grepAnswer } from "../src/tools.ts";

const CURRENT = "ses_current";
const PAST = "ses_past";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-cross-"));
}

function seed(dir: string, sessionID: string, texts: readonly string[]): void {
  const store = new LcmStore(join(dir, `${sessionID}.sqlite`));
  try {
    ingestEntries(
      store,
      texts.map((text, index) => ({
        entryId: `${sessionID}:prompt:msg_${index + 1}`,
        role: "user" as const,
        text,
        timestamp: index + 1,
      })),
    );
  } finally {
    store.close();
  }
}

function identity(text: string): string {
  return text;
}

function deps(dir: string) {
  const sidecars = new Sidecars(dir);
  return {
    sidecars,
    recall: {
      store: () => undefined,
      redact: identity,
      pastSessions: { list: (excludeSessionId?: string) => sidecars.list(excludeSessionId) },
    },
  };
}

function contextOf(sessionID: string): ToolExecuteContext {
  return { sessionID };
}

describe("cross-session recall", () => {
  it("labels a hit from another sidecar and never reads the calling session", () => {
    const dir = tempDir();
    seed(dir, CURRENT, ["the passphrase is MARIGOLD-4421"]);
    seed(dir, PAST, ["the passphrase is ORCHID-7319"]);
    const { sidecars, recall } = deps(dir);
    try {
      const found = grepAnswer(recall, contextOf(CURRENT), {
        query: "ORCHID",
        scope: "sessions",
      });
      expect(found).toContain("ORCHID-7319");
      expect(found).toContain(`[lcm:session ${PAST}]`);
      expect(found).toContain("lcm_expand({session, entry_id})");

      // The calling session is excluded by sidecar path, so its own token is
      // reachable only through the default scope, where this deps has no store.
      const own = grepAnswer(recall, contextOf(CURRENT), {
        query: "MARIGOLD",
        scope: "sessions",
      });
      expect(own).not.toContain("MARIGOLD-4421");
      expect(own).toContain("No matches");

      // OpenCode keeps one global sidecar directory, so the two scopes agree.
      const all = grepAnswer(recall, contextOf(CURRENT), {
        query: "ORCHID",
        scope: "all_sessions",
      });
      expect(all).toContain(`[lcm:session ${PAST}]`);
    } finally {
      sidecars.close();
    }
  });

  it("reads a past entry through lcm_expand and refuses a missing session or entry", () => {
    const dir = tempDir();
    seed(dir, PAST, ["the passphrase is ORCHID-7319"]);
    const { sidecars, recall } = deps(dir);
    try {
      const entryId = `${PAST}:prompt:msg_1`;
      const read = expandAnswer(recall, contextOf(CURRENT), {
        session: PAST,
        entry_id: entryId,
      });
      expect(read).toContain(`[lcm:session ${PAST}]`);
      expect(read).toContain("past session's history");
      expect(read).toContain("ORCHID-7319");

      const ghost = expandAnswer(recall, contextOf(CURRENT), {
        session: "ses_ghost",
        entry_id: "ses_ghost:prompt:msg_1",
      });
      expect(ghost).toContain("no stored session with id ses_ghost");
      expect(existsSync(join(dir, "ses_ghost.sqlite"))).toBe(false);

      const missing = expandAnswer(recall, contextOf(CURRENT), {
        session: PAST,
        entry_id: `${PAST}:prompt:msg_404`,
      });
      expect(missing).toContain("No stored message with entry id");
      expect(missing).not.toContain("ORCHID-7319");

      const empty = expandAnswer(recall, contextOf(CURRENT), {
        session: "   ",
        entry_id: entryId,
      });
      expect(empty).toContain("session must be a non-empty session id");
    } finally {
      sidecars.close();
    }
  });

  it("skips a store it cannot open and counts it", () => {
    const dir = tempDir();
    seed(dir, PAST, ["the passphrase is ORCHID-7319"]);
    writeFileSync(join(dir, "ses_broken.sqlite"), "this is not a database");
    const { sidecars, recall } = deps(dir);
    try {
      const found = grepAnswer(recall, contextOf(CURRENT), {
        query: "ORCHID",
        scope: "sessions",
      });
      expect(found).toContain("ORCHID-7319");
      expect(found).toContain("skipped 1 unreadable");
    } finally {
      sidecars.close();
    }
  });

  it("stops at the wall-clock deadline", () => {
    const dir = tempDir();
    seed(dir, PAST, ["walrus sighted"]);
    const { sidecars, recall } = deps(dir);
    try {
      let calls = 0;
      const result = searchPastSessions(
        {
          past: recall.pastSessions,
          redact: identity,
          now: () => (calls++ === 0 ? 0 : CROSS_SESSION_DEADLINE_MS + 1),
        },
        CURRENT,
        "walrus",
      );
      expect(result.stoppedBy).toBe("deadline");
      expect(result.text).toContain("deadline");
    } finally {
      sidecars.close();
    }
  });

  it("reports the store cap and the hit cap", () => {
    const storesDir = tempDir();
    for (let index = 0; index < CROSS_SESSION_STORE_LIMIT + 2; index++) {
      seed(storesDir, `ses_many_${index}`, ["walrus sighted"]);
    }
    const many = new Sidecars(storesDir);
    try {
      const storeCapped = searchPastSessions(
        {
          past: { list: (exclude?: string) => many.list(exclude) },
          redact: identity,
          now: () => 0,
        },
        CURRENT,
        "walrus",
      );
      expect(storeCapped.hits).toBe(CROSS_SESSION_STORE_LIMIT);
      expect(storeCapped.stoppedBy).toBe("stores");
      expect(storeCapped.text).toContain(`${CROSS_SESSION_STORE_LIMIT}-store cap`);
    } finally {
      many.close();
    }

    const hitsDir = tempDir();
    for (let index = 0; index < 5; index++) {
      seed(
        hitsDir,
        `ses_hits_${index}`,
        Array.from({ length: 12 }, () => "narwhal sighted"),
      );
    }
    const chatty = new Sidecars(hitsDir);
    try {
      const hitCapped = searchPastSessions(
        {
          past: { list: (exclude?: string) => chatty.list(exclude) },
          redact: identity,
          now: () => 0,
        },
        CURRENT,
        "narwhal",
      );
      expect(hitCapped.hits).toBe(CROSS_SESSION_HITS_LIMIT);
      expect(hitCapped.stoppedBy).toBe("hits");
      expect(hitCapped.text).toContain(`${CROSS_SESSION_HITS_LIMIT}-hit cap`);
    } finally {
      chatty.close();
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
    const { sidecars, recall } = deps(dir);
    try {
      expect(
        grepAnswer(recall, contextOf(CURRENT), { query: "ORCHID", scope: "sessions" }),
      ).toContain("ORCHID-7319");
      expect(
        expandAnswer(recall, contextOf(CURRENT), {
          session: PAST,
          entry_id: `${PAST}:prompt:msg_1`,
        }),
      ).toContain("ORCHID-7319");
    } finally {
      sidecars.close();
    }
    expect(readFileSync(path).equals(before.bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(dir, `${CURRENT}.sqlite`))).toBe(false);
  });
});
