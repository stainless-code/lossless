import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";

import type { CommitState, ResolvedThresholds } from "./commit-policy.ts";
import { fmtTokens } from "./format.ts";
import type { Finding } from "./integrity.ts";
import type { ChainReport } from "./llm.ts";
import type { DepthStat } from "./report.ts";
import type { LcmStore } from "./store.ts";

export interface FactConfig {
  swapAtTokens?: number;
  recutAtTokens?: number;
  smartZone?: number;
  swapAtRatio?: number;
  recutAtRatio?: number;
  assemblyEnabled?: boolean;
}

export interface SessionFacts {
  stats: ReturnType<LcmStore["stats"]>;
  integrity: { checks: number; findings: Finding[]; repairs: string[] };
  depthRows: DepthStat[];
  pin: CommitState | null;
  model: string;
  window: { tokens: number; effective: ResolvedThresholds } | null;
  chain: ChainReport;
  zoneConfigured: boolean;
  config: FactConfig;
  keepRecentTokens: number;
  configPath?: string;
}

function findingLines(f: Finding): string[] {
  const marker = f.severity === "violation" ? "" : " (info)";
  return [
    `  ${f.kind}${marker}: ${f.count} x ${f.detail}`,
    ...(f.sample.length > 0 ? [`    ${f.sample.join(", ")}`] : []),
  ];
}

/**
 * The store, projection and model facts, in the order both readers print them.
 * Generated from numbers and config values, so nothing here needs a mask: no
 * line can carry a character a session produced.
 */
export function sessionFactLines(f: SessionFacts): string[] {
  const s = f.stats;
  const tokensConfigured =
    (f.config.swapAtTokens != null && f.config.swapAtTokens > 0) ||
    (f.config.recutAtTokens != null && f.config.recutAtTokens > 0) ||
    (f.config.smartZone != null && f.config.smartZone > 0);
  return [
    `messages: ${s.messages}${s.removedMessages > 0 ? ` (${s.removedMessages} removed, retained)` : ""}, summaries: ${s.summaries}, size: ${(s.dbBytes / 1024).toFixed(0)} KB`,
    ...(s.payloadMessages > 0
      ? [
          `payload: ${s.payloadMessages} message(s) keep raw blocks the derived text does not hold, ${(s.payloadBytes / 1024).toFixed(0)} KB`,
        ]
      : []),
    ...(s.files > 0
      ? [`files: ${s.files} externalized, ${(s.fileBytes / 1024).toFixed(0)} KB of retained bodies`]
      : []),
    ...f.integrity.repairs.map((note) => `repair: ${note}`),
    `integrity: ${f.integrity.checks} checks, ${f.integrity.findings.length === 0 ? "no findings" : `${f.integrity.findings.length} finding(s)`}`,
    ...f.integrity.findings.flatMap(findingLines),
    ...f.depthRows.map(
      (d) =>
        `  depth ${d.depth}${d.depth === 0 ? " (leaf)" : d.depth === 1 ? " (condensed)" : ""}: ${d.count} summaries, ${fmtTokens(d.totalTokens)} tokens total, ${fmtTokens(d.avgTokens)} avg`,
    ),
    `pinned projection: ${f.pin ? `yes (cut ${f.pin.cutCount}, applied at ${(f.pin.appliedAtOccupancy * 100).toFixed(0)}%)` : "none"}`,
    `model: ${f.model || "(unknown)"}, window: ${f.window ? fmtTokens(f.window.tokens) : "?"}`,
    f.chain.state,
    ...(f.chain.level === "warning" ? [`⚠ ${f.chain.warning}`] : []),
    `active zone: ${f.zoneConfigured ? `zones["${f.model}"]` : "none (global thresholds)"}`,
    `assembly: ${f.config.assemblyEnabled === false ? "disabled" : "enabled"}, swap: ${f.config.swapAtTokens ? `${fmtTokens(f.config.swapAtTokens)} tok` : `${((f.config.swapAtRatio ?? 0.7) * 100).toFixed(0)}%`}, recut: ${f.config.recutAtTokens ? `${fmtTokens(f.config.recutAtTokens)} tok` : `${((f.config.recutAtRatio ?? 0.85) * 100).toFixed(0)}%`}, keepRecent: ${f.keepRecentTokens}`,
    `effective for this model: ${f.window ? `swap ${(f.window.effective.swap * 100).toFixed(0)}% · recut ${(f.window.effective.recut * 100).toFixed(0)}%${f.window.effective.clamped ? " (clamped)" : ""}` : "window unknown"}`,
    ...(f.configPath === undefined ? [] : [`config: ${f.configPath}`]),
    ...hintLine(f, tokensConfigured),
  ];
}

