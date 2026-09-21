import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "vite-plus/test";

import { EXPORT_VERSION, exportTranscript } from "../src/export.ts";
import { describeFile, filePreviewText, kindOf } from "../src/files.ts";
import { importTranscript, parseExport } from "../src/import.ts";
import { ingestEntries } from "../src/ingest.ts";
import { describeView } from "../src/recall-view.ts";
import { redactSecrets } from "../src/redact.ts";
import { LcmStore } from "../src/store.ts";
import { storedPass } from "./support/pass-outcome.ts";

const POLICY = { externalize: { largeFileChars: 1000 } };

function jsonBody(rows: number): string {
  return JSON.stringify(Array.from({ length: rows }, (_, i) => ({ id: i, name: `row ${i}` })));
}

test("files: the kind comes from the structure, with the extension as a fallback", () => {
  assert.equal(kindOf("/x/a.json", jsonBody(3)), "json");
  assert.equal(kindOf("/x/a.ts", jsonBody(3)), "json");
  assert.equal(kindOf("/x/a.txt", '{"a":1}\n{"a":2}\n'), "jsonl");
  assert.equal(kindOf("/x/a.csv", "id,name\n1,alpha\n2,beta\n"), "csv");
  assert.equal(kindOf("/x/a.tsv", "id\tname\n1\talpha\n"), "tsv");
  assert.equal(kindOf("/x/a.ts", "export const a = 1;\n"), "code");
  assert.equal(kindOf("/x/notes.md", "just prose, no structure here\n"), "code");
  assert.equal(kindOf("/x/a.txt", "just prose, no structure here\n"), "text");
  assert.equal(kindOf("/x/a.txt", "hello, world\nand a second line\n"), "text");
});

test("files: the descriptor names the revision and describes the body", () => {
  const body = jsonBody(412);
  const d = describeFile("/Users/x/big.json", body);
  assert.equal(d.fileId.length, 16);
  assert.equal(d.sha256.length, 64);
  assert.equal(d.bytes, body.length);
  assert.equal(d.path, "/Users/x/big.json");
  assert.equal(d.kind, "json");
  assert.equal(d.preview.split("\n")[0], "array of 412 objects, keys: id, name");
  assert.deepEqual(describeFile("/other/path.json", body).fileId, d.fileId);

  const code = describeFile("/x/engine.ts", "export const a = 1;\nexport const b = 2;\n");
  assert.equal(code.kind, "code");
  assert.equal(
    code.preview.split("\n")[0],
    "TypeScript, 3 lines; 2 top-level declaration(s): const a, const b",
  );

  const csv = describeFile("/x/rows.csv", "id,name\n1,alpha\n2,beta\n");
  assert.equal(csv.preview.split("\n")[0], "3 rows, 2 columns: id, name");
});

test("files: the handle and the description are what a summarizer reads", () => {
  const d = describeFile("/x/big.json", jsonBody(9));
  assert.equal(
    filePreviewText(d).split("\n")[0],
    `[lcm:file /x/big.json (${d.fileId}, ${d.bytes} chars, json)]`,
  );
  assert.equal(filePreviewText(d).split("\n")[1], "array of 9 objects, keys: id, name");
});

test("ingest: a large body with a named path becomes a file handle", () => {
  const s = new LcmStore(":memory:");
  const body = jsonBody(400);
  const stats = ingestEntries(
    s,
    [
      {
        entryId: "e0",
        role: "toolResult",
        text: body,
        timestamp: 1,
        fileHint: { path: "/x/big.json" },
      },
    ],
    POLICY,
  );
  assert.equal(stats.files.length, 1);
  assert.deepEqual(stats.files[0], {
    entryId: "e0",
    fileId: describeFile("/x/big.json", body).fileId,
    path: "/x/big.json",
    kind: "json",
    bytes: body.length,
  });
  assert.deepEqual(stats.largeInline, []);
  assert.equal(s.messageByEntryId("e0")!.text.length, body.length);
  const refs = s.filesForMessages([s.messageByEntryId("e0")!.id]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.messageId, 1);
  assert.equal(refs[0]!.path, "/x/big.json");
  assert.equal(s.fileIdsForMessages([1]).length, 1);
  const stats2 = s.stats();
  assert.equal(stats2.files, 1);
  assert.equal(stats2.fileBytes, body.length);
  s.close();
});

