import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import type { ModelCompactPolicyConfig } from "@deepseek-ai/dsh-compaction-basic";
import {
  appendMetric,
  buildDiagnoseBundle,
  checkIntegrity,
  depthStats,
  dropSidecarFiles,
  effectiveThresholds,
  exportTranscript,
  fmtTokens,
  importTranscript,
  listSidecarRefs,
  makeLlm,
  mergeZone,
  modelKey,
  packageVersionNear,
  parseExport,
  readMetricRows,
  redactSecrets,
  runHeal,
  sanitizeSidecarId,
  SCHEMA_VERSION,
  storeGeneration,
  type HealOutcome,
  LcmStore,
  type LlmComplete,
  type ThresholdConfig,
} from "lossless-core";

import { healLlmConfig, healRunBudgets } from "./ladder.ts";
import { agentRoute, dshModelHost, type DshRoute } from "./model-host.ts";

export interface LcmCommandDeps {
  readonly stores: () => ReadonlyMap<string, LcmStore>;
  /** Open-or-create the calling session sidecar. Import uses it so a fresh
   * session can restore history it has never mirrored. */
  readonly storeFor?: (sessionId: string) => LcmStore;
  /** Sidecar directory: the metrics log lives here and default export paths land here. */
  readonly sidecarDir: string;
  /** File path of one session's sidecar, for backup targets. */
  readonly storePathFor: (sessionId: string) => string;
  /** Tokens one repaired node targets. Unset keeps the ladder default. */
  readonly summaryTokens?: number;
  /** Tokens one summarizer request may cost. Unset keeps the core default. */
  readonly summarizerTokensPerCall?: number;
  /** Tokens one heal run may spend across all of its calls. Unset keeps the
   * core heal default. */
  readonly summarizerTokensPerHeal?: number;
  /** Estimated tokens one heal node may read as source. Unset derives the
   * core default (8 x target, clamped) inside runHeal. */
  readonly healSourceTokens?: number;
  /** Configured summary route. A set pair names the heal model; unset
   * follows the calling agent's route, like the ladder. */
  readonly summarizationProvider?: string;
  readonly summarizationModel?: string;
  /** Seam pressure keys status and diagnose report as effective values. */
  readonly thresholdRatio?: number;
  readonly retainTokens?: number;
  readonly retainRatio?: number;
  readonly headroomTokens?: number;
  /** Exact provider/model pressure overrides, merged per routed target. */
  readonly modelPolicies?: ModelCompactPolicyConfig[];
}

const STAMP = (): string => new Date().toISOString().replace(/[:.]/g, "-");

async function resolveWindowTokens(ctx: Context, agent: Agent): Promise<number | undefined> {
  const route = agentRoute(agent);
  if (!route) return undefined;
  try {
    const info = await ctx.llm?.resolveModelInfo(route.provider, route.model);
    const window = info?.context?.contextWindow;
    return typeof window === "number" && window > 0 ? window : undefined;
  } catch {
    return undefined;
  }
}

