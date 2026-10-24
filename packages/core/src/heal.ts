import { CHARS_PER_TOKEN, estimateTokens } from "./estimate-tokens.ts";
import { filePreviewText } from "./files.ts";
import { SUMMARIZER_CALL_TOKENS, SummarizerFailure } from "./llm.ts";
import {
  appendMetric,
  type HealNodeOutcomeKind,
  type HealStopReason,
  type MetricsSink,
  type SummaryLevel,
} from "./metrics.ts";
import type { HealStore, SummaryNode, SummaryQuality, SummarySources } from "./store.ts";
import { TRUNCATED_SUMMARY_PREFIX } from "./store.ts";
import { summarizeWithEscalation, type LlmComplete } from "./summarize.ts";

/** The mechanical marker shared with the store migration and import fallback.
 * Detection prefers the quality verdict and keeps this as the legacy signal. */
export const HEAL_TRUNCATED_PREFIX = TRUNCATED_SUMMARY_PREFIX;

export const HEAL_TARGET_TOKENS = 1500;
/** The source-to-summary ratio the default window follows. A heal reads more
 * than it writes, but a repair that cannot see the source cannot be clean. */
export const HEAL_SOURCE_TARGET_FACTOR = 8;
export const HEAL_SOURCE_MIN_TOKENS = 3_000;
export const HEAL_SOURCE_MAX_TOKENS = 24_000;
/** One repair may read a source larger than its window, but only as a bounded
 * map-reduce: the fanout matches the DAG's maximum child count, so a windowed
 * repair cannot grow calls without a limit. */
export const HEAL_MAX_WINDOWS_PER_NODE = 8;
/** Room for the system prompt and the summary instruction under a call cap. */
export const HEAL_PROMPT_TOKENS = 1_024;
/** Kept for callers that still name the old constant. The value is the floor,
 * not a fixed per-message clip. */
export const HEAL_LEAF_CHUNK_TOKENS = HEAL_SOURCE_MIN_TOKENS;
export const HEAL_MAX_NODES = 32;
export const HEAL_TOKEN_BUDGET = 250_000;

export interface HealSourceBudgetInput {
  targetTokens?: number;
  /** An explicit source window. The derived default is `8 * targetTokens`,
   * clamped to the source floor and ceiling and then to the call budget. */
  sourceTokens?: number;
  callBudgetTokens?: number;
}

export interface HealInput {
  /** Session tag for every engine row and every ladder call this run makes. */
  session?: string;
  /** Tokens one repaired node targets. A result above twice this is rejected. */
  targetTokens?: number;
  /** Estimated tokens one map window may read. Defaults to `8 * targetTokens`,
   * clamped to 3,000 through 24,000 and to the request budget. A larger leaf
   * source uses up to eight windows and one reduce; it is never clipped to a
   * per-message slice. */
  sourceTokens?: number;
  /** @deprecated Use `sourceTokens`. Kept so a caller from the first heal
   * release keeps working; it now means the same per-window budget. */
  leafChunkTokens?: number;
  /** Tokens one summarizer request may cost. The source window is clamped so
   * its prompt, output, and reserve fit this cap. */
  callBudgetTokens?: number;
  /** Nodes this run may attempt. Ancestors only run after their children. */
  maxNodes?: number;
  /** Model calls this run may make. Defaults to twice `maxNodes`. */
  maxCalls?: number;
  /** Estimated tokens this run may spend. The provider's own budget still runs. */
  maxTokens?: number;
  /** Report the plan and make no model call. */
  dryRun?: boolean;
  /** Masks text on its way to the model and into the replacement node. */
  redact?: (text: string) => string;
  /** Override for tests and imports; the deterministic prefix is the default. */
  truncatedPrefix?: string;
}

export interface HealCandidate {
  id: number;
  nodeKind: "leaf" | "condensed";
  depth: number;
  quality: SummaryQuality;
  /** The node's own text is the deterministic truncate, either by verdict or by
   * the prefix fallback. */
  mechanical: boolean;
  /** The node is a seed: its quality is not clean, or its text carries the
   * mechanical prefix. */
  tainted: boolean;
  /** Candidate parents, in id order. A dry run reports the dependency shape
   * through these edges; repair order is always child before parent. */
  parents: number[];
}

export interface HealNodeResult {
  id: number;
  nodeKind: "leaf" | "condensed";
  depth: number;
  tainted: boolean;
  qualityBefore: SummaryQuality;
  /** The quality this run stored, or absent when the old row stands. A failed
   * node keeps its persisted verdict, which is what the next run seeds on. */
  qualityAfter?: SummaryQuality;
  outcome: HealNodeOutcomeKind;
  reason?: string;
  /** 3 when the text is the deterministic truncate, null otherwise. */
  levelBefore: SummaryLevel | null;
  /** The level stored by this run, or null when the old text stands. */
  levelAfter: SummaryLevel | null;
  beforeTokens: number;
  afterTokens: number | null;
  calls: number;
  /** Source facts for the attempted node. They never include source text. */
  sourceTokens?: number;
  sourceChars?: number;
  sourceClipped?: boolean;
}

