import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { contextChars } from "../src/assembly.ts";
import {
  CALIBRATION_MIN_SAMPLES,
  calibrate,
  CHARS_PER_TOKEN,
  estimateTokens,
  scaledBudget,
  type EstimateSample,
} from "../src/estimate-tokens.ts";

test("estimate: the constant is the estimate when nothing is known", () => {
  assert.equal(estimateTokens("12345678"), 2);
  assert.equal(calibrate([]), null);
});

test("estimate: calibration moves toward Pi's count as samples arrive", () => {
  const sample: EstimateSample = { chars: 600, tokens: 100 };
  const samples: EstimateSample[] = [];
  for (let n = 1; n <= CALIBRATION_MIN_SAMPLES; n++) {
    samples.push(sample);
    const ratio = calibrate(samples);
    if (n < CALIBRATION_MIN_SAMPLES) {
      assert.equal(ratio, null, `${n} samples cannot support a ratio`);
    } else {
      assert.equal(ratio, 6);
    }
  }
  assert.notEqual(6, CHARS_PER_TOKEN);
});

test("estimate: samples that disagree produce no ratio, not an average", () => {
  const samples: EstimateSample[] = [
    { chars: 600, tokens: 100 },
    { chars: 600, tokens: 100 },
    { chars: 600, tokens: 100 },
    { chars: 1200, tokens: 100 },
  ];
  assert.equal(calibrate(samples), null);
  assert.equal(
    calibrate([
      { chars: 600, tokens: 100 },
      { chars: 600, tokens: 100 },
      { chars: 700, tokens: 100 },
    ]),
    6,
  );
});

test("estimate: a ratio outside the band is refused, not clamped", () => {
  const dense: EstimateSample[] = Array.from({ length: 4 }, () => ({ chars: 150, tokens: 100 }));
  assert.equal(calibrate(dense), null, "1.5 chars per token is a miscount");
  const sparse: EstimateSample[] = Array.from({ length: 4 }, () => ({ chars: 2000, tokens: 100 }));
  assert.equal(calibrate(sparse), null, "20 chars per token is a corpus this build never counted");
});

test("estimate: samples with no characters or no tokens are not samples", () => {
  assert.equal(calibrate([{ chars: 0, tokens: 100 }]), null);
  assert.equal(calibrate([{ chars: 600, tokens: 0 }]), null);
});

test("estimate: a configured budget is scaled into the estimator's units", () => {
  assert.equal(scaledBudget(1000, 6), 1500);
  assert.equal(scaledBudget(1000, 3), 750);
  assert.equal(scaledBudget(1000, CHARS_PER_TOKEN), 1000);
  assert.equal(scaledBudget(1000, null), 1000, "uncalibrated keeps the constant's reading");
  assert.equal(scaledBudget(1, 2), 1, "a positive budget never scales to nothing");
  assert.equal(scaledBudget(0, 6), 0);
});

test("estimate: context characters count the same rendering the cut walk measures", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ];
  const expected =
    (JSON.stringify(messages[0])?.length ?? 0) + (JSON.stringify(messages[1])?.length ?? 0);
  assert.equal(contextChars(messages), expected);
  assert.equal(contextChars([]), 0);
  assert.equal(contextChars([undefined as never]), 0);
});