test("ingest: a large body with no path is reported, not externalized", () => {
  const s = new LcmStore(":memory:");
  const body = "p".repeat(2000);
  const stats = ingestEntries(
    s,
    [{ entryId: "e0", role: "user", text: body, timestamp: 1 }],
    POLICY,
  );
  assert.deepEqual(stats.files, []);
  assert.deepEqual(stats.largeInline, [{ entryId: "e0", chars: 2000 }]);
  assert.equal(s.stats().files, 0);
  const small = ingestEntries(
    s,
    [
      {
        entryId: "e1",
        role: "toolResult",
        text: "short",
        timestamp: 2,
        fileHint: { path: "/x/s" },
      },
    ],
    POLICY,
  );
  assert.deepEqual(small.files, []);
  assert.deepEqual(small.largeInline, []);
  s.close();
});

test("ingest: externalization off leaves the body as ordinary text", () => {
  const s = new LcmStore(":memory:");
  const stats = ingestEntries(s, [
    {
      entryId: "e0",
      role: "toolResult",
      text: jsonBody(400),
      timestamp: 1,
      fileHint: { path: "/x/big.json" },
    },
  ]);
  assert.deepEqual(stats.files, []);
  assert.deepEqual(stats.largeInline, []);
  assert.equal(s.stats().files, 0);
  s.close();
});

test("ingest: the descriptor names the retained bytes, preview included", () => {
  const s = new LcmStore(":memory:");
  const key = "sk-ant-0123456789abcdefghij";
  const body = `notes before the key\nthe deploy key is ${key}\n${"filler line\n".repeat(120)}`;
  const stats = ingestEntries(
    s,
    [
      {
        entryId: "e0",
        role: "toolResult",
        text: body,
        timestamp: 1,
        fileHint: { path: "/x/b.md" },
      },
    ],
    POLICY,
  );
  const stored = s.messageByEntryId("e0")!;
  assert.equal(stored.text, body, "the row is the input, byte for byte");
  assert.equal(stats.files[0]!.bytes, stored.text.length, "the count is what a reader gets");
  assert.equal(stats.files[0]!.fileId, describeFile("/x/b.md", stored.text).fileId);
  const refs = s.filesForMessages([stored.id]);
  assert.equal(refs.length, 1, "the descriptor is linked to the message");
  assert.ok(refs[0]!.preview.includes(key), refs[0]!.preview);
  assert.equal(refs[0]!.fileId, stats.files[0]!.fileId);
  s.close();
});

test("compaction: a file body is represented by its handle, and the leaf carries it", async () => {
  const s = new LcmStore(":memory:");
  const body = jsonBody(500);
  ingestEntries(
    s,
    [
      { entryId: "e0", role: "user", text: "look at this file", timestamp: 0 },
      {
        entryId: "e1",
        role: "toolResult",
        text: body,
        timestamp: 1,
        fileHint: { path: "/x/big.json" },
      },
    ],
    POLICY,
  );
  const prompts: string[] = [];
  const outcome = await storedPass(
    s,
    {
      span: [
        { entryId: "e0", role: "user", text: "look at this file" },
        { entryId: "e1", role: "toolResult", text: body },
      ],
      targetTokens: 1500,
    },
    async (_system, userText) => {
      prompts.push(userText);
      return "summarized";
    },
    { leafChunkTokens: 8000, maxChunks: 2 },
  );
  assert.equal(outcome.leafSummaryIds.length, 1);
  const leaf = s.getSummary(outcome.leafSummaryIds[0]!)!;
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes("[lcm:file /x/big.json ("), prompts[0]!.slice(0, 200));
  assert.ok(prompts[0]!.includes("array of 500 objects, keys: id, name"));
  assert.equal(
    prompts[0]!.includes(body.slice(1500, 1700)),
    false,
    "the body past the preview is not in the summarizer input",
  );
  const described = describeView(s, redactSecrets, leaf.id);
  assert.ok(described.ok);
  if (!described.ok) return;
  assert.ok(
    described.text.includes(
      `Files: /x/big.json (${describeFile("/x/big.json", body).fileId}, ${body.length} chars, json; array of 500 objects, keys: id, name)`,
    ),
    described.text,
  );
  s.close();
});