export interface HealCounts {
  candidates: number;
  tainted: number;
  attempted: number;
  /** Nodes whose new text is clean. An improved node is not a repair. */
  repaired: number;
  /** Nodes whose text changed but remains clipped or derived. */
  improved: number;
  failed: number;
  /** Dependency-blocked plus source-blocked nodes. */
  blocked: number;
  /** The source-blocked subset of `blocked`. */
  blockedSource: number;
  skipped: number;
  changed: number;
  notAttempted: number;
}

export interface HealOutcome {
  dryRun: boolean;
  stop: HealStopReason;
  /** The effective map window for this run, in estimated tokens. */
  sourceTokens: number;
  callBudgetTokens: number;
  candidates: HealCandidate[];
  nodes: HealNodeResult[];
  repaired: number[];
  improved: number[];
  failed: number[];
  blocked: number[];
  /** The subset of `blocked` whose source exceeded the window. */
  blockedSource: number[];
  skipped: number[];
  changed: number[];
  notAttempted: number[];
  calls: number;
  tokens: number;
  counts: HealCounts;
}

interface HealPlan {
  candidates: HealCandidate[];
  tainted: Set<number>;
  parents: Map<number, number[]>;
  sources: Map<number, SummarySources>;
  tokens: Map<number, number>;
}

interface CallBudget {
  calls: number;
  tokens: number;
  stopped: HealStopReason | null;
}

/** The source window a repair is allowed to read, in estimated tokens.
 *
 * The default is a multiple of the summary target, so the one quality knob a
 * user already tunes moves the source with it. A fixed source window has the
 * failure this policy exists to remove: every larger input clips at the same
 * place forever. The window is still bounded by the request cap, so a large
 * source cannot turn into a prompt the provider will refuse.
 */
export function healSourceBudget(input: HealSourceBudgetInput = {}): number {
  const target = bounded(input.targetTokens, HEAL_TARGET_TOKENS, 1);
  const configured = bounded(input.sourceTokens, Number.NaN, 1);
  const base = Number.isFinite(configured)
    ? Math.min(HEAL_SOURCE_MAX_TOKENS, configured)
    : Math.min(
        HEAL_SOURCE_MAX_TOKENS,
        Math.max(HEAL_SOURCE_MIN_TOKENS, target * HEAL_SOURCE_TARGET_FACTOR),
      );
  const callBudget = bounded(input.callBudgetTokens, SUMMARIZER_CALL_TOKENS, 1);
  const requestCeiling = callBudget - target - HEAL_PROMPT_TOKENS;
  return Math.max(1, Math.min(base, requestCeiling));
}

interface HealWindow {
  items: Array<{ role: string; text: string }>;
  sourceChars: number;
}

type HealSource =
  | {
      kind: "items";
      items: Array<{ role: string; text: string }>;
      /** The repaired node's verdict. A clipped leaf source, or a condensed
       * node over a non-clean child, must not be stored as clean. */
      quality: SummaryQuality;
      sourceChars: number;
      sourceTokens: number;
      sourceClipped: boolean;
      /** Present when a leaf source exceeds one window but fits the bounded
       * map-reduce plan. The items are then the exact full source. */
      windows?: HealWindow[];
    }
  | { kind: "missing"; reason: "no-source" | "source-missing" };

/**
 * Re-derive mechanical summaries from the source they still point at, then
 * recompute every ancestor whose child changed. The messages table is never
 * written: a leaf is rebuilt from its exact provenance rows, a condensed node
 * from its exact children, and only a node whose text still matches the read
 * that produced the replacement is written at all.
 */
