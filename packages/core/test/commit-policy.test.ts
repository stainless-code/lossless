import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vite-plus/test";

import {
  nextAction,
  cutMayReplace,
  effectiveThresholds,
  mergeZone,
  thresholdConflicts,
  type CommitState,
} from "../src/commit-policy.ts";
import {
  appendMetric,
  metricsPath,
  usageRecord,
  rotateIfNeeded,
  pruneGenerations,
} from "../src/metrics.ts";

function state(cutCount: number): CommitState {
  return {
    cutCount,
    synthetic: { role: "user", content: "frozen", timestamp: 0 },
    summaryId: 1,
    appliedAtOccupancy: 0.72,
    tailKey: JSON.stringify(["user", "frozen tail"]),
    applied: [],
  };
}

test("commit policy: quiet below soft, consider-apply past soft (no pin)", () => {
  assert.equal(nextAction(null, 0.5, 0.7, 0.85), "quiet");
  assert.equal(nextAction(null, 0.71, 0.7, 0.85), "consider-apply");
  assert.equal(nextAction(null, 0.7, 0.7, 0.85), "consider-apply");
});

test("commit policy: pinned projection stays stable below commit line", () => {
  const s = state(20);
  assert.equal(nextAction(s, 0.72, 0.7, 0.85), "stable");
  assert.equal(nextAction(s, 0.84, 0.7, 0.85), "stable");
  assert.equal(nextAction(s, 0.85, 0.7, 0.85), "recommit");
  assert.equal(nextAction(s, 0.95, 0.7, 0.85), "recommit");
});

test("commit policy: monotonic cut: never keep less than committed", () => {
  const s = state(30);
  assert.ok(cutMayReplace(null, 10));
  assert.ok(cutMayReplace(s, 30));
  assert.ok(cutMayReplace(s, 50));
  assert.ok(!cutMayReplace(s, 10));
});

test("thresholds: ratio mode is the default (no token overrides)", () => {
  const t = effectiveThresholds({ swapAtRatio: 0.7, recutAtRatio: 0.85 }, 1_000_000);
  assert.equal(t.swap, 0.7);
  assert.equal(t.recut, 0.85);
  assert.deepEqual(effectiveThresholds({}, 200_000), { swap: 0.7, recut: 0.85, clamped: false });
});

test("thresholds: absolute tokens override ratios (smart-zone mode)", () => {
  const t = effectiveThresholds(
    { swapAtRatio: 0.7, recutAtRatio: 0.85, swapAtTokens: 110_000, recutAtTokens: 130_000 },
    1_000_000,
  );
  assert.equal(t.swap, 0.11);
  assert.equal(t.recut, 0.13);
});

test("thresholds: token override of soft only still clamps commit above soft", () => {
  const t = effectiveThresholds({ swapAtTokens: 110_000 }, 1_000_000);
  assert.equal(t.swap, 0.11);
  assert.equal(t.recut, 0.85);
  const t2 = effectiveThresholds({ swapAtTokens: 150_000, recutAtTokens: 120_000 }, 1_000_000);
  assert.deepEqual(t2, { swap: 0.15, recut: 0.16, clamped: true });
});

test("thresholds: zero/negative token values fall back to ratio mode", () => {
  const t = effectiveThresholds({ swapAtTokens: 0, recutAtTokens: 0, swapAtRatio: 0.6 }, 500_000);
  assert.equal(t.swap, 0.6);
  assert.equal(t.recut, 0.85);
});

test("thresholds: degenerate window falls back to raw config", () => {
  const t = effectiveThresholds({ swapAtRatio: 0.7 }, 0);
  assert.equal(t.swap, 0.7);
  assert.equal(t.recut, 0.85);
});

test("thresholds: safety ceiling clamps global tokens on small windows", () => {
  assert.deepEqual(
    effectiveThresholds({ swapAtTokens: 150_000, recutAtTokens: 160_000 }, 128_000),
    {
      swap: 0.9,
      recut: 0.95,
      clamped: true,
    },
  );
  assert.deepEqual(
    effectiveThresholds({ swapAtTokens: 110_000, recutAtTokens: 130_000 }, 128_000),
    {
      swap: 0.859375,
      recut: 0.95,
      clamped: true,
    },
  );
  assert.deepEqual(
    effectiveThresholds({ swapAtTokens: 110_000, recutAtTokens: 130_000 }, 1_000_000),
    {
      swap: 0.11,
      recut: 0.13,
      clamped: false,
    },
  );
});

test("smart zone end-to-end: swap at 110k, recommit at 130k of a 1M window", () => {
  const cfg = { swapAtTokens: 110_000, recutAtTokens: 130_000 };
  const { swap, recut } = effectiveThresholds(cfg, 1_000_000);
  assert.equal(nextAction(null, 100_000 / 1_000_000, swap, recut), "quiet");
  assert.equal(nextAction(null, 111_000 / 1_000_000, swap, recut), "consider-apply");
  const pinned = state(40);
  assert.equal(nextAction(pinned, 125_000 / 1_000_000, swap, recut), "stable");
  assert.equal(nextAction(pinned, 131_000 / 1_000_000, swap, recut), "recommit");
});

test("smartZone knob: swap = smartZone, recut = smartZone × 1.18", () => {
  assert.deepEqual(effectiveThresholds({ smartZone: 110_000 }, 1_000_000), {
    swap: 0.11,
    recut: 0.1298,
    clamped: false,
  });
});

