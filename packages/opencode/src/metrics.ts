/** One diagnostic row per assembly decision, appended beside the session
 * sidecars. The implementation lives in the core so the hosts cannot drift;
 * this module keeps the import path its callers already use. */

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