export async function runHeal(
  store: HealStore,
  input: HealInput,
  llm: LlmComplete,
): Promise<HealOutcome> {
  const emit = llm.metrics ?? appendMetric;
  const session = input.session;
  const targetTokens = bounded(input.targetTokens, HEAL_TARGET_TOKENS, 1);
  const maxNodes = bounded(input.maxNodes, HEAL_MAX_NODES, 0);
  const maxCalls = bounded(
    input.maxCalls,
    Math.max(2, maxNodes * 2, HEAL_MAX_WINDOWS_PER_NODE * 2 + 2),
    0,
  );
  const tokenBudget = bounded(input.maxTokens, HEAL_TOKEN_BUDGET, 0);
  const callBudgetTokens = bounded(input.callBudgetTokens, SUMMARIZER_CALL_TOKENS, 1);
  const configuredSource = input.sourceTokens ?? input.leafChunkTokens;
  const sourceTokens = healSourceBudget({
    targetTokens,
    ...(configuredSource === undefined ? {} : { sourceTokens: configuredSource }),
    callBudgetTokens,
  });
  const maxChars = sourceTokens * CHARS_PER_TOKEN;
  const redact = input.redact ?? ((text: string) => text);
  const prefix = input.truncatedPrefix ?? HEAL_TRUNCATED_PREFIX;
  const dryRun = input.dryRun === true;

  const plan = buildPlan(store, prefix);

  emit({
    event: "lcm",
    kind: "heal-start",
    session,
    candidates: plan.candidates.length,
    taintedNodes: plan.tainted.size,
    maxNodes,
    maxCalls,
    maxTokens: tokenBudget,
    targetTokens,
    sourceTokens,
    callBudgetTokens,
    dryRun,
  });

  if (dryRun) {
    const outcome: HealOutcome = {
      dryRun: true,
      stop: "dry-run",
      sourceTokens,
      callBudgetTokens,
      candidates: plan.candidates,
      nodes: [],
      repaired: [],
      improved: [],
      failed: [],
      blocked: [],
      blockedSource: [],
      skipped: [],
      changed: [],
      notAttempted: [],
      calls: 0,
      tokens: 0,
      counts: {
        candidates: plan.candidates.length,
        tainted: plan.tainted.size,
        attempted: 0,
        repaired: 0,
        improved: 0,
        failed: 0,
        blocked: 0,
        blockedSource: 0,
        skipped: 0,
        changed: 0,
        notAttempted: 0,
      },
    };
    reportComplete(emit, session, outcome);
    return outcome;
  }

  const state: CallBudget = { calls: 0, tokens: 0, stopped: null };
  const budgeted = budgetedComplete(llm, { maxCalls, maxTokens: tokenBudget }, state);
  const changed = new Set<number>();
  const blocked = new Set<number>();
  const results: HealNodeResult[] = [];
  const repaired: number[] = [];
  const improved: number[] = [];
  const failed: number[] = [];
  const blockedIds: number[] = [];
  const blockedSourceIds: number[] = [];
  const skipped: number[] = [];
  const changedIds: number[] = [];
  let attempted = 0;
  let stop: HealStopReason = "done";
  let notAttempted: number[] = [];

  const blockAncestors = (id: number): void => {
    const stack = [...(plan.parents.get(id) ?? [])];
    while (stack.length > 0) {
      const ancestor = stack.pop();
      if (ancestor === undefined || blocked.has(ancestor)) continue;
      blocked.add(ancestor);
      stack.push(...(plan.parents.get(ancestor) ?? []));
    }
  };

  /** A repaired child makes its parents stale. Persist that before this run can
   * stop or fail, so the next run still finds a clean-looking ancestor. */
  const markParentsDerived = (id: number): void => {
    const parents = new Set([...(plan.parents.get(id) ?? []), ...store.parentSummaryIds(id)]);
    for (const parentId of parents) store.markSummaryDerived(parentId);
  };

  const record = (result: HealNodeResult): void => {
    results.push(result);
    emit({
      event: "lcm",
      kind: "heal-node",
      session,
      summaryId: result.id,
      depth: result.depth,
      nodeKind: result.nodeKind,
      tainted: result.tainted,
      qualityBefore: result.qualityBefore,
      ...(result.qualityAfter === undefined ? {} : { qualityAfter: result.qualityAfter }),
      levelBefore: result.levelBefore,
      levelAfter: result.levelAfter,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      calls: result.calls,
      outcome: result.outcome,
      reason: result.reason,
      ...(result.sourceTokens === undefined ? {} : { sourceTokens: result.sourceTokens }),
      ...(result.sourceChars === undefined ? {} : { sourceChars: result.sourceChars }),
      ...(result.sourceClipped === undefined ? {} : { sourceClipped: result.sourceClipped }),
    });
  };

  const reject = (
    candidate: HealCandidate,
    beforeTokens: number,
    levelBefore: SummaryLevel | null,
    calls: number,
    reason: string,
  ): void => {
    failed.push(candidate.id);
    record({
      id: candidate.id,
      nodeKind: candidate.nodeKind,
      depth: candidate.depth,
      tainted: candidate.tainted,
      qualityBefore: candidate.quality,
      outcome: "failed",
      reason,
      levelBefore,
      levelAfter: null,
      beforeTokens,
      afterTokens: null,
      calls,
    });
    blockAncestors(candidate.id);
  };

  for (let i = 0; i < plan.candidates.length; i++) {
    const candidate = plan.candidates[i];
    if (!candidate) continue;
    const levelBefore: SummaryLevel | null = candidate.mechanical ? 3 : null;
    const planTokens = plan.tokens.get(candidate.id) ?? 0;

    if (blocked.has(candidate.id)) {
      blockedIds.push(candidate.id);
      record({
        id: candidate.id,
        nodeKind: candidate.nodeKind,
        depth: candidate.depth,
        tainted: candidate.tainted,
        qualityBefore: candidate.quality,
        outcome: "blocked",
        reason: "dependency-failed",
        levelBefore,
        levelAfter: null,
        beforeTokens: planTokens,
        afterTokens: null,
        calls: 0,
      });
      continue;
    }

    const childIds = (plan.sources.get(candidate.id) ?? store.summarySources(candidate.id))
      .summaries;
    const needsRepair = candidate.tainted || childIds.some((id) => changed.has(id));
    if (!needsRepair) {
      skipped.push(candidate.id);
      record({
        id: candidate.id,
        nodeKind: candidate.nodeKind,
        depth: candidate.depth,
        tainted: false,
        qualityBefore: candidate.quality,
        outcome: "skipped",
        reason: "clean",
        levelBefore,
        levelAfter: null,
        beforeTokens: planTokens,
        afterTokens: null,
        calls: 0,
      });
      continue;
    }

    // The durable retry marker: whether this attempt succeeds, is refused, or
    // never starts because the run is bounded, a clean node whose child changed
    // is stale from here on.
    store.markSummaryDerived(candidate.id);

    if (attempted >= maxNodes) {
      stop = "max-nodes";
      notAttempted = remainingIds(plan.candidates, i);
      break;
    }
    if (state.calls >= maxCalls) {
      stop = "max-calls";
      notAttempted = remainingIds(plan.candidates, i);
      break;
    }
    if (state.tokens >= tokenBudget) {
      stop = "token-budget";
      notAttempted = remainingIds(plan.candidates, i);
      break;
    }

    const current = store.getSummary(candidate.id);
    if (!current) {
      failed.push(candidate.id);
      record({
        id: candidate.id,
        nodeKind: candidate.nodeKind,
        depth: candidate.depth,
        tainted: candidate.tainted,
        qualityBefore: candidate.quality,
        outcome: "failed",
        reason: "node-missing",
        levelBefore,
        levelAfter: null,
        beforeTokens: planTokens,
        afterTokens: null,
        calls: 0,
      });
      blockAncestors(candidate.id);
      continue;
    }

    const sources = plan.sources.get(candidate.id) ?? store.summarySources(candidate.id);
    const source = sourceFor(store, current, sources, { maxChars, redact, emit, session });
    if (source.kind === "missing") {
      failed.push(candidate.id);
      record({
        id: candidate.id,
        nodeKind: candidate.nodeKind,
        depth: candidate.depth,
        tainted: candidate.tainted,
        qualityBefore: candidate.quality,
        outcome: "failed",
        reason: source.reason,
        levelBefore,
        levelAfter: null,
        beforeTokens: current.tokens,
        afterTokens: null,
        calls: 0,
      });
      blockAncestors(candidate.id);
      continue;
    }

    const childChanged = childIds.some((id) => changed.has(id));
    // A clipped or derived source cannot produce a clean node. Retrying it at
    // the same window buys another model call and the same verdict, so it is
    // blocked instead. A mechanical node gets one improvement because a model
    // summary over a clipped source is still better than the truncate, and a
    // parent whose child changed this run gets one chance to consume that new
    // text. Neither can repeat at the same window.
    if (source.quality !== "clean" && !candidate.mechanical && !childChanged) {
      // This node consumed no model slot: a bounded run must not spend its
      // node allowance on sources that cannot change verdict at this window.
      blockedIds.push(candidate.id);
      blockedSourceIds.push(candidate.id);
      record({
        id: candidate.id,
        nodeKind: candidate.nodeKind,
        depth: candidate.depth,
        tainted: candidate.tainted,
        qualityBefore: candidate.quality,
        outcome: "blocked",
        reason: "source-over-budget",
        levelBefore,
        levelAfter: null,
        beforeTokens: current.tokens,
        afterTokens: null,
        calls: 0,
        sourceTokens: source.sourceTokens,
        sourceChars: source.sourceChars,
        sourceClipped: source.sourceClipped,
      });
      continue;
    }

    if (source.windows !== undefined) {
      const windows = source.windows;
      const minCalls = windows.length + (windows.length > 1 ? 1 : 0);
      if (state.calls + minCalls > maxCalls) {
        stop = "max-calls";
        notAttempted = remainingIds(plan.candidates, i);
        break;
      }
      const minTokens =
        windows.reduce((n, window) => n + Math.ceil(window.sourceChars / CHARS_PER_TOKEN), 0) +
        (windows.length + 1) * (targetTokens + HEAL_PROMPT_TOKENS);
      if (state.tokens + minTokens > tokenBudget) {
        stop = "token-budget";
        notAttempted = remainingIds(plan.candidates, i);
        break;
      }
    }

    attempted++;
    const callsBefore = state.calls;
    let answer: { text: string; level: SummaryLevel };
    if (source.windows !== undefined) {
      const result = await summarizeWindows(
        source.windows,
        targetTokens,
        budgeted,
        session,
        redact,
      );
      if (result.kind === "failed") {
        reject(candidate, current.tokens, levelBefore, state.calls - callsBefore, result.reason);
        if (state.stopped !== null) {
          stop = state.stopped;
          notAttempted = remainingIds(plan.candidates, i + 1);
          break;
        }
        continue;
      }
      answer = result;
    } else {
      answer = await summarizeWithEscalation(source.items, targetTokens, budgeted, session);
    }
    const calls = state.calls - callsBefore;
    const sourceFields = {
      sourceTokens: source.sourceTokens,
      sourceChars: source.sourceChars,
      sourceClipped: source.sourceClipped,
    };

    if (answer.level === 3) {
      reject(candidate, current.tokens, levelBefore, calls, state.stopped ?? "level-3");
    } else {
      const stored = redact(answer.text);
      const afterTokens = estimateTokens(stored);
      if (stored.trim().length === 0) {
        reject(candidate, current.tokens, levelBefore, calls, "empty");
      } else if (afterTokens > targetTokens * 2) {
        reject(candidate, current.tokens, levelBefore, calls, "oversized");
      } else if (prefix.length > 0 && stored.startsWith(prefix)) {
        // A level 1 or 2 answer that echoes the mechanical marker would be
        // detected as tainted on the next run, so it is not a repair.
        reject(candidate, current.tokens, levelBefore, calls, "mechanical-prefix");
      } else if (
        !store.casUpdateSummaryText({
          id: current.id,
          expectedText: current.text,
          expectedTokens: current.tokens,
          text: stored,
          tokens: afterTokens,
          quality: source.quality,
        })
      ) {
        changedIds.push(candidate.id);
        record({
          id: candidate.id,
          nodeKind: candidate.nodeKind,
          depth: candidate.depth,
          tainted: candidate.tainted,
          qualityBefore: candidate.quality,
          outcome: "changed",
          reason: "concurrent-change",
          levelBefore,
          levelAfter: null,
          beforeTokens: current.tokens,
          afterTokens: null,
          calls,
          ...sourceFields,
        });
        blockAncestors(candidate.id);
        // Another writer changed this row's text. Its parents are stale either
        // way, and this run cannot claim the child as clean.
        markParentsDerived(candidate.id);
      } else {
        changed.add(candidate.id);
        const clean = source.quality === "clean";
        if (clean) repaired.push(candidate.id);
        else improved.push(candidate.id);
        record({
          id: candidate.id,
          nodeKind: candidate.nodeKind,
          depth: candidate.depth,
          tainted: candidate.tainted,
          qualityBefore: candidate.quality,
          qualityAfter: source.quality,
          outcome: clean ? "repaired" : "improved",
          levelBefore,
          levelAfter: answer.level,
          beforeTokens: current.tokens,
          afterTokens,
          calls,
          ...sourceFields,
        });
        markParentsDerived(candidate.id);
      }
    }

    if (state.stopped !== null) {
      stop = state.stopped;
      notAttempted = remainingIds(plan.candidates, i + 1);
      break;
    }
  }

  const outcome: HealOutcome = {
    dryRun: false,
    stop,
    sourceTokens,
    callBudgetTokens,
    candidates: plan.candidates,
    nodes: results,
    repaired,
    improved,
    failed,
    blocked: blockedIds,
    blockedSource: blockedSourceIds,
    skipped,
    changed: changedIds,
    notAttempted,
    calls: state.calls,
    tokens: state.tokens,
    counts: {
      candidates: plan.candidates.length,
      tainted: plan.tainted.size,
      attempted,
      repaired: repaired.length,
      improved: improved.length,
      failed: failed.length,
      blocked: blockedIds.length,
      blockedSource: blockedSourceIds.length,
      skipped: skipped.length,
      changed: changedIds.length,
      notAttempted: notAttempted.length,
    },
  };
  reportComplete(emit, session, outcome);
  return outcome;
}

