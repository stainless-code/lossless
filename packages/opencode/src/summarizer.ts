/** The summarizer knobs every OpenCode pass entry point shares. The shapes
 * live in the core so the hosts cannot drift; this module keeps the import
 * path its callers already use. */

export {
  healBudgets,
  SUMMARIZER_HEAL_TOKENS,
  summarizerConfig,
  type HealBudgetOptions,
  type HealBudgets,
  type SummarizerOptions,
} from "lossless-core";
