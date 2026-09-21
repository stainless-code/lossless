import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { EXPORT_VERSION, exportTranscript } from "../src/export.ts";
import { importTranscript, parseExport } from "../src/import.ts";
import { ingestEntries } from "../src/ingest.ts";
import { LcmStore } from "../src/store.ts";

function seeded(n = 6): LcmStore {
  const s = new LcmStore(":memory:");
  ingestEntries(
    s,
    Array.from({ length: n }, (_, i) => ({
      entryId: `e${String(i).padStart(2, "0")}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `message ${i} about the compaction engine ${"filler ".repeat(12)}`,
      timestamp: i,
    })),
  );
  const ids = s.messagesInSpan("e00", "e05").map((m) => m.id);
  const leafA = s.insertSummary({
    kind: "leaf",
    text: "leaf over e00..e02",
    tokens: 40,
    depth: 0,
    firstEntryId: "e00",
    lastEntryId: "e02",
    messageIds: ids.slice(0, 3),
  });
  if (!leafA.created) throw new Error("fixture leaf A collided");
  const leafB = s.insertSummary({
    kind: "leaf",
    text: "leaf over e03..e05",
    tokens: 40,
    depth: 0,
    firstEntryId: "e03",
    lastEntryId: "e05",
    messageIds: ids.slice(3),
  });
  if (!leafB.created) throw new Error("fixture leaf B collided");
  const parent = s.insertSummary({
    kind: "condensed",
    text: "condensed over both leaves",
    tokens: 30,
    depth: 1,
    firstEntryId: "e00",
    lastEntryId: "e05",
    childSummaryIds: [leafA.id, leafB.id],
  });
  if (!parent.created) throw new Error("fixture parent collided");
  return s;
}

function shape(s: LcmStore): Array<{ kind: string; depth: number; covered: string[] }> {
  return s.allSummaries().map((n) => ({
    kind: n.kind,
    depth: n.depth,
    covered: s.messagesByIds(s.coveredMessageIds(n.id)).map((m) => m.entryId),
  }));
}

test("import: an exported store survives the round trip with its provenance", async () => {
  const source = seeded();
  const text = exportTranscript(source).toJSONL();

  const target = new LcmStore(":memory:");
  const parsed = parseExport(text);
  assert.ok("rows" in parsed, "the file this build writes parses");
  const result = importTranscript(target, (parsed as { rows: never[] }).rows);

  assert.equal(result.refused, undefined);
  assert.equal(result.messagesInserted, 6);
  assert.equal(result.summariesInserted, 3);
  assert.deepEqual(
    target.allMessages().map((m) => m.entryId),
    source.allMessages().map((m) => m.entryId),
  );
  assert.deepEqual(shape(target), shape(source), "kind, depth, and covered span all match");
  assert.deepEqual(
    target.frontier("e00", "e05").map((n) => n.text),
    source.frontier("e00", "e05").map((n) => n.text),
  );
  target.close();
  source.close();
});

test("import: a re-import of the same file writes nothing", async () => {
  const source = seeded();
  const rows = (parseExport(exportTranscript(source).toJSONL()) as { rows: never[] }).rows;
  const target = new LcmStore(":memory:");
  importTranscript(target, rows);
  const again = importTranscript(target, rows);
  assert.equal(again.messagesInserted, 0);
  assert.equal(again.messagesSkipped, 6);
  assert.equal(again.summariesInserted, 0);
  assert.equal(again.summariesSkipped, 3);
  target.close();
  source.close();
});

test("import: a malformed line is refused with its number, before anything is written", () => {
  const text = [
    JSON.stringify({
      v: EXPORT_VERSION,
      rowType: "message",
      entryId: "e00",
      role: "user",
      text: "one",
      tokens: 1,
      timestamp: 1,
    }),
    "{not json",
  ].join("\n");
  const parsed = parseExport(text);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /line 2 is not JSON/);
});

test("import: a file without the version header is refused, and so is an empty one", () => {
  const noVersion = parseExport(
    JSON.stringify({
      rowType: "message",
      entryId: "e00",
      role: "user",
      text: "x",
      tokens: 1,
      timestamp: 1,
    }),
  );
  assert.ok("error" in noVersion);
  assert.match((noVersion as { error: string }).error, /version/);
  const empty = parseExport("\n\n");
  assert.ok("error" in empty);
  assert.match((empty as { error: string }).error, /no rows/);
});

test("import: a store holding a different history is refused, not merged", () => {
  const source = seeded();
  const rows = (parseExport(exportTranscript(source).toJSONL()) as { rows: never[] }).rows;
  const target = new LcmStore(":memory:");
  ingestEntries(target, [
    { entryId: "other", role: "user", text: "a different session", timestamp: 1 },
  ]);
  const result = importTranscript(target, rows);
  assert.match(result.refused ?? "", /already holds 1 message/);
  assert.equal(result.messagesInserted, 0);
  assert.equal(target.allSummaries().length, 0, "nothing was written");
  target.close();
  source.close();
});

test("import: provenance naming a child the file does not hold is refused", () => {
  const row = (ordinal: number, children: number[]) =>
    JSON.stringify({
      v: EXPORT_VERSION,
      rowType: "summary",
      ordinal,
      kind: "condensed",
      text: "s",
      tokens: 1,
      depth: 1,
      firstEntryId: "e00",
      lastEntryId: "e01",
      messageEntryIds: [],
      childOrdinals: children,
    });
  const parsed = parseExport(row(0, [7]));
  assert.ok("rows" in parsed);
  const target = new LcmStore(":memory:");
  const result = importTranscript(target, (parsed as { rows: never[] }).rows);
  assert.match(result.refused ?? "", /names child 7/);
  assert.equal(target.allSummaries().length, 0);
  target.close();
});

test("import: a role outside the stored four folds on the way in", () => {
  const source = seeded();
  const rows = (
    parseExport(exportTranscript(source).toJSONL()) as {
      rows: { rowType: string; role?: string }[];
    }
  ).rows;
  const first = rows.find((r) => r.rowType === "message");
  if (!first) throw new Error("the round-trip export holds no message row");
  first.role = "branchSummary";

  const target = new LcmStore(":memory:");
  const result = importTranscript(target, rows as never[]);
  assert.equal(result.refused, undefined);
  assert.equal(
    target.allMessages().find((m) => m.entryId === "e00")?.role,
    "custom",
    "a role Pi may emit but the store does not carry folds to custom",
  );
  target.close();
  source.close();
});
