import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { ingestEntries } from "../src/ingest.ts";
import {
  expandView,
  filesView,
  grepView,
  historyManifest,
  LARGE_INLINE_CHARS,
  orderSummariesByOverlap,
} from "../src/recall-view.ts";
import { redactSecrets } from "../src/redact.ts";
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
    // Non-tool messages never match a tool scope.
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
  // Stop words carry no weight: a query of only stop words keeps input order.
  assert.deepEqual(orderSummariesByOverlap("the and of", nodes), nodes);
  // Ties keep input order, so the ordering is deterministic.
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
    // The plain manifest lists newest first (m02 ahead of m00); the seeded one
    // floats the overlap winner (m00) to the top without changing the set.
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
    // Same file linked from two messages reads once.
    store.linkMessageFile(byEntry.get("f01")!, "file-a");
    // Only the first two messages are covered, so the span has gaps.
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
