import {
  renderSummaries,
  tailKeyOf,
  type AlignedEntry,
  type AssemblyMsg,
  type RenderableSummary,
} from "./assembly.ts";
import type {
  AppliedSummary,
  AssemblyAction,
  CommitState,
  ResolvedThresholds,
  ThresholdConfig,
} from "./commit-policy.ts";
import { estimateTokens } from "./estimate-tokens.ts";
import { fmtTokens } from "./format.ts";
import type { LcmMetricRecord } from "./metrics.ts";
import type { SummaryNode } from "./store.ts";

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface ContextPolicyInput {
  rawMessages: readonly AssemblyMsg[];
  getCtxEntries: () => readonly AlignedEntry[];
  occupancy: number;
  tokens: number;
  /** True when `tokens` is the estimator's count rather than Pi's, because the
   * reported figure described a context other than the one on hand. */
  tokensEstimated?: true;
  contextWindow: number;
  /** The window the ratio thresholds are measured against, when it differs from
   * Pi's belief: a correction from a provider's overflow error, or the one-shot
   * floor a refused request proved. The belief stays in `contextWindow` because a
   * correction is not a window change the pin should be dropped over. */
  thresholdWindow?: number;
  modelKey: string;
  zone?: string;
  thresholds: ThresholdConfig;
  keepRecentTokens: number;
  summaryTokens: number;
  clampNotified: boolean;
  commitState: CommitState | null;
  pinnedModelKey: string;
  pinnedWindow: number;
}

export type BailReason =
  | "nothing-to-age"
  | "no-boundary"
  | "tail-exceeds-entries"
  | "aged-empty"
  | "aged-unstored"
  | "monotonic-refused"
  | "tail-shrunk"
  | "tail-mismatch"
  | "projection-over-budget";

export type NonEmpty<T> = readonly [T, ...T[]];

export interface ContextPolicyBase {
  commitState: CommitState | null;
  metrics: LcmMetricRecord[];
  pinnedModelKey: string;
  pinnedWindow: number;
  clampNotified: boolean;
  clampWarning?: string;
}

export type ContextPolicyResult = ContextPolicyBase &
  (
    | { outcome: "quiet" }
    | { outcome: "reapply"; messages: AssemblyMsg[] }
    | { outcome: "swap"; messages: AssemblyMsg[] }
    | { outcome: "bail"; reason: BailReason; messages?: AssemblyMsg[] }
    | {
        outcome: "kick";
        reason: "summary-missing";
        aged: NonEmpty<AlignedEntry>;
        /** The span this kick is about, in the order the store resolves one. The
         * adapter keys its latch on it, so the latch and the coverage check
         * cannot disagree about which boundary is missing. */
        span: { firstEntryId: string; lastEntryId: string };
        messages?: AssemblyMsg[];
      }
  );

export interface ContextPolicyDeps {
  thresholds: (cfg: ThresholdConfig, window: number) => ResolvedThresholds;
  nextAction: (
    state: CommitState | null,
    occupancy: number,
    swap: number,
    recut: number,
  ) => AssemblyAction;
  cutIndexFor: (msgs: readonly AssemblyMsg[], keepRecentTokens: number) => number | null;
  cutMayReplace: (previous: CommitState | null, newCutCount: number) => boolean;
  frontier: (firstEntryId: string, lastEntryId: string) => SummaryNode[];
  /** The aged set's own ends as a span: branch order, and only entries the store
   * holds. Pi's context array is not branch order (it hoists the newest
   * compaction entry to the front), and a span whose ends are inverted resolves
   * to nothing, so this answers with the end pair a store query can use. Null
   * when the store holds none of the aged entries, which is a state rather than
   * a kick. */
  spanBounds: (
    aged: NonEmpty<AlignedEntry>,
  ) => { firstEntryId: string; lastEntryId: string } | null;
  buildSynthetic: (summaries: readonly RenderableSummary[]) => CommitState["synthetic"];
  /** The mask node text passes through on its way to a model. The store keeps
   * the bytes, so every read seam takes this rather than storing a masked
   * copy; `makeRedact` is the provider a real caller passes. */
  redact: (text: string) => string;
}

export interface FailedBoundary {
  attempts: number;
  lastAt: number;
}

export const KICK_MAX_ATTEMPTS = 3;
export const KICK_BACKOFF_MS = 10 * 60_000;