function hintLine(f: SessionFacts, tokensConfigured: boolean): string[] {
  if (!f.window || f.window.tokens < 500_000 || tokensConfigured) return [];
  return [
    `hint: this model's window is ${fmtTokens(f.window.tokens)} tokens, ratio mode fires very late. Smart-zone mode may fit better: set "smartZone" (or "swapAtTokens"/"recutAtTokens") in lcm.json (see README).`,
  ];
}

export const MAX_METRIC_ROWS = 25;
export const MAX_BUNDLE_BYTES = 8192;

const FOREIGN_TEXT_FIELDS = new Set(["error", "errorMessage", "message", "detail", "note"]);

export interface DiagnoseBundleInput {
  /** Resolved at print time, so a package that moved still names its version.
   * Each is a label the host composes, `name version`, because this core names
   * no product: the header a second harness prints names that harness. */
  versions: { plugin: () => string; host: () => string };
  runtime: { node: string; platform: string; arch: string; mode: string };
  /** Basenames and a version, never a path. */
  session: { store: string; file: string; format: string };
  facts: SessionFacts;
  config: { effective: string; path: string };
  /** Every metrics row for this session, oldest first. The bundle takes the
   * tail, so it does not have to guess how many there are. */
  metrics: readonly Record<string, unknown>[];
  redact: (text: string) => string;
  home: string;
}

/** The block a reporter pastes. Generated lines and foreign strings are kept
 * apart: a line this module builds is never masked, because masking is what
 * turns `modelKey` into `[REDACTED]`, and a value that came from outside is
 * always masked. Absolute paths get one of two treatments: `~` inside the home
 * directory, `<path>` outside it. */
export function buildDiagnoseBundle(input: DiagnoseBundleInput): string {
  const home = input.home.endsWith("/") ? input.home.slice(0, -1) : input.home;
  const rows = input.metrics.map((row) => sanitizeRow(row, input.redact, home));
  const decision = lastDecisionRow(rows);
  const head = [
    `LCM diagnose bundle: ${input.versions.plugin()}, ${input.versions.host()}, node ${input.runtime.node}, ${input.runtime.platform}/${input.runtime.arch}, mode ${input.runtime.mode}`,
    `session: store ${input.session.store}, file ${input.session.file}, format ${input.session.format}`,
  ];
  const fixed = [
    ...head,
    "store:",
    ...sessionFactLines(input.facts).map((line) => `  ${line}`),
    `config (${input.config.path}):`,
    `  ${input.config.effective}`,
  ];
  const closing = `omitted: no message body, no summary text, no search query, no absolute path outside the Pi home. Provider and host error text is masked; the rows, the config and the facts above are this package's own vocabulary. Read the block before posting it, and strip anything personal.`;

  let take = Math.min(rows.length, MAX_METRIC_ROWS);
  for (;;) {
    const lines = [
      ...fixed,
      ...metricLines(rows.slice(rows.length - take), decision, take, rows.length),
      closing,
    ];
    const bundle = finalize(lines, home);
    if (byteLength(bundle) <= MAX_BUNDLE_BYTES || take === 0) return clip(lines, home);
    take -= 1;
  }
}

function metricLines(
  shown: readonly Record<string, unknown>[],
  decision: Record<string, unknown> | undefined,
  take: number,
  total: number,
): string[] {
  const kinds = tally(shown);
  return [
    `metrics: ${total} row(s) for this session, ${take} shown, ${total - take} not shown`,
    `  by kind (shown): ${kinds.length > 0 ? kinds.map(([k, n]) => `${k} ${n}`).join(", ") : "none"}`,
    `  ${decision === undefined ? "last decision: none" : `last decision: ${JSON.stringify(decision)}`}`,
    ...shown.map((row) => `  ${JSON.stringify(row)}`),
  ];
}

