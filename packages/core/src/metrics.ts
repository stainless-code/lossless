import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { lcmHomePath } from "./home-paths.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_GENERATIONS = 12;

export function metricsPath(): string {
  return lcmHomePath("lcm", "metrics.jsonl");
}

/** The metrics log, oldest generation first, so a window longer than one
 * generation still reads as one history. */
export function metricsLogFiles(): string[] {
  const base = metricsPath();
  const paths: string[] = [];
  try {
    const dir = dirname(base);
    const prefix = `${basename(base)}.`;
    for (const f of readdirSync(dir)) {
      if (f.startsWith(prefix) && /^\d+$/.test(f.slice(prefix.length))) {
        paths.push(join(dir, f));
      }
    }
  } catch {}
  paths.sort();
  paths.push(base);
  return paths;
}

export function rotateIfNeeded(path: string, maxBytes: number): void {
  if (!existsSync(path)) return;
  if (statSync(path).size > maxBytes) {
    renameSync(path, `${path}.${Date.now()}`);
  }
}

export function pruneGenerations(path: string, keep: number): void {
  try {
    const dir = dirname(path);
    const prefix = `${basename(path)}.`;
    const generations = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && /^\d+$/.test(f.slice(prefix.length)))
      .sort()
      .reverse();
    for (const stale of generations.slice(keep)) {
      try {
        unlinkSync(join(dir, stale));
      } catch {}
    }
  } catch {}
}

