/** The window a provider named in an overflow error.
 *
 * Every pattern is copied from Pi's own overflow list
 * (`@earendil-works/pi-ai/dist/utils/overflow.js`, `OVERFLOW_PATTERNS`) with the
 * example message that file carries, because the number this build wants is the
 * one Pi would have matched with the same text. The patterns that do not name a
 * maximum are absent on purpose: "Please reduce the length of the messages",
 * "400/413 status code (no body)", and the silent-overflow providers say a
 * request was too long without saying how long is allowed, and there is nothing
 * to parse out of them. Those take the caller's floor path instead.
 *
 * The number is the *allowed* one, never the requested one. A message that names
 * both, like Anthropic's "prompt is too long: 213462 tokens > 200000 maximum",
 * carries the request first and the window second, so each pattern below is
 * anchored on the phrase that introduces the limit rather than on the first
 * integer in the string. */
const WINDOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long:[^>]*>\s*([\d,]+)\s*maximum/i,
  /maximum context length of\s*([\d,]+)\s*tokens?/i,
  /maximum context length is\s*([\d,]+)\s*tokens?/i,
  /context length\s*\(([\d,]+)(?:\s*tokens?)?\)/i,
  /maximum number of tokens allowed\s*\(([\d,]+)\)/i,
  /maximum prompt length is\s*([\d,]+)/i,
  /model with\s*([\d,]+)\s*maximum context length/i,
  /configured context size is\s*([\d,]+)\s*tokens?/i,
  /exceeds the limit of\s*([\d,]+)/i,
  /maximum allowed input length of\s*([\d,]+)/i,
  /model token limit:?\s*([\d,]+)/i,
  /range of input length should be\s*\[[\d,]+\s*,\s*([\d,]+)\]/i,
];

/** A window outside this band is a misread rather than a model: no provider
 * serves a context under a thousand tokens or over a hundred million, and a
 * number outside it means a pattern caught the request count, a status code, or
 * something else that was not a limit. A refused parse is the floor path, which
 * costs one conservative turn instead of a wrong permanent window. */
export const WINDOW_MIN = 1_000;
export const WINDOW_MAX = 100_000_000;

/** The window in tokens a provider stated in an overflow message, or null when
 * the message does not name one. Null is an answer: the caller keeps Pi's belief
 * and arms the one-shot floor, which is all a body like "400/413 status code (no
 * body)" can support. */
export function windowFromError(errorMessage: string | undefined): number | null {
  if (!errorMessage) return null;
  for (const pattern of WINDOW_PATTERNS) {
    const match = pattern.exec(errorMessage);
    if (!match?.[1]) continue;
    const window = Number(match[1].replace(/,/g, ""));
    if (!Number.isInteger(window) || window < WINDOW_MIN || window > WINDOW_MAX) continue;
    return window;
  }
  return null;
}

export const WINDOW_PATTERN_EXAMPLES: readonly string[] = [
  "prompt is too long: 213462 tokens > 200000 maximum",
  "Requested token count exceeds the model's maximum context length of 131072 tokens",
  "This endpoint's maximum context length is 131072 tokens. However, you requested about 130000 tokens",
  "Input length (265330) exceeds model's maximum context length (262144).",
  "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
  "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
  "Prompt contains 265330 tokens, which is too large for model with 131072 maximum context length",
  "Prompt has 265330 tokens, but the configured context size is 131072 tokens",
  "prompt token count of 265330 exceeds the limit of 131072",
  "Input length 265330 exceeds the maximum allowed input length of 131072 tokens.",
  "Your request exceeded model token limit: 131072 (requested: 265330)",
  "Range of input length should be [1, 1048575]",
];