test("compaction: a parent node inherits the file handles of its children", async () => {
  const s = new LcmStore(":memory:");
  const spans = [
    { entryId: "e0", file: "/x/a.json", body: jsonBody(300) },
    { entryId: "e1", file: "/x/b.json", body: jsonBody(320) },
  ];
  ingestEntries(
    s,
    spans.map((x, i) => ({
      entryId: x.entryId,
      role: "toolResult" as const,
      text: x.body,
      timestamp: i,
      fileHint: { path: x.file },
    })),
    POLICY,
  );
  const outcome = await storedPass(
    s,
    {
      span: spans.map((x) => ({ entryId: x.entryId, role: "toolResult" as const, text: x.body })),
      targetTokens: 1,
    },
    async (_s, userText) => (userText.includes("a.json") ? "leaf one" : "leaf two"),
    { leafChunkTokens: 3000, maxChunks: 2 },
  );
  assert.equal(outcome.leafSummaryIds.length, 2);
  assert.equal(outcome.condensedSummaryIds.length, 1, "two nodes over a 1-token target condense");
  const parent = s.getSummary(outcome.condensedSummaryIds[0]!)!;
  const files = s.filesForSummaries([parent.id]).map((f) => f.path);
  assert.deepEqual(files, ["/x/a.json", "/x/b.json"]);
  const described = describeView(s, redactSecrets, parent.id);
  assert.ok(described.ok);
  if (!described.ok) return;
  assert.ok(described.text.includes("/x/a.json"), described.text);
  assert.ok(described.text.includes("/x/b.json"), described.text);
  s.close();
});

test("export and import: file rows round trip with their message links", () => {
  const source = new LcmStore(":memory:");
  const body = jsonBody(400);
  ingestEntries(
    source,
    [
      {
        entryId: "e0",
        role: "toolResult",
        text: body,
        timestamp: 1,
        fileHint: { path: "/x/big.json" },
      },
    ],
    POLICY,
  );
  const text = exportTranscript(source).toJSONL();
  const rows = text.split("\n").map((l) => JSON.parse(l) as { rowType: string; v: number });
  const fileRow = rows.find((r) => r.rowType === "file")!;
  assert.equal(fileRow.v, EXPORT_VERSION);

  const target = new LcmStore(":memory:");
  const result = importTranscript(target, (parseExport(text) as { rows: never[] }).rows);
  assert.equal(result.messagesInserted, 1);
  const refs = target.filesForMessages([target.allMessages()[0]!.id]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.path, "/x/big.json");
  assert.equal(refs[0]!.preview, describeFile("/x/big.json", body).preview);
  target.close();
  source.close();
});

test("import: a file row naming a kind this build does not know is refused", () => {
  const row = JSON.stringify({
    v: EXPORT_VERSION,
    rowType: "file",
    fileId: "0123456789abcdef",
    path: "/x/a.yaml",
    bytes: 10,
    sha256: "a".repeat(64),
    kind: "yaml",
    preview: "1 element(s)",
    entryIds: [],
  });
  const parsed = parseExport(row);
  assert.ok("error" in parsed);
  assert.match(
    (parsed as { error: string }).error,
    /file kind "yaml"; this build reads json, jsonl, csv, tsv, code, text/,
  );
});

test("store: a file row whose kind this build cannot read comes back as text", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-filekind-"));
  const store = new LcmStore(join(dir, "store.db"));
  try {
    const raw = new DatabaseSync(join(dir, "store.db"));
    raw
      .prepare(
        "INSERT INTO files (file_id, path, bytes, sha256, kind, preview, first_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("0123456789abcdef", "/x/a.yaml", 10, "a".repeat(64), "yaml", "1 element(s)", "e0", 0);
    raw.close();
    assert.equal(store.allFiles()[0]!.kind, "text");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("import: a file row naming an entry the file does not hold is refused", () => {
  const row = (entryIds: string[]) =>
    JSON.stringify({
      v: EXPORT_VERSION,
      rowType: "file",
      fileId: "0123456789abcdef",
      path: "/x/a.json",
      bytes: 10,
      sha256: "a".repeat(64),
      kind: "json",
      preview: "1 element(s)",
      entryIds,
    });
  const parsed = parseExport(row(["missing"]));
  assert.ok("rows" in parsed);
  const target = new LcmStore(":memory:");
  const result = importTranscript(target, (parsed as { rows: never[] }).rows);
  assert.match(result.refused ?? "", /came from entry missing/);
  assert.equal(target.stats().files, 0);
  target.close();
});