export function appendMetric(record: MetricRecord): void {
  try {
    const path = metricsPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    rotateIfNeeded(path, MAX_BYTES);
    pruneGenerations(path, MAX_GENERATIONS);
    appendFileSync(path, `${JSON.stringify({ ts: Date.now(), ...record })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {}
}

export interface UsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { input?: unknown; output?: unknown; total?: unknown };
}

interface MetricBase {
  /** Session tag. Absent on rows written outside a session (`gc`, `import`). */
  session?: string;
}

export type MetricSpan = [string, string];

export type SummaryStage = "leaf" | "condensed";
export type CompactionStage = "blocking" | "async" | "direct";
export type SummaryLevel = 1 | 2 | 3;

/** One model's turn in a summarizer chain, in the order it was tried. */
type SummarizerAttempt =
  | { model: string; outcome: "ok" | "empty" }
  | { model: string; outcome: "threw"; error: string };

export type UsageCounters = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  costInput: number | null;
  costOutput: number | null;
  costTotal: number | null;
};

function countersOf(usage: UsageLike | undefined): UsageCounters {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    input: num(usage?.input),
    output: num(usage?.output),
    cacheRead: num(usage?.cacheRead),
    cacheWrite: num(usage?.cacheWrite),
    costInput: num(usage?.cost?.input),
    costOutput: num(usage?.cost?.output),
    costTotal: num(usage?.cost?.total),
  };
}

function billed(counters: UsageCounters): boolean {
  return Object.values(counters).some((v) => v !== null);
}

/** The counters to put on a row, or `undefined` when the provider billed
 * nothing (an aborted call, or a provider that reports no usage). */
export function billedCounters(usage: UsageLike | undefined): UsageCounters | undefined {
  const counters = countersOf(usage);
  return billed(counters) ? counters : undefined;
}

/** One metrics row per measured assistant message: no numeric counter at all
 * (aborted turn, legacy row) yields `undefined`, so it does not count as a turn
 * in the report's cache-economics averages. */
export function usageRecord(usage: UsageLike | undefined): UsageRow | undefined {
  const counters = countersOf(usage);
  if (!billed(counters)) return undefined;
  return { event: "usage" as const, ...counters };
}

export type SummarizerStage = "blocking" | "async";

/** Why a summarizer call failed, as far as the provider's own text says. A
 * closed set, and `unknown` is a real answer: a classification that guesses is
 * worse than a bucket that says it could not tell, and the raw message stays on
 * the row either way. `capped` is not a provider failure: it is the pass giving
 * up after too many of them, and the category beside it says which one. */
export type SummarizerFailureCategory =
  | "auth"
  | "rate-limit"
  | "timeout"
  | "unavailable"
  | "length"
  | "empty"
  | "capped"
  | "unknown";

/** `ok` answered with usable text, `empty` answered with none, `failure` was rejected. */
export type SummarizerOutcome = "ok" | "empty" | "failure";

export interface SummarizerUsageOptions {
  /** The resolved model key, as `modelKey` renders it. */
  model: string;
  stage?: SummarizerStage;
  outcome: SummarizerOutcome;
  /** The provider's own stop word, so `length` and `error` are told apart. */
  stopReason?: string;
  session?: string;
}

export type SummarizerUsageRow = UsageCounters & {
  event: "lcm";
  kind: "summarizer-usage";
  model: string;
  stage?: SummarizerStage;
  outcome: SummarizerOutcome;
  stopReason?: string;
  session?: string;
};

/** One provider call the summarizer made. `usage` rows cannot carry it, since
 * those come from Pi's `message_end` for the session's own messages while the
 * summarizer talks to the model registry directly. */
export function summarizerUsageRecord(
  usage: UsageLike | undefined,
  opts: SummarizerUsageOptions,
): SummarizerUsageRow | undefined {
  const counters = countersOf(usage);
  if (!billed(counters)) return undefined;
  return { event: "lcm", kind: "summarizer-usage", ...opts, ...counters };
}

// One interface per kind, derived from the call sites, makes the writer the
// checked side; the report trusts none of the input, and the reader stays
// tolerant on purpose so a line from a newer build still parses.

export type UsageRow = MetricBase & UsageCounters & { event: "usage" };

interface LcmRowBase extends MetricBase {
  event: "lcm";
}

export type ContextDecisionRow = LcmRowBase & {
  kind: "context-decision";
  action: string;
  occupancy: number;
  tokens: number;
  window: number;
  soft: number;
  commit: number;
  zone?: string;
  committed: boolean;
  /** Present when `tokens` is the estimator's count rather than Pi's: the
   * reported figure described a context other than the one on hand. */
  tokensEstimated?: true;
};

export type ProjectionOverBudgetRow = LcmRowBase & {
  kind: "projection-over-budget";
  nodes: number;
  renderedTokens: number;
  budgetTokens: number;
};

export type SwapAppliedRow = LcmRowBase & {
  kind: "swap-applied";
  summaryId: number;
  cutCount: number;
  distinctBoundary: boolean;
  appliedAtOccupancy: number;
  nodes: number;
  stubbed: number;
  renderedTokens: number;
  budgetTokens: number;
};

/**
 * A swap the policy did not commit. `tokens` is the occupancy that triggered
 * the bail; the kick-backoff writer names the entry it declined to kick instead.
 */
export type SwapBlockedRow = LcmRowBase & {
  kind: "swap-blocked";
  reason: string;
  occupancy: number;
  tokens?: number;
  entryId?: string;
};

export type PiCompactionRow = LcmRowBase & {
  kind: "pi-compaction";
  entryId: string;
  tokens?: number;
  window?: number;
};

/** One calibration sample against Pi's own count: the characters this build
 * counted for the growth of the context, the tokens Pi reported for it, and the
 * ratio the samples now support. A null ratio is the answer "cannot say", which is
 * why the row carries the sample beside it. */
export type EstimateCalibratedRow = LcmRowBase & {
  kind: "estimate-calibrated";
  chars: number;
  tokens: number;
  charsPerToken: number | null;
  samples: number;
};

/** A provider stated the real context window in an overflow error, which is the
 * one window number in this system that is not a belief. */
export type WindowCorrectedRow = LcmRowBase & {
  kind: "window-corrected";
  model: string;
  window: number;
  source: string;
};

/** A refused request proved the window in use was too big without naming the
 * real one: the window for the next turn is floored at what the request carried,
 * and `window` is the stored correction when one exists. */
export type WindowFloorRow = LcmRowBase & {
  kind: "window-floor";
  tokens: number;
  window: number | null;
};

export type ConfigProblemRow = LcmRowBase & {
  kind: "config-problem";
  problems: string[];
};

export type SummaryInputClippedRow = LcmRowBase & {
  kind: "summary-input-clipped";
  entryId: string;
  keptChars: number;
  droppedChars: number;
};

export type SummaryFallbackStoredRow = LcmRowBase & {
  kind: "summary-fallback-stored";
  stage: SummaryStage;
  span: MetricSpan;
  sourceChars: number;
};

export type SummaryStoredRow = LcmRowBase & {
  kind: "summary-stored";
  stage: SummaryStage;
  level: SummaryLevel;
  depth: number;
  tokens: number;
  summaryId: number;
  span: MetricSpan;
};

export type SummarySkippedCoveredRow = LcmRowBase & {
  kind: "summary-skipped-covered";
  stage: SummaryStage;
  span: MetricSpan;
  messages: number;
};

export type SummarySkippedExistingRow = LcmRowBase & {
  kind: "summary-skipped-existing";
  stage: SummaryStage;
  summaryId: number;
  depth: number;
  span: MetricSpan;
  attemptedTokens: number;
  existingTokens: number;
};

export type SummaryOversizedRow = LcmRowBase & {
  kind: "summary-oversized";
  stage: SummaryStage;
  depth: number;
  tokens: number;
  targetTokens: number;
  sourceTokens: number;
  retried: boolean;
  level: SummaryLevel;
  span: MetricSpan;
};

export type SummaryReplacedRow = LcmRowBase & {
  kind: "summary-replaced";
  stage: SummaryStage;
  summaryId: number;
  beforeTokens: number;
  afterTokens: number;
};

export type SummaryFinalTruncatedRow = LcmRowBase & {
  kind: "summary-final-truncated";
  stage: CompactionStage;
  span: MetricSpan;
  beforeTokens: number;
  afterTokens: number;
};

export type CondensationStalledRow = LcmRowBase & {
  kind: "condensation-stalled";
  reason: string;
  nodes: number;
  minDepth: number;
  frontierTokens: number;
  targetTokens: number;
  cap: number;
};

export type CondensationReducedRow = LcmRowBase & {
  kind: "condensation-reduced";
  summaryId: number;
  depth: number;
  level: SummaryLevel;
  beforeTokens: number;
  afterTokens: number;
  targetTokens: number;
  frontierTokens: number;
};

export type CompactionCompleteRow = LcmRowBase & {
  kind: "compaction-complete";
  leaves: number;
  condensed: number;
  ingested: number;
  span: MetricSpan;
};

/** A summarizer call that answered with nothing, or that threw. An empty answer
 * is its own reason, so only a throw needs the category that says why. */
export type SummarizerErrorRow = LcmRowBase & {
  kind: "summarizer-error";
  level: SummaryLevel;
  sourceChars: number;
} & (
    | { reason: "empty-response"; maxTokens: number }
    | { reason: "threw"; error: string; category: SummarizerFailureCategory }
  );

/** A pass that stopped calling the model and finished its span with the
 * mechanical truncate. One row per completer, not per refused call: a refusal
 * never reaches a provider, so it is not a `summarizer-error`, and the forty
 * calls it stands for are one fact. */
export type SummarizerCappedRow = LcmRowBase & {
  kind: "summarizer-capped";
  stage?: SummarizerStage;
  fingerprint: string;
  /** Failed walks this completer paid for before it gave up; 0 when the span
   * was already remembered or the refusal was a budget's. */
  failedWalks: number;
  category: SummarizerFailureCategory;
  source: "pass" | "span-memory" | "budget";
  /** Which budget refused: one request's estimate, or the pass's accumulator. */
  reason?: "call" | "pass";
  spentTokens?: number;
  budgetTokens?: number;
  span: MetricSpan;
};

export type SummarizerFallbackRow = LcmRowBase & {
  kind: "summarizer-fallback";
  attempts: SummarizerAttempt[];
  used: string | null;
};

/** A configured model key that did not resolve, so a substitution is billing. */
export type SummarizerModelRow = LcmRowBase & {
  kind: "summarizer-model";
  requested: string[];
  chain: string[];
  unresolved: string[];
};

/**
 * A compaction failed. The two writers are told apart by stage: the `gc` path
 * has a db path and no session, the hook path has a session and one of the two
 * span handles.
 */
export type CompactionErrorRow = LcmRowBase & { kind: "compaction-error"; error: string } & (
    | { stage: "gc" | "migrate"; db: string }
    | { stage: "blocking" | "async"; entryId?: string; spanEnd?: string }
  );

export type CompactionAwaitedRow = LcmRowBase & {
  kind: "compaction-awaited";
  elapsedMs: number;
  timedOut: boolean;
};

export type CompactionQueuedRow = LcmRowBase & {
  kind: "compaction-queued";
  entryId: string;
  queued: number;
};

export type CompactionQueuedDroppedRow = LcmRowBase & {
  kind: "compaction-queued-dropped";
  entryId: string;
  reason: "store-reset";
};

export type CompactionTimeoutClearedRow = LcmRowBase & {
  kind: "compaction-timeout-cleared";
  elapsedMs: number;
};

/** A pass whose result was computed under conditions the session no longer
 * holds, so the rows it wrote were deleted instead of applied. `changed` is
 * empty when only the model moved. */
export type CompactionStaleRow = LcmRowBase & {
  kind: "compaction-stale";
  reason: "model-changed" | "settings-changed";
  changed: string[];
  stage: SummarizerStage;
  entryId: string;
  span: MetricSpan;
  dropped: number;
};

/** Rows a pass wrote that never became memory: what a dead or stale handle left,
 * reaped by the next run, or dropped at commit because a child they named was
 * gone. The count is the work that has to be done again. */
export type CompactionAbandonedRow = LcmRowBase & {
  kind: "compaction-abandoned";
  stage: SummarizerStage;
  dropped: number;
};

/** Why a pass produced no text. `no-entries` is a span the store holds no message
 * row for, and `covered` is one whose every message is already memory or another
 * live run's. Neither is a failure, so neither is a `compaction-error`. */
export type CompactionNoopReason = "no-entries" | "covered";

/** A pass that stored nothing, with the span it was given. The walk was paid for,
 * so the count is worth keeping even when the outcome is correct. */
export type CompactionNoopRow = LcmRowBase & {
  kind: "compaction-noop";
  stage: SummarizerStage;
  reason: CompactionNoopReason;
  ingested: number;
  span?: MetricSpan;
};

/** A store left behind by an older build, upgraded in place by `/lcm migrate` so
 * cross-session search can read it. Only that command writes one: a search skips
 * a store it cannot read. */
export type StoreMigratedRow = LcmRowBase & {
  kind: "store-migrated";
  db: string;
  fromGeneration: number;
  toGeneration: number;
};

export type GcDeletedRow = LcmRowBase & {
  kind: "gc-deleted";
  db: string;
  reason: string;
  sizeBytes: number;
  exportedTo: string;
};

export type BranchRemovedRow = LcmRowBase & {
  kind: "branch-removed";
  removed: number;
  restored: number;
};

export type FileExternalizedRow = LcmRowBase & {
  kind: "file-externalized";
  entryId: string;
  fileId: string;
  path: string;
  fileKind: string;
  bytes: number;
};

/** A large body with no path behind it, so nothing could be externalized. */
export type LargeInlineRow = LcmRowBase & {
  kind: "large-inline";
  entryId: string;
  chars: number;
};

export type RecallRow = LcmRowBase & {
  kind: "recall";
  tool: "lcm_grep" | "lcm_describe";
  outcome: "hit" | "miss" | "error";
  hits?: number;
  id?: number;
  depth?: number;
  tokens?: number;
  sessionsScanned?: number;
  sessionsSkipped?: number;
};

/** One procedural long-context evaluation run: the
 * seed and size of the generated context, and whether every needle stayed
 * reachable. `fromProjection` is what the surface a model sees already carried,
 * `fromRecall` is what the memory had to recover, and `failed` is the count that
 * has to stay zero. */
export type EvalRow = LcmRowBase & {
  kind: "eval";
  seed: number;
  turns: number;
  needles: number;
  passes: number;
  depth: number;
  fidelity: number;
  fromProjection: number;
  fromRecall: number;
  failed: number;
  surfaceTokens: number;
};

/** One bounded-reader run, with the provider calls it made. `scope` is set when
 * the caller named a source instead of searching for it, and the id it named
 * rides along, so an addressed read can be counted apart from a search without
 * reading the tool's arguments back. */
export type RetrievalRow = LcmRowBase & {
  kind: "retrieval";
  queryChars: number;
  budgetTokens: number;
  steps: number;
  retrievedTokens: number;
  stop: string;
  reason?: string;
  scope?: "summary" | "entry";
  summaryId?: number;
  entryId?: string;
} & Partial<UsageCounters>;

export type ImportRow = MetricBase & { event: "lcm"; kind: "import"; db: string } & (
    | { refused: string }
    | {
        messagesInserted: number;
        messagesSkipped: number;
        summariesInserted: number;
        summariesSkipped: number;
      }
  );

export type LcmMetricRecord =
  | ContextDecisionRow
  | ProjectionOverBudgetRow
  | SwapAppliedRow
  | SwapBlockedRow
  | PiCompactionRow
  | EstimateCalibratedRow
  | WindowCorrectedRow
  | WindowFloorRow
  | ConfigProblemRow
  | SummaryInputClippedRow
  | SummaryFallbackStoredRow
  | SummaryStoredRow
  | SummarySkippedCoveredRow
  | SummarySkippedExistingRow
  | SummaryOversizedRow
  | SummaryReplacedRow
  | SummaryFinalTruncatedRow
  | CondensationStalledRow
  | CondensationReducedRow
  | CompactionCompleteRow
  | SummarizerErrorRow
  | SummarizerCappedRow
  | SummarizerFallbackRow
  | SummarizerModelRow
  | SummarizerUsageRow
  | CompactionErrorRow
  | CompactionAwaitedRow
  | CompactionQueuedRow
  | CompactionQueuedDroppedRow
  | CompactionTimeoutClearedRow
  | CompactionStaleRow
  | CompactionAbandonedRow
  | CompactionNoopRow
  | GcDeletedRow
  | StoreMigratedRow
  | BranchRemovedRow
  | FileExternalizedRow
  | LargeInlineRow
  | RecallRow
  | RetrievalRow
  | EvalRow
  | ImportRow;

export type MetricRecord = UsageRow | LcmMetricRecord;