function measureTotalTokens(ctx: Context, agent: Agent): number | undefined {
  try {
    const measurement = ctx.tokenMeter?.measure(agent.session);
    return measurement === undefined ? undefined : Math.max(0, measurement.totalTokens);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const METRIC_ROWS_LIMIT = 500;

function metricRows(deps: LcmCommandDeps, sessionId?: string): Record<string, unknown>[] {
  const opts =
    sessionId === undefined
      ? { limit: METRIC_ROWS_LIMIT }
      : { session: sessionId, limit: METRIC_ROWS_LIMIT };
  return readMetricRows(deps.sidecarDir, opts).filter((row): row is Record<string, unknown> =>
    isRecord(row),
  );
}

function sessionRows(
  rows: readonly Record<string, unknown>[],
  sessionId: string,
): Record<string, unknown>[] {
  return rows.filter((row) => row.session === sessionId);
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Heal model: the configured pair first, the calling route after. */
function healRoute(deps: LcmCommandDeps, agent: Agent | undefined): DshRoute | undefined {
  const provider = deps.summarizationProvider;
  const model = deps.summarizationModel;
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
    return { provider, model };
  }
  return agentRoute(agent);
}

/** Pressure override for one routed model: exact match, like the seam. */
function policyFor(
  deps: LcmCommandDeps,
  route: DshRoute | undefined,
): ModelCompactPolicyConfig | undefined {
  if (route === undefined) return undefined;
  return deps.modelPolicies?.find(
    (policy) => policy.provider === route.provider && policy.model === route.model,
  );
}

/** Zone status and diagnose report: base seam keys plus the routed override. */
function pressureZone(deps: LcmCommandDeps, route: DshRoute | undefined): ThresholdConfig {
  const override = policyFor(deps, route)?.thresholdRatio;
  return mergeZone(
    deps.thresholdRatio === undefined ? {} : { swapAtRatio: deps.thresholdRatio },
    override === undefined ? undefined : { swapAtRatio: override },
  );
}

function lastPassLine(passRows: readonly Record<string, unknown>[]): string {
  const last = passRows[passRows.length - 1];
  if (!last) return "none recorded";
  const outcome = typeof last.outcome === "string" ? last.outcome : "unknown";
  if (outcome === "stored") {
    return `stored (${numberOf(last.leaf)} leaf, ${numberOf(last.condensed)} condensed)`;
  }
  if (outcome === "nothing") {
    const reason = typeof last.reason === "string" ? last.reason : "already memory";
    return `nothing (${reason})`;
  }
  if (outcome === "failed") {
    const error = typeof last.error === "string" ? last.error : "unknown error";
    return `failed (${error.slice(0, 120)})`;
  }
  return outcome;
}

/** Enriched status: the mirrored counts plus the meter window, thresholds,
 * and the last pass outcome. Count lines stay additive to the old shape. */
export async function handleStatus(
  ctx: Context,
  deps: LcmCommandDeps,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const stores = deps.stores();
  if (stores.size === 0) return { kind: "success", text: "LCM has mirrored no sessions yet." };
  const sessionId = String(invocation.agent.session.id);
  const lines = [...stores].map(([id, store]) => {
    const messages = store.messageCount();
    // Summary payloads stay small beside message bodies, so listing them costs little.
    const summaries = store.allSummaries().length;
    return `${id}: ${messages} messages, ${summaries} summaries`;
  });
  lines.unshift(`LCM sidecar status: ${stores.size} session(s)`);
  const window = await resolveWindowTokens(ctx, invocation.agent);
  const total = measureTotalTokens(ctx, invocation.agent);
  if (window !== undefined && total !== undefined) {
    const occupancy = (total / window) * 100;
    lines.push(
      `window (${sessionId}): ${total}/${fmtTokens(window)} tokens (${occupancy.toFixed(0)}%)`,
    );
    const route = agentRoute(invocation.agent);
    const resolved = effectiveThresholds(pressureZone(deps, route), window);
    lines.push(
      `thresholds: swap ${(resolved.swap * 100).toFixed(0)}% / recut ${(resolved.recut * 100).toFixed(0)}%${resolved.clamped ? " (clamped)" : ""}`,
    );
  } else if (window !== undefined) {
    lines.push(`window: ${fmtTokens(window)} (pressure unread: token meter unavailable)`);
    lines.push("thresholds: window known, pressure unknown");
  } else {
    lines.push("window: unknown (no model window resolved)");
    lines.push("thresholds: window unknown");
  }
  const passes = sessionRows(metricRows(deps, sessionId), sessionId).filter(
    (row) => row.kind === "pass",
  );
  lines.push(`last pass (${sessionId}): ${lastPassLine(passes)}`);
  return { kind: "success", text: lines.join("\n") };
}

/** Session-scoped metrics rollup over the metrics rows, in the OpenCode vocabulary. */
export function formatSessionReport(
  rows: readonly Record<string, unknown>[],
  sessionId: string,
): string {
  const mine = sessionRows(rows, sessionId);
  if (mine.length === 0) return "LCM metrics: no rows recorded for this session yet.";
  const lines = [
    `LCM metrics: ${mine.length} row(s) for session ${sessionId} (${rows.length} in the log).`,
  ];
  const passes = mine.filter((row) => row.kind === "pass");
  const stored = passes.filter((row) => row.outcome === "stored").length;
  const nothing = passes.filter((row) => row.outcome === "nothing").length;
  const failed = passes.filter((row) => row.outcome === "failed").length;
  const leaf = passes.reduce((sum, row) => sum + numberOf(row.leaf), 0);
  const condensed = passes.reduce((sum, row) => sum + numberOf(row.condensed), 0);
  lines.push(
    `passes: ${passes.length} (stored ${stored}, nothing ${nothing}, failed ${failed}); ${leaf} leaf, ${condensed} condensed`,
  );
  const checkpoints = mine.filter((row) => row.kind === "compaction-checkpoint").length;
  lines.push(`checkpoints: ${checkpoints} commit(s)`);
  const backfills = mine.filter((row) => row.kind === "backfill");
  const backfilled = backfills.reduce((sum, row) => sum + numberOf(row.ingested), 0);
  lines.push(`backfill: ${backfills.length} session(s), ${backfilled} ingested`);
  const recall = mine.filter((row) => row.kind === "recall");
  const recallOutcomes = ["hit", "miss", "refused", "error"].flatMap((outcome) => {
    const count = recall.filter((row) => row.outcome === outcome).length;
    return count === 0 ? [] : [`${outcome} ${count}`];
  });
  lines.push(
    `recall: ${recall.length}${recallOutcomes.length === 0 ? "" : ` (${recallOutcomes.join(", ")})`}`,
  );
  const retrieval = mine.filter((row) => row.kind === "retrieval");
  const stops = ["answered", "refused", "failed", "stopped"].flatMap((stop) => {
    const count = retrieval.filter((row) => row.stop === stop).length;
    return count === 0 ? [] : [`${stop} ${count}`];
  });
  lines.push(`retrieval: ${retrieval.length}${stops.length === 0 ? "" : ` (${stops.join(", ")})`}`);
  lines.push(`last pass: ${lastPassLine(passes)}`);
  const text = lines.join("\n");
  return text.length <= 2048 ? text : `${text.slice(0, 2040)}...`;
}

export function handleReport(deps: LcmCommandDeps, invocation: CommandInvocation): CommandResult {
  const sessionId = String(invocation.agent.session.id);
  return { kind: "success", text: formatSessionReport(metricRows(deps, sessionId), sessionId) };
}

/** Timestamped copy of the calling session's sidecar, mode 0600. */
export function handleBackup(
  deps: LcmCommandDeps,
  invocation: CommandInvocation,
  args: readonly string[],
): CommandResult {
  const sessionId = String(invocation.agent.session.id);
  const store = deps.stores().get(sessionId);
  if (!store) return { kind: "error", text: "LCM backup: no stored history for this session yet." };
  const target =
    args[0] === undefined ? `${deps.storePathFor(sessionId)}.backup-${STAMP()}` : resolve(args[0]);
  try {
    store.backup(target);
    try {
      chmodSync(target, 0o600);
    } catch {}
  } catch (error) {
    return {
      kind: "error",
      text: `LCM backup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { kind: "success", text: `LCM backup written: ${target} (mode 0600).` };
}

/** JSONL export of the calling session's sidecar, mode 0600. */
export function handleExport(
  deps: LcmCommandDeps,
  invocation: CommandInvocation,
  args: readonly string[],
): CommandResult {
  const sessionId = String(invocation.agent.session.id);
  const store = deps.stores().get(sessionId);
  if (!store) return { kind: "error", text: "LCM export: no stored history for this session yet." };
  const target =
    args[0] === undefined ? join(deps.sidecarDir, `lcm-export-${STAMP()}.jsonl`) : resolve(args[0]);
  try {
    const out = exportTranscript(store);
    writeFileSync(target, `${out.toJSONL()}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(target, 0o600);
    } catch {}
    return {
      kind: "success",
      text: `LCM export: ${out.messages.length} messages + ${out.summaries.length} summaries -> ${target} (mode 0600).`,
    };
  } catch (error) {
    return {
      kind: "error",
      text: `LCM export failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

type SaveFlag = { kind: "path"; path: string } | { kind: "absent" } | { kind: "missing-path" };

function parseSaveFlag(flags: readonly string[]): SaveFlag {
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--save") {
      const next = flags[i + 1];
      return next === undefined ? { kind: "missing-path" } : { kind: "path", path: next };
    }
    if (flag?.startsWith("--save=")) {
      const path = flag.slice("--save=".length);
      return path === "" ? { kind: "missing-path" } : { kind: "path", path };
    }
  }
  return { kind: "absent" };
}

function pluginLabel(): string {
  const version = packageVersionNear(fileURLToPath(import.meta.url), "deepseek-lossless");
  return `deepseek-lossless ${version ?? "unknown"}`;
}

/** Redacted bundle via the core helper, inline or `--save`d to a 0600 file. */
export async function handleDiagnose(
  ctx: Context,
  deps: LcmCommandDeps,
  invocation: CommandInvocation,
  args: readonly string[],
): Promise<CommandResult> {
  const sessionId = String(invocation.agent.session.id);
  const store = deps.stores().get(sessionId);
  if (!store) {
    return { kind: "error", text: "LCM diagnose: no stored history for this session yet." };
  }
  const save = parseSaveFlag(args);
  if (save.kind === "missing-path") {
    return {
      kind: "error",
      text: "LCM diagnose --save: name the file to write, e.g. `/lcm diagnose --save lcm-diagnose.txt`.",
    };
  }
  const stats = store.stats();
  const integrity = checkIntegrity(store);
  const route = agentRoute(invocation.agent);
  const policy = policyFor(deps, route);
  const zone = pressureZone(deps, route);
  const model =
    route === undefined
      ? "(session model)"
      : modelKey({ provider: route.provider, id: route.model });
  const window = await resolveWindowTokens(ctx, invocation.agent);
  const bundle = buildDiagnoseBundle({
    versions: { plugin: pluginLabel, host: () => "deepseek harness" },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      mode: "plugin",
    },
    session: {
      store: basename(deps.storePathFor(sessionId)),
      file: "(deepseek session)",
      format: "deepseek session log",
    },
    facts: {
      stats,
      integrity: { checks: integrity.checks, findings: integrity.findings, repairs: [] },
      depthRows: depthStats(store.allSummaries()),
      pin: null,
      model,
      window:
        window === undefined
          ? null
          : { tokens: window, effective: effectiveThresholds(zone, window) },
      chain: { level: "info", state: "summarizer: deepseek ladder (leaf plus condensed DAG)" },
      zoneConfigured: policy !== undefined,
      config: {
        swapAtRatio: zone.swapAtRatio ?? 0.7,
        recutAtRatio: zone.recutAtRatio ?? 0.85,
        assemblyEnabled: false,
      },
      keepRecentTokens: deps.retainTokens ?? 0,
      configPath: "plugin options",
    },
    config: {
      effective: JSON.stringify({
        swapAtRatio: zone.swapAtRatio ?? 0.7,
        recutAtRatio: zone.recutAtRatio ?? 0.85,
        ...(deps.retainTokens === undefined ? {} : { retainTokens: deps.retainTokens }),
        ...(deps.retainRatio === undefined ? {} : { retainRatio: deps.retainRatio }),
        ...(deps.headroomTokens === undefined ? {} : { headroomTokens: deps.headroomTokens }),
        ...(deps.modelPolicies === undefined ? {} : { modelPolicies: deps.modelPolicies }),
      }),
      path: "plugin options",
    },
    metrics: sessionRows(metricRows(deps, sessionId), sessionId),
    redact: redactSecrets,
    home: homedir(),
  });
  if (save.kind === "path") {
    const target = resolve(save.path);
    try {
      writeFileSync(target, `${bundle}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(target, 0o600);
    } catch (error) {
      return {
        kind: "error",
        text: `LCM diagnose: cannot write ${target} (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
    return {
      kind: "success",
      text: `LCM diagnose: wrote ${Buffer.byteLength(bundle, "utf8")} bytes to ${target} (mode 0600); the block is in the file, not in this message.`,
    };
  }
  return { kind: "success", text: bundle };
}

/** Restore rows from a file written by export. Dedup is the importer's own:
 * re-importing the same file inserts nothing and reports the skips. */
export function handleImport(
  deps: LcmCommandDeps,
  invocation: CommandInvocation,
  args: readonly string[],
): CommandResult {
  const sessionId = String(invocation.agent.session.id);
  const arg = args[0];
  if (arg === undefined || arg.length === 0) {
    return {
      kind: "error",
      text: "LCM import: name a file written by /lcm export, e.g. `/lcm import lcm-export.jsonl`.",
    };
  }
  let text: string;
  try {
    text = readFileSync(resolve(arg), "utf8");
  } catch (error) {
    return {
      kind: "error",
      text: `LCM import failed: cannot read ${arg} (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  const parsed = parseExport(text);
  if ("error" in parsed) {
    return { kind: "error", text: `LCM import refused: ${parsed.error}.` };
  }
  const store = deps.storeFor?.(sessionId) ?? deps.stores().get(sessionId);
  if (!store) {
    return { kind: "error", text: "LCM import: no stored history for this session yet." };
  }
  const result = importTranscript(store, parsed.rows);
  if (result.refused !== undefined) {
    return { kind: "error", text: `LCM import refused: ${result.refused}.` };
  }
  const restored = result.messagesInserted + result.summariesInserted;
  const skipped = result.messagesSkipped + result.summariesSkipped;
  return {
    kind: "success",
    text: `LCM import: ${restored} row(s) restored (${result.messagesInserted} messages, ${result.summariesInserted} summaries); ${skipped} row(s) already present.`,
  };
}

/** Live stems guard gc: disk stems are sanitized session ids, so the check
 * compares those, not raw ids, and fails closed by also covering the calling
 * session even when its store is not in the map yet. */
function liveStems(deps: LcmCommandDeps, sessionId: string): Set<string> {
  const stems = new Set<string>();
  for (const id of deps.stores().keys()) stems.add(sanitizeSidecarId(id));
  stems.add(sanitizeSidecarId(sessionId));
  return stems;
}

const GC_DEFAULT_DAYS = 30;

function gcCandidates(
  deps: LcmCommandDeps,
  sessionId: string,
): Array<{ id: string; path: string; sizeBytes: number; ageDays: number }> {
  const live = liveStems(deps, sessionId);
  const cutoff = Date.now() - GC_DEFAULT_DAYS * 86_400_000;
  const out: Array<{ id: string; path: string; sizeBytes: number; ageDays: number }> = [];
  for (const ref of listSidecarRefs(deps.sidecarDir)) {
    if (live.has(ref.id)) continue;
    try {
      const stat = statSync(ref.path);
      if (!stat.isFile()) continue;
      let mtimeMs = stat.mtimeMs;
      for (const suffix of ["-wal", "-shm"]) {
        try {
          mtimeMs = Math.max(mtimeMs, statSync(`${ref.path}${suffix}`).mtimeMs);
        } catch {}
      }
      if (mtimeMs > cutoff) continue;
      out.push({
        id: ref.id,
        path: ref.path,
        sizeBytes: stat.size,
        ageDays: Math.max(0, (Date.now() - mtimeMs) / 86_400_000),
      });
    } catch {
      continue;
    }
  }
  return out;
}

/** Age-based sidecar collection. Dry-run default; only --apply deletes, and
 * it never touches a live sidecar. A no-op apply writes no export file. */
export function handleGc(
  deps: LcmCommandDeps,
  invocation: CommandInvocation,
  args: readonly string[],
): CommandResult {
  const sessionId = String(invocation.agent.session.id);
  const apply = args.includes("--apply");
  let candidates: Array<{ id: string; path: string; sizeBytes: number; ageDays: number }>;
  try {
    candidates = gcCandidates(deps, sessionId);
  } catch (error) {
    return {
      kind: "error",
      text: `LCM gc failed: cannot list ${deps.sidecarDir} (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  if (candidates.length === 0) {
    return {
      kind: "success",
      text: `LCM gc: nothing eligible (no sidecar older than ${GC_DEFAULT_DAYS} day(s); live sidecars are never candidates).`,
    };
  }
  const lines = candidates.map(
    (c) => `  ${c.id}: ${(c.sizeBytes / 1024).toFixed(0)} KB, ${c.ageDays.toFixed(1)} day(s) old`,
  );
  if (!apply) {
    return {
      kind: "success",
      text: `LCM gc dry-run: ${candidates.length} sidecar(s) removable:\n${lines.join("\n")}\nRun \`/lcm gc --apply\` to export then delete them. Backups are never touched.`,
    };
  }
  const stamp = STAMP();
  let removed = 0;
  let exported = 0;
  let failed = 0;
  const written: string[] = [];
  for (const candidate of candidates) {
    try {
      const probe = new LcmStore(candidate.path, { queryOnly: true });
      let rows = "";
      try {
        rows = exportTranscript(probe).toJSONL();
      } finally {
        probe.close();
      }
      if (rows.length > 0) {
        // One file per sidecar: ordinals restart at 0 per store.
        const target = join(deps.sidecarDir, `lcm-export-gc-${candidate.id}-${stamp}.jsonl`);
        writeFileSync(target, `${rows}\n`, { encoding: "utf8", mode: 0o600 });
        try {
          chmodSync(target, 0o600);
        } catch {}
        written.push(target);
        exported++;
      }
      dropSidecarFiles(candidate.path);
      removed++;
    } catch {
      failed++;
    }
  }
  if (exported > 0) {
    return {
      kind: "success",
      text: `LCM gc: removed ${removed} of ${candidates.length} sidecar(s); ${exported} transcript(s) exported to ${written.join(", ")}${failed === 0 ? "" : `; ${failed} skipped (migrate or inspect first)`}.`,
    };
  }
  return {
    kind: "success",
    text: `LCM gc: removed ${removed} of ${candidates.length} sidecar(s); transcripts were empty so no export file was written${failed === 0 ? "" : `; ${failed} skipped (migrate or inspect first)`}.`,
  };
}

/** Generation-gated migration. A store this process holds open is already
 * current, so live stems are excluded: opening a second writer would only
 * race the live session. Dry-run default; only --apply opens writers. */
export function handleMigrate(
  deps: LcmCommandDeps,
  invocation: CommandInvocation,
  args: readonly string[],
): CommandResult {
  const sessionId = String(invocation.agent.session.id);
  const apply = args.includes("--apply");
  const live = liveStems(deps, sessionId);
  const refs = listSidecarRefs(deps.sidecarDir).filter((ref) => !live.has(ref.id));
  const stale: Array<{ id: string; path: string; generation: number }> = [];
  let current = deps.stores().size;
  let broken = 0;
  for (const ref of refs) {
    const generation = storeGeneration(ref.path);
    if (generation === undefined) broken++;
    else if (generation < SCHEMA_VERSION) stale.push({ ...ref, generation });
    else current++;
  }
  if (stale.length === 0) {
    return {
      kind: "success",
      text: `LCM migrate: nothing to do (${current} sidecar(s) at generation ${SCHEMA_VERSION}${broken === 0 ? "" : `, ${broken} unreadable`}).`,
    };
  }
  const summary = stale
    .map((s) => `  ${s.id}: generation ${s.generation} -> ${SCHEMA_VERSION}`)
    .join("\n");
  if (!apply) {
    return {
      kind: "success",
      text: `LCM migrate dry-run: ${stale.length} sidecar(s) older than generation ${SCHEMA_VERSION} (${current} current${broken === 0 ? "" : `, ${broken} unreadable`}):\n${summary}\nRun \`/lcm migrate --apply\` to upgrade them in place.`,
    };
  }
  let migrated = 0;
  let failed = 0;
  for (const s of stale) {
    try {
      const candidate = new LcmStore(s.path);
      candidate.close();
      migrated++;
    } catch {
      failed++;
    }
  }
  return {
    kind: "success",
    text: `LCM migrate: upgraded ${migrated} of ${stale.length} sidecar(s) to generation ${SCHEMA_VERSION}${failed === 0 ? "" : `, ${failed} failed`}.`,
  };
}

type MaxNodesFlag = { kind: "absent" } | { kind: "value"; value: number } | { kind: "invalid" };

function parseMaxNodesFlag(flags: readonly string[]): MaxNodesFlag {
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--max-nodes") {
      const next = flags[i + 1];
      if (next === undefined || next.startsWith("--")) return { kind: "invalid" };
      return maxNodesValue(next);
    }
    if (flag?.startsWith("--max-nodes=")) {
      return maxNodesValue(flag.slice("--max-nodes=".length));
    }
  }
  return { kind: "absent" };
}

function maxNodesValue(raw: string): MaxNodesFlag {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? { kind: "value", value } : { kind: "invalid" };
}

/** A dry run reads the plan and makes no provider call. */
const healDryRunLlm: LlmComplete = Object.assign(
  async (): Promise<string> => {
    throw new Error("lcm: a heal dry run never calls the model");
  },
  { metrics: appendMetric },
);

function healReport(outcome: HealOutcome): string {
  if (outcome.dryRun) {
    return outcome.counts.candidates === 0
      ? "LCM heal dry-run: no truncated summaries or stale ancestors; nothing to repair."
      : `LCM heal dry-run: ${outcome.counts.candidates} candidate(s), ${outcome.counts.tainted} tainted, ${outcome.sourceTokens} source tokens; run \`/lcm heal --apply\` to repair.`;
  }
  const stop = outcome.stop === "done" ? "" : ` (stopped: ${outcome.stop})`;
  const changed = outcome.counts.changed === 0 ? "" : `, changed ${outcome.counts.changed}`;
  const blockedSource =
    outcome.counts.blockedSource === 0 ? "" : ` (${outcome.counts.blockedSource} source)`;
  return `LCM heal: repaired ${outcome.counts.repaired} clean, improved ${outcome.counts.improved}, failed ${outcome.counts.failed}, blocked ${outcome.counts.blocked}${blockedSource}${changed}, remaining ${outcome.counts.notAttempted}; ${outcome.calls} model call(s)${stop}.`;
}

const healInFlight = new Set<string>();

/** Repair mechanically truncated nodes from their stored sources. Dry-run
 * default; only --apply calls the model. Budgets ride the plugin config
 * through these deps; unset keys keep the core heal defaults. */
export async function handleHeal(
  ctx: Context,
  deps: LcmCommandDeps,
  invocation: CommandInvocation,
  args: readonly string[],
): Promise<CommandResult> {
  const sessionId = String(invocation.agent.session.id);
  const apply = args.includes("--apply");
  const maxNodes = parseMaxNodesFlag(args);
  if (maxNodes.kind === "invalid") {
    return {
      kind: "error",
      text: "LCM heal: --max-nodes takes a positive whole number, e.g. `/lcm heal --apply --max-nodes 8`.",
    };
  }
  const store = deps.stores().get(sessionId);
  if (!store) {
    return { kind: "error", text: "LCM heal: no stored history for this session yet." };
  }
  const span = store.entrySpan();
  if (!span) {
    return { kind: "error", text: "LCM heal: this session has no stored entries yet." };
  }
  if (store.hasLiveRun()) {
    return {
      kind: "error",
      text: "LCM heal: a compaction pass is in flight; retry when it finishes.",
    };
  }
  if (healInFlight.has(sessionId)) {
    return { kind: "error", text: "LCM heal: a repair is already running for this session." };
  }
  healInFlight.add(sessionId);
  try {
    const maxNodeInput = maxNodes.kind === "value" ? { maxNodes: maxNodes.value } : {};
    if (!apply) {
      const outcome = await runHeal(
        store,
        {
          session: sessionId,
          redact: redactSecrets,
          dryRun: true,
          ...healRunBudgets(deps),
          ...maxNodeInput,
        },
        healDryRunLlm,
      );
      return { kind: "success", text: healReport(outcome) };
    }
    const route = healRoute(deps, invocation.agent);
    const host = dshModelHost(ctx, {
      ...(route === undefined ? {} : { defaultRoute: route }),
      signal: invocation.signal,
      sessionId,
    });
    const llm = makeLlm(host, healLlmConfig(deps), {
      session: sessionId,
      stage: "heal",
      span: { firstEntryId: span.first, lastEntryId: span.last },
    });
    if (!llm) {
      return {
        kind: "error",
        text: "LCM heal: no summarizer model resolves for this session; nothing was repaired.",
      };
    }
    const outcome = await runHeal(
      store,
      { session: sessionId, redact: redactSecrets, ...healRunBudgets(deps), ...maxNodeInput },
      llm,
    );
    return { kind: "success", text: healReport(outcome) };
  } catch (error) {
    return {
      kind: "error",
      text: `LCM heal failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    healInFlight.delete(sessionId);
  }
}

/** Session-less lookup for tests: the gc dry-run default window in days. */
export function gcDryRunDefaultDays(): number {
  return GC_DEFAULT_DAYS;
}

/** Session-less lookup for tests, consulted by dispose: the ids of sessions with a heal in flight. */
export function healInFlightSessions(): readonly string[] {
  return [...healInFlight];
}
