import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { test } from "vite-plus/test";

import { metricsPath } from "../src/metrics.ts";
import { buildReport, collectMetricsEvents, depthStats, type MetricsEvent } from "../src/report.ts";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function ev(partial: Record<string, unknown>): MetricsEvent {
  return { ts: T0, event: "lcm", ...partial } as MetricsEvent;
}

test("report: a lone node brought back under budget reads as its own line", () => {
  const report = buildReport([
    ev({
      kind: "condensation-reduced",
      summaryId: 7,
      depth: 1,
      level: 1,
      beforeTokens: 3500,
      afterTokens: 900,
      targetTokens: 1500,
      frontierTokens: 3515,
    }),
  ]);
  assert.match(
    report,
    /## Lone nodes brought back under budget \(1 re-summarized in place, 2\.6k tokens freed\)/,
  );
});

test("report: four protocol sections from a small fixture", () => {
  const events: MetricsEvent[] = [
    { ts: T0, event: "usage", input: 1000, cacheRead: 0, cacheWrite: 0, costTotal: 0.01 },
    { ts: T0 + MIN, event: "usage", input: 1200, cacheRead: 0, cacheWrite: 0, costTotal: 0.02 },
    ev({ kind: "context-decision", action: "quiet", occupancy: 0.05, commit: 0.85 }),
    ev({ kind: "context-decision", action: "recommit", occupancy: 0.92, commit: 0.85 }),
    ev({ ts: T0 + 2 * MIN, kind: "swap-applied", summaryId: 1, cutCount: 10 }),
    {
      ts: T0 + 5 * MIN,
      event: "usage",
      input: 500,
      cacheRead: 90_000,
      cacheWrite: 0,
      costTotal: 0.004,
    },
    ev({ ts: T0 + 15 * MIN, kind: "swap-applied", summaryId: 2, cutCount: 12 }),
    ev({ kind: "summarizer-error", error: "boom" }),
    ev({ kind: "summarizer-fallback", used: "b/c" }),
  ];
  const report = buildReport(events);
  assert.match(report, /## Occupancy dwell \(2 decisions\)/);
  assert.match(report, /At\/above the recut line: 1 of 2 \(50\.0%\)/);
  assert.ok(report.includes("## Swap cadence (2 applications, 2 distinct boundaries)"));
  assert.ok(report.includes("| (no session) | 2 | 2 | 13.0 |"));
  assert.match(report, /\| before first swap \| 2 \| 2\.2k \| 0 \| 0 \| \$0\.0300 \|/);
  assert.match(report, /\| after first swap \| 1 \| 500 \| 90\.0k \| 0 \| \$0\.0040 \|/);
  assert.match(report, /## Summarizer health \(2 error\/capped\/fallback\/abandoned events\)/);
  assert.match(report, /^\| 2023-11-14 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \|$/m);
});

test("report: a discarded pass is counted in summarizer health, by day", () => {
  const events: MetricsEvent[] = [
    ev({
      kind: "compaction-stale",
      reason: "model-changed",
      changed: [],
      stage: "async",
      entryId: "e3",
      span: ["e1", "e3"],
      dropped: 2,
    }),
    ev({ ts: T0 + MIN, kind: "compaction-stale", reason: "settings-changed", dropped: 1 }),
    ev({ ts: T0 + MIN, kind: "compaction-abandoned", stage: "async", dropped: 3 }),
  ];
  const report = buildReport(events);
  assert.match(report, /## Summarizer health \(3 error\/capped\/fallback\/abandoned events\)/);
  assert.match(report, /^\| 2023-11-14 \| 0 \| 0 \| 0 \| 0 \| 2 \| 1 \| 0 \|$/m);
});

test("report: a pass that covered nothing is counted with its reason, and is not an error", () => {
  const events: MetricsEvent[] = [
    ev({
      kind: "compaction-noop",
      stage: "async",
      reason: "covered",
      ingested: 0,
      span: ["e1", "e3"],
    }),
    ev({
      ts: T0 + MIN,
      kind: "compaction-noop",
      stage: "blocking",
      reason: "no-entries",
      ingested: 0,
    }),
    ev({
      ts: T0 + MIN,
      kind: "compaction-noop",
      stage: "async",
      reason: "no-entries",
      ingested: 4,
    }),
  ];
  const report = buildReport(events);
  assert.match(report, /## Passes that covered nothing/);
  assert.match(report, /3 passes produced no text: covered 1, no-entries 2\./);
  assert.match(report, /## Summarizer health \(0 error\/capped\/fallback\/abandoned events\)/);
});

test("report: swap cadence counts boundaries, not applications of one cut", () => {
  const events: MetricsEvent[] = [
    ev({ ts: T0, kind: "swap-applied", session: "s1", cutCount: 91 }),
    ev({ ts: T0 + MIN, kind: "swap-applied", session: "s1", cutCount: 91 }),
    ev({ ts: T0 + 2 * MIN, kind: "swap-applied", session: "s1", cutCount: 91 }),
    ev({ ts: T0 + 60 * MIN, kind: "swap-applied", session: "s1", cutCount: 360 }),
    ev({
      ts: T0 + 61 * MIN,
      kind: "swap-applied",
      session: "s2",
      cutCount: 7,
      distinctBoundary: true,
    }),
    ev({
      ts: T0 + 62 * MIN,
      kind: "swap-applied",
      session: "s2",
      cutCount: 7,
      distinctBoundary: false,
    }),
  ];
  const report = buildReport(events);
  assert.ok(report.includes("## Swap cadence (6 applications, 3 distinct boundaries)"));
  assert.ok(report.includes("3 of 6 applications re-applied a boundary already served"));
  assert.ok(report.includes("| s1 | 4 | 2 | 60.0 |"));
  assert.ok(report.includes("| s2 | 2 | 1 | n/a |"));
  assert.ok(!report.includes("median minutes between swaps"));
});

test("report: condensation stalls are listed with a reason and the worst overrun", () => {
  const events: MetricsEvent[] = [
    ev({
      ts: T0,
      kind: "condensation-stalled",
      reason: "no-same-depth-run",
      nodes: 2,
      frontierTokens: 3000,
      targetTokens: 1500,
      cap: 8,
    }),
    ev({
      ts: T0 + MIN,
      kind: "condensation-stalled",
      reason: "no-same-depth-run",
      nodes: 1,
      frontierTokens: 4224,
      targetTokens: 1500,
      cap: 8,
    }),
    ev({ ts: T0 + 2 * MIN, kind: "condensation-stalled", reason: "depth-cap", cap: 1 }),
  ];
  const report = buildReport(events);
  assert.match(report, /## Condensation stalls \(3 passes over budget\)/);
  assert.match(report, /\| 2023-11-14 \| no-same-depth-run \| 2 \| 2\.82× \|/);
  assert.match(report, /\| 2023-11-14 \| depth-cap \| 1 \| \(unrecorded\) \|/);
});

test("report: oversize and truncation counts are listed by day", () => {
  const events: MetricsEvent[] = [
    ev({ ts: T0, kind: "summary-oversized", stage: "leaf", tokens: 5000, targetTokens: 1500 }),
    ev({ ts: T0 + MIN, kind: "summary-oversized", stage: "condensed", tokens: 3288 }),
    ev({ ts: T0 + 2 * MIN, kind: "summary-final-truncated", beforeTokens: 18_000 }),
    ev({ ts: T0 + 3 * MIN, kind: "a-kind-this-build-never-wrote", droppedChars: 500 }),
  ];
  const report = buildReport(events);
  assert.match(report, /## Content lost or oversized \(3 events\)/);
  assert.match(report, /\| 2023-11-14 \| 2 \| 1 \|/);
  assert.doesNotMatch(report, /a-kind-this-build-never-wrote/);
});

test("collectMetricsEvents: non-object JSON lines are skipped, not pushed", () => {
  const origHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), "lcm-report-"));
  process.env.HOME = dir;
  try {
    const p = metricsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      [
        "null",
        '"a string"',
        "42",
        "[1,2]",
        "{not json",
        '{"event":"usage","input":7}',
        '{"event":"usage","costTotal":"oops","input":"12","cacheRead":null,"ts":"x","kind":5,"extra":"kept"}',
        "",
      ].join("\n"),
    );
    const events = collectMetricsEvents();
    assert.deepEqual(events, [
      { event: "usage", input: 7 },
      { event: "usage", cacheRead: null, extra: "kept" },
    ]);
    const report = buildReport(events);
    assert.match(report, /## Occupancy dwell \(0 decisions\)/);
    assert.match(report, /\| total \| 2 \| 7 \| 0 \| 0 \| \$0\.0000 \|/);
  } finally {
    process.env.HOME = origHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectMetricsEvents: a rotated generation is read before the live file", () => {
  const origHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), "lcm-report-"));
  process.env.HOME = dir;
  try {
    const p = metricsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.1700000000000`, '{"event":"usage","input":1}\n');
    writeFileSync(`${p}.1700000000001`, '{"event":"usage","input":2}\n');
    writeFileSync(p, '{"event":"usage","input":3}\n');
    assert.deepEqual(
      collectMetricsEvents().map((e) => e.input),
      [1, 2, 3],
    );
    assert.match(buildReport(collectMetricsEvents()), /3 rows across 3 files\./);
  } finally {
    process.env.HOME = origHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: the header names how many rows and files the window holds", () => {
  const report = buildReport([
    ev({ kind: "context-decision", action: "quiet" }),
    ev({ ts: T0 + 60 * MIN, kind: "context-decision", action: "quiet" }),
  ]);
  assert.match(
    report,
    /^# LCM metrics report\n\n2 rows across 1 file, 2023-11-14 22:13 to 2023-11-14 23:13 UTC/,
  );
});

test("report: reader calls are split into addressed and searched", () => {
  const report = buildReport([
    ev({ kind: "retrieval", stop: "answered", scope: "summary", summaryId: 7 }),
    ev({ kind: "retrieval", stop: "answered", scope: "entry", entryId: "e00" }),
    ev({ kind: "retrieval", stop: "answered" }),
  ]);
  assert.match(report, /\| addressed summary \| addressed entry \| searched \|/);
  assert.match(report, /\| 1 \| 1 \| 1 \|/);
});

test("depthStats: one row per depth, ascending, with rounded averages", () => {
  assert.deepEqual(depthStats([]), []);
  const rows = depthStats([
    { depth: 1, tokens: 900 },
    { depth: 0, tokens: 1000 },
    { depth: 0, tokens: 2000 },
    { depth: 0, tokens: 1001 },
    { depth: 3, tokens: 7 },
  ]);
  assert.deepEqual(rows, [
    { depth: 0, count: 3, totalTokens: 4001, avgTokens: 1334 },
    { depth: 1, count: 1, totalTokens: 900, avgTokens: 900 },
    { depth: 3, count: 1, totalTokens: 7, avgTokens: 7 },
  ]);
});

test("report: summarizer spend is its own section, not the session's usage", () => {
  const events: MetricsEvent[] = [
    {
      ts: T0,
      event: "usage",
      input: 1000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      costTotal: 0.1,
    },
    ev({
      ts: T0 + MIN,
      kind: "summarizer-usage",
      model: "p/m",
      stage: "async",
      outcome: "ok",
      stopReason: "stop",
      input: 4000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      costInput: 0.01,
      costOutput: 0.02,
      costTotal: 0.03,
    }),
    ev({
      ts: T0 + 2 * MIN,
      kind: "summarizer-usage",
      model: "p/m",
      stage: "blocking",
      outcome: "failure",
      stopReason: "length",
      input: 2000,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      costInput: 0.005,
      costOutput: 0.001,
      costTotal: 0.006,
    }),
  ];
  const report = buildReport(events);
  assert.ok(report.includes("## Summarizer spend (2 provider calls, $0.0360)"));
  assert.ok(report.includes("| p/m | async | 1 | 4.0k | 0 | 500 | $0.0300 |"));
  assert.ok(report.includes("| p/m | blocking | 1 | 2.0k | 0 | 20 | $0.0060 |"));
  assert.ok(report.includes("| total | | 2 | 6.0k | 0 | 520 | $0.0360 |"));
  assert.ok(
    report.includes("Summarizer calls are 36.0% of the $0.1000 the session's own turns cost"),
  );
  assert.ok(report.includes("1 of 2 calls were rejected by the provider"));
  assert.ok(report.includes("| total | 1 | 1.0k | 0 | 0 | $0.1000 |"));
  assert.ok(!report.includes("before first swap | 2 |"));
});

test("report: a restarted process does not recount a boundary it already applied", () => {
  const events: MetricsEvent[] = [
    ev({ ts: T0, kind: "swap-applied", session: "s1", cutCount: 481 }),
    ev({
      ts: T0 + 13 * MIN,
      kind: "swap-applied",
      session: "s1",
      cutCount: 481,
      distinctBoundary: true,
    }),
    ev({
      ts: T0 + 14 * MIN,
      kind: "swap-applied",
      session: "s1",
      cutCount: 481,
      distinctBoundary: false,
    }),
  ];
  const report = buildReport(events);
  assert.ok(report.includes("## Swap cadence (3 applications, 1 distinct boundary)"));
  assert.ok(report.includes("| s1 | 3 | 1 | n/a |"));
  assert.ok(report.includes("2 of 3 applications re-applied a boundary already served"));
});

test("report: recall tool use answers the pointer question, split by swap order", () => {
  const events: MetricsEvent[] = [
    ev({ ts: T0, kind: "swap-applied", session: "s1", cutCount: 10 }),
    ev({ ts: T0 + MIN, kind: "recall", session: "s1", tool: "lcm_grep", outcome: "hit", hits: 3 }),
    ev({ ts: T0 + 2 * MIN, kind: "recall", session: "s1", tool: "lcm_describe", outcome: "miss" }),
    ev({ ts: T0 + 3 * MIN, kind: "recall", session: "s2", tool: "lcm_grep", outcome: "miss" }),
    ev({ ts: T0 + 4 * MIN, kind: "swap-applied", session: "s2", cutCount: 4 }),
    ev({ ts: T0 + 5 * MIN, kind: "swap-applied", session: "s3", cutCount: 7 }),
  ];
  const report = buildReport(events);
  assert.match(report, /## Recall tool use \(3 calls across 2 sessions\)/);
  assert.match(report, /\| lcm_grep \| 2 \| 1 \| 1 \| 0 \|/);
  assert.match(report, /\| lcm_describe \| 1 \| 0 \| 1 \| 0 \|/);
  assert.match(
    report,
    /1 of 2 sessions that used a recall tool had already applied a swap, so a projection pointer existed before the call\. 1 of 3 sessions that applied a swap never called one\./,
  );
});

test("report: no recall rows prints no recall section", () => {
  const report = buildReport([ev({ kind: "swap-applied", session: "s1", cutCount: 1 })]);
  assert.ok(!report.includes("## Recall tool use"));
});

test("report: Pi's own head compaction is the overflow number C3 waits on", () => {
  const events: MetricsEvent[] = [
    ev({
      ts: T0,
      kind: "pi-compaction",
      session: "s1",
      entryId: "c0",
      tokens: 120_000,
      window: 128_000,
    }),
    ev({
      ts: T0 + MIN,
      kind: "pi-compaction",
      session: "s1",
      entryId: "c1",
      tokens: 122_000,
      window: 128_000,
    }),
    ev({
      ts: T0 + 2 * MIN,
      kind: "pi-compaction",
      session: "s2",
      entryId: "c2",
      tokens: 60_000,
      window: 128_000,
    }),
  ];
  const report = buildReport(events);
  assert.match(report, /## Window overflow \(Pi's own compaction\)/);
  assert.match(report, /Pi compacted a session head 3 times across 2 sessions/);
  assert.match(report, /\| s1 \| 2 \| 122\.0k \| 128\.0k \|/);
  assert.match(report, /\| s2 \| 1 \| 60\.0k \| 128\.0k \|/);
});

test("report: no Pi compaction prints the zero line, not an empty section", () => {
  const report = buildReport([ev({ kind: "swap-applied", session: "s1", cutCount: 1 })]);
  assert.match(report, /## Window overflow \(Pi's own compaction\)/);
  assert.match(report, /Pi never compacted a session head in these rows/);
});

test("report: reader spend is reported apart from the turn totals", () => {
  const events: MetricsEvent[] = [
    { ts: T0, event: "usage", input: 1000, cacheRead: 0, cacheWrite: 0, costTotal: 0.01 },
    ev({
      ts: T0 + MIN,
      kind: "retrieval",
      session: "s1",
      steps: 3,
      retrievedTokens: 900,
      budgetTokens: 10_000,
      input: 5000,
      cacheRead: 1000,
      cacheWrite: 0,
      output: 200,
      costTotal: 0.004,
      stop: "answered",
    }),
  ];
  const report = buildReport(events);
  assert.match(report, /## Retrieval reader spend \(1 call\)/);
  assert.match(report, /\| 1 \| 5\.0k \| 1\.0k \| 0 \| 200 \| \$0\.0040 \|/);
  assert.match(report, /Reader calls are not part of the turn totals above/);
  assert.match(report, /\| total \| 1 \| 1\.0k \| 0 \| 0 \| \$0\.0100 \|/);
});

test("report: a reader that reported no counters says so", () => {
  const report = buildReport([
    ev({ kind: "retrieval", session: "s1", steps: 1, budgetTokens: 1000, stop: "failed" }),
  ]);
  assert.match(report, /## Retrieval reader spend \(1 call\)/);
  assert.match(report, /No reader call in these rows reported provider counters\./);
});

test("report: branch navigation is its own section, and absent without rows", () => {
  const withRows = buildReport([
    ev({ ts: T0, kind: "branch-removed", session: "s1", removed: 3, restored: 0 }),
    ev({ ts: T0 + MIN, kind: "branch-removed", session: "s1", removed: 1, restored: 2 }),
    ev({ ts: T0 + 2 * MIN, kind: "branch-removed", session: "s2", removed: 4, restored: 0 }),
  ]);
  assert.ok(withRows.includes("## Branch navigation (3 changes across 2 sessions)"));
  assert.ok(withRows.includes("| s1 | 4 | 2 |"), withRows);
  assert.ok(withRows.includes("| s2 | 4 | 0 |"), withRows);
  const one = buildReport([
    ev({ ts: T0, kind: "branch-removed", session: "s1", removed: 1, restored: 1 }),
  ]);
  assert.ok(one.includes("## Branch navigation (1 change across 1 session)"), one);
  assert.ok(
    !buildReport([ev({ kind: "swap-applied", session: "s1", cutCount: 1 })]).includes(
      "## Branch navigation",
    ),
  );
});

test("report: a capped pass is a column, and its cause is named", () => {
  const events: MetricsEvent[] = [
    ev({
      ts: T0,
      kind: "summarizer-capped",
      stage: "async",
      fingerprint: "e0..e9|s/session",
      failedWalks: 3,
      category: "rate-limit",
      source: "pass",
      span: ["e0", "e9"],
    }),
    ev({
      ts: T0 + MIN,
      kind: "summarizer-capped",
      fingerprint: "e0..e9|s/session",
      failedWalks: 0,
      category: "rate-limit",
      source: "span-memory",
      span: ["e0", "e9"],
    }),
    ev({ ts: T0 + MIN, kind: "summarizer-error", reason: "threw", category: "rate-limit" }),
  ];
  const report = buildReport(events);
  assert.match(report, /## Summarizer health \(3 error\/capped\/fallback\/abandoned events\)/);
  assert.match(report, /^\| 2023-11-14 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 2 \|$/m);
  assert.match(report, /Capped passes by cause: rate-limit 2\./);
});
