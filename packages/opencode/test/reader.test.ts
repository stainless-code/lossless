import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { ReaderSession, SessionCreateInput, SessionMessageInfo } from "../src/host.ts";
import {
  READER_AGENT,
  READER_PERMISSIONS,
  READER_TITLE,
  createReader,
  type Reader,
} from "../src/reader.ts";
import { Sidecars } from "../src/sidecars.ts";
import { grepAnswer } from "../src/tools.ts";

const PARENT = "ses_parent";
const CHILD = "ses_child";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-reader-"));
}

interface ScriptOptions {
  readonly parentHistory?: SessionMessageInfo[];
  readonly childMessages?: SessionMessageInfo[];
  readonly wait?: (sessionID: string) => Promise<void>;
  readonly onPrompt?: (sessionID: string) => Promise<void> | void;
  /** Overrides the prompt call, for a failure test. */
  readonly promptError?: Error;
}

interface Script {
  readonly session: ReaderSession;
  readonly creates: SessionCreateInput[];
  readonly prompts: Array<{ sessionID: string; text: string }>;
  readonly interrupted: string[];
  readonly removed: string[];
}

/** A child-session host with every call the reader makes scripted. `context`
 * answers the parent's history for the parent and the reader's stored messages
 * for the child, which is how the host would separate the two. */
function scripted(options: ScriptOptions = {}): Script {
  const creates: SessionCreateInput[] = [];
  const prompts: Array<{ sessionID: string; text: string }> = [];
  const interrupted: string[] = [];
  const removed: string[] = [];
  const parentHistory = options.parentHistory ?? [];
  const childMessages = options.childMessages ?? [];

  const session: ReaderSession = {
    context: (input) => Promise.resolve(input.sessionID === PARENT ? parentHistory : childMessages),
    create: (input) => {
      creates.push(input);
      return Promise.resolve({
        id: CHILD,
        ...(typeof input.parentID === "string" ? { parentID: input.parentID } : {}),
      });
    },
    prompt: async (args) => {
      if (options.promptError) throw options.promptError;
      prompts.push(args);
      await options.onPrompt?.(args.sessionID);
      return { messageID: "msg_child" };
    },
    wait: (input) => (options.wait ? options.wait(input.sessionID) : Promise.resolve()),
    interrupt: (input) => {
      interrupted.push(input.sessionID);
      return Promise.resolve({ interrupted: true });
    },
    remove: (input) => {
      removed.push(input.sessionID);
      return Promise.resolve();
    },
  };
  return { session, creates, prompts, interrupted, removed };
}

function assistant(text: string): SessionMessageInfo {
  return { id: "msg_child_answer", type: "assistant", content: [{ type: "text", text }] };
}

function useParentStore(sidecars: Sidecars, text: string): void {
  ingestEntries(sidecars.for(PARENT), [
    { entryId: `${PARENT}:prompt:msg_1`, role: "user", text, timestamp: 1 },
  ]);
}

