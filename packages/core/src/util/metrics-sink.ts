import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Basename of the JSONL metrics log inside a sidecar directory. */
export const METRICS_FILE = "metrics.jsonl";
/** Size in bytes that triggers rotation (5 MiB); the full log is renamed aside. */
export const METRICS_MAX_BYTES = 5 * 1024 * 1024;
/** Rotated generations kept beside the live log; older timestamped files are deleted. */
export const METRICS_KEEP_GENERATIONS = 3;

/** One metrics row: free-form fields plus an optional unix-ms stamp, session id, and kind. */
export interface MetricSinkRow extends Record<string, unknown> {
  ts?: number;
  session?: string;
  kind?: string;
}

/** The live metrics file inside a sidecar directory. */
export function metricsFilePath(dir: string): string {
  return join(dir, METRICS_FILE);
}

/** Rename an over-budget log to `<file>.<Date.now()>` and keep only the newest generations. Never throws. */
export function rotateMetricsIfNeeded(dir: string): void {
  const path = metricsFilePath(dir);
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size <= METRICS_MAX_BYTES) return;
    renameSync(path, `${path}.${Date.now()}`);
    pruneGenerations(path, METRICS_KEEP_GENERATIONS);
  } catch {}
}

function pruneGenerations(path: string, keep: number): void {
  try {
    const dir = dirname(path);
    const prefix = `${METRICS_FILE}.`;
    const generations = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
    for (const stale of generations.slice(keep)) {
      try {
        unlinkSync(join(dir, stale));
      } catch {}
    }
  } catch {}
}

/** Append one JSONL row, stamping `ts` in unix ms when absent; creates the dir with mode 0700. Never throws. */
export function appendMetricRow(dir: string, row: Record<string, unknown>): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    rotateMetricsIfNeeded(dir);
    const path = metricsFilePath(dir);
    const stamped = typeof row.ts === "number" ? row : { ts: Date.now(), ...row };
    appendFileSync(path, `${JSON.stringify(stamped)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {}
}

/** Filter for {@link readMetricRows}: narrows to one session and keeps only the newest rows. */
export interface ReadMetricRowsOptions {
  readonly session?: string;
  readonly limit?: number;
}

/** Read rotated generations oldest-first plus the live log, skipping missing files and malformed lines. */
export function readMetricRows(dir: string, opts?: ReadMetricRowsOptions): unknown[] {
  const session =
    typeof opts?.session === "string" && opts.session.length > 0 ? opts.session : undefined;
  const limit =
    typeof opts?.limit === "number" && Number.isFinite(opts.limit) ? opts.limit : undefined;
  if (session === undefined && (limit === undefined || limit < 0)) {
    return readAllMetricRows(dir);
  }
  if (limit !== undefined && limit <= 0) return [];
  const capped = limit === undefined ? undefined : Math.floor(limit);
  const paths = metricPaths(dir);
  const kept: unknown[] = [];
  for (let i = paths.length - 1; i >= 0; i -= 1) {
    let text: string;
    try {
      text = readFileSync(paths[i] as string, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let j = lines.length - 1; j >= 0; j -= 1) {
      const trimmed = (lines[j] as string).trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      if (session !== undefined && (parsed as Record<string, unknown>).session !== session)
        continue;
      kept.push(parsed);
      if (capped !== undefined && kept.length >= capped) {
        kept.reverse();
        return kept;
      }
    }
  }
  kept.reverse();
  return kept;
}

function metricPaths(dir: string): string[] {
  const paths: string[] = [];
  const base = metricsFilePath(dir);
  try {
    const prefix = `${METRICS_FILE}.`;
    for (const name of readdirSync(dir)) {
      const suffix = name.slice(prefix.length);
      if (name.startsWith(prefix) && /^\d+$/.test(suffix)) paths.push(join(dir, name));
    }
  } catch {}
  paths.sort(
    (a, b) => Number(a.slice(a.lastIndexOf(".") + 1)) - Number(b.slice(b.lastIndexOf(".") + 1)),
  );
  paths.push(base);
  return paths;
}

function readAllMetricRows(dir: string): unknown[] {
  const paths = metricPaths(dir);

  const rows: unknown[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        rows.push(parsed);
      }
    }
  }
  return rows;
}

/** Running provider counts one ladder sums across calls. Host-free so every
 * adapter tallies the same four legs without importing a provider SDK. */
export interface UsageTally {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Empty tally: no call has been added yet. */
export function createUsageTally(): UsageTally {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Add one call's counts. Legs are required numbers per the core Usage type. */
export function addUsageTally(
  tally: UsageTally,
  delta: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
  tally.input += delta.input;
  tally.output += delta.output;
  tally.cacheRead += delta.cacheRead;
  tally.cacheWrite += delta.cacheWrite;
}

/** Fold a tally into provider token names. Undefined when nothing was billed,
 * so the caller keeps the absent usage signal instead of a zero row. */
export function tokenUsageOfTally(tally: UsageTally):
  | {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  | undefined {
  if (tally.input === 0 && tally.output === 0) return undefined;
  return {
    inputTokens: tally.input,
    outputTokens: tally.output,
    totalTokens: tally.input + tally.output,
    cacheReadTokens: tally.cacheRead,
    cacheWriteTokens: tally.cacheWrite,
  };
}

/** Build the usage record with zeroed cost legs: nothing offline knows what a
 * token costs here, so every cost leg is zero and the totals stay exact. */
export function zeroCostUsageOfTokens(
  usage:
    | {
        inputTokens: number;
        outputTokens: number;
        totalTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      }
    | undefined,
):
  | {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    }
  | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  return {
    input,
    output,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
