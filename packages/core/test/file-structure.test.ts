import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { estimateTokens } from "../src/estimate-tokens.ts";
import { describeFile, filePreviewText } from "../src/files.ts";
import { ingestEntries } from "../src/ingest.ts";
import { describeView } from "../src/recall-view.ts";
import { redactSecrets } from "../src/redact.ts";
import { LcmStore } from "../src/store.ts";
import { storedPass } from "./support/pass-outcome.ts";

function structureLine(path: string, text: string): string {
  return describeFile(path, text).preview.split("\n")[0]!;
}

test("structure: code names its top-level declarations, per family", () => {
  assert.equal(
    structureLine(
      "/x/engine.ts",
      [
        'import { a } from "./a.ts";',
        "",
        "export const POLICY = { x: 1 };",
        "export interface Options {",
        "\tz: string;",
        "}",
        "",
        "export async function compact(options: Options) {",
        "\treturn 1;",
        "}",
        "class Engine {}",
        "function helper() {}",
        "type Kind = string;",
      ].join("\n"),
    ),
    "TypeScript, 13 lines; 6 top-level declaration(s): const POLICY, interface Options, function compact, class Engine, function helper, type Kind",
  );
  assert.equal(
    structureLine(
      "/x/p.py",
      "def parse(x):\n    def inner():\n        pass\n\nclass Thing:\n    pass\n",
    ),
    "Python, 7 lines; 2 top-level declaration(s): def parse, class Thing",
  );
  assert.equal(
    structureLine("/x/lib.rs", "pub fn load() {}\nstruct Node {}\nimpl Node {}\ntrait Loader {}\n"),
    "Rust, 5 lines; 4 top-level declaration(s): fn load, struct Node, impl Node, trait Loader",
  );
  assert.equal(
    structureLine("/x/main.go", "package main\n\nfunc main() {\n}\n\ntype Config struct{}\n"),
    "Go, 7 lines; 3 top-level declaration(s): package main, func main, type Config",
  );
  assert.equal(
    structureLine("/x/s.sh", "set -e\n\nrun() {\n  echo hi\n}\n"),
    "Shell, 6 lines; 1 top-level declaration(s): function run",
  );
  assert.equal(
    structureLine(
      "/x/q.sql",
      "CREATE TABLE messages (id INTEGER);\nCREATE INDEX idx ON messages(id);\n",
    ),
    "SQL, 3 lines; 2 statement(s): table messages, index idx",
  );
});

test("structure: structured data names its shape and one level of nesting", () => {
  assert.equal(
    structureLine(
      "/x/rows.json",
      JSON.stringify(Array.from({ length: 412 }, (_, i) => ({ id: i, name: `r${i}` }))),
    ),
    "array of 412 objects, keys: id, name",
  );
  assert.equal(
    structureLine(
      "/x/doc.json",
      JSON.stringify({ version: 1, messages: [{ id: 1 }], meta: { a: 1 }, files: [] }),
    ),
    "object with 4 key(s): version, messages, meta, files; nested messages: array of 1 objects; meta: object with 1 key(s); files: empty array",
  );
  assert.equal(
    structureLine("/x/list.json", JSON.stringify(["a", "b", "c"])),
    "array of 3 strings",
  );
  assert.equal(
    structureLine("/x/rows.jsonl", '{"event":"a","kind":"b","session":"s"}\n{"event":"c"}\n'),
    "2 JSON rows; first row keys: event, kind, session",
  );
  assert.equal(
    structureLine("/x/rows.csv", "id,name,score\n1,a,2\n2,b,3\n"),
    "3 rows, 3 columns: id, name, score",
  );
  assert.equal(structureLine("/x/rows.tsv", "id\tname\n1\ta\n"), "2 rows, 2 columns: id, name");
});

test("structure: text and Markdown name their outline", () => {
  assert.equal(
    structureLine("/x/README.md", "# LCM\n\ntext\n\n## Install\n\nmore\n\n### Config\n"),
    "Markdown, 10 lines; 3 heading(s): # LCM, ## Install, ### Config",
  );
  assert.equal(
    structureLine("/x/notes.txt", "first line here\n\nsecond paragraph\n\nthird\n"),
    "6 lines, 3 paragraph(s); first line: first line here",
  );
});