test("smartZone: explicit tokens override the knob per field", () => {
  const t = effectiveThresholds({ smartZone: 110_000, recutAtTokens: 200_000 }, 1_000_000);
  assert.equal(t.swap, 0.11);
  assert.equal(t.recut, 0.2);
});

test("smartZone: ratio fallback when knob unset is untouched", () => {
  const t = effectiveThresholds({ smartZone: 0, swapAtRatio: 0.6 }, 500_000);
  assert.equal(t.swap, 0.6);
  assert.equal(t.recut, 0.85);
});

test("smartZone: still clamped by the window safety ceiling", () => {
  assert.deepEqual(effectiveThresholds({ smartZone: 500_000 }, 128_000), {
    swap: 0.9,
    recut: 0.95,
    clamped: true,
  });
});

test("mergeZone: model entry wins field-wise, missing fields inherit global", () => {
  const global = { swapAtRatio: 0.7, recutAtRatio: 0.85, smartZone: 130_000 };
  const downshift = mergeZone(global, { smartZone: 0, swapAtRatio: 0.5 });
  assert.equal(downshift.swapAtRatio, 0.5);
  assert.equal(downshift.recutAtRatio, 0.85);
  assert.equal(downshift.smartZone, 0);
  const same = mergeZone(global, undefined);
  assert.deepEqual(same, global);
});

test("mergeZone: mixed vocabularies across levels compose", () => {
  const merged = mergeZone({ smartZone: 110_000 }, { recutAtTokens: 200_000 });
  const t = effectiveThresholds(merged, 1_000_000);
  assert.equal(t.swap, 0.11);
  assert.equal(t.recut, 0.2);
});

test("thresholdConflicts: smartZone + token pair at one level warns", () => {
  const warnings = thresholdConflicts({ smartZone: 130_000, swapAtTokens: 110_000 });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.includes("global config"));
  const zone = thresholdConflicts({ smartZone: 130_000, recutAtTokens: 130_000 }, 'zones["x/y"]');
  assert.equal(zone.length, 1);
  assert.ok(zone[0]!.includes("zones"));
  assert.equal(thresholdConflicts({ smartZone: 130_000 }).length, 0);
  assert.equal(thresholdConflicts({ swapAtTokens: 110_000, recutAtTokens: 130_000 }).length, 0);
});

test("metrics: append + rotation", () => {
  const origHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), "lcm-metrics-"));
  process.env.HOME = dir;
  try {
    const recall = (hits: number) => ({
      event: "lcm" as const,
      kind: "recall" as const,
      tool: "lcm_grep" as const,
      outcome: "hit" as const,
      hits,
    });
    appendMetric(recall(1));
    appendMetric(recall(2));
    assert.ok(existsSync(metricsPath()));
    if (process.getuid?.() !== 0) {
      assert.equal(statSync(metricsPath()).mode & 0o777, 0o600, "metrics file is owner-only");
    }
    const lines = readFileSync(metricsPath(), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!) as {
      event: string;
      kind: string;
      hits: number;
      ts: number;
    };
    assert.equal(first.event, "lcm");
    assert.equal(first.kind, "recall");
    assert.equal(first.hits, 1);
    assert.ok(typeof first.ts === "number");
  } finally {
    process.env.HOME = origHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metrics: rotateIfNeeded rotates over threshold, keeps under threshold", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rotate-"));
  const path = join(dir, "metrics.jsonl");
  try {
    writeFileSync(path, "x".repeat(150), "utf8");
    rotateIfNeeded(path, 100);
    assert.ok(!existsSync(path));
    const gen = readdirSync(dir).find((f) => f.startsWith("metrics.jsonl."));
    assert.ok(gen, "timestamped generation exists");
    assert.ok(/^\d+$/.test(gen!.slice("metrics.jsonl.".length)), "generation name is a timestamp");
    assert.equal(statSync(join(dir, gen!)).size, 150);
    appendFileSync(path, `${JSON.stringify({ event: "test" })}\n`, "utf8");
    rotateIfNeeded(path, 100);
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
    rotateIfNeeded(join(dir, "absent.jsonl"), 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metrics: pruneGenerations keeps the newest N", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-prune-"));
  const path = join(dir, "metrics.jsonl");
  try {
    for (const ts of [300, 100, 500, 200, 400]) {
      writeFileSync(`${path}.${ts}`, String(ts), "utf8");
    }
    pruneGenerations(path, 4);
    const left = readdirSync(dir)
      .filter((f) => f.startsWith("metrics.jsonl."))
      .map((f) => Number(f.slice("metrics.jsonl.".length)))
      .sort((a: number, b: number) => a - b);
    assert.deepEqual(left, [200, 300, 400, 500]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metrics: usage normalization keeps numbers, nulls garbage", () => {
  const r = usageRecord({
    input: 123,
    output: 45,
    cacheRead: 9999,
    cacheWrite: "nope",
    cost: { input: 0.01, output: 0.02, total: 0.03 },
  });
  assert.deepEqual(r, {
    event: "usage",
    input: 123,
    output: 45,
    cacheRead: 9999,
    cacheWrite: null,
    costInput: 0.01,
    costOutput: 0.02,
    costTotal: 0.03,
  });
  assert.equal(usageRecord(undefined), undefined);
  assert.equal(usageRecord({ input: "12", cost: {} }), undefined);
});
