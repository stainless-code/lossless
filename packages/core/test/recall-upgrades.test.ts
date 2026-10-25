import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vite-plus/test";

import { ingestEntries } from "../src/ingest.ts";
import {
  expandView,
  filesView,
  ftsPhrase,
  grepView,
  historyManifest,
  LARGE_INLINE_CHARS,
  orderSummariesByOverlap,
  toolMarker,
  toolScopeMessageIds,
  withToolScope,
} from "../src/recall-view.ts";
import { redactSecrets } from "../src/redact.ts";
import { searchSessions } from "../src/sessions.ts";
import { LcmStore } from "../src/store.ts";

function seedRoleTime(): LcmStore {
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    Array.from({ length: 6 }, (_, i) => ({
      entryId: `e${String(i).padStart(2, "0")}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `filterword message ${i} about the engine`,
      timestamp: 1000 * (i + 1),
    })),
  );
  const ids = store.messagesInSpan("e00", "e05").map((m) => m.id);
  store.insertSummary({
    kind: "leaf",
    text: "leaf over the filterword span",
    tokens: 4,
    depth: 0,
    firstEntryId: "e00",
    lastEntryId: "e05",
    messageIds: ids,
  });
  return store;
}

function hitIds(view: ReturnType<typeof grepView>): string[] {
  assert.equal(view.ok, true);
  return view.text
    .split("\n")
    .slice(1)
    .filter((l) => l.startsWith("["))
    .map((l) => l.slice(1, l.indexOf("]")));
}

test("grepView: a role filter equals the unfiltered result plus the filter", () => {
  const store = seedRoleTime();
  try {
    const all = hitIds(grepView(store, redactSecrets, { query: "filterword" }));
    assert.deepEqual(all, ["e00", "e01", "e02", "e03", "e04", "e05"]);
    const users = hitIds(grepView(store, redactSecrets, { query: "filterword", role: "user" }));
    assert.deepEqual(users, ["e00", "e02", "e04"]);
    const asst = hitIds(grepView(store, redactSecrets, { query: "filterword", role: "assistant" }));
    assert.deepEqual(asst, ["e01", "e03", "e05"]);
  } finally {
    store.close();
  }
});

test("grepView: a date range keeps its window and an empty range returns empty", () => {
  const store = seedRoleTime();
  try {
    const window = hitIds(
      grepView(store, redactSecrets, { query: "filterword", dateStart: 2000, dateEnd: 4000 }),
    );
    assert.deepEqual(window, ["e01", "e02", "e03"]);
    const empty = grepView(store, redactSecrets, {
      query: "filterword",
      dateStart: 9000,
      dateEnd: 1000,
    });
    assert.equal(empty.ok, true);
    assert.match(empty.text, /No matches/);
    assert.deepEqual(empty.details, { hits: 0 });
  } finally {
    store.close();
  }
});

test("grepView: the pattern path respects role and date filters", () => {
  const store = seedRoleTime();
  try {
    const users = grepView(store, redactSecrets, { pattern: "filterword", role: "user" });
    assert.equal(users.ok, true);
    for (const want of ["e00 (user)", "e02 (user)", "e04 (user)"])
      assert.ok(users.text.includes(`[${want}]`), users.text);
    assert.ok(!users.text.includes("e01 (assistant)"), users.text);
    const window = grepView(store, redactSecrets, {
      pattern: "filterword",
      dateStart: 2000,
      dateEnd: 2000,
    });
    assert.equal(window.ok, true);
    assert.ok(window.text.includes("[e01 (assistant)]"), window.text);
    assert.ok(!window.text.includes("e02 (user)"), window.text);
  } finally {
    store.close();
  }
});

test("grepView: an unknown role is refused and bad timestamps are refused", () => {
  const store = seedRoleTime();
  try {
    const bad = grepView(store, redactSecrets, {
      query: "filterword",
      role: "owner" as "user",
    });
    assert.equal(bad.ok, false);
    const time = grepView(store, redactSecrets, { query: "filterword", dateStart: -1 });
    assert.equal(time.ok, false);
  } finally {
    store.close();
  }
});

function seedTools(): LcmStore {
  const store = new LcmStore(":memory:");
  ingestEntries(store, [
    {
      entryId: "t00",
      role: "toolResult",
      text: '[tool:read] {"path": "/a"} cache key rot13',
      timestamp: 1,
    },
    {
      entryId: "t01",
      role: "toolResult",
      text: '[tool:write] {"path": "/b"} cache key rot13',
      timestamp: 2,
    },
    { entryId: "t02", role: "user", text: "cache key rot13 in plain prose", timestamp: 3 },
    { entryId: "t03", role: "assistant", text: "cache key rot13 answered", timestamp: 4 },
  ]);
  return store;
}

test("grepView: a tool scope equals the unfiltered query plus the tool filter", () => {
  const store = seedTools();
  try {
    const scoped = hitIds(grepView(store, redactSecrets, { query: "cache", toolName: "read" }));
    assert.deepEqual(scoped, ["t00"]);
    const write = hitIds(grepView(store, redactSecrets, { query: "cache", toolName: "write" }));
    assert.deepEqual(write, ["t01"]);
    assert.ok(!scoped.includes("t02") && !scoped.includes("t03"));
    // An unknown tool name returns empty, not an error.
    const unknown = grepView(store, redactSecrets, { query: "cache", toolName: "nosuchtool" });
    assert.equal(unknown.ok, true);
    assert.match(unknown.text, /No matches/);
  } finally {
    store.close();
  }
});

test("grepView: toolName with a pattern is refused, not silently ignored", () => {
  const store = seedTools();
  try {
    const view = grepView(store, redactSecrets, { pattern: "cache", toolName: "read" });
    assert.equal(view.ok, false);
  } finally {
    store.close();
  }
});

test("orderSummariesByOverlap: query-word overlap orders headers deterministically", () => {
  const nodes = [
    { text: "unrelated weather report" },
    { text: "the compaction engine keeps history" },
    { text: "engine room compaction notes" },
    { text: "compaction engine" },
  ];
  const ordered = orderSummariesByOverlap("compaction engine repair", nodes);
  assert.deepEqual(
    ordered.map((n) => n.text),
    [
      "the compaction engine keeps history",
      "engine room compaction notes",
      "compaction engine",
      "unrelated weather report",
    ],
  );
  // Stop words carry no weight.
  assert.deepEqual(orderSummariesByOverlap("the and of", nodes), nodes);
  const tied = orderSummariesByOverlap("compaction", [nodes[1]!, nodes[3]!]);
  assert.deepEqual(tied, [nodes[1], nodes[3]]);
});

test("historyManifest: a query seeds overlap order without changing the set", () => {
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(store, [
      { entryId: "m00", role: "user", text: "compaction engine keeps history", timestamp: 1 },
      { entryId: "m01", role: "user", text: "weather report", timestamp: 2 },
      { entryId: "m02", role: "user", text: "weather report", timestamp: 3 },
    ]);
    for (const span of ["m00", "m01", "m02"]) {
      const ids = store.messagesInSpan(span, span).map((m) => m.id);
      store.insertSummary({
        kind: "leaf",
        text: span === "m00" ? "compaction engine keeps history" : "weather report",
        tokens: 2,
        depth: 0,
        firstEntryId: span,
        lastEntryId: span,
        messageIds: ids,
      });
    }
    const plain = historyManifest(store, 20);
    const seeded = historyManifest(store, 20, "compaction engine");
    const idsOf = (text: string) =>
      [...text.matchAll(/#(\d+)/g)]
        .flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
        .sort((a, b) => (a < b ? -1 : 1));
    assert.deepEqual(idsOf(plain), idsOf(seeded));
    assert.ok(plain.indexOf("m02 .. m02") < plain.indexOf("m00 .. m00"), plain);
    assert.ok(seeded.indexOf("m00 .. m00") < seeded.indexOf("m02 .. m02"), seeded);
  } finally {
    store.close();
  }
});

test("filesView: lists each linked file once, flags gaps, marks large-inline", () => {
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(store, [
      { entryId: "f00", role: "toolResult", text: "small body one", timestamp: 1 },
      { entryId: "f01", role: "toolResult", text: "small body two", timestamp: 2 },
      { entryId: "f02", role: "user", text: "plain prose with no file", timestamp: 3 },
      { entryId: "f03", role: "toolResult", text: `x`.repeat(LARGE_INLINE_CHARS), timestamp: 4 },
    ]);
    const byEntry = new Map(store.allMessages().map((m) => [m.entryId, m.id]));
    store.insertFile(
      {
        fileId: "file-a",
        path: "/a.txt",
        bytes: 10,
        sha256: "s",
        kind: "text",
        preview: "preview a",
      },
      "f00",
    );
    store.linkMessageFile(byEntry.get("f00")!, "file-a");
    store.linkMessageFile(byEntry.get("f01")!, "file-a");
    const covered = [byEntry.get("f00")!, byEntry.get("f01")!];
    store.insertSummary({
      kind: "leaf",
      text: "leaf over f00 f01",
      tokens: 2,
      depth: 0,
      firstEntryId: "f00",
      lastEntryId: "f01",
      messageIds: covered,
    });
    const view = filesView(store, redactSecrets);
    assert.equal(view.ok, true);
    assert.ok(view.text.includes("/a.txt (file-a"), view.text);
    assert.equal(view.text.match(/\/a\.txt/g)?.length, 1, view.text);
    assert.ok(view.text.includes("incomplete-coverage"), view.text);
    assert.deepEqual(view.details, {
      files: 1,
      uncovered: 2,
      largeInline: ["f03"],
      incompleteCoverage: true,
    });
    assert.ok(view.text.includes("large-inline"), view.text);
  } finally {
    store.close();
  }
});

test("filesView: a fully covered span with no files reports no gaps", () => {
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(store, [{ entryId: "g00", role: "user", text: "hello", timestamp: 1 }]);
    const ids = store.messagesInSpan("g00", "g00").map((m) => m.id);
    store.insertSummary({
      kind: "leaf",
      text: "leaf",
      tokens: 1,
      depth: 0,
      firstEntryId: "g00",
      lastEntryId: "g00",
      messageIds: ids,
    });
    const view = filesView(store, redactSecrets);
    assert.equal(view.ok, true);
    assert.ok(!view.text.includes("incomplete-coverage"), view.text);
  } finally {
    store.close();
  }
});

function seedSpan(n = 10): { store: LcmStore; leaf: number } {
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    Array.from({ length: n }, (_, i) => ({
      entryId: `e${String(i).padStart(2, "0")}`,
      role: "user" as const,
      text: `message ${i}`,
      timestamp: i,
    })),
  );
  const leaf = store.insertSummary({
    kind: "leaf",
    text: "leaf over the span",
    tokens: 2,
    depth: 0,
    firstEntryId: "e00",
    lastEntryId: `e${String(n - 1).padStart(2, "0")}`,
    messageIds: store.messagesInSpan("e00", `e${String(n - 1).padStart(2, "0")}`).map((m) => m.id),
  }).id;
  return { store, leaf };
}

function listedIds(view: ReturnType<typeof expandView>): string[] {
  assert.equal(view.ok, true);
  return view.text
    .split("\n")
    .filter((l) => l.startsWith("[e"))
    .map((l) => l.slice(1, l.indexOf("]")));
}

test("expandView: a mid-span anchor returns a window containing it with neighbors", () => {
  const { store, leaf } = seedSpan();
  try {
    const view = expandView(store, redactSecrets, {
      mode: "list",
      id: leaf,
      offset: 0,
      limit: 5,
      maxChars: 4000,
      anchor: "e05",
    });
    assert.deepEqual(listedIds(view), ["e03", "e04", "e05", "e06", "e07"]);
  } finally {
    store.close();
  }
});

test("expandView: span-edge anchors clamp instead of running past the ends", () => {
  const { store, leaf } = seedSpan();
  try {
    const head = expandView(store, redactSecrets, {
      mode: "list",
      id: leaf,
      offset: 0,
      limit: 5,
      maxChars: 4000,
      anchor: "e00",
    });
    assert.deepEqual(listedIds(head), ["e00", "e01", "e02", "e03", "e04"]);
    const tail = expandView(store, redactSecrets, {
      mode: "list",
      id: leaf,
      offset: 0,
      limit: 5,
      maxChars: 4000,
      anchor: "e09",
    });
    assert.deepEqual(listedIds(tail), ["e05", "e06", "e07", "e08", "e09"]);
  } finally {
    store.close();
  }
});

test("expandView: an unknown anchor returns a typed empty", () => {
  const { store, leaf } = seedSpan();
  try {
    const view = expandView(store, redactSecrets, {
      mode: "list",
      id: leaf,
      offset: 0,
      limit: 5,
      maxChars: 4000,
      anchor: "e99",
    });
    assert.equal(view.ok, false);
    assert.match(view.text, /No stored message with entry id e99/);
  } finally {
    store.close();
  }
});

test("grepView: a tool name with a quote builds a valid FTS5 phrase", () => {
  assert.equal(ftsPhrase('[tool:a"b]'), '"[tool:a""b]"');
  assert.equal(withToolScope("cache", 'a"b'), '(cache) AND "[tool:a""b]"');
  assert.equal(withToolScope("q", "t"), `(q) AND ${ftsPhrase(toolMarker("t"))}`);
  const store = seedTools();
  try {
    const view = grepView(store, redactSecrets, { query: "cache", toolName: 'a"b' });
    assert.equal(view.ok, true);
    assert.match(view.text, /No matches/);
  } finally {
    store.close();
  }
});

test("searchSessions: a quoted tool name shares the helper and stays valid", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-session-quote-"));
  const storePath = join(dir, "store.db");
  const setup = new LcmStore(storePath);
  try {
    ingestEntries(setup, [
      {
        entryId: "t00",
        role: "toolResult",
        text: '[tool:read] {"path": "/a"} cache key',
        timestamp: 1,
      },
    ]);
  } finally {
    setup.close();
  }
  try {
    const result = searchSessions(
      [
        {
          hash: "h",
          sessionFile: join(dir, "s.jsonl"),
          storePath,
          cwd: "/x",
          sessionId: "s",
          when: 1,
        },
      ],
      "cache",
      { toolName: 'a"b' },
    );
    assert.deepEqual(result.hits, []);
    assert.equal(result.scanned, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expandView: an anchor with a nonzero offset pages as an absolute index", () => {
  const { store, leaf } = seedSpan();
  try {
    const first = expandView(store, redactSecrets, {
      mode: "list",
      id: leaf,
      offset: 0,
      limit: 5,
      maxChars: 4000,
      anchor: "e05",
    });
    assert.deepEqual(listedIds(first), ["e03", "e04", "e05", "e06", "e07"]);
    assert.equal(first.ok === true && first.details.offset, 3);
    const second = expandView(store, redactSecrets, {
      mode: "list",
      id: leaf,
      offset: 8,
      limit: 5,
      maxChars: 4000,
      anchor: "e05",
    });
    assert.deepEqual(listedIds(second), ["e08", "e09"]);
    assert.equal(second.ok === true && second.details.offset, 8);
    assert.deepEqual(
      listedIds(second).filter((id) => listedIds(first).includes(id)),
      [],
    );
  } finally {
    store.close();
  }
});

function seedTiedManifest(): LcmStore {
  const store = new LcmStore(":memory:");
  ingestEntries(store, [
    { entryId: "m00", role: "user", text: "weather report", timestamp: 1 },
    { entryId: "m01", role: "user", text: "weather report", timestamp: 2 },
    { entryId: "m02", role: "user", text: "weather report", timestamp: 3 },
    { entryId: "m03", role: "user", text: "weather report", timestamp: 4 },
  ]);
  for (const span of ["m00", "m01", "m02", "m03"]) {
    const ids = store.messagesInSpan(span, span).map((m) => m.id);
    store.insertSummary({
      kind: "leaf",
      text: "weather report",
      tokens: 2,
      depth: 0,
      firstEntryId: span,
      lastEntryId: span,
      messageIds: ids,
    });
  }
  return store;
}

test("historyManifest: ties and wordless queries keep the newest summaries", () => {
  const store = seedTiedManifest();
  try {
    const tied = historyManifest(store, 2, "weather");
    assert.ok(tied.includes("m03 .. m03") && tied.includes("m02 .. m02"), tied);
    assert.ok(!tied.includes("m00 .. m00"), tied);
    const wordless = historyManifest(store, 2, "the and of");
    assert.ok(wordless.includes("m03 .. m03") && wordless.includes("m02 .. m02"), wordless);
    assert.ok(!wordless.includes("m00 .. m00"), wordless);
  } finally {
    store.close();
  }
});

test("historyManifest: the omitted label names overlap order or age", () => {
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(store, [
      { entryId: "m00", role: "user", text: "compaction engine keeps history", timestamp: 1 },
      { entryId: "m01", role: "user", text: "weather report", timestamp: 2 },
      { entryId: "m02", role: "user", text: "weather report", timestamp: 3 },
    ]);
    for (const span of ["m00", "m01", "m02"]) {
      const ids = store.messagesInSpan(span, span).map((m) => m.id);
      store.insertSummary({
        kind: "leaf",
        text: span === "m00" ? "compaction engine keeps history" : "weather report",
        tokens: 2,
        depth: 0,
        firstEntryId: span,
        lastEntryId: span,
        messageIds: ids,
      });
    }
    const plain = historyManifest(store, 1);
    assert.match(plain, /\(2 older not listed\)/);
    const seeded = historyManifest(store, 1, "compaction engine");
    assert.match(seeded, /\(2 lower-overlap not listed\)/);
    assert.ok(!seeded.includes("older not listed"), seeded);
  } finally {
    store.close();
  }
});

function seedPiCallResult(): LcmStore {
  const store = new LcmStore(":memory:");
  ingestEntries(store, [
    { entryId: "p00", role: "assistant", text: '[tool:read] {"path": "/a"}', timestamp: 1 },
    {
      entryId: "p01",
      role: "toolResult",
      text: "file body holds uniqueword123 nowhere else",
      timestamp: 2,
    },
    { entryId: "p02", role: "user", text: "unrelated chatter", timestamp: 3 },
  ]);
  return store;
}

test("grepView: a tool scope finds a Pi result row after its call row", () => {
  const store = seedPiCallResult();
  try {
    const scoped = hitIds(
      grepView(store, redactSecrets, { query: "uniqueword123", toolName: "read" }),
    );
    assert.deepEqual(scoped, ["p01"]);
    const wrongTool = grepView(store, redactSecrets, {
      query: "uniqueword123",
      toolName: "write",
    });
    assert.equal(wrongTool.ok, true);
    assert.match(wrongTool.text, /No matches/);
    const asResult = hitIds(
      grepView(store, redactSecrets, {
        query: "uniqueword123",
        toolName: "read",
        role: "toolResult",
      }),
    );
    assert.deepEqual(asResult, ["p01"]);
  } finally {
    store.close();
  }
});

test("grepView: a tool scope keeps fetching until the filtered page is complete", () => {
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(store, [
      ...Array.from({ length: 22 }, (_, i) => ({
        entryId: `u${String(i).padStart(2, "0")}`,
        role: "user" as const,
        text: Array(10).fill("targetword").join(" "),
        timestamp: i + 1,
      })),
      {
        entryId: "c00",
        role: "assistant" as const,
        text: '[tool:read] {"path": "/a"}',
        timestamp: 100,
      },
      {
        entryId: "r00",
        role: "toolResult" as const,
        text: `targetword ${"filler prose ".repeat(20)}`,
        timestamp: 101,
      },
      {
        entryId: "r01",
        role: "toolResult" as const,
        text: `targetword ${"filler prose ".repeat(20)}`,
        timestamp: 102,
      },
    ]);
    const view = grepView(store, redactSecrets, {
      query: "targetword",
      toolName: "read",
      limit: 20,
    });
    assert.equal(view.ok, true);
    assert.deepEqual(view.details, { hits: 2, offset: 0, total: 2 });
    assert.ok(view.text.includes("[r00]") && view.text.includes("[r01]"), view.text);
  } finally {
    store.close();
  }
});

test("searchSessions: a tool scope finds a Pi result row after its call row", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-session-pi-"));
  const storePath = join(dir, "store.db");
  const setup = new LcmStore(storePath);
  try {
    ingestEntries(setup, [
      { entryId: "p00", role: "assistant", text: '[tool:read] {"path": "/a"}', timestamp: 1 },
      {
        entryId: "p01",
        role: "toolResult",
        text: "file body holds uniqueword123 nowhere else",
        timestamp: 2,
      },
    ]);
  } finally {
    setup.close();
  }
  try {
    const result = searchSessions(
      [
        {
          hash: "h",
          sessionFile: join(dir, "s.jsonl"),
          storePath,
          cwd: "/x",
          sessionId: "s",
          when: 1,
        },
      ],
      "uniqueword123",
      { toolName: "read" },
    );
    assert.equal(result.scanned, 1);
    assert.deepEqual(
      result.hits.map((h) => h.entryId),
      ["p01"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toolScope: a user-quoted marker opens no scope but mixed assistant still matches", () => {
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(store, [
      { entryId: "u00", role: "user", text: 'quoting "[tool:read]" in prose', timestamp: 1 },
      { entryId: "r00", role: "toolResult", text: "followword body here", timestamp: 2 },
      { entryId: "c00", role: "custom", text: 'quoting "[tool:read]" in prose', timestamp: 3 },
      { entryId: "r01", role: "toolResult", text: "customfollowword body here", timestamp: 4 },
      {
        entryId: "a00",
        role: "assistant",
        text: 'checking [tool:read] {"path": "/a"} plus prose',
        timestamp: 5,
      },
      { entryId: "r02", role: "toolResult", text: "mixedword body here", timestamp: 6 },
    ]);
    const byEntry = new Map(store.allMessages().map((m) => [m.entryId, m.id]));
    const scoped = toolScopeMessageIds(store, "read");
    assert.ok(!scoped.has(byEntry.get("u00")!), "user marker row opens no scope");
    assert.ok(!scoped.has(byEntry.get("r00")!), "result after a user marker stays out");
    assert.ok(!scoped.has(byEntry.get("c00")!), "custom marker row opens no scope");
    assert.ok(!scoped.has(byEntry.get("r01")!), "result after a custom marker stays out");
    assert.ok(scoped.has(byEntry.get("a00")!), "mixed assistant marker still opens");
    assert.ok(scoped.has(byEntry.get("r02")!), "result after mixed assistant stays in");
    const missed = grepView(store, redactSecrets, { query: "followword", toolName: "read" });
    assert.equal(missed.ok, true);
    assert.match(missed.text, /No matches/);
    const kept = hitIds(grepView(store, redactSecrets, { query: "mixedword", toolName: "read" }));
    assert.deepEqual(kept, ["r02"]);
  } finally {
    store.close();
  }
});

test("grepView: an unbalanced-quote query falls back to a phrase search", () => {
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(store, [
      { entryId: "p00", role: "assistant", text: '[tool:read] {"path": "/a"}', timestamp: 1 },
      { entryId: "p01", role: "toolResult", text: "hello world cache here", timestamp: 2 },
    ]);
    const plain = grepView(store, redactSecrets, { query: 'hello"' });
    assert.equal(plain.ok, true);
    assert.ok(plain.text.includes("[p01]"), plain.text);
    const scoped = grepView(store, redactSecrets, { query: 'hello"', toolName: "read" });
    assert.equal(scoped.ok, true);
    assert.ok(scoped.text.includes("[p01]"), scoped.text);
    const miss = grepView(store, redactSecrets, { query: 'foo"', toolName: "read" });
    assert.equal(miss.ok, true);
    assert.match(miss.text, /No matches/);
  } finally {
    store.close();
  }
});

test("searchSessions: an unbalanced-quote query runs a phrase search", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-session-phrase-"));
  const storePath = join(dir, "store.db");
  const setup = new LcmStore(storePath);
  try {
    ingestEntries(setup, [
      { entryId: "p00", role: "assistant", text: '[tool:read] {"path": "/a"}', timestamp: 1 },
      { entryId: "p01", role: "toolResult", text: "hello world cache here", timestamp: 2 },
    ]);
  } finally {
    setup.close();
  }
  const ref = {
    hash: "h",
    sessionFile: join(dir, "s.jsonl"),
    storePath,
    cwd: "/x",
    sessionId: "s",
    when: 1,
  };
  try {
    const plain = searchSessions([ref], 'hello"');
    assert.equal(plain.scanned, 1);
    assert.deepEqual(
      plain.hits.map((h) => h.entryId),
      ["p01"],
    );
    const scoped = searchSessions([ref], 'hello"', { toolName: "read" });
    assert.equal(scoped.scanned, 1);
    assert.deepEqual(
      scoped.hits.map((h) => h.entryId),
      ["p01"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