test("structure: a family with no rule reports its size rather than guessing", () => {
  assert.equal(
    structureLine("/x/style.css", "body { color: red; }\n.a { color: blue; }\n"),
    "CSS, 3 lines",
  );
  assert.equal(
    structureLine("/x/page.html", "<html>\n<body>hi</body>\n</html>\n"),
    "HTML, 4 lines",
  );
  assert.equal(structureLine("/x/empty.ts", "// just a comment\n"), "TypeScript, 2 lines");
});

test("structure: the summary is bounded whatever the body holds", () => {
  const many = Array.from({ length: 5_000 }, (_, i) => `export function fn${i}() {}`).join("\n");
  const summary = structureLine("/x/huge.ts", many);
  assert.match(summary, /^TypeScript, 5000 lines; 5000 top-level declaration\(s\): function fn0, /);
  assert.match(summary, /\(\+4988 more\)$/);
  const long = structureLine("/x/long.ts", `export function ${"n".repeat(500)}() {}\n`);
  assert.ok(long.includes("…"), long);
  assert.ok(long.length < 200, `${long.length} chars`);
  const big = describeFile("/x/huge.ts", many);
  assert.ok(big.preview.length < 1_500, `${big.preview.length} chars`);
});

test("structure: the descriptor is a fraction of the body it describes", () => {
  const rows = Array.from({ length: 900 }, (_, i) => ({
    id: i,
    name: `row ${i}`,
    score: i * 3,
    note: "x".repeat(200),
  }));
  const body = JSON.stringify(rows);
  const preview = filePreviewText(describeFile("/x/big.json", body));
  const bodyTokens = estimateTokens(body);
  const previewTokens = estimateTokens(preview);
  assert.ok(
    previewTokens * 10 < bodyTokens,
    `preview ${previewTokens} tokens vs body ${bodyTokens}`,
  );
  assert.match(preview, /array of 900 objects, keys: id, name, score, note/);

  const source = Array.from(
    { length: 2_000 },
    (_, i) => `export function fn${i}(input: string) {\n\treturn input.repeat(${i});\n}`,
  ).join("\n");
  const codeTokens = estimateTokens(source);
  const codePreview = estimateTokens(filePreviewText(describeFile("/x/big.ts", source)));
  assert.ok(codePreview * 10 < codeTokens, `preview ${codePreview} tokens vs source ${codeTokens}`);
});

test("structure: a re-ingest of the same bytes keeps one row and rewrites the preview", () => {
  const s = new LcmStore(":memory:");
  const body = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, name: `r${i}` })));
  const entry = {
    entryId: "e0",
    role: "toolResult" as const,
    text: body,
    timestamp: 0,
    fileHint: { path: "/x/big.json" },
  };
  ingestEntries(s, [entry], { externalize: { largeFileChars: 1000 } });
  const first = s.allFiles();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.preview.split("\n")[0], "array of 400 objects, keys: id, name");
  ingestEntries(s, [entry], { externalize: { largeFileChars: 1000 } });
  assert.equal(s.allFiles().length, 1, "the same bytes are the same file id");
  s.close();
});

test("structure: lcm_describe names each file's structure", async () => {
  const s = new LcmStore(":memory:");
  const body = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, name: `r${i}` })));
  ingestEntries(
    s,
    [
      { entryId: "e0", role: "user", text: "look at this", timestamp: 0 },
      {
        entryId: "e1",
        role: "toolResult",
        text: body,
        timestamp: 1,
        fileHint: { path: "/x/big.json" },
      },
    ],
    { externalize: { largeFileChars: 1000 } },
  );
  const outcome = await storedPass(
    s,
    {
      span: [
        { entryId: "e0", role: "user", text: "look at this" },
        { entryId: "e1", role: "toolResult", text: body },
      ],
      targetTokens: 1500,
    },
    async () => "summarized",
    { leafChunkTokens: 8000, maxChunks: 2 },
  );
  const described = describeView(s, redactSecrets, outcome.leafSummaryIds[0]!);
  assert.ok(described.ok);
  if (!described.ok) return;
  assert.match(
    described.text,
    /Files: \/x\/big\.json \([^)]*json; array of 400 objects, keys: id, name\)/,
  );
  assert.ok(described.text.length < 1_000, `${described.text.length} chars`);
  s.close();
});
