import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  METRICS_FILE,
  METRICS_MAX_BYTES,
  appendMetricRow,
  metricsPath,
  readMetricRows,
  rotateIfNeeded,
} from "../src/metrics.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-metrics-"));
}

function generations(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${METRICS_FILE}.`))
    .sort();
}

describe("metrics log", () => {
  it("reads back what it appended and tolerates a missing file", () => {
    const dir = tempDir();
    expect(readMetricRows(dir)).toEqual([]);
    appendMetricRow(dir, { ts: 1, session: "ses_1", kind: "projection", action: "quiet" });
    appendMetricRow(dir, { ts: 2, session: "ses_1", kind: "recall", tool: "lcm_grep" });
    expect(readMetricRows(dir)).toEqual([
      { ts: 1, session: "ses_1", kind: "projection", action: "quiet" },
      { ts: 2, session: "ses_1", kind: "recall", tool: "lcm_grep" },
    ]);
  });

  it("skips malformed lines and non-object rows instead of failing the read", () => {
    const dir = tempDir();
    writeFileSync(
      metricsPath(dir),
      [
        '{"ts":1,"kind":"projection"}',
        "",
        "not json",
        "[1,2,3]",
        "null",
        '"text"',
        '{"ts":2,"kind":"pass"}',
        "",
      ].join("\n"),
    );
    expect(readMetricRows(dir)).toEqual([
      { ts: 1, kind: "projection" },
      { ts: 2, kind: "pass" },
    ]);
  });

  it("rotates at the size cap and keeps three generations", () => {
    const dir = tempDir();
    for (const suffix of ["100", "200", "300", "400"]) {
      writeFileSync(`${metricsPath(dir)}.${suffix}`, '{"ts":0}\n');
    }
    writeFileSync(metricsPath(dir), "x".repeat(METRICS_MAX_BYTES + 1));
    appendMetricRow(dir, { ts: 3, kind: "recall" });

    expect(readMetricRows(dir).at(-1)).toEqual({ ts: 3, kind: "recall" });
    const kept = generations(dir);
    expect(kept).toHaveLength(3);
    expect(kept).not.toContain(`${METRICS_FILE}.100`);
    expect(kept).not.toContain(`${METRICS_FILE}.200`);
    // The rotated file keeps the rows it held, oldest generation first.
    expect(readMetricRows(dir)[0]).toEqual({ ts: 0 });
  });

  it("leaves a small log in place", () => {
    const dir = tempDir();
    appendMetricRow(dir, { ts: 1 });
    rotateIfNeeded(dir);
    expect(generations(dir)).toEqual([]);
    expect(readMetricRows(dir)).toEqual([{ ts: 1 }]);
  });

  it("creates the directory 0700 and the log 0600", () => {
    const dir = join(tempDir(), "lossless");
    appendMetricRow(dir, { ts: 1 });
    expect(existsSync(metricsPath(dir))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(metricsPath(dir)).mode & 0o777).toBe(0o600);
  });
});
