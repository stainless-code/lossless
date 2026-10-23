import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { formatMetricsReport, reportCommand } from "../src/command.ts";
import { metricsPath, readMetricRows } from "../src/metrics.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-report-"));
}

const SESSION = "ses_report";

const ROWS: ReadonlyArray<Record<string, unknown>> = [
  { ts: 1, session: SESSION, kind: "projection", action: "quiet", occupancy: 0.3, tokens: 300 },
  {
    ts: 2,
    session: SESSION,
    kind: "projection",
    action: "kick",
    occupancy: 0.75,
    reason: "summary-missing",
  },
  {
    ts: 3,
    session: SESSION,
    kind: "projection",
    action: "kick",
    occupancy: 0.76,
    reason: "summary-missing",
  },
  {
    ts: 4,
    session: SESSION,
    kind: "projection",
    action: "bail",
    occupancy: 0.77,
    reason: "host-checkpoint",
  },
  { ts: 5, session: SESSION, kind: "projection", action: "swap", occupancy: 0.72, tokens: 92000 },
  {
    ts: 6,
    session: SESSION,
    kind: "compaction-checkpoint",
    action: "checkpoint",
    summaryIds: [12, 13],
    chars: 4180,
  },
  { ts: 7, session: SESSION, kind: "compaction-checkpoint", action: "skip", reason: "no-boundary" },
  {
    ts: 8,
    session: SESSION,
    kind: "pass",
    stage: "direct",
    outcome: "stored",
    leaf: 2,
    condensed: 1,
  },
  {
    ts: 9,
    session: SESSION,
    kind: "pass",
    stage: "async",
    outcome: "failed",
    error: "provider down",
  },
  { ts: 10, session: SESSION, kind: "recall", tool: "lcm_grep", outcome: "hit" },
  { ts: 11, session: SESSION, kind: "recall", tool: "lcm_grep", outcome: "miss" },
  { ts: 12, session: SESSION, kind: "recall", tool: "lcm_expand", outcome: "hit" },
  { ts: 13, session: SESSION, kind: "reader", outcome: "answered", durationMs: 1200 },
  { ts: 14, session: SESSION, kind: "reader", outcome: "failed", durationMs: 800 },
  { ts: 15, session: "ses_other", kind: "projection", action: "swap", occupancy: 0.99 },
];

function seeded(): { dir: string; text: string } {
  const dir = tempDir();
  writeFileSync(metricsPath(dir), `${ROWS.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { dir, text: formatMetricsReport(readMetricRows(dir), SESSION) };
}

describe("lossless report", () => {
  it("renders one bounded summary of this session's rows", () => {
    const { text } = seeded();

    expect(text).toContain("LCM metrics: 14 row(s) for this session (15 in the log).");
    expect(text).toContain("projections: 5 (quiet 1, swap 1, kick 2, bail 1)");
    expect(text).toContain("kick: summary-missing 2");
    expect(text).toContain("bail: host-checkpoint 1");
    expect(text).toContain(
      "checkpoints: 1 written, 1 skipped, 0 failed; last #12,#13 (4180 chars)",
    );
    expect(text).toContain("passes: 2 (stored 1, nothing 0, failed 1); 2 leaf, 1 condensed");
    expect(text).toContain("lcm_grep 2 (hit 1, miss 1)");
    expect(text).toContain("lcm_expand 1 (hit 1)");
    expect(text).toContain("reader: 2 (1 answered, 1 failed, 0 timeout); avg 1000 ms");
    expect(text).toContain("last decision: swap at 0.720 occupancy (92000 tokens)");
    expect(text).not.toContain("ses_other");
    expect(text.length).toBeLessThan(2048);
  });

  it("says so when the session has no rows", () => {
    expect(formatMetricsReport(ROWS, "ses_absent")).toContain("no rows recorded for this session");
    expect(formatMetricsReport([], SESSION)).toContain("no rows recorded for this session");
  });

  it("answers the command through a session prompt", async () => {
    const { dir } = seeded();
    const prompts: Array<{ sessionID: string; text: string }> = [];
    const command = reportCommand({
      dir,
      prompt: (sessionID, text) => {
        prompts.push({ sessionID, text });
        return Promise.resolve(undefined);
      },
    });
    await command.execute({ sessionID: SESSION, prompt: { text: "" }, delivery: "steer" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe(SESSION);
    expect(prompts[0]?.text).toContain("projections:");
    expect(command.name).toBe("lossless-report");
  });
});
