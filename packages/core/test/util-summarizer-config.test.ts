import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { scaledBudget } from "../src/estimate-tokens.ts";
import { SUMMARIZER_CALL_TOKENS, SUMMARIZER_PASS_TOKENS } from "../src/llm.ts";
import {
  DEFAULT_SUMMARY_TOKENS,
  healBudgets,
  type HealBudgetOptions,
  summarizerConfig,
} from "../src/util/summarizer-config.ts";

test("summarizer config: empty options resolve to the core defaults", () => {
  assert.deepEqual(summarizerConfig({}), {
    summarizerTokensPerCall: SUMMARIZER_CALL_TOKENS,
    summarizerTokensPerPass: SUMMARIZER_PASS_TOKENS,
  });
});

test("summarizer config: explicit options are kept", () => {
  assert.deepEqual(
    summarizerConfig({
      summarizer: "test/m1",
      summarizerTokensPerCall: 10_000,
      summarizerTokensPerPass: 20_000,
    }),
    {
      summarizer: "test/m1",
      summarizerTokensPerCall: 10_000,
      summarizerTokensPerPass: 20_000,
    },
  );
  assert.deepEqual(summarizerConfig({ summarizer: ["test/m1", "test/m2"] }).summarizer, [
    "test/m1",
    "test/m2",
  ]);
});

test("summarizer config: heal defaults target the fallback node with no source window", () => {
  assert.deepEqual(healBudgets(), {
    targetTokens: DEFAULT_SUMMARY_TOKENS,
    callBudgetTokens: SUMMARIZER_CALL_TOKENS,
  });
  assert.deepEqual(healBudgets({}, null), healBudgets());
});

test("summarizer config: a null ratio keeps the configured reading", () => {
  assert.equal(healBudgets({ summaryTokens: 1000 }, null).targetTokens, 1000);
  assert.equal(
    healBudgets({ summaryTokens: 1000, healSourceTokens: 2000 }, null).sourceTokens,
    2000,
  );
});

test("summarizer config: heal budgets scale with the calibrated ratio", () => {
  assert.equal(healBudgets({ summaryTokens: 1000 }, 6).targetTokens, scaledBudget(1000, 6));
  assert.equal(healBudgets({ summaryTokens: 1000 }, 6).targetTokens, 1500);
  assert.equal(
    healBudgets({ summaryTokens: 1000, healSourceTokens: 2000 }, 6).sourceTokens,
    scaledBudget(2000, 6),
  );
  assert.equal(healBudgets({ summaryTokens: 1000, healSourceTokens: 2000 }, 6).sourceTokens, 3000);
});

test("summarizer config: heal budgets match the Pi assembly seam branch for branch", () => {
  // Mirrors packages/pi/src/index.ts healBudgets: the target scales the
  // configured node (or the 1500 fallback), the source stays absent unless the
  // caller overrides it, and the call budget keeps its own default.
  assert.equal(DEFAULT_SUMMARY_TOKENS, 1500);
  assert.equal(SUMMARIZER_CALL_TOKENS, 60_000);
  const cases: Array<{ options: HealBudgetOptions; ratio: number | null }> = [
    { options: {}, ratio: null },
    { options: {}, ratio: 6 },
    { options: { summaryTokens: 1000 }, ratio: null },
    { options: { summaryTokens: 1000 }, ratio: 6 },
    { options: { healSourceTokens: 2000 }, ratio: null },
    { options: { healSourceTokens: 2000 }, ratio: 6 },
    { options: { summaryTokens: 1000, healSourceTokens: 2000 }, ratio: 6 },
    { options: { summaryTokens: 1000, summarizerTokensPerCall: 10_000 }, ratio: 6 },
  ];
  for (const { options, ratio } of cases) {
    const sourceTokens =
      options.healSourceTokens === undefined
        ? undefined
        : scaledBudget(options.healSourceTokens, ratio);
    assert.deepEqual(healBudgets(options, ratio), {
      targetTokens: scaledBudget(options.summaryTokens ?? 1500, ratio),
      callBudgetTokens: options.summarizerTokensPerCall ?? 60_000,
      ...(sourceTokens === undefined ? {} : { sourceTokens }),
    });
  }
});
