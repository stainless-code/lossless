import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { redactSecrets } from "lossless-core";
import { ingestEntries } from "lossless-core";
import { hashSessionPath } from "lossless-core";
import { LcmStore } from "lossless-core";
import {
  formatSessionHits,
  listSessions,
  openSessionStore,
  readSessionHeader,
  searchSessions,
  sessionStorePath,
  sessionsForScope,
} from "lossless-core";
import { test } from "vite-plus/test";

import { createExpandQueryTool, createGrepTool, type SessionRoots } from "../src/tools/recall.ts";
import { readerFor } from "./support/pi-double.ts";

const NO_CTX = {} as never;

function replyWithCall(name: string, args: Record<string, unknown>): never {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name, arguments: args }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  } as never;
}

function reply(text: string): never {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as never;
}

interface Fixture {
  root: string;
  sessionsRoot: string;
  storesDir: string;
  session(slug: string, name: string, header: Record<string, unknown>, lines?: string[]): string;
  store(sessionFile: string, texts: string[], generation?: number): LcmStore;
  cleanup(): void;
}

let seq = 0;
function fixture(): Fixture {
  const root = join(tmpdir(), `lcm-sessions-${process.pid}-${seq++}`);
  const sessionsRoot = join(root, "sessions");
  const storesDir = join(root, "lcm");
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(storesDir, { recursive: true });
  return {
    root,
    sessionsRoot,
    storesDir,
    session(slug, name, header, lines = []) {
      const dir = join(sessionsRoot, slug);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      const body = [JSON.stringify({ type: "session", version: 3, ...header }), ...lines];
      writeFileSync(path, `${body.join("\n")}\n`, "utf8");
      return path;
    },
    store(sessionFile, texts) {
      const s = new LcmStore(sessionStorePath(storesDir, sessionFile));
      ingestEntries(
        s,
        texts.map((text, i) => ({
          entryId: `e${String(i).padStart(2, "0")}`,
          role: "user" as const,
          text,
          timestamp: i,
        })),
      );
      return s;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function header(cwd: string, when: string, id = "11111111-2222-3333-4444-555555555555") {
  return { id, timestamp: when, cwd };
}

test("session header: line 1 is read and a broken line 2 does not matter", () => {
  const f = fixture();
  try {
    const path = f.session(
      "--proj--",
      "2026-09-14T10-00-00-000Z_abcd.jsonl",
      header("/Users/x/proj", "2026-09-14T10:00:00.000Z"),
      ["{ this is not json at all"],
    );
    assert.deepEqual(readSessionHeader(path), {
      cwd: "/Users/x/proj",
      id: "11111111-2222-3333-4444-555555555555",
      timestamp: "2026-09-14T10:00:00.000Z",
    });
    const other = join(f.sessionsRoot, "note.jsonl");
    writeFileSync(other, '{"type":"message"}\n', "utf8");
    assert.equal(readSessionHeader(other), undefined);
    assert.equal(readSessionHeader(join(f.sessionsRoot, "absent.jsonl")), undefined);
  } finally {
    f.cleanup();
  }
});

test("list sessions: same project only, newest first, store required, asking session excluded", () => {
  const f = fixture();
  try {
    const mine = f.session(
      "--proj--",
      "2026-09-16T00-00-00-000Z_me.jsonl",
      header("/Users/x/proj", "2026-09-16T00:00:00.000Z"),
    );
    const older = f.session(
      "--proj--",
      "2026-09-10T00-00-00-000Z_old.jsonl",
      header("/Users/x/proj", "2026-09-10T00:00:00.000Z"),
    );
    const newer = f.session(
      "--proj--",
      "2026-09-20T00-00-00-000Z_new.jsonl",
      header("/Users/x/proj", "2026-09-20T00:00:00.000Z"),
    );
    const elsewhere = f.session(
      "--other--",
      "2026-09-21T00-00-00-000Z_other.jsonl",
      header("/Users/x/other", "2026-09-21T00:00:00.000Z"),
    );
    const noStore = f.session(
      "--proj--",
      "2026-09-22T00-00-00-000Z_empty.jsonl",
      header("/Users/x/proj", "2026-09-22T00:00:00.000Z"),
    );
    f.store(mine, ["mine"]).close();
    f.store(older, ["older"]).close();
    f.store(newer, ["newer"]).close();
    f.store(elsewhere, ["elsewhere"]).close();

    const sameProject = listSessions({
      sessionsRoot: f.sessionsRoot,
      storesDir: f.storesDir,
      cwd: "/Users/x/proj",
      excludeHash: hashSessionPath(mine),
    });
    assert.deepEqual(
      sameProject.map((s) => s.sessionFile),
      [newer, older],
      "newest first, and neither the asking session nor the storeless one",
    );
    assert.equal(sameProject[0]!.hash, hashSessionPath(newer));
    assert.equal(sameProject[0]!.cwd, "/Users/x/proj");
    assert.equal(
      sameProject[0]!.when,
      Date.parse("2026-09-20T00:00:00.000Z"),
      "the header timestamp orders the scan",
    );

    const everyProject = listSessions({
      sessionsRoot: f.sessionsRoot,
      storesDir: f.storesDir,
      excludeHash: hashSessionPath(mine),
    });
    assert.deepEqual(
      everyProject.map((s) => s.sessionFile),
      [elsewhere, newer, older],
    );

    const capped = listSessions({
      sessionsRoot: f.sessionsRoot,
      storesDir: f.storesDir,
      cwd: "/Users/x/proj",
      limit: 1,
    });
    assert.deepEqual(
      capped.map((s) => s.sessionFile),
      [newer],
      "the cap keeps the newest, not the first the directory listed",
    );
    assert.equal(join(f.storesDir, `${hashSessionPath(noStore)}.db`).includes("lcm"), true);
  } finally {
    f.cleanup();
  }
});

test("search across sessions: finds a past session's decision, not another project's", () => {
  const f = fixture();
  try {
    const mine = f.session(
      "--proj--",
      "2026-09-16T00-00-00-000Z_me.jsonl",
      header("/Users/x/proj", "2026-09-16T00:00:00.000Z"),
    );
    const pastSession = f.session(
      "--proj--",
      "2026-09-10T00-00-00-000Z_sib.jsonl",
      header("/Users/x/proj", "2026-09-10T00:00:00.000Z"),
    );
    const elsewhere = f.session(
      "--other--",
      "2026-09-12T00-00-00-000Z_other.jsonl",
      header("/Users/x/other", "2026-09-12T00:00:00.000Z"),
    );
    f.store(mine, ["nothing to see here"]).close();
    f.store(pastSession, ["we decided to keep the WAL probe in the scan path"]).close();
    f.store(elsewhere, ["the WAL probe decision belongs to another project"]).close();

    const refs = sessionsForScope({
      scope: "sessions",
      sessionsRoot: f.sessionsRoot,
      storesDir: f.storesDir,
      cwd: "/Users/x/proj",
      excludeHash: hashSessionPath(mine),
    });
    const result = searchSessions(refs, "WAL probe");
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]!.session, hashSessionPath(pastSession));
    assert.equal(result.hits[0]!.entryId, "e00");
    assert.equal(result.scanned, 1);
    assert.equal(result.truncated, false);
    assert.equal(result.skipped.missing, 0);
    assert.match(
      formatSessionHits(result, redactSecrets),
      /^Found 1 match\(es\) across 1 past session\(s\)/,
    );
    assert.match(
      formatSessionHits(result, redactSecrets),
      new RegExp(
        `\\[lcm:session ${hashSessionPath(pastSession)} 2026-09-10 /Users/x/proj\\] \\[e00\\] \\(user\\) .*WAL probe`,
      ),
    );

    const wide = sessionsForScope({
      scope: "all_sessions",
      sessionsRoot: f.sessionsRoot,
      storesDir: f.storesDir,
      cwd: "/Users/x/proj",
      excludeHash: hashSessionPath(mine),
    });
    const all = searchSessions(wide, "WAL probe");
    assert.equal(all.hits.length, 2, "every project when the scope says so");
    assert.equal(new Set(all.hits.map((h) => h.session)).size, 2);

    const none = searchSessions(refs, "a phrase that exists nowhere");
    assert.equal(none.hits.length, 0);
    assert.equal(formatSessionHits(none, redactSecrets), "No matches in 1 past session(s).");
  } finally {
    f.cleanup();
  }
});

test("search across sessions: an unreadable, absent or older store is skipped and counted", () => {
  const f = fixture();
  try {
    const pastSession = f.session(
      "--proj--",
      "2026-09-10T00-00-00-000Z_sib.jsonl",
      header("/Users/x/proj", "2026-09-10T00:00:00.000Z"),
    );
    const old = f.session(
      "--proj--",
      "2026-09-09T00-00-00-000Z_old.jsonl",
      header("/Users/x/proj", "2026-09-09T00:00:00.000Z"),
    );
    const broken = f.session(
      "--proj--",
      "2026-09-08T00-00-00-000Z_broken.jsonl",
      header("/Users/x/proj", "2026-09-08T00:00:00.000Z"),
    );
    f.store(pastSession, ["the WAL probe decision"]).close();
    f.store(old, ["an old WAL probe note"]).close();
    const stale = new DatabaseSync(sessionStorePath(f.storesDir, old));
    stale.exec("PRAGMA user_version = 0");
    stale.close();
    writeFileSync(sessionStorePath(f.storesDir, broken), "not a database at all", "utf8");

    const before = readFileSync(sessionStorePath(f.storesDir, old));
    const refs = listSessions({
      sessionsRoot: f.sessionsRoot,
      storesDir: f.storesDir,
      cwd: "/Users/x/proj",
    });
    const result = searchSessions(refs, "WAL probe");
    assert.equal(result.hits.length, 1, "the readable store still answers");
    assert.equal(result.hits[0]!.session, hashSessionPath(pastSession));
    assert.equal(result.skipped["older-generation"], 1);
    assert.equal(result.skipped.unreadable, 1);
    assert.match(
      formatSessionHits(result, redactSecrets),
      /skipped 1 unreadable, 1 older-generation/,
      "the footer says what the scan did not read",
    );
    assert.deepEqual(
      readFileSync(sessionStorePath(f.storesDir, old)),
      before,
      "a store this build cannot read is left byte-identical, not migrated",
    );

    // A store named by a ref but absent on disk is its own count, which is the
    // race a scan can lose between listing and opening.
    const gone = openSessionStore({ ...refs[0]!, storePath: join(f.storesDir, "nope.db") });
    assert.deepEqual(gone, { kind: "skipped", reason: "missing" });
  } finally {
    f.cleanup();
  }
});

test("search across sessions: the asking store is not reopened, and the file is not rewritten", () => {
  const f = fixture();
  try {
    const mine = f.session(
      "--proj--",
      "2026-09-16T00-00-00-000Z_me.jsonl",
      header("/Users/x/proj", "2026-09-16T00:00:00.000Z"),
    );
    const other = f.session(
      "--proj--",
      "2026-09-15T00-00-00-000Z_other.jsonl",
      header("/Users/x/proj", "2026-09-15T00:00:00.000Z"),
    );
    const writer = f.store(mine, ["my own WAL probe note"]);
    const pastSession = f.store(other, ["their WAL probe note"]);
    try {
      const storePath = sessionStorePath(f.storesDir, other);
      const before = readFileSync(storePath);
      const refs = sessionsForScope({
        scope: "sessions",
        sessionsRoot: f.sessionsRoot,
        storesDir: f.storesDir,
        cwd: "/Users/x/proj",
        excludeHash: hashSessionPath(mine),
      });
      const result = searchSessions(refs, "WAL probe");
      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0]!.session, hashSessionPath(other));
      assert.deepEqual(readFileSync(storePath), before, "the searched store is unchanged");
      assert.equal(result.scanned, 1, "the asking session's store is not part of the scan");
    } finally {
      writer.close();
      pastSession.close();
    }
  } finally {
    f.cleanup();
  }
});