export function shouldKickBoundary(latch: FailedBoundary | undefined, now: number): boolean {
  if (!latch) return true;
  if (latch.attempts >= KICK_MAX_ATTEMPTS && now - latch.lastAt < KICK_BACKOFF_MS) return false;
  return true;
}

function nonEmpty<T>(items: readonly T[]): NonEmpty<T> | null {
  return items.length > 0 ? (items as NonEmpty<T>) : null;
}

export function applyContextPolicy(
  input: ContextPolicyInput,
  deps: ContextPolicyDeps,
): ContextPolicyResult {
  const { swap, recut, clamped } = deps.thresholds(
    input.thresholds,
    input.thresholdWindow ?? input.contextWindow,
  );
  const clampWarning =
    clamped && !input.clampNotified
      ? `LCM: configured threshold exceeds this model's ${fmtTokens(input.contextWindow)}-token window, ` +
        `clamped to swap ${(swap * 100).toFixed(0)}% / recut ${(recut * 100).toFixed(0)}%.`
      : undefined;

  // A pin cut for another model or window says nothing about this one.
  const pinned =
    input.commitState &&
    (input.modelKey !== input.pinnedModelKey || input.contextWindow !== input.pinnedWindow)
      ? null
      : input.commitState;

  const base: ContextPolicyBase = {
    commitState: pinned,
    metrics: [],
    pinnedModelKey: input.modelKey,
    pinnedWindow: input.contextWindow,
    clampNotified: input.clampNotified || clamped,
    clampWarning,
  };

  const action = deps.nextAction(pinned, input.occupancy, swap, recut);
  base.metrics.push({
    event: "lcm",
    kind: "context-decision",
    action,
    occupancy: round3(input.occupancy),
    tokens: input.tokens,
    tokensEstimated: input.tokensEstimated,
    window: input.contextWindow,
    soft: round3(swap),
    commit: round3(recut),
    zone: input.zone,
    committed: Boolean(pinned),
  });

  if (action === "quiet") return { ...base, outcome: "quiet" };

  // Captured before the paths below can clear the pin, so the row can say
  // whether this turn applied a new boundary or re-applied the pinned one. Read
  // the cut, not this field, to count compactions.
  const appliedCut = pinned?.cutCount ?? null;

  // The context hook is STATELESS per call: Pi reassembles event.messages
  // from session entries before every LLM request, so a previously
  // returned synthetic never persists into the next event.
  const rawMessages = input.rawMessages;

  // The frozen cut keeps the projection byte-identical (pure appends, cache-safe).
  if (pinned) {
    // cutCount is the number of aged messages the synthetic replaces, so
    // the first kept message is rawMessages[cutCount] and stays at that
    // index as turns append.
    const { cutCount } = pinned;
    if (cutCount >= rawMessages.length) {
      return { ...base, commitState: null, outcome: "bail", reason: "tail-shrunk" };
    }
    if (tailKeyOf(rawMessages[cutCount]) !== pinned.tailKey) {
      return { ...base, commitState: null, outcome: "bail", reason: "tail-mismatch" };
    }
    if (action === "stable") {
      return { ...base, outcome: "reapply", messages: pinnedProjection(pinned, rawMessages) };
    }
  }

  // A bailed recut keeps serving the verified pin: raw context at the
  // session's highest occupancy is the worst answer available here.
  const bail = (reason: BailReason): ContextPolicyResult => ({
    ...base,
    outcome: "bail",
    reason,
    ...(pinned ? { messages: pinnedProjection(pinned, rawMessages) } : {}),
  });

  const cut = deps.cutIndexFor(rawMessages, input.keepRecentTokens);
  if (cut === null) return bail("no-boundary");
  if (cut === 0) return bail("nothing-to-age");
  if (!deps.cutMayReplace(pinned, cut)) return bail("monotonic-refused");

  // Entry ids come from the session, not from event.messages (which carry no ids).
  const ctxEntries = input.getCtxEntries();
  const keptCount = rawMessages.length - cut;
  if (keptCount > ctxEntries.length) return bail("tail-exceeds-entries");
  const aged = nonEmpty(ctxEntries.slice(0, ctxEntries.length - keptCount));
  if (!aged) return bail("aged-empty");
  // slice of Pi's context array, which puts a compaction entry ahead of the
  // entries it follows, and a span read off that slice covers nothing at all.
  const bounds = deps.spanBounds(aged);
  if (!bounds) return bail("aged-unstored");

  // The boundary is covered when the frontier's newest node ends exactly at the
  // span's last entry; anything else means the DAG has not reached it.
  const frontier = deps.frontier(bounds.firstEntryId, bounds.lastEntryId);
  const summary = frontier[frontier.length - 1];
  if (!summary || summary.lastEntryId !== bounds.lastEntryId) {
    return {
      ...base,
      outcome: "kick",
      reason: "summary-missing",
      aged,
      span: bounds,
      ...(pinned ? { messages: pinnedProjection(pinned, rawMessages) } : {}),
    };
  }

  // The projection is the frontier itself. A node that does not fit loses
  // text, never its id: evicting the oldest node dropped every pointer it
  // carried, and the model cannot name what it cannot see.
  const applied: AppliedSummary[] = frontier.map(
    ({ id, depth, text, thoroughText, firstEntryId, lastEntryId }) => ({
      id,
      depth,
      text: deps.redact(text),
      ...(thoroughText === undefined ? {} : { thoroughText: deps.redact(thoroughText) }),
      firstEntryId,
      lastEntryId,
      tier: "rich",
    }),
  );
  let renderedTokens = estimateTokens(renderSummaries(applied));
  for (const node of applied) {
    if (renderedTokens <= input.summaryTokens) break;
    for (const tier of degradationLadder(node)) {
      node.tier = tier;
      renderedTokens = estimateTokens(renderSummaries(applied));
      if (renderedTokens <= input.summaryTokens) break;
    }
  }
  if (renderedTokens > input.summaryTokens) {
    base.metrics.push({
      event: "lcm",
      kind: "projection-over-budget",
      nodes: applied.length,
      renderedTokens,
      budgetTokens: input.summaryTokens,
    });
    return bail("projection-over-budget");
  }

  const appliedAtOccupancy = round3(input.occupancy);
  const synthetic = deps.buildSynthetic(applied);
  base.metrics.push({
    event: "lcm",
    kind: "swap-applied",
    summaryId: summary.id,
    cutCount: cut,
    distinctBoundary: appliedCut === null || appliedCut !== cut,
    appliedAtOccupancy,
    nodes: applied.length,
    stubbed: applied.filter((n) => n.tier === "stub").length,
    renderedTokens,
    budgetTokens: input.summaryTokens,
  });

  return {
    ...base,
    commitState: {
      cutCount: cut,
      synthetic,
      summaryId: summary.id,
      applied,
      appliedAtOccupancy,
      tailKey: tailKeyOf(rawMessages[cut]),
    },
    outcome: "swap",
    messages: [synthetic, ...rawMessages.slice(cut)],
  };
}