describe("reader child session", () => {
  it("runs a narrowed child against the parent store and returns its answer", async () => {
    const dir = tempDir();
    const sidecars = new Sidecars(dir);
    useParentStore(sidecars, "the vault code is ORCHID-7319");
    let reader!: Reader;
    const host = scripted({
      childMessages: [assistant("The vault code is ORCHID-7319.")],
      onPrompt: (childID) => {
        // The mapping is what the recall tools resolve through: inside the
        // child, lcm_grep reads the parent's sidecar, not the child's.
        expect(reader.isActive(childID)).toBe(true);
        expect(reader.storeSession(childID)).toBe(PARENT);
        const hit = grepAnswer(
          {
            store: (sessionId) =>
              sessionId === undefined ? undefined : sidecars.peek(reader.storeSession(sessionId)),
            redact: (text) => text,
          },
          { sessionID: childID },
          { query: "ORCHID" },
        );
        expect(hit).toContain("ORCHID-7319");
        // Open the child's own transcript sidecar; the reader must delete it.
        sidecars.for(childID);
      },
    });
    reader = createReader({ session: host.session, sidecars, redact: (text) => text });

    try {
      const content = await reader.expand(PARENT, {
        query: "vault code",
        prompt: "What is the vault code? Quote it.",
      });

      expect(content).toContain("ORCHID-7319");
      expect(content).toContain("<recovered_findings>");
      expect(host.creates).toEqual([
        {
          parentID: PARENT,
          title: READER_TITLE,
          agent: READER_AGENT,
          permissions: READER_PERMISSIONS,
        },
      ]);
      expect(host.prompts).toHaveLength(1);
      const brief = host.prompts[0]?.text ?? "";
      expect(brief).toContain("Question: vault code");
      expect(brief).toContain("What to find out: What is the vault code? Quote it.");
      expect(brief).toContain("Retrieval budget: 10000 tokens");
      expect(brief).toContain("Use lcm_grep, lcm_describe, and lcm_expand");
      expect(brief).not.toContain("Read entry");
      expect(host.removed).toEqual([CHILD]);
      expect(existsSync(sidecars.pathFor(CHILD))).toBe(false);
      // Retired readers stay recognizable so a late bus event cannot reopen
      // the sidecar, but they are no longer active.
      expect(reader.isReader(CHILD)).toBe(true);
      expect(reader.isActive(CHILD)).toBe(false);
    } finally {
      sidecars.close();
    }
  });

  it("names the parent's last model on the child", async () => {
    const dir = tempDir();
    const sidecars = new Sidecars(dir);
    useParentStore(sidecars, "the lighthouse keeper tallies the oil");
    const host = scripted({
      parentHistory: [
        {
          id: "msg_a1",
          type: "assistant",
          content: [{ type: "text", text: "the first answer" }],
          model: { providerID: "test", id: "model", variant: "high" },
        },
      ],
      childMessages: [assistant("oil tallied at dusk")],
    });
    const reader = createReader({ session: host.session, sidecars, redact: (text) => text });

    try {
      await reader.expand(PARENT, { query: "oil", prompt: "How much oil?" });
      expect(host.creates[0]?.model).toEqual({
        providerID: "test",
        id: "model",
        variant: "high",
      });
    } finally {
      sidecars.close();
    }
  });

  it("refuses a missing store or address before creating a child", async () => {
    const emptyDir = tempDir();
    const empty = new Sidecars(emptyDir);
    const noStoreHost = scripted();
    const noStoreReader = createReader({
      session: noStoreHost.session,
      sidecars: empty,
      redact: (text) => text,
    });
    try {
      const answer = await noStoreReader.expand(PARENT, { query: "vault", prompt: "code" });
      expect(answer).toContain("no stored history");
      expect(noStoreHost.creates).toHaveLength(0);
    } finally {
      empty.close();
    }

    const dir = tempDir();
    const sidecars = new Sidecars(dir);
    useParentStore(sidecars, "the vault code is ORCHID-7319");
    const host = scripted();
    const reader = createReader({ session: host.session, sidecars, redact: (text) => text });
    try {
      const both = await reader.expand(PARENT, {
        query: "vault",
        prompt: "code",
        summary_id: 1,
        entry_id: `${PARENT}:prompt:msg_1`,
      });
      expect(both).toContain("pass summary_id or entry_id, not both");

      const summary = await reader.expand(PARENT, {
        query: "vault",
        prompt: "code",
        summary_id: 9,
      });
      expect(summary).toContain("no summary with id 9");

      const entry = await reader.expand(PARENT, {
        query: "vault",
        prompt: "code",
        entry_id: "ses_other:prompt:msg_1",
      });
      expect(entry).toContain("no stored message with entry id ses_other:prompt:msg_1");
      expect(host.creates).toHaveLength(0);
    } finally {
      sidecars.close();
    }
  });

  it("names an addressed entry in the brief and clamps the budget", async () => {
    const dir = tempDir();
    const sidecars = new Sidecars(dir);
    useParentStore(sidecars, "the vault code is ORCHID-7319");
    const host = scripted({ childMessages: [assistant("ORCHID-7319")] });
    const reader = createReader({ session: host.session, sidecars, redact: (text) => text });
    const entryId = `${PARENT}:prompt:msg_1`;

    try {
      await reader.expand(PARENT, {
        query: "vault",
        prompt: "code",
        entry_id: entryId,
        max_tokens: 10,
      });
      await reader.expand(PARENT, {
        query: "vault",
        prompt: "code",
        entry_id: entryId,
        max_tokens: 999_999,
      });
      expect(host.prompts[0]?.text).toContain(`Read entry ${entryId}`);
      expect(host.prompts[0]?.text).toContain("Retrieval budget: 500 tokens");
      expect(host.prompts[1]?.text).toContain("Retrieval budget: 40000 tokens");
      expect(host.creates).toHaveLength(2);
    } finally {
      sidecars.close();
    }
  });

  it("interrupts and removes a child that outlives the timeout", async () => {
    const dir = tempDir();
    const sidecars = new Sidecars(dir);
    useParentStore(sidecars, "the vault code is ORCHID-7319");
    const host = scripted({
      wait: () => new Promise<void>(() => undefined),
      onPrompt: (childID) => {
        sidecars.for(childID);
      },
    });
    const reader = createReader({
      session: host.session,
      sidecars,
      redact: (text) => text,
      timeoutMs: 20,
    });

    try {
      const content = await reader.expand(PARENT, { query: "vault", prompt: "code" });
      expect(content).toContain("timed out after 20 ms");
      expect(host.interrupted).toEqual([CHILD]);
      expect(host.removed).toEqual([CHILD]);
      expect(reader.isActive(CHILD)).toBe(false);
      expect(existsSync(sidecars.pathFor(CHILD))).toBe(false);
    } finally {
      sidecars.close();
    }
  });

  it("removes the child and its sidecar when the prompt fails", async () => {
    const dir = tempDir();
    const sidecars = new Sidecars(dir);
    useParentStore(sidecars, "the vault code is ORCHID-7319");
    const host = scripted({
      promptError: new Error("the host refused the prompt"),
      onPrompt: (childID) => {
        sidecars.for(childID);
      },
    });
    const reader = createReader({ session: host.session, sidecars, redact: (text) => text });

    try {
      const content = await reader.expand(PARENT, { query: "vault", prompt: "code" });
      expect(content).toContain("Retrieval failed: the host refused the prompt");
      expect(host.removed).toEqual([CHILD]);
      expect(existsSync(sidecars.pathFor(CHILD))).toBe(false);
    } finally {
      sidecars.close();
    }
  });

  it("redacts the child's answer on its way to the parent", async () => {
    const dir = tempDir();
    const sidecars = new Sidecars(dir);
    useParentStore(sidecars, "the vault code is ORCHID-7319");
    const host = scripted({ childMessages: [assistant("The code is ORCHID-7319.")] });
    const reader = createReader({
      session: host.session,
      sidecars,
      redact: (text) => text.replaceAll("ORCHID-7319", "[vault code]"),
    });

    try {
      const content = await reader.expand(PARENT, { query: "vault", prompt: "code" });
      expect(content).toContain("[vault code]");
      expect(content).not.toContain("ORCHID-7319");
    } finally {
      sidecars.close();
    }
  });
});