function buildPlan(store: HealStore, prefix: string): HealPlan {
  const seeds = store.taintedSummaries(prefix);
  const tainted = new Set(seeds.map((node) => node.id));
  const nodes = new Map<number, SummaryNode>();
  const parentSets = new Map<number, Set<number>>();
  const sources = new Map<number, SummarySources>();
  const queue: SummaryNode[] = [];

  const sourcesOf = (id: number): SummarySources => {
    const cached = sources.get(id);
    if (cached) return cached;
    const fresh = store.summarySources(id);
    sources.set(id, fresh);
    return fresh;
  };
  const enqueue = (node: SummaryNode): void => {
    if (nodes.has(node.id)) return;
    nodes.set(node.id, node);
    queue.push(node);
  };
  for (const node of seeds) enqueue(node);

  // Every ancestor of a tainted node is a candidate, because a clean-looking
  // parent's text was derived from children it cannot see changing.
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (!node) continue;
    for (const parentId of store.parentSummaryIds(node.id)) {
      const set = parentSets.get(node.id) ?? new Set<number>();
      set.add(parentId);
      parentSets.set(node.id, set);
      if (nodes.has(parentId)) continue;
      const parent = store.getSummary(parentId);
      if (parent) enqueue(parent);
    }
  }

  // Child before parent, deterministic by id. Mechanical work comes before a
  // clipped retry, so a bounded run keeps making new progress. The `visiting`
  // state guards a corrupt cycle rather than trusting the depth column.
  const priority = (id: number): number => qualityPriority(nodes.get(id));
  const order: number[] = [];
  const state = new Map<number, "visiting" | "done">();
  const visit = (id: number): void => {
    if (state.has(id)) return;
    state.set(id, "visiting");
    const children = sourcesOf(id)
      .summaries.filter((child) => nodes.has(child))
      .sort((a, b) => priority(a) - priority(b) || a - b);
    for (const child of children) visit(child);
    state.set(id, "done");
    order.push(id);
  };
  for (const id of [...nodes.keys()].sort((a, b) => priority(a) - priority(b) || a - b)) {
    visit(id);
  }

  const candidates: HealCandidate[] = [];
  const parents = new Map<number, number[]>();
  const tokens = new Map<number, number>();
  for (const id of order) {
    const node = nodes.get(id);
    if (!node) continue;
    const ancestorIds = [...(parentSets.get(id) ?? [])]
      .filter((parentId) => nodes.has(parentId))
      .sort((a, b) => a - b);
    parents.set(id, ancestorIds);
    tokens.set(id, node.tokens);
    candidates.push({
      id,
      nodeKind: node.kind,
      depth: node.depth,
      quality: node.quality,
      mechanical:
        node.quality === "mechanical" || (prefix.length > 0 && node.text.startsWith(prefix)),
      tainted: tainted.has(id),
      parents: ancestorIds,
    });
  }
  // Depth keeps children before parents. Within a depth, repair mechanical and
  // derived nodes before clipped ones: a clipped source is the most expensive
  // case, and a bounded run must not spend its whole budget on it first.
  candidates.sort(
    (a, b) => a.depth - b.depth || qualityRank(a.quality) - qualityRank(b.quality) || a.id - b.id,
  );
  return { candidates, tainted, parents, sources, tokens };
}

