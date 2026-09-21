import { createHash } from "node:crypto";

/** Characters of a body's description that stay in the preview. The message row
 * keeps every character, so this bounds what the summarizer reads, not what is
 * retained. */
export const FILE_PREVIEW_CHARS = 1200;

export const FILE_KINDS = ["json", "jsonl", "csv", "tsv", "code", "text"] as const;

export type FileKind = (typeof FILE_KINDS)[number];

export function isFileKind(value: unknown): value is FileKind {
  return typeof value === "string" && FILE_KINDS.some((k) => k === value);
}

export interface FileDescriptor {
  fileId: string;
  path: string;
  /** Characters retained in the message, not bytes on disk. */
  bytes: number;
  sha256: string;
  kind: FileKind;
  preview: string;
}

const CODE_LANGUAGES: Array<[string, string]> = [
  ["ts", "TypeScript"],
  ["tsx", "TypeScript"],
  ["mts", "TypeScript"],
  ["cts", "TypeScript"],
  ["js", "JavaScript"],
  ["jsx", "JavaScript"],
  ["mjs", "JavaScript"],
  ["cjs", "JavaScript"],
  ["py", "Python"],
  ["rs", "Rust"],
  ["go", "Go"],
  ["java", "Java"],
  ["rb", "Ruby"],
  ["sh", "Shell"],
  ["sql", "SQL"],
  ["css", "CSS"],
  ["html", "HTML"],
  ["yml", "YAML"],
  ["yaml", "YAML"],
  ["toml", "TOML"],
  ["md", "Markdown"],
];

export function fileHandle(d: FileDescriptor): string {
  return `[lcm:file ${d.path} (${d.fileId}, ${d.bytes} chars, ${d.kind})]`;
}

export function filePreviewText(d: FileDescriptor): string {
  return `${fileHandle(d)}\n${d.preview}`;
}

export function describeFile(path: string, text: string): FileDescriptor {
  const kind = kindOf(path, text);
  return {
    fileId: createHash("sha256").update(text).digest("hex").slice(0, 16),
    path,
    bytes: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
    kind,
    preview: previewOf(kind, path, text),
  };
}

function extension(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** What the body is, decided by structure rather than by extension alone: a
 * `.ts` file holding a JSON array is JSON, and a `.txt` file holding JSON is
 * JSON too. The parse is tried before the extension for that reason. */
export function kindOf(path: string, text: string): FileKind {
  const head = text.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) return "json";
    } catch {}
  }
  if (looksLikeJsonLines(text)) return "jsonl";
  const delimiter = delimiterOf(text);
  if (delimiter !== undefined) return delimiter === "\t" ? "tsv" : "csv";
  if (CODE_LANGUAGES.some(([ext]) => ext === extension(path))) return "code";
  return "text";
}

function looksLikeJsonLines(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The one delimiter every early line splits into the same column count on, or
 * `undefined` when the body is not tabular. Two columns is the floor: a line
 * with a single comma is prose, not a table. */
function delimiterOf(text: string): string | undefined {
  const lines = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, 20);
  if (lines.length < 2) return undefined;
  for (const delimiter of ["\t", ","]) {
    const columns = lines[0]!.split(delimiter).length;
    if (columns < 2) continue;
    if (lines.every((l) => l.split(delimiter).length === columns)) return delimiter;
  }
  return undefined;
}

export function structureOf(kind: FileKind, path: string, text: string): string {
  switch (kind) {
    case "json":
      return jsonStructure(text);
    case "jsonl":
      return jsonlStructure(text);
    case "csv":
    case "tsv":
      return tableStructure(text);
    case "code":
      return codeStructure(path, text);
    case "text":
      return textStructure(text);
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function previewOf(kind: FileKind, path: string, text: string): string {
  return `${structureOf(kind, path, text)}\n${headPreview(undefined, text)}`;
}

function shapeOf(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "empty array";
    return `array of ${value.length} ${nounOf(value[0])}`;
  }
  if (value && typeof value === "object") return `object with ${Object.keys(value).length} key(s)`;
  return typeof value;
}

function nounOf(value: unknown): string {
  if (value === null) return "values";
  if (Array.isArray(value)) return "arrays";
  switch (typeof value) {
    case "object":
      return "objects";
    case "string":
      return "strings";
    case "number":
      return "numbers";
    case "boolean":
      return "booleans";
    default:
      return "values";
  }
}

function jsonStructure(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `${lineCount(text)} lines of unparsed JSON`;
  }
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    const keys =
      first && typeof first === "object" && !Array.isArray(first)
        ? `, keys: ${nameList(Object.keys(first))}`
        : "";
    return `${shapeOf(parsed)}${keys}`;
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    // One level of nesting is named, not descended into: the shape of a named
    // payload is what tells a reader whether this is the wrapper they want.
    const nested = keys
      .filter((k) => typeof (parsed as Record<string, unknown>)[k] === "object")
      .slice(0, 3)
      .map((k) => `${k}: ${shapeOf((parsed as Record<string, unknown>)[k])}`);
    return `object with ${keys.length} key(s): ${nameList(keys)}${nested.length > 0 ? `; nested ${nested.join("; ")}` : ""}`;
  }
  return `JSON ${typeof parsed}`;
}

