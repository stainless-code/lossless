import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import {
  parseLcmConfig,
  passConditions,
  changedPassConditions,
  staleReason,
} from "../src/ui/config-io.ts";
import type { LcmConfig, PassIdentity } from "../src/ui/config-io.ts";

const COCKPIT_CONFIG = {
  summarizer: ["one/model", "two/model"],
  smartZone: 120_000,
  swapAtTokens: 0,
  recutAtTokens: 0,
  swapAtRatio: 0.5,
  recutAtRatio: 0.95,
  summaryTokens: 750,
  leafChunkTokens: 2000,
  keepRecentTokens: 10_000,
  maxAsyncChunks: 6,
  summarizerTokensPerCall: 60_000,
  summarizerTokensPerPass: 250_000,
  redactSecrets: false,
  assemblyEnabled: true,
  zones: { "one/model": { swapAtRatio: 0.9, swapAtTokens: 0, smartZone: 0 } },
};

test("config-io: the values the cockpit writes all survive the parse", () => {
  const { config, dropped, notes } = parseLcmConfig(COCKPIT_CONFIG);
  assert.deepEqual(dropped, []);
  assert.deepEqual(notes, []);
  assert.deepEqual(config, COCKPIT_CONFIG);
});

test("config-io: a number outside its range is dropped by key, not coerced", () => {
  const cases: Array<[string, number]> = [
    ["summaryTokens", 0],
    ["summaryTokens", -1500],
    ["summaryTokens", 0.5],
    ["leafChunkTokens", 0],
    ["maxAsyncChunks", 0],
    ["summarizerTokensPerCall", 0],
    ["summarizerTokensPerPass", 0],
    ["summarizerTokensPerPass", -1],
    ["keepRecentTokens", -1],
    ["smartZone", -1],
    ["swapAtTokens", -1],
    ["recutAtTokens", -1],
    ["swapAtRatio", 0],
    ["swapAtRatio", 1.5],
    ["recutAtRatio", 0],
    ["recutAtRatio", 2],
  ];
  for (const [key, value] of cases) {
    const { config, dropped } = parseLcmConfig({ [key]: value });
    assert.deepEqual(dropped, [`${key} (out of range)`], `${key}: ${value}`);
    assert.deepEqual(config, {}, `${key}: ${value}`);
  }
});

test("config-io: the edges of every range are kept", () => {
  const edges = {
    summaryTokens: 1,
    leafChunkTokens: 1,
    maxAsyncChunks: 1,
    keepRecentTokens: 0,
    smartZone: 0,
    swapAtTokens: 0,
    recutAtTokens: 0,
    swapAtRatio: 1,
    recutAtRatio: 0.0001,
  };
  const { config, dropped } = parseLcmConfig(edges);
  assert.deepEqual(dropped, []);
  assert.deepEqual(config, edges);
});

test("config-io: zone overrides carry the same ranges, named by their path", () => {
  const { config, dropped } = parseLcmConfig({
    zones: { "one/model": { swapAtRatio: 0 }, "two/model": { swapAtTokens: 5000 } },
  });
  assert.deepEqual(dropped, ["zones.one/model.swapAtRatio (out of range)"]);
  assert.deepEqual(config, { zones: { "two/model": { swapAtTokens: 5000 } } });
});

test("config-io: an emptied zone is not stored, and a non-threshold key is unknown", () => {
  const { config, dropped } = parseLcmConfig({ zones: { "one/model": { summaryTokens: 900 } } });
  assert.deepEqual(dropped, ["zones.one/model.summaryTokens (unknown key)"]);
  assert.deepEqual(config, {});
});

test("config-io: a type fault and an out-of-range fault are named differently", () => {
  const { config, dropped } = parseLcmConfig({
    summaryTokens: "1500",
    swapAtRatio: null,
    maxAsyncChunks: Number.POSITIVE_INFINITY,
    leafChunkTokens: Number.NaN,
  });
  assert.deepEqual(dropped, [
    "swapAtRatio (wrong type)",
    "summaryTokens (wrong type)",
    "leafChunkTokens (wrong type)",
    "maxAsyncChunks (wrong type)",
  ]);
  assert.deepEqual(config, {});
});

test("config-io: pass conditions default to what the pass reads", () => {
  assert.deepEqual(passConditions({}), {
    summarizer: '"auto"',
    summaryTokens: 1500,
    leafChunkTokens: 3000,
    maxAsyncChunks: 24,
    redactSecrets: true,
  });
});

test("config-io: an unset summarizer chain and an explicit auto are one condition", () => {
  assert.deepEqual(passConditions({ summarizer: "auto" }), passConditions({}));
  assert.notDeepEqual(passConditions({ summarizer: ["one/model", "auto"] }), passConditions({}));
});

test("config-io: a setting set to its default reads the same as unset", () => {
  assert.deepEqual(
    passConditions({
      summaryTokens: 1500,
      leafChunkTokens: 3000,
      maxAsyncChunks: 24,
      redactSecrets: true,
    }),
    passConditions({}),
  );
  assert.deepEqual(
    changedPassConditions(passConditions({}), passConditions({ redactSecrets: true })),
    [],
  );
});

test("config-io: every pass condition is compared, and only those", () => {
  const moved = passConditions({
    summarizer: "one/model",
    summaryTokens: 750,
    leafChunkTokens: 2000,
    maxAsyncChunks: 6,
    redactSecrets: false,
  });
  assert.deepEqual(changedPassConditions(passConditions({}), moved), [
    "summarizer",
    "summaryTokens",
    "leafChunkTokens",
    "maxAsyncChunks",
    "redactSecrets",
  ]);
  assert.deepEqual(
    passConditions({ swapAtRatio: 0.95, keepRecentTokens: 1000, assemblyEnabled: false }),
    passConditions({}),
  );
});

const identity = (model: string, config: LcmConfig): PassIdentity => ({
  model,
  settings: passConditions(config),
});

test("config-io: a pass under the same conditions and model is not stale", () => {
  const same = identity("one/model", {});
  assert.equal(staleReason(same, same), undefined);
  assert.equal(staleReason(same, identity("one/model", {})), undefined);
});

test("config-io: each setting can make a pass stale, and the row can name it", () => {
  const moved: Array<[keyof ReturnType<typeof passConditions>, LcmConfig]> = [
    ["summarizer", { summarizer: "one/model" }],
    ["summaryTokens", { summaryTokens: 750 }],
    ["leafChunkTokens", { leafChunkTokens: 2000 }],
    ["maxAsyncChunks", { maxAsyncChunks: 6 }],
    ["redactSecrets", { redactSecrets: false }],
  ];
  for (const [key, config] of moved) {
    assert.deepEqual(staleReason(identity("one/model", {}), identity("one/model", config)), {
      reason: "settings-changed",
      changed: [key],
    });
  }
  assert.deepEqual(
    staleReason(identity("one/model", {}), identity("two/model", { summaryTokens: 750 })),
    { reason: "model-changed", changed: ["summaryTokens"] },
  );
});