/** A leaf reads the exact message rows its provenance names, with the file
 * handle and mask a compaction leaf uses. A condensed node reads the exact
 * child summaries, so a repaired child's new text is what its parent sees.
 *
 * A source that fits one window is sent whole. A larger leaf is split into
 * exact windows and reduced, so one large tool result is never clipped to a
 * per-message slice. */
function sourceFor(
  store: HealStore,
  node: SummaryNode,
  sources: SummarySources,
  opts: {
    maxChars: number;
    redact: (text: string) => string;
    emit: MetricsSink;
    session?: string;
  },
): HealSource {
  const items: Array<{ role: string; text: string; entryId: string }> = [];
  let sourceQuality: SummaryQuality = "clean";

  if (node.kind === "condensed") {
    if (sources.summaries.length === 0) return { kind: "missing", reason: "no-source" };
    for (const childId of sources.summaries) {
      const child = store.getSummary(childId);
      if (!child) return { kind: "missing", reason: "source-missing" };
      items.push({ role: "summary", text: child.text, entryId: child.firstEntryId });
      if (!isCleanSummary(child)) sourceQuality = "derived";
    }
  } else {
    if (sources.messages.length === 0) return { kind: "missing", reason: "no-source" };
    const messages = store.messagesByIds(sources.messages);
    if (messages.length !== sources.messages.length) {
      return { kind: "missing", reason: "source-missing" };
    }
    const refs = store.filesForMessages(messages.map((message) => message.id));
    const refByMessage = new Map(refs.map((ref) => [ref.messageId, ref]));
    for (const message of messages) {
      const ref = refByMessage.get(message.id);
      items.push({
        role: message.role,
        text: opts.redact(ref ? filePreviewText(ref) : message.text),
        entryId: message.entryId,
      });
    }
  }

  const sourceChars = items.reduce((n, item) => n + item.text.length, 0);
  // Condensed nodes read child summaries, which the DAG already bounds by its
  // fanout and target. Clipping them would turn a clean parent into a derived
  // one for no safety gain; the call budget still refuses an impossible prompt.
  if (node.kind !== "leaf" || sourceChars <= opts.maxChars) {
    return {
      kind: "items",
      items: items.map(({ role, text }) => ({ role, text })),
      quality: sourceQuality,
      sourceChars,
      sourceTokens: Math.ceil(sourceChars / CHARS_PER_TOKEN),
      sourceClipped: false,
    };
  }

  const windows = planHealWindows(items, opts.maxChars, HEAL_MAX_WINDOWS_PER_NODE);
  if (windows !== null) {
    return {
      kind: "items",
      items: items.map(({ role, text }) => ({ role, text })),
      quality: "clean",
      sourceChars,
      sourceTokens: Math.ceil(sourceChars / CHARS_PER_TOKEN),
      sourceClipped: false,
      windows,
    };
  }

  // The source is larger than the bounded plan. A mechanical node may still
  // spend one clipped call, because a model summary over part of the source is
  // better than the deterministic truncate. A clipped or derived node blocks
  // rather than buying the same partial read again.
  const clipped = clipSourceItems(items, opts.maxChars, opts);
  return {
    kind: "items",
    items: clipped.items.map(({ role, text }) => ({ role, text })),
    quality: sourceQuality === "clean" ? "clipped" : sourceQuality,
    sourceChars,
    sourceTokens: Math.ceil(sourceChars / CHARS_PER_TOKEN),
    sourceClipped: clipped.sourceClipped,
  };
}