test("search across sessions: the deadline ends the scan and says so", () => {
  const f = fixture();
  try {
    const paths: string[] = [];
    for (let i = 0; i < 4; i++) {
      const path = f.session(
        "--proj--",
        `2026-09-0${i + 1}T00-00-00-000Z_s${i}.jsonl`,
        header("/Users/x/proj", `2026-09-0${i + 1}T00:00:00.000Z`),
      );
      f.store(path, [`WAL probe note ${i}`]).close();
      paths.push(path);
    }
    const refs = listSessions({ sessionsRoot: f.sessionsRoot, storesDir: f.storesDir });
    assert.equal(refs.length, 4);
    const complete = searchSessions(refs, "WAL probe", { deadlineMs: 60_000 });
    assert.equal(complete.scanned, 4);
    assert.equal(complete.hits.length, 4);
    assert.equal(complete.truncated, false);

    let clock = 0;
    const expired = searchSessions(refs, "WAL probe", {
      deadlineMs: 1,
      now: () => (clock += 1_000),
    });
    assert.equal(expired.scanned, 0);
    assert.equal(expired.truncated, true);
    assert.equal(expired.hits.length, 0);
    assert.match(formatSessionHits(expired, redactSecrets), /not a complete answer/);

    const capped = searchSessions(refs, "WAL probe", { limit: 2, deadlineMs: 60_000 });
    assert.equal(capped.hits.length, 2);
    assert.equal(capped.truncated, true);
    assert.equal(capped.scanned, 2);
  } finally {
    f.cleanup();
  }
});