function jsonlStructure(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const first = firstParsedRow(lines);
  if (first === undefined) return `${lines.length} JSON rows`;
  const keys = Object.keys(first);
  return `${lines.length} JSON rows; first row keys: ${nameList(keys)}`;
}

function firstParsedRow(lines: string[]): Record<string, unknown> | undefined {
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line.trim());
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function tableStructure(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const header = lines[0] ?? "";
  const delimiter = text.includes("\t") ? "\t" : ",";
  const columns = header.split(delimiter).map((c) => c.trim());
  return `${lines.length} rows, ${columns.length} columns: ${nameList(columns)}`;
}

const DECLARATION_MODIFIERS =
  /^(?:export\s+|default\s+|declare\s+|abstract\s+|async\s+|public\s+|private\s+|protected\s+|static\s+|readonly\s+|pub(?:\s*\([^)]*\))?\s+)+/;

const DECLARATION =
  /^(function|class|interface|type|enum|const|let|var|def|fn|struct|impl|trait|func|module|namespace|package)\s+([A-Za-z_$][\w$]*)/;

const SHELL_FUNCTION = /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/;

const SQL_STATEMENT =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|INDEX|VIEW|TRIGGER|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w".]+)/i;

const HEADING = /^#{1,6}\s+(.+)$/;

function codeStructure(path: string, text: string): string {
  const language = languageOf(path);
  const lines = lineCount(text);
  if (language === "Markdown") return headingStructure(text, lines);
  if (language === "SQL") return sqlStructure(text, lines);
  const declarations = topLevelDeclarations(text, language);
  if (declarations.length === 0) return `${language}, ${lines} lines`;
  return `${language}, ${lines} lines; ${declarations.length} top-level declaration(s): ${nameList(declarations)}`;
}

/** Declarations come from lines with no leading whitespace, which is what
 * "top-level" means in every family this reads. */
function topLevelDeclarations(text: string, language: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0 || /^\s/.test(line)) continue;
    const trimmed = line.trimEnd();
    const declaration = trimmed.replace(DECLARATION_MODIFIERS, "").match(DECLARATION);
    if (declaration) {
      found.push(`${declaration[1]} ${declaration[2]}`);
      continue;
    }
    if (language === "Shell") {
      const fn = trimmed.match(SHELL_FUNCTION);
      if (fn) found.push(`function ${fn[1]}`);
    }
  }
  return found;
}

function sqlStructure(text: string, lines: number): string {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const statement = line.replace(DECLARATION_MODIFIERS, "").match(SQL_STATEMENT);
    if (statement) found.push(`${statement[1]!.toLowerCase()} ${statement[2]}`);
  }
  if (found.length === 0) return `SQL, ${lines} lines`;
  return `SQL, ${lines} lines; ${found.length} statement(s): ${nameList(found)}`;
}

function headingStructure(text: string, lines: number): string {
  const headings: string[] = [];
  for (const line of text.split("\n")) {
    const heading = line.match(HEADING);
    if (heading) headings.push(`${line.match(/^#+/)?.[0] ?? "#"} ${heading[1]!.trim()}`);
  }
  if (headings.length === 0) return `Markdown, ${lines} lines`;
  return `Markdown, ${lines} lines; ${headings.length} heading(s): ${nameList(headings)}`;
}

function textStructure(text: string): string {
  const lines = lineCount(text);
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
  const first = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return `${lines} lines, ${paragraphs} paragraph(s); first line: ${clip(first.trim(), 80)}`;
}

const NAME_BUDGET = 12;
const NAME_CHARS = 60;

function nameList(names: string[]): string {
  const shown = names.slice(0, NAME_BUDGET).map((n) => clip(n, NAME_CHARS));
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} (+${more} more)` : shown.join(", ");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function headPreview(label: string | undefined, text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const head = flat.length <= FILE_PREVIEW_CHARS ? flat : `${flat.slice(0, FILE_PREVIEW_CHARS)}…`;
  return label === undefined ? head : `${label}\n${head}`;
}

function languageOf(path: string): string {
  const ext = extension(path);
  return CODE_LANGUAGES.find(([e]) => e === ext)?.[1] ?? "code";
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}
