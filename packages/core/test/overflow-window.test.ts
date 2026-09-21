import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import {
  WINDOW_MAX,
  WINDOW_MIN,
  WINDOW_PATTERN_EXAMPLES,
  windowFromError,
} from "../src/overflow-window.js";

test("overflow window: every phrasing that names a maximum parses to that maximum", () => {
  assert.equal(windowFromError("prompt is too long: 213462 tokens > 200000 maximum"), 200_000);
  assert.equal(
    windowFromError(
      "Requested token count exceeds the model's maximum context length of 131072 tokens",
    ),
    131_072,
  );
  assert.equal(
    windowFromError(
      "This endpoint's maximum context length is 131072 tokens. However, you requested about 130000 tokens",
    ),
    131_072,
  );
  assert.equal(
    windowFromError("Input length (265330) exceeds model's maximum context length (262144)."),
    262_144,
  );
  assert.equal(
    windowFromError(
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
    ),
    1_048_575,
  );
  assert.equal(
    windowFromError(
      "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
    ),
    131_072,
  );
  assert.equal(
    windowFromError(
      "Prompt contains 265330 tokens, which is too large for model with 131072 maximum context length",
    ),
    131_072,
  );
  assert.equal(
    windowFromError("Prompt has 265330 tokens, but the configured context size is 131072 tokens"),
    131_072,
  );
  assert.equal(
    windowFromError("prompt token count of 265330 exceeds the limit of 131072"),
    131_072,
  );
  assert.equal(
    windowFromError(
      "Input length 265330 exceeds the maximum allowed input length of 131072 tokens.",
    ),
    131_072,
  );
  assert.equal(
    windowFromError("Your request exceeded model token limit: 131072 (requested: 265330)"),
    131_072,
  );
  assert.equal(windowFromError("Range of input length should be [1, 1048575]"), 1_048_575);
});

test("overflow window: every example in the pattern table is one of the parses above", () => {
  for (const example of WINDOW_PATTERN_EXAMPLES) {
    assert.ok(windowFromError(example) !== null, `no parse for: ${example}`);
  }
});

test("overflow window: a body that names no limit parses to nothing", () => {
  assert.equal(windowFromError("Please reduce the length of the messages or completion"), null);
  assert.equal(windowFromError("400 status code (no body)"), null);
  assert.equal(windowFromError("413 status code (no body)"), null);
  assert.equal(windowFromError("request_too_large"), null);
  assert.equal(windowFromError("invalid params, context window exceeds limit"), null);
  assert.equal(
    windowFromError("tokens to keep from the initial prompt is greater than the context length"),
    null,
  );
  assert.equal(
    windowFromError("the request exceeds the available context size, try increasing it"),
    null,
  );
  assert.equal(windowFromError("Your input exceeds the context window of this model"), null);
  assert.equal(windowFromError("input is too long for requested model"), null);
  assert.equal(
    windowFromError("prompt too long; exceeded max context length by 1333 tokens"),
    null,
  );
  assert.equal(windowFromError(undefined), null);
  assert.equal(windowFromError(""), null);
  assert.equal(windowFromError("no numbers here at all"), null);
});

test("overflow window: a number outside the band is refused rather than stored", () => {
  assert.equal(windowFromError(`exceeds the limit of ${WINDOW_MIN - 1}`), null);
  assert.equal(windowFromError(`exceeds the limit of ${WINDOW_MAX + 1}`), null);
  assert.equal(windowFromError("context length (999)"), null);
  assert.equal(windowFromError("maximum context length of 1,048,576 tokens"), 1_048_576);
  assert.equal(windowFromError("exceeds the limit of 12.5"), null);
});