/** Split a leaf source into exact, ordered windows. A message larger than one
 * window is sliced at a preferred boundary; every character is kept once. */
function planHealWindows(
  items: readonly { role: string; text: string; entryId: string }[],
  maxChars: number,
  maxWindows: number,
): HealWindow[] | null {
  const slices: Array<{ role: string; text: string }> = [];
  for (const item of items) {
    if (item.text.length === 0) continue;
    const parts: string[] = [];
    for (let start = 0; start < item.text.length;) {
      const end = sliceEnd(item.text, start, maxChars);
      parts.push(item.text.slice(start, end));
      start = end;
    }
    for (let index = 0; index < parts.length; index++) {
      const text = parts[index] ?? "";
      slices.push({
        role: parts.length > 1 ? `${item.role} part ${index + 1}/${parts.length}` : item.role,
        text,
      });
    }
  }

  const windows: HealWindow[] = [];
  let current: Array<{ role: string; text: string }> = [];
  let currentChars = 0;
  const flush = (): boolean => {
    if (current.length === 0) return true;
    windows.push({ items: current, sourceChars: currentChars });
    if (windows.length > maxWindows) return false;
    current = [];
    currentChars = 0;
    return true;
  };
  for (const slice of slices) {
    if (currentChars > 0 && currentChars + slice.text.length > maxChars && !flush()) return null;
    current.push(slice);
    currentChars += slice.text.length;
  }
  if (!flush()) return null;
  return windows.length === 0 ? null : windows;
}

