/** Per-composition JSONL sink beside the sidecar directory. The rows live in
 * the core so adapters cannot drift; this module keeps the import path its
 * callers already use and binds one recorder per composition. */

export {
  METRICS_FILE,
  METRICS_KEEP_GENERATIONS,
  METRICS_MAX_BYTES,
  appendMetricRow,
  readMetricRows,
} from "lossless-core";
export {
  metricsFilePath as metricsPath,
  rotateMetricsIfNeeded as rotateIfNeeded,
} from "lossless-core";

import { appendMetricRow } from "lossless-core";

/** One JSONL recorder bound to a sidecar directory. Appends through the
 * shared core seam, so placement (beside the sidecars), 0600 file modes,
 * and the rotation policy stay identical to the OpenCode precedent. */
export function createRecord(dir: string): (row: Record<string, unknown>) => void {
  return (row) => appendMetricRow(dir, row);
}
