export const CHARS_PER_TOKEN = 4;

/** The band a calibrated ratio is held inside. Below the floor a sample is a
 * miscount (a reply counted against no characters, or a window reported in a unit
 * that is not tokens), and above the ceiling it describes a corpus this build
 * never counted. A ratio outside the band is refused, not clamped into place. */
const CHARS_PER_TOKEN_MIN = 2;
const CHARS_PER_TOKEN_MAX = 8;

const CALIBRATION_SPREAD = 0.25;

/** Samples below this count say nothing: with two points any line fits, and the
 * first turns of a session are exactly where the overhead has not cancelled. */
export const CALIBRATION_MIN_SAMPLES = 3;

/** Samples kept in memory. A cap keeps the median describing the recent turns of
 * the session rather than its whole history, which is what a model switch inside
 * one session would otherwise be unable to move. */
export const CALIBRATION_SAMPLE_CAP = 8;

/** One observation of the same session: how many characters this build counted in
 * the messages, and how many tokens Pi reported for the request that carried
 * them. Sampling differences rather than totals is what cancels the system prompt
 * and tool definitions, which this build never counts. */
export interface EstimateSample {
  chars: number;
  tokens: number;
}

export function estimateTokens(text: string): number {
  return tokensFromChars(text.length);
}

export function tokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** A reported count below this share of the estimate describes a context other
 * than the one on hand: Pi reports its last measurement, and after a resume that
 * measurement belongs to the previous process. The estimator's own error is
 * bounded by the calibration band, which is a factor of two in either direction
 * around the constant, so anything below a quarter is a different turn rather
 * than a miscount. A reported count too high only compacts early, which is why
 * this looks one way. */
export const STALE_REPORT_SHARE = 0.25;

export function calibrate(samples: readonly EstimateSample[]): number | null {
  const ratios = samples.filter((s) => s.chars > 0 && s.tokens > 0).map((s) => s.chars / s.tokens);
  if (ratios.length < CALIBRATION_MIN_SAMPLES) return null;
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (sorted.some((r) => Math.abs(r - median) / median > CALIBRATION_SPREAD)) return null;
  if (median < CHARS_PER_TOKEN_MIN || median > CHARS_PER_TOKEN_MAX) return null;
  return Math.round(median * 100) / 100;
}

/** A configured token budget in the units `estimateTokens` counts. The estimator
 * counts chars / 4, so a model whose real ratio is 6 needs 1.5 times the
 * configured number of estimated tokens accumulated before it has kept the
 * context the user asked for. Without a ratio the budget is left alone, which is
 * the constant's own reading of it. */
export function scaledBudget(tokens: number, charsPerToken: number | null): number {
  if (charsPerToken === null || charsPerToken === CHARS_PER_TOKEN) return tokens;
  const scaled = Math.round(tokens * (charsPerToken / CHARS_PER_TOKEN));
  return tokens > 0 && scaled < 1 ? 1 : scaled;
}