function pinnedProjection(state: CommitState, rawMessages: readonly AssemblyMsg[]): AssemblyMsg[] {
  return [state.synthetic, ...rawMessages.slice(state.cutCount)];
}

function degradationLadder(node: AppliedSummary): Array<"terse" | "stub"> {
  return node.thoroughText === undefined ? ["stub"] : ["terse", "stub"];
}

export interface CompactionBounds {
  startEntryId?: string;
  firstKeptEntryId: string;
}

/** Blocking-regime span (session_before_compact), computed the way Pi's
 * prepareCompaction does: branch entries from the previous compaction's first
 * kept entry up to but excluding the new one, minus compaction rows. Entry ids,
 * not message text, so bash and branch-summary rows align. An unknown
 * firstKeptEntryId yields an empty span, so the caller falls back to Pi. */
export function resolveCompactionSpan(
  branchMsgs: readonly AlignedEntry[],
  bounds: CompactionBounds,
): AlignedEntry[] {
  const end = branchMsgs.findIndex((e) => e.entryId === bounds.firstKeptEntryId);
  if (end <= 0) return [];
  let start = bounds.startEntryId
    ? branchMsgs.findIndex((e) => e.entryId === bounds.startEntryId)
    : 0;
  if (start < 0) {
    const lastCompaction = branchMsgs.findLastIndex((e) => e.role === "compactionSummary");
    start = lastCompaction + 1;
  }
  return branchMsgs.slice(start, end).filter((e) => e.role !== "compactionSummary");
}
