import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import {
  buildDiagnoseBundle,
  checkIntegrity,
  depthStats,
  effectiveThresholds,
  exportTranscript,
  fmtTokens,
  mergeZone,
  modelKey,
  packageVersionNear,
  readMetricRows,
  redactSecrets,
  type LcmStore,
} from "lossless-core";

export interface LcmCommandDeps {
  readonly stores: () => ReadonlyMap<string, LcmStore>;
  /** Sidecar directory: the metrics log lives here and default export paths land here. */
  readonly sidecarDir: string;
  /** File path of one session's sidecar, for backup targets. */
  readonly storePathFor: (sessionId: string) => string;
}

const STAMP = (): string => new Date().toISOString().replace(/[:.]/g, "-");

/** The calling session's route: the latest routed request first, agent options second. */
function agentRoute(agent: Agent): { provider: string; model: string } | undefined {
  try {
    const header = agent.session.requestHeader?.()?.config;
    if (
      header !== undefined &&
      typeof header.provider === "string" &&
      header.provider.length > 0 &&
      typeof header.model === "string" &&
      header.model.length > 0
    ) {
      return { provider: header.provider, model: header.model };
    }
  } catch {}
  const options = agent.options as { provider?: unknown; model?: unknown } | undefined;
  if (
    typeof options?.provider === "string" &&
    options.provider.length > 0 &&
    typeof options?.model === "string" &&
    options.model.length > 0
  ) {
    return { provider: options.provider, model: options.model };
  }
  return undefined;
}

/** Model window in tokens, or undefined when the host cannot name one. */
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

/** Current request pressure for the calling session, or undefined without a meter. */
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

function metricRows(deps: LcmCommandDeps): Record<string, unknown>[] {
  return readMetricRows(deps.sidecarDir).filter((row): row is Record<string, unknown> =>
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

/** One-line summary of the newest pass row, the way the report phrases it. */
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
    const messages = store.allMessages().length;
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
    const resolved = effectiveThresholds(mergeZone({}, undefined), window);
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
  const passes = sessionRows(metricRows(deps), sessionId).filter((row) => row.kind === "pass");
  lines.push(`last pass (${sessionId}): ${lastPassLine(passes)}`);
  return { kind: "success", text: lines.join("\n") };
}

/** Session-scoped metrics rollup over the slice-2 rows, in the OpenCode vocabulary. */
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
  return { kind: "success", text: formatSessionReport(metricRows(deps), sessionId) };
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
  const model = route === undefined ? "(session model)" : modelKey(route);
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
          : { tokens: window, effective: effectiveThresholds(mergeZone({}, undefined), window) },
      chain: { level: "info", state: "summarizer: deepseek ladder (leaf plus condensed DAG)" },
      zoneConfigured: false,
      config: { swapAtRatio: 0.7, recutAtRatio: 0.85, assemblyEnabled: false },
      keepRecentTokens: 0,
      configPath: "plugin options",
    },
    config: {
      effective: JSON.stringify({ swapAtRatio: 0.7, recutAtRatio: 0.85 }),
      path: "plugin options",
    },
    metrics: sessionRows(metricRows(deps), sessionId),
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
