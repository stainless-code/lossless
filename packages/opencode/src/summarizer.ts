/** The summarizer knobs every OpenCode pass entry point shares. One helper
 * turns resolved plugin options into the engine's config, so the direct,
 * async, and blocking paths cannot drift on a budget or a chain. */

import {
  SUMMARIZER_CALL_TOKENS,
  SUMMARIZER_PASS_TOKENS,
  type SummarizerConfig,
} from "lossless-core";

/** Tokens one bounded repair run may spend across all of its calls. A heal
 * re-derives nodes a pass already paid for, so it carries its own budget. */
export const SUMMARIZER_HEAL_TOKENS = 120_000;

export interface SummarizerOptions {
  /** One model id, or an ordered fallback chain. `auto` is the session model. */
  readonly summarizer?: string | string[];
  /** Tokens one request may cost, estimate plus output cap, before it is
   * refused rather than paid for. */
  readonly summarizerTokensPerCall?: number;
  /** Tokens one pass may spend across all of its calls. */
  readonly summarizerTokensPerPass?: number;
  /** Tokens one on-demand heal run may spend across all of its calls. */
  readonly summarizerTokensPerHeal?: number;
}

/** The engine config for these options. An unresolved budget keeps the core
 * default, which is also what a direct caller that passes no options gets. */
export function summarizerConfig(options: SummarizerOptions): SummarizerConfig {
  return {
    ...(options.summarizer === undefined ? {} : { summarizer: options.summarizer }),
    summarizerTokensPerCall: options.summarizerTokensPerCall ?? SUMMARIZER_CALL_TOKENS,
    summarizerTokensPerPass: options.summarizerTokensPerPass ?? SUMMARIZER_PASS_TOKENS,
  };
}
