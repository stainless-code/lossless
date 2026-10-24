/** The summarizer knobs every host shares. One helper turns resolved plugin
 * options into the engine's config, so the direct, async, and blocking paths
 * cannot drift on a budget or a chain. Heal carries its own token budget
 * because it re-derives nodes a pass already paid for. */

import { scaledBudget } from "../estimate-tokens.ts";
import { SUMMARIZER_CALL_TOKENS, SUMMARIZER_PASS_TOKENS, type SummarizerConfig } from "../llm.ts";

/** Tokens one bounded repair run may spend across all of its calls. A heal
 * re-derives nodes a pass already paid for, so it carries its own budget. */
export const SUMMARIZER_HEAL_TOKENS = 120_000;

/** Tokens one repaired node targets when the caller names none. It matches
 * the heal engine's own fallback, so an unresolved option still repairs. */
export const DEFAULT_SUMMARY_TOKENS = 1500;

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

export interface HealBudgetOptions {
  /** Tokens one repaired node targets. */
  readonly summaryTokens?: number;
  /** Estimated tokens one heal node may read as source. Unset derives the
   * engine default; this is the explicit override for large sources. */
  readonly healSourceTokens?: number;
  /** Tokens one summarizer request may cost. */
  readonly summarizerTokensPerCall?: number;
}

/** Calibrated heal budgets in tokens: node target, per-call cap, and optional source window. */
export interface HealBudgets {
  readonly targetTokens: number;
  readonly callBudgetTokens: number;
  readonly sourceTokens?: number;
}

/** The calibrated heal target and source window. A null ratio keeps the
 * configured reading, which is what an uncalibrated host passes. */
export function healBudgets(
  options: HealBudgetOptions = {},
  charsPerToken: number | null = null,
): HealBudgets {
  const targetTokens = scaledBudget(options.summaryTokens ?? DEFAULT_SUMMARY_TOKENS, charsPerToken);
  const sourceTokens =
    options.healSourceTokens === undefined
      ? undefined
      : scaledBudget(options.healSourceTokens, charsPerToken);
  return {
    targetTokens,
    callBudgetTokens: options.summarizerTokensPerCall ?? SUMMARIZER_CALL_TOKENS,
    ...(sourceTokens === undefined ? {} : { sourceTokens }),
  };
}