/** Pick a cut near the end of the window, preferring a paragraph, line,
 * sentence, or word boundary. The cut never splits a surrogate pair or CRLF. */
function sliceEnd(text: string, start: number, maxChars: number): number {
  const limit = Math.min(text.length, start + maxChars);
  if (limit >= text.length) return text.length;
  // Keep the cut near the full window. A boundary in the last fifth would
  // shrink every slice enough that a source fitting eight windows needs more.
  const floor = start + Math.floor(maxChars * 0.95);
  for (const marker of ["\n\n", "\n", ". ", " "]) {
    const found = text.lastIndexOf(marker, limit);
    if (found >= floor) return Math.min(limit, found + marker.length);
  }
  let end = limit;
  if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  if (text[end - 1] === "\r" && text[end] === "\n") end--;
  return end > start ? end : limit;
}

function clipSourceItems(
  items: readonly { role: string; text: string; entryId: string }[],
  maxChars: number,
  opts: {
    redact: (text: string) => string;
    emit: MetricsSink;
    session?: string;
  },
): { items: Array<{ role: string; text: string; entryId: string }>; sourceClipped: boolean } {
  const shares = shareChars(
    items.map((item) => item.text.length),
    maxChars,
  );
  let sourceClipped = false;
  const clippedItems = items.map((item, index) => {
    const clipped = clipForHeal(item.text, item.entryId, shares[index] ?? 0);
    if (clipped.droppedChars <= 0) return item;
    sourceClipped = true;
    opts.emit({
      event: "lcm",
      kind: "summary-input-clipped",
      session: opts.session,
      entryId: item.entryId,
      keptChars: clipped.keptChars,
      droppedChars: clipped.droppedChars,
    });
    return { ...item, text: clipped.text };
  });
  return { items: clippedItems, sourceClipped };
}

/** Distribute a whole-node character budget over its items. Every character of
 * a short item is kept; the remainder is shared evenly among longer items. The
 * allocation is deterministic and never exceeds the budget. */
function shareChars(lengths: readonly number[], budget: number): number[] {
  const shares = lengths.map(() => 0);
  let remaining = Math.max(0, Math.floor(budget));
  let active = lengths
    .map((length, index) => ({ length, index }))
    .filter(({ length }) => length > 0)
    .map(({ index }) => index);
  while (remaining > 0 && active.length > 0) {
    const per = Math.max(1, Math.floor(remaining / active.length));
    const next: number[] = [];
    for (const index of active) {
      const length = lengths[index] ?? 0;
      const share = shares[index] ?? 0;
      const add = Math.min(length - share, per, remaining);
      if (add <= 0) continue;
      shares[index] = share + add;
      remaining -= add;
      if (shares[index]! < length) next.push(index);
    }
    if (next.length === active.length && next.every((index) => shares[index] === 0)) break;
    active = next;
  }
  return shares;
}

function isCleanSummary(node: SummaryNode): boolean {
  return node.quality === "clean" && !node.text.startsWith(TRUNCATED_SUMMARY_PREFIX);
}

function qualityRank(quality: SummaryQuality): number {
  switch (quality) {
    case "mechanical":
      return 0;
    case "derived":
      return 1;
    case "clean":
      return 2;
    case "clipped":
      return 3;
  }
}

