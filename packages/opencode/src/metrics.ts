/** One diagnostic row per assembly decision, appended beside the session
 * sidecars. `appendFile` only applies `mode` when it creates the file, so an
 * existing log is re-chmodded on every row rather than left at whatever mode a
 * previous process gave it. Metrics are diagnostic only: a read-only directory
 * must not break a turn or a compaction.
 *
 * The log rotates by size, the way core's does for Pi, but the generation
 * count is smaller because this file only holds one sidecar directory's
 * sessions. A reader joins the generations oldest first, so a report still
 * covers a window that straddles a rotation. */

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

export function metricsPath(dir: string): string {
  return join(dir, METRICS_FILE);
}

/** Move the log aside when it outgrows the cap. A rotation that cannot happen
 * (a read-only directory, a file that vanished) leaves the next append to
 * decide; the row is worth more than the generation boundary. */
export function rotateIfNeeded(dir: string): void {
  const path = metricsPath(dir);
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
    rotateIfNeeded(dir);
    const path = metricsPath(dir);
    const stamped = typeof row.ts === "number" ? row : { ts: Date.now(), ...row };
    appendFileSync(path, `${JSON.stringify(stamped)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // The caller's work already happened; a read-only directory loses the row.
  }
}

/** Every row the log holds, oldest generation first. A missing file is an empty
 * history, and a malformed line is skipped rather than failing the read: one
 * half-written row must not hide the rest. Only JSON objects are rows, because
 * a report reads named fields and an array or scalar has none. */
export function readMetricRows(dir: string): unknown[] {
  const paths: string[] = [];
  const base = metricsPath(dir);
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