function tally(rows: readonly Record<string, unknown>[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const kind = row["kind"];
    // Our own `usage` rows carry no kind, and a tally key of "(no kind)" tells
    // a reader nothing about the row standing beside it.
    const key =
      typeof kind === "string"
        ? kind
        : typeof row["event"] === "string"
          ? row["event"]
          : "(no kind)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function lastDecisionRow(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.["kind"] === "context-decision") return rows[i];
  }
  return undefined;
}

export function sanitizeRow(
  row: Record<string, unknown>,
  redact: (text: string) => string,
  home: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = sanitizeValue(key, value, redact, home);
  }
  return out;
}

function sanitizeValue(
  key: string,
  value: unknown,
  redact: (text: string) => string,
  home: string,
): unknown {
  if (typeof value === "string") {
    const masked = FOREIGN_TEXT_FIELDS.has(key) ? redact(value) : value;
    return bindPath(masked, home);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item, redact, home));
  }
  if (typeof value === "object" && value !== null) {
    return sanitizeRow(value as Record<string, unknown>, redact, home);
  }
  return value;
}

function bindPath(value: string, home: string): string {
  if (value === home || value.startsWith(`${home}/`)) return `~${value.slice(home.length)}`;
  if (isAbsolute(value)) return "<path>";
  return value;
}

function isAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function finalize(lines: readonly string[], home: string): string {
  return lines.join("\n").split(home).join("~");
}

function clip(lines: readonly string[], home: string): string {
  const text = finalize(lines, home);
  if (byteLength(text) <= MAX_BUNDLE_BYTES) return text;
  const marker = `… truncated at the ${MAX_BUNDLE_BYTES} byte limit`;
  const closing = lines.at(-1) ?? "";
  let budget = MAX_BUNDLE_BYTES - byteLength(marker) - byteLength(closing) - 2;
  const kept: string[] = [];
  for (const line of lines.slice(0, -1)) {
    const cost = byteLength(line) + 1;
    if (cost > budget) break;
    kept.push(line);
    budget -= cost;
  }
  return finalize([...kept, marker, closing], home);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The session file's format version, from the header line Pi rewrites on every
 * flush. A file that is missing, unreadable or not a session header renders the
 * honest fallback rather than a wrong number. */
export function readSessionFormat(sessionFile: string | undefined): string {
  if (sessionFile === undefined) return "unknown (no session file)";
  let head: string;
  try {
    head = readFileSync(sessionFile, "utf8").split("\n", 1)[0] ?? "";
  } catch {
    return "unknown (unreadable)";
  }
  try {
    const parsed: unknown = JSON.parse(head);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (record["type"] === "session" && typeof record["version"] === "number") {
        return `v${record["version"]}`;
      }
    }
  } catch {}
  return "unknown (first line is not a session header)";
}

/** The host package's version, resolved from the caller's own module
 * (`import.meta.url`); a bundled engine cannot know where its host lives. */
export function hostVersion(hostPackage: string, from: string | URL): string {
  for (const anchor of hostAnchors(hostPackage, from)) {
    const version = packageVersionNear(anchor, hostPackage);
    if (version !== undefined) return version;
  }
  return "unknown (not resolved)";
}

/** The host manifest from the caller's module, then the realpath'd process
 * entry, so a symlinked global `bin` still lands inside the package. */
function hostAnchors(hostPackage: string, from: string | URL): string[] {
  const anchors: string[] = [];
  try {
    const manifest = findPackageJSON(hostPackage, from);
    if (manifest !== undefined) anchors.push(manifest);
  } catch {}
  const argv = process.argv[1];
  if (argv !== undefined) {
    try {
      anchors.push(realpathSync(argv));
    } catch {
      anchors.push(argv);
    }
  }
  return anchors;
}

/** The `version` of the nearest `package.json` named `name`, walking up from the
 * directory holding `from`. A manifest that is missing, unreadable, unparsable
 * or named something else is not the answer, so a wrong anchor fails the name
 * check instead of reporting a stranger's version. */
export function packageVersionNear(from: string, name: string): string | undefined {
  let dir = dirname(from);
  for (;;) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const pkg = parsed as Record<string, unknown>;
        if (pkg["name"] === name && typeof pkg["version"] === "string") return pkg["version"];
      }
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
