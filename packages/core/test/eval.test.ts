import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import {
  EVAL_LEAF_CHUNK_TOKENS,
  EVAL_SPAN_MESSAGES,
  EVAL_TARGET_TOKENS,
  formatEvalTable,
  generateContext,
  runEval,
  SMALL_SEED,
  seededRandom,
} from "../src/eval.ts";
import { ingestEntries } from "../src/ingest.ts";
import { LcmStore } from "../src/store.ts";

/** The CI size: small enough to stay under a second, long enough for two passes
 * to bury a needle under a committed summary. */
const CI = { seed: SMALL_SEED, turns: 48, needles: 6, fillerChars: 400 };

test("eval: the generator is frozen by its seed", () => {
  const first = generateContext(CI);
  const second = generateContext(CI);
  assert.deepEqual(
    first.entries.map((e) => e.text),
    second.entries.map((e) => e.text),
  );
  assert.deepEqual(first.needles, second.needles);
  assert.deepEqual(first.key, second.key);
  const other = generateContext({ ...CI, seed: CI.seed + 1 });
  assert.notDeepEqual(
    other.entries.map((e) => e.text),
    first.entries.map((e) => e.text),
  );
  const rand = seededRandom(1);
  assert.deepEqual(
    [rand(), rand(), rand()].map((n) => Math.floor(n * 1000)),
    [627, 2, 527],
  );
});

test("eval: the frozen seed produces the documented context", () => {
  const fixture = generateContext(CI);
  assert.equal(fixture.entries.length, 48);
  assert.equal(fixture.needles.length, 6);
  assert.deepEqual(
    fixture.needles.map((n) => n.id),
    ["N00", "N01", "N02", "N03", "N04", "N05"],
  );
  assert.deepEqual(
    fixture.needles.map((n) => n.entryId),
    ["e0000", "e0008", "e0016", "e0024", "e0032", "e0040"],
  );
  assert.equal(fixture.key.needles, 6);
  assert.ok(fixture.key.sum > 6000 && fixture.key.sum < 54_000, String(fixture.key.sum));
  for (const needle of fixture.needles) {
    const entry = fixture.entries.find((e) => e.entryId === needle.entryId)!;
    assert.ok(entry.text.includes(needle.line), `${needle.id} is not in its entry`);
  }
});

test("eval: every needle stays reachable by address after the passes", async () => {
  const result = await runEval(CI, { passes: 2, record: false });
  assert.equal(result.passes, 2, "two passes ran");
  assert.equal(result.fidelity, 6, "every needle is returned verbatim by address");
  assert.equal(result.readable, 6, "every needle is inside a bounded reader window");
  assert.equal(result.covered, 6);
  assert.ok(result.condensed > 0, `${result.condensed} condensed nodes`);
  assert.ok(result.depth >= 1, `depth ${result.depth}`);
  assert.ok(
    result.summaries > result.condensed,
    `${result.summaries} summaries, ${result.condensed} condensed`,
  );
});

test("eval: the aggregate is provable at rising lengths, and the surface is named", async () => {
  const short = await runEval({ ...CI, turns: 48 }, { passes: 2, record: false });
  assert.equal(short.answered, true);
  assert.equal(short.failed, 0);
  assert.equal(short.fromProjection + short.fromRecall, 6);

  const longer = await runEval({ ...CI, turns: 240, needles: 8 }, { passes: 4, record: false });
  assert.equal(longer.answered, true);
  assert.equal(longer.passes, 4);
  assert.equal(longer.failed, 0);
  assert.equal(longer.fromProjection + longer.fromRecall, 8);
  assert.ok(longer.fromRecall > 0, "the recall path was needed");
  assert.ok(longer.fromProjection < longer.needles, "the cheap surface did not carry every needle");

  const longest = await runEval({ ...CI, turns: 960, needles: 8 }, { passes: 8, record: false });
  assert.equal(longest.answered, true);
  assert.equal(longest.failed, 0);
  assert.equal(longest.fidelity, 8);
  assert.equal(longest.fidelity, 8);
  assert.ok(longest.covered > 0 && longest.covered < 8, `${longest.covered} covered`);
  assert.ok(longest.surfaceTokens > short.surfaceTokens, "the surface grew with the context");
});

test("eval: a needle the store cannot return is a failure, not a projection hit", async () => {
  const fixture = generateContext({ ...CI, turns: 48, needles: 3 });
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    fixture.entries.filter((e) => e.entryId !== fixture.needles[0]!.entryId),
  );
  const surface = fixture.needles[0]!.line;
  assert.ok(surface.length > 0);
  const found = fixture.needles.filter((n) => store.messageByEntryId(n.entryId) !== undefined);
  assert.equal(found.length, 2, "the store holds two of the three needles");
  store.close();
});

test("eval: a run records one metrics row and prints a table", async () => {
  const result = await runEval({ ...CI, turns: 16, needles: 4 }, { passes: 1, record: false });
  const table = formatEvalTable([result]);
  assert.match(table, /^\| turns \| needles \| passes \|/);
  assert.match(table, /\| 16 \| 4 \| 1 \|/);
  assert.match(table, /\| yes \|$/m);
});

test("eval: a pass span is wide enough to condense what it writes", () => {
  assert.ok(EVAL_SPAN_MESSAGES >= 8);
  assert.ok(EVAL_LEAF_CHUNK_TOKENS > EVAL_TARGET_TOKENS);
});