test("grep tool: scope sessions returns labelled pointers and never this session's text", async () => {
  const f = fixture();
  try {
    const mine = f.session(
      "--proj--",
      "2026-09-16T00-00-00-000Z_me.jsonl",
      header("/Users/x/proj", "2026-09-16T00:00:00.000Z"),
    );
    const pastSession = f.session(
      "--proj--",
      "2026-09-10T00-00-00-000Z_sib.jsonl",
      header("/Users/x/proj", "2026-09-10T00:00:00.000Z"),
    );
    f.store(mine, ["the current session is about something else"]).close();
    f.store(pastSession, [
      "we decided to keep the WAL probe in the scan path; token sk-ant-abcdefghijklmnopqrstuvwxyz012345",
    ]).close();
    const myStore = new LcmStore(":memory:");
    ingestEntries(myStore, [
      {
        entryId: "m0",
        role: "user",
        text: "current session: the WAL probe is mine alone",
        timestamp: 0,
      },
    ]);
    const roots: SessionRoots = {
      sessionsRoot: f.sessionsRoot,
      storesDir: f.storesDir,
      cwd: "/Users/x/proj",
      excludeHash: hashSessionPath(mine),
    };
    const tool = createGrepTool({
      store: () => myStore,
      session: () => "s1",
      redact: redactSecrets,
      sessions: () => roots,
    });
    const local = await tool.execute("t1", { query: "WAL probe" });
    assert.match(local.content[0]!.text, /\[m0\] \(user\)/);
    assert.doesNotMatch(local.content[0]!.text, /lcm:session/, "the local scope stays local");

    const past = await tool.execute("t2", { query: "WAL probe", scope: "sessions" });
    const text = past.content[0]!.text;
    assert.match(
      text,
      new RegExp(`\\[lcm:session ${hashSessionPath(pastSession)} 2026-09-10 /Users/x/proj\\]`),
    );
    assert.match(text, /we decided to keep the WAL probe/);
    assert.doesNotMatch(
      text,
      /sk-ant-abcdefghijklmnopqrstuvwxyz012345/,
      "the mask reaches a past session",
    );
    assert.doesNotMatch(
      text,
      /mine alone/,
      "a past session's scan does not answer with this one's text",
    );
    assert.deepEqual(past.details["sessions"], [hashSessionPath(pastSession)]);
    assert.equal(past.details["hits"], 1);

    // A caller cannot raise the hit cap: the block goes into a context window,
    // and the limit is a request rather than a budget the model owns. Fourteen
    // matching stores exist here, so a raised limit would show more than 40.
    for (let i = 0; i < 14; i++) {
      const extra = f.session(
        "--proj--",
        `2026-08-${String(i + 1).padStart(2, "0")}T00-00-00-000Z_x${i}.jsonl`,
        header("/Users/x/proj", `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
      );
      f.store(
        extra,
        Array.from({ length: 5 }, (_, n) => `WAL probe note ${i}.${n}`),
      ).close();
    }
    const raised = await tool.execute("t6", { query: "WAL probe", scope: "sessions", limit: 500 });
    assert.equal(raised.details["hits"], 40, "the cross-session cap holds at 40");

    const missing = await tool.execute("t3", { query: "WAL probe", scope: "all_sessions" });
    assert.match(missing.content[0]!.text, /we decided to keep the WAL probe/);

    const bare = createGrepTool({
      store: () => myStore,
      session: () => "s1",
      redact: redactSecrets,
    });
    const unavailable = await bare.execute("t4", { query: "x", scope: "sessions" });
    assert.match(unavailable.content[0]!.text, /not reachable in this process/);
    const refused = await tool.execute("t5", { pattern: "WAL", scope: "sessions" });
    assert.match(refused.content[0]!.text, /Pass query for past sessions/);
    myStore.close();
  } finally {
    f.cleanup();
  }
});

test("expand query tool: a named session is read read-only and its findings are labelled", async () => {
  const f = fixture();
  try {
    const pastSession = f.session(
      "--proj--",
      "2026-09-10T00-00-00-000Z_sib.jsonl",
      header("/Users/x/proj", "2026-09-10T00:00:00.000Z"),
    );
    f.store(pastSession, [
      "we decided to keep the WAL probe in the scan path; token sk-ant-abcdefghijklmnopqrstuvwxyz012345",
    ]).close();
    const roots: SessionRoots = {
      sessionsRoot: f.sessionsRoot,
      storesDir: f.storesDir,
      cwd: "/Users/x/proj",
    };
    // The reader's own context is a seam too: what it reads from another
    // session has to arrive masked, not merely be masked on the way back.
    const readerContexts: string[] = [];
    const mine = new LcmStore(":memory:");
    ingestEntries(mine, [{ entryId: "m0", role: "user", text: "my own note", timestamp: 0 }]);
    const tool = createExpandQueryTool({
      store: () => mine,
      session: () => "s1",
      redact: redactSecrets,
      sessions: () => roots,
      reader: () =>
        readerFor((context) => {
          readerContexts.push(JSON.stringify(context.messages));
          const read = context.messages.some((m) => m.role === "toolResult");
          return read
            ? reply("They kept the WAL probe.")
            : replyWithCall("lcm_expand", { entry_id: "e00", max_chars: 4000 });
        }),
    });
    const hash = hashSessionPath(pastSession);
    const r = await tool.execute(
      "t1",
      { session: hash, entry_id: "e00", query: "WAL probe", prompt: "What was decided?" },
      undefined,
      undefined,
      NO_CTX,
    );
    const text = r.content[0]!.text;
    assert.match(text, new RegExp(`a past session's history \\(session ${hash}\\)`));
    assert.match(text, new RegExp(`<recovered_findings session="${hash}">`));
    assert.match(text, /They kept the WAL probe\./);
    const readerSaw = readerContexts.join("\n");
    assert.match(readerSaw, /we decided to keep the WAL probe/, "the reader reads the entry");
    assert.doesNotMatch(
      readerSaw,
      /sk-ant-abcdefghijklmnopqrstuvwxyz012345/,
      "the mask reaches the reader's context",
    );

    const bad = await tool.execute(
      "t2",
      { session: "not-a-hash", query: "x", prompt: "p" },
      undefined,
      undefined,
      NO_CTX,
    );
    assert.match(bad.content[0]!.text, /not a session hash/);
    const gone = await tool.execute(
      "t3",
      { session: "0".repeat(16), query: "x", prompt: "p" },
      undefined,
      undefined,
      NO_CTX,
    );
    assert.match(gone.content[0]!.text, /could not be read \(missing\)/);
    const bare = createExpandQueryTool({
      store: () => mine,
      session: () => "s1",
      redact: redactSecrets,
      reader: () =>
        readerFor(() => {
          throw new Error("should not be called");
        }),
    });
    const unreachable = await bare.execute(
      "t4",
      { session: hash, query: "x", prompt: "p" },
      undefined,
      undefined,
      NO_CTX,
    );
    assert.match(unreachable.content[0]!.text, /past sessions are not reachable/);
    mine.close();
  } finally {
    f.cleanup();
  }
});

test("a WAL store with no shared memory file is still readable, and the write ban holds", () => {
  const f = fixture();
  try {
    const path = f.session(
      "--proj--",
      "2026-09-10T00-00-00-000Z_sib.jsonl",
      header("/Users/x/proj", "2026-09-10T00:00:00.000Z"),
    );
    f.store(path, ["the WAL probe decision"]).close();
    const storePath = sessionStorePath(f.storesDir, path);
    for (const sidecar of [`${storePath}-wal`, `${storePath}-shm`]) {
      rmSync(sidecar, { force: true });
    }
    assert.equal(readdirSync(f.storesDir).length, 1, "only the store file is left");
    const before = readFileSync(storePath);
    const opened = openSessionStore({
      hash: hashSessionPath(path),
      sessionFile: path,
      storePath,
      cwd: "/Users/x/proj",
      sessionId: "id",
      when: 0,
    });
    assert.equal(opened.kind, "opened", "the fallback opens what the strict path cannot");
    if (opened.kind !== "opened") return;
    assert.equal(opened.store.grep("WAL probe").length, 1);
    assert.throws(() => opened.store.setModelState("probe", { charsPerToken: 1, samples: 1 }));
    opened.store.close();
    const result = searchSessions(
      [
        {
          hash: hashSessionPath(path),
          sessionFile: path,
          storePath,
          cwd: "/Users/x/proj",
          sessionId: "id",
          when: 0,
        },
      ],
      "WAL probe",
    );
    assert.equal(result.hits.length, 1);
    assert.equal(result.skipped.unreadable, 0);
    assert.deepEqual(readFileSync(storePath), before, "the store is byte-identical afterwards");
  } finally {
    f.cleanup();
  }
});

test("a store opened for a read past a session refuses every write", () => {
  const f = fixture();
  try {
    const path = f.session(
      "--proj--",
      "2026-09-10T00-00-00-000Z_sib.jsonl",
      header("/Users/x/proj", "2026-09-10T00:00:00.000Z"),
    );
    f.store(path, ["the fallback reads this"]).close();
    const store = new LcmStore(sessionStorePath(f.storesDir, path), { queryOnly: true });
    try {
      assert.equal(store.grep("fallback reads").length, 1);
      assert.throws(() => store.setModelState("probe", { charsPerToken: 1, samples: 1 }));
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
});

test("a store at the current generation opens read-only outside a session", () => {
  const f = fixture();
  try {
    const path = f.session(
      "--proj--",
      "2026-09-10T00-00-00-000Z_sib.jsonl",
      header("/Users/x/proj", "2026-09-10T00:00:00.000Z"),
    );
    const writer = f.store(path, ["needle"]);
    writer.close();
    const ref = {
      hash: hashSessionPath(path),
      sessionFile: path,
      storePath: sessionStorePath(f.storesDir, path),
      cwd: "/Users/x/proj",
      sessionId: "id",
      when: 0,
    };
    const opened = openSessionStore(ref);
    assert.equal(opened.kind, "opened");
    if (opened.kind === "opened") {
      assert.equal(opened.store.generation, 1);
      assert.equal(opened.store.grep("needle").length, 1);
      opened.store.close();
    }
    const db = new DatabaseSync(ref.storePath);
    db.exec("PRAGMA user_version = 0");
    db.close();
    const stale = openSessionStore(ref);
    assert.deepEqual(stale, { kind: "skipped", reason: "older-generation" });
  } finally {
    f.cleanup();
  }
});