/** A bounded run spends its first attempts on nodes that can become clean. A
 * clipped retry is still worth doing, but only after the mechanical work. */
function qualityPriority(node: SummaryNode | undefined): number {
  if (node === undefined) return 4;
  if (node.quality === "mechanical") return 0;
  if (node.quality === "derived") return 1;
  if (node.quality === "clipped") return 2;
  return 3;
}

/** Map every window, then reduce the answers once. A map that falls back to the
 * deterministic truncate is a failure for this node: storing a clipped result
 * would leave it in the tainted set and buy the same windows again. */
async function summarizeWindows(
  windows: readonly HealWindow[],
  targetTokens: number,
  llm: LlmComplete,
  session: string | undefined,
  redact: (text: string) => string,
): Promise<{ kind: "ok"; text: string; level: SummaryLevel } | { kind: "failed"; reason: string }> {
  const answers: Array<{ text: string; level: SummaryLevel }> = [];
  for (const window of windows) {
    const answer = await summarizeWithEscalation(window.items, targetTokens, llm, session);
    if (answer.level === 3) return { kind: "failed", reason: "window-level-3" };
    answers.push({ text: redact(answer.text), level: answer.level });
  }
  if (answers.length === 1) {
    return { kind: "ok", text: answers[0]?.text ?? "", level: answers[0]?.level ?? 1 };
  }
  const reduced = await summarizeWithEscalation(
    answers.map((answer, index) => ({
      role: `summary window ${index + 1}/${answers.length}`,
      text: answer.text,
    })),
    targetTokens,
    llm,
    session,
  );
  if (reduced.level === 3) return { kind: "failed", reason: "reduce-level-3" };
  return { kind: "ok", text: reduced.text, level: reduced.level };
}

function budgetedComplete(
  llm: LlmComplete,
  limits: { maxCalls: number; maxTokens: number },
  state: CallBudget,
): LlmComplete {
  return Object.assign(
    async (systemPrompt: string, userText: string, maxTokens: number): Promise<string> => {
      if (state.stopped !== null) {
        throw new SummarizerFailure("lcm: heal budget is exhausted", "capped");
      }
      if (state.calls >= limits.maxCalls) {
        state.stopped = "max-calls";
        throw new SummarizerFailure(
          `lcm: heal call budget reached (${limits.maxCalls} calls)`,
          "capped",
        );
      }
      const estimate =
        estimateTokens(systemPrompt) + estimateTokens(userText) + Math.max(0, maxTokens);
      if (state.tokens + estimate > limits.maxTokens) {
        state.stopped = "token-budget";
        throw new SummarizerFailure(
          `lcm: heal token budget would be exceeded (${state.tokens + estimate} against ${limits.maxTokens})`,
          "capped",
        );
      }
      state.calls++;
      state.tokens += estimate;
      try {
        return await llm(systemPrompt, userText, maxTokens);
      } catch (error) {
        // The adapter's completer stops calling after this, so continuing the
        // walk would only turn every remaining node into a mechanical result.
        if (error instanceof SummarizerFailure && error.category === "capped") {
          state.stopped = "llm-capped";
        }
        throw error;
      }
    },
    { metrics: llm.metrics },
  );
}

function reportComplete(
  emit: MetricsSink,
  session: string | undefined,
  outcome: HealOutcome,
): void {
  emit({
    event: "lcm",
    kind: "heal-complete",
    session,
    stop: outcome.stop,
    candidates: outcome.counts.candidates,
    attempted: outcome.counts.attempted,
    repaired: outcome.counts.repaired,
    improved: outcome.counts.improved,
    failed: outcome.counts.failed,
    blocked: outcome.counts.blocked,
    blockedSource: outcome.counts.blockedSource,
    skipped: outcome.counts.skipped,
    changedCount: outcome.counts.changed,
    notAttempted: outcome.counts.notAttempted,
    calls: outcome.calls,
    tokens: outcome.tokens,
    sourceTokens: outcome.sourceTokens,
    callBudgetTokens: outcome.callBudgetTokens,
    repairedIds: outcome.repaired,
    improvedIds: outcome.improved,
  });
}

function remainingIds(candidates: readonly HealCandidate[], from: number): number[] {
  return candidates.slice(from).map((candidate) => candidate.id);
}

function bounded(value: number | undefined, fallback: number, min: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(min, Math.floor(candidate));
}

function clipForHeal(
  text: string,
  entryId: string,
  maxChars: number,
): { text: string; keptChars: number; droppedChars: number } {
  if (text.length <= maxChars) return { text, keptChars: text.length, droppedChars: 0 };
  const kept = text.slice(0, maxChars);
  const dropped = text.length - maxChars;
  return {
    text: `${kept}\n\n[lcm:input-clipped ${entryId}: kept ${maxChars} of ${text.length} chars, ${dropped} dropped from this summary's source; entry ${entryId} is stored verbatim and lcm_expand_query can read it]`,
    keptChars: maxChars,
    droppedChars: dropped,
  };
}
