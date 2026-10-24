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

export const METRICS_FILE = "metrics.jsonl";
export const METRICS_MAX_BYTES = 5 * 1024 * 1024;
export const METRICS_KEEP_GENERATIONS = 3;

export interface MetricSinkRow extends Record<string, unknown> {
  ts?: number;
  session?: string;
  kind?: string;
}

export function metricsFilePath(dir: string): string {
  return join(dir, METRICS_FILE);
}

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

export function readMetricRows(dir: string): unknown[] {
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
