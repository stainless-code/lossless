import type { SummaryTier, SyntheticMessage } from "./assembly.ts";

export interface AppliedSummary {
  id: number;
  depth: number;
  text: string;
  thoroughText?: string;
  firstEntryId: string;
  lastEntryId: string;
  tier: SummaryTier;
}

export type AssemblyAction = "quiet" | "consider-apply" | "stable" | "recommit";

export interface CommitState {
  cutCount: number;
  synthetic: SyntheticMessage;
  applied: AppliedSummary[];
  summaryId: number;
  appliedAtOccupancy: number;
  tailKey: string;
}

export const DEFAULT_SWAP_RATIO = 0.7;
export const DEFAULT_RECUT_RATIO = 0.85;

const RECUT_ABOVE_SWAP_MARGIN = 0.01;

export const WINDOW_SAFETY_CEILING = 0.9;

/** Ceiling for the resolved recut fraction: a line above 1.0 is unreachable, so
 * the pin never re-cuts and the raw tail grows past the window while "stable"
 * is reported forever. Strictly above WINDOW_SAFETY_CEILING + RECUT_ABOVE_SWAP_MARGIN. */
export const RECUT_CEILING = 0.95;

export const REZONE_MARGIN = 1.18;

export interface ThresholdConfig {
  swapAtRatio?: number;
  swapAtTokens?: number;
  recutAtRatio?: number;
  recutAtTokens?: number;
  smartZone?: number;
}

export type ZoneThresholds = ThresholdConfig;

export interface ResolvedThresholds {
  swap: number;
  recut: number;
  clamped: boolean;
}

export function mergeZone(global: ThresholdConfig, zone?: ZoneThresholds): ThresholdConfig {
  return zone ? { ...global, ...zone } : global;
}

export function thresholdConflicts(cfg: ThresholdConfig, scope = "global config"): string[] {
  const warnings: string[] = [];
  const hasTokens =
    (cfg.swapAtTokens != null && cfg.swapAtTokens > 0) ||
    (cfg.recutAtTokens != null && cfg.recutAtTokens > 0);
  if (cfg.smartZone != null && cfg.smartZone > 0 && hasTokens) {
    warnings.push(
      `LCM ${scope}: both "smartZone" and explicit "swapAtTokens"/"recutAtTokens" are set, and explicit tokens win. Remove one (OR-mode vocabularies).`,
    );
  }
  return warnings;
}

export function effectiveThresholds(
  cfg: ThresholdConfig,
  contextWindow: number,
): ResolvedThresholds {
  if (!(contextWindow > 0)) {
    return {
      swap: cfg.swapAtRatio ?? DEFAULT_SWAP_RATIO,
      recut: DEFAULT_RECUT_RATIO,
      clamped: false,
    };
  }
  const smartZone = cfg.smartZone != null && cfg.smartZone > 0 ? cfg.smartZone : 0;
  const hasSmartZone = smartZone > 0;
  const swap =
    cfg.swapAtTokens != null && cfg.swapAtTokens > 0
      ? cfg.swapAtTokens / contextWindow
      : hasSmartZone
        ? smartZone / contextWindow
        : (cfg.swapAtRatio ?? DEFAULT_SWAP_RATIO);
  const rawRecut =
    cfg.recutAtTokens != null && cfg.recutAtTokens > 0
      ? cfg.recutAtTokens / contextWindow
      : hasSmartZone
        ? (smartZone * REZONE_MARGIN) / contextWindow
        : (cfg.recutAtRatio ?? DEFAULT_RECUT_RATIO);
  const clampedSwap = Math.min(swap, WINDOW_SAFETY_CEILING);
  const recut = Math.min(Math.max(rawRecut, clampedSwap + RECUT_ABOVE_SWAP_MARGIN), RECUT_CEILING);
  return { swap: clampedSwap, recut, clamped: clampedSwap !== swap || recut !== rawRecut };
}

export function nextAction(
  state: CommitState | null,
  occupancy: number,
  swapRatio: number,
  recutRatio: number,
): AssemblyAction {
  if (!state) {
    return occupancy >= swapRatio ? "consider-apply" : "quiet";
  }
  if (occupancy >= recutRatio) return "recommit";
  return "stable";
}

export function cutMayReplace(previous: CommitState | null, newCutCount: number): boolean {
  if (!previous) return true;
  return newCutCount >= previous.cutCount;
}
