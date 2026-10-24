import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CommandId } from "@deepseek-ai/dsh-commands/brand";
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from "@deepseek-ai/dsh-compaction";
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { TokenMeasurement, TokenMeter, TokenSurfaceNode } from "@deepseek-ai/dsh-token-meter";
import { selectCompactableRange, type CompactionSpanEntry } from "lossless-core";

import type { LadderOutcome, LosslessEngineDeps } from "./ladder.ts";
import { resolveSummarizationTarget, runLadder, withSummaryRefs } from "./ladder.ts";
import type { DshRoute } from "./model-host.ts";

/** Deps for the DAG bracket: the ladder deps, the composition the ladder
 * runs inside, and the summarization fallback the target resolves from. The
 * token meter is read off the composition, which the host harness provides;
 * the import is type-only, so the runtime boundary stays honest. */
export interface DagCommitDeps extends LosslessEngineDeps {
  readonly ctx: Context;
  /** Empty means unset: resolution falls through to the routed request, then
   * the agent options, exactly like the seam. */
  readonly summarizationProvider: string;
  readonly summarizationModel: string;
}

/** Inclusive surface-node span to condense, mirroring the seam's start/end. */
export interface DagCommitSelection {
  readonly start: SessionSeq;
  readonly end: SessionSeq;
}

export interface DagCommitOptions {
  /** Null compacts an idle session (manual taxonomy); any other value
   * requires an open turn and reports that turn as the lifecycle owner. */
  readonly owner: string | null;
  readonly stability: "whole-surface" | "selected-span";
  readonly sourceCommandId?: CommandId;
  readonly flush?: () => Promise<void>;
}

/** Bracket result: the seam's CompactionResult fields plus the DAG node
 * records. The singular summary fields name the condensed metering record
 * (the event directly before the checkpoint); summarySeqs lists it first,
 * then one log-only record per stored leaf. The seam shape is kept so the
 * engine override and the /lcm command read this result unchanged. */
export interface DagCommitResult {
  readonly compactionId: CompactionId;
  readonly sourceCommandId?: CommandId;
  readonly startSeq: SessionSeq;
  readonly summarySeq: SessionSeq;
  readonly endSeq: SessionSeq;
  readonly summary: ContentBlock[];
  readonly shadowedRange: { readonly start: SessionSeq; readonly end: SessionSeq };
  readonly shadowedSeqs: SessionSeq[];
  readonly shadowedTokenCount: number;
  /** Condensed record first, then one log-only record per stored leaf. */
  readonly summarySeqs: readonly SessionSeq[];
  readonly leafSeqs: readonly SessionSeq[];
}

/** Stability failure inside the bracket: the span moved under the ladder.
 * Plays the seam's internal SurfaceChangedError role in the taxonomy. */
export class DagStabilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DagStabilityError";
  }
}

/** Checkpoint framing copied from the seam so a DAG checkpoint reads like
 * one: dsh-compaction-basic@0.1.7-alpha.2 lib/index.js:234-235, 280. */
const DAG_SUMMARY_OPEN_TAG = "<compacted-summary>";
const DAG_SUMMARY_CLOSE_TAG = "</compacted-summary>";
const DAG_CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

type StartEvent = Extract<SessionEvent, { type: "compaction/start" }>;

interface DagValidated {
  readonly start: SessionSeq;
  readonly end: SessionSeq;
  readonly startIdx: number;
  readonly endIdx: number;
  readonly shadowedSeqs: SessionSeq[];
}

interface DagPrepared extends DagValidated {
  readonly sessionId: string;
  readonly target: DshRoute;
  readonly measurement: TokenMeasurement;
  readonly selectedNodes: TokenSurfaceNode[];
  readonly shadowedTokenCount: number;
  readonly shadowedRouteTokenCount: number;
  readonly span: CompactionSpanEntry[];
}

type DagStage = "summary" | "commit";

/** One custom compaction transaction: the seam's bracket (lock check, open,
 * stability, shrink check, commit, close, failure taxonomy) with the
 * lossless ladder as the summarizer and one log-only summary record per
 * stored DAG node. Structure mirrors compactSurfaceRegion line for line
 * (dsh-compaction-basic@0.1.7-alpha.2 lib/index.js:449-521); the two
 * deliberate divergences are marked B1 below. */
export async function commitDagTransaction(
  deps: DagCommitDeps,
  agent: Agent,
  selection: DagCommitSelection,
  options: DagCommitOptions,
  signal?: AbortSignal,
): Promise<DagCommitResult> {
  const session = agent.session;
  if (options.owner === null) signal?.throwIfAborted();
  const validated = validateDagRegion(session, selection.start, selection.end);
  const entryState = inspectDagEntryState(session);
  assertDagInactive(entryState.unmatchedStart, entryState.latestEndSeedSeq, "compaction");
  let owner: number | null;
  if (options.owner === null) {
    if (entryState.openTurn !== null) {
      throw new ManualCompactionError(
        "busy",
        "manual compaction: the session already has an open turn",
      );
    }
    owner = null;
  } else {
    if (entryState.openTurn === null) {
      throw new Error(
        "compactRegion: no open turn — automatic compaction events must be enclosed in a turn",
      );
    }
    owner = entryState.openTurn;
  }
  const compactionId = CompactionId(randomUUID());
  const lifecycle = {
    compactionId,
    ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
    turn: owner,
  };
  const startEvent = session.append("compaction/start", lifecycle);
  const assertStable =
    options.stability === "whole-surface" ? assertWholeSurfaceUnchanged : assertSelectedSpanStable;
  let failure: { error: unknown; stage: DagStage } | undefined;
  let flushFailure: unknown;
  let result: DagCommitResult | undefined;
  let closed = false;
  let closing = false;
  let stage: DagStage = "summary";
  try {
    const prepared = prepareDagCommit(deps, agent, session, validated);
    signal?.throwIfAborted();
    // B1 runs one ladder attempt. The seam retries through its recover hook
    // with a reprepared span; that loop is an auto-path production concern
    // and arrives with the production wiring, not the spike.
    const ladder = await runLadder(
      deps.ctx,
      deps,
      prepared.target,
      prepared.sessionId,
      prepared.span,
      signal,
    );
    const condensed = frameCondensed(deps, prepared, ladder, compactionId, options.sourceCommandId);
    if (options.owner === null) signal?.throwIfAborted();
    assertStable(deps.ctx.tokenMeter, session, prepared);
    stage = "commit";
    const pending = commitDagBody(session, startEvent, prepared, ladder, condensed);
    closing = true;
    const endEvent = session.append("compaction/end", lifecycle);
    closed = true;
    result = { ...pending, endSeq: endEvent.seq };
  } catch (error) {
    failure = { error, stage: closing ? "commit" : stage };
    if (!closing) {
      closing = true;
      try {
        session.append("compaction/end", { ...lifecycle, error: errorChain(error) });
        closed = true;
      } catch (closeError) {
        failure = { error: closeError, stage: "commit" };
      }
    }
  }
  if (closed && options.flush !== undefined) {
    try {
      await options.flush();
    } catch (error) {
      flushFailure = error;
    }
  }
  if (options.owner === null) signal?.throwIfAborted();
  if (failure !== undefined) {
    if (options.owner === null) throwDagFailure(failure);
    throw failure.error;
  }
  if (flushFailure !== undefined) {
    throw new ManualCompactionError(
      "persistence",
      "manual compaction durability checkpoint failed",
      {
        cause: flushFailure,
      },
    );
  }
  if (result === undefined) throw new Error("compaction committed without a result");
  // One row per bracket commit: the condensed record first, then the leaf
  // records, so the checkpoint shape stays countable in the metrics log.
  deps.record?.({
    ts: Date.now(),
    event: "lcm",
    kind: "compaction-checkpoint",
    session: String(agent.session.id),
    summarySeqs: [...result.summarySeqs],
    leafSeqs: [...result.leafSeqs],
  });
  return result;
}

/** Classify one closed manual attempt without weakening cancellation
 * precedence. Mirrors throwManualFailure (lib/index.js:523-528). */
function throwDagFailure(failure: { error: unknown; stage: DagStage }): never {
  if (failure.stage === "commit") {
    throw new ManualCompactionError("commit", "manual compaction did not commit cleanly", {
      cause: failure.error,
    });
  }
  if (failure.error instanceof DagStabilityError) {
    throw new ManualCompactionError(
      "changed",
      "the compacted history changed during manual compaction",
      {
        cause: failure.error,
      },
    );
  }
  throw new ManualCompactionError(
    "summary",
    "manual compaction could not produce a smaller summary",
    {
      cause: failure.error,
    },
  );
}

/** Reject a durable unmatched compaction marker unless a later
 * constructor-seed boundary proves its owner belongs to an earlier session
 * lifecycle. Mirrors assertCompactionInactive (lib/index.js:535-542). */
function assertDagInactive(
  unmatchedStart: StartEvent | undefined,
  latestEndSeedSeq: SessionSeq | undefined,
  stage: string,
): void {
  if (unmatchedStart === undefined) return;
  if (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedStart.seq) return;
  throw new ManualCompactionError(
    "busy",
    `${stage}: compaction already in progress; the session compaction lock is already active`,
  );
}

/** Resolve the next range starting at the first non-system surface node
 * while retaining a priced recent tail and never splitting an assistant
 * tool-call/result pair. The index math lives in the core seam's
 * selectCompactableRange (which mirrors the host seam at
 * lib/index.js:409-448); this wrapper keeps the fail-closed surface check
 * and the system-head offset. */
export function selectDagRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
): DagCommitSelection | null {
  const pricedNodes = measurement.nodes;
  const surfaceNodes = session.surface.nodes;
  if (
    surfaceNodes.length !== pricedNodes.length ||
    surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)
  ) {
    throw new Error(
      "lossless dag commit: token-meter surface does not match the current session surface",
    );
  }
  const head = surfaceNodes[0];
  if (head === undefined) return null;
  // A system/message at surface node 0 is the retained head, never inside
  // the range; without one the range starts at node 0.
  const firstIdx = dagSystemHead(session, head) === undefined ? 0 : 1;
  return selectCompactableRange(
    surfaceNodes.map((seq, index) => ({ seq, tokens: pricedNodes[index]?.tokens ?? 0 })),
    firstIdx,
    retainTokens,
    (seq) => toolPairingBalancedBefore(session, seq),
  );
}

function dagSystemHead(session: Session, headSeq: SessionSeq) {
  const head = session.eventAt(headSeq);
  return head?.type === "system/message" ? head : undefined;
}

/** Validate one requested surface-position span before the bracket opens.
 * Mirrors validateSurfaceRegion (lib/index.js:549-565). */
function validateDagRegion(session: Session, start: SessionSeq, end: SessionSeq): DagValidated {
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  const startNode = nodes[startIdx];
  const endNode = nodes[endIdx];
  if (startNode === undefined)
    throw new Error(`dag commit: start seq ${start} not found in surface`);
  if (endNode === undefined) throw new Error(`dag commit: end seq ${end} not found in surface`);
  if (startIdx > endIdx) {
    throw new Error(
      `dag commit: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    );
  }
  if (!toolPairingBalancedBefore(session, startNode)) {
    throw new Error(
      `dag commit: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`,
    );
  }
  if (!toolPairingBalancedAfter(session, endNode)) {
    throw new Error(
      `dag commit: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`,
    );
  }
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) };
}

/** Snapshot pricing, resolve the summarization target, and map the span
 * through the sidecar entry ids. Mirrors prepareCompaction
 * (lib/index.js:567-579); the span mapping follows the seam's spanOf through
 * entry ids the mirror records, never through text matching. */
function prepareDagCommit(
  deps: DagCommitDeps,
  agent: Agent,
  session: Session,
  validated: DagValidated,
): DagPrepared {
  const meter = deps.ctx.tokenMeter;
  const measurement = meter.measure(session);
  const selectedNodes = measurement.nodes.slice(validated.startIdx, validated.endIdx + 1);
  if (
    selectedNodes.length !== validated.shadowedSeqs.length ||
    selectedNodes.some((node, index) => node.seq !== validated.shadowedSeqs[index])
  ) {
    throw new DagStabilityError(
      "lossless dag commit: selected surface changed before summarization began",
    );
  }
  const sessionId = String(session.id);
  const target = resolveSummarizationTarget(
    {
      summarizationProvider: deps.summarizationProvider,
      summarizationModel: deps.summarizationModel,
    },
    agent,
  );
  if (!target) {
    throw new Error(
      "lossless compaction: no provider/model available for summarization: set both engine summarization fields, route one request, or set both agent options fields",
    );
  }
  const store = deps.store(sessionId);
  if (!store) throw new Error(`lossless compaction: no sidecar store for session ${sessionId}`);
  const rowsByEntry = new Map(store.allMessages().map((row) => [row.entryId, row]));
  // Core reads a span as a storage range, so frontierFrom must name the
  // storage minimum. Surface order diverges from storage order after a
  // replace (the checkpoint row is newest), so order by rowid here.
  const items: Array<{ rowId: number; entry: CompactionSpanEntry }> = [];
  for (const seq of validated.shadowedSeqs) {
    // Entry ids mirror the ingest projection (ingest.ts projectedEntry), so
    // the seq maps to its row without touching the live message index.
    const entryId = `${session.id}:${seq}`;
    const row = rowsByEntry.get(entryId);
    if (!row) throw new Error(`lossless dag commit: sidecar holds no row for ${entryId}`);
    items.push({ rowId: row.id, entry: { entryId, role: row.role, text: row.text } });
  }
  items.sort((a, b) => a.rowId - b.rowId);
  return {
    ...validated,
    sessionId,
    target,
    measurement,
    selectedNodes: [...selectedNodes],
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    span: items.map((item) => item.entry),
  };
}

interface CondensedCommit {
  readonly checkpointMessage: ReturnType<typeof createUserMessage>;
  readonly leafTexts: readonly string[];
  readonly condensedBlocks: ContentBlock[];
}

/** Frame the condensed checkpoint, resolve every stored leaf text, and run
 * the shrink check. Mirrors the framing half of summarizeCompaction
 * (lib/index.js:581-606). */
function frameCondensed(
  deps: DagCommitDeps,
  prepared: DagPrepared,
  ladder: LadderOutcome,
  compactionId: ReturnType<typeof CompactionId>,
  sourceCommandId: CommandId | undefined,
): CondensedCommit {
  const condensedText = withSummaryRefs(ladder.summaryText, [
    ...ladder.leafSummaryIds,
    ...ladder.condensedSummaryIds,
  ]);
  deps.memory?.note(prepared.sessionId, condensedText);
  const store = deps.store(prepared.sessionId);
  const leafTexts = ladder.leafSummaryIds.map((id) => {
    const text = store?.getSummary(id)?.text;
    if (text === undefined) throw new Error(`lossless dag commit: sidecar holds no summary #${id}`);
    return text;
  });
  const condensedBlocks: ContentBlock[] = [{ type: "text", text: condensedText }];
  const checkpointMessage = createUserMessage({
    content: [
      { type: "text", text: `${DAG_CHECKPOINT_PREAMBLE}\n\n${DAG_SUMMARY_OPEN_TAG}` },
      { type: "text", text: condensedText },
      { type: "text", text: DAG_SUMMARY_CLOSE_TAG },
    ],
    source: compactCheckpointSource(compactionId, sourceCommandId),
  });
  const framedSummaryTokenCount = deps.ctx.tokenMeter.estimateMessage(checkpointMessage);
  if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) {
    throw new Error(
      `summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`,
    );
  }
  return { checkpointMessage, leafTexts, condensedBlocks };
}

/** Append the condensed summary record, one log-only record per stored
 * leaf, and the replacement body without yielding. The leaf records come
 * first so the condensed metering event sits directly before the checkpoint,
 * preserving the seam's shadow-price adjacency contract
 * (lib/index.js:627-675 and the compaction/summary doc at types/types.d.ts).
 * B1 is the second deliberate divergence: the seam commits one summary
 * record; the bracket commits the stored leaves alongside it. */
function commitDagBody(
  session: Session,
  startEvent: StartEvent,
  prepared: DagPrepared,
  ladder: LadderOutcome,
  condensed: CondensedCommit,
): Omit<DagCommitResult, "endSeq"> {
  const compactionId = startEvent.data.compactionId;
  const sourceCommandId =
    startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId };
  const leafEvents = condensed.leafTexts.map((text) =>
    session.append("compaction/summary", {
      compactionId,
      ...sourceCommandId,
      summary: [{ type: "text", text }],
      shadowedRange: { start: prepared.start, end: prepared.end },
      shadowedSeqs: [...prepared.shadowedSeqs],
      shadowedTokenCount: prepared.shadowedTokenCount,
      provider: ladder.provider,
      model: ladder.model,
    }),
  );
  const summaryEvent = session.append("compaction/summary", {
    compactionId,
    ...sourceCommandId,
    summary: condensed.condensedBlocks,
    rawOutput: condensed.condensedBlocks,
    shadowedRange: { start: prepared.start, end: prepared.end },
    shadowedSeqs: [...prepared.shadowedSeqs],
    shadowedTokenCount: prepared.shadowedTokenCount,
    provider: ladder.provider,
    model: ladder.model,
    ...(ladder.usage === undefined ? {} : { usage: ladder.usage }),
  });
  session.append("user/message", condensed.checkpointMessage, {
    surfaceOp: { op: "replace", startSeq: prepared.start, endSeq: prepared.end },
    sourceEventSeqs: [
      startEvent.seq,
      summaryEvent.seq,
      ...leafEvents.map((event) => event.seq),
      ...prepared.shadowedSeqs,
    ],
  });
  const leafSeqs = leafEvents.map((event) => event.seq);
  return {
    compactionId,
    ...sourceCommandId,
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary: condensed.condensedBlocks,
    shadowedRange: { start: prepared.start, end: prepared.end },
    shadowedSeqs: [...prepared.shadowedSeqs],
    shadowedTokenCount: prepared.shadowedTokenCount,
    summarySeqs: [summaryEvent.seq, ...leafSeqs],
    leafSeqs,
  };
}

/** Reject a summary prepared against any earlier surface generation.
 * Mirrors assertWholeSurfaceUnchanged (lib/index.js:608-610). */
function assertWholeSurfaceUnchanged(
  meter: TokenMeter,
  session: Session,
  prepared: DagPrepared,
): void {
  if (!isDeepStrictEqual(meter.measure(session).nodes, prepared.measurement.nodes)) {
    throw new DagStabilityError(
      "lossless dag commit: session surface changed during summarization",
    );
  }
}

/** Require only that the selected span remain the same present, contiguous,
 * equally priced, balanced replacement target. Mirrors
 * assertSelectedSpanStable (lib/index.js:616-626). */
function assertSelectedSpanStable(
  meter: TokenMeter,
  session: Session,
  prepared: DagPrepared,
): void {
  let current: DagValidated;
  try {
    current = validateDagRegion(session, prepared.start, prepared.end);
  } catch (error) {
    throw new DagStabilityError(
      "lossless dag commit: the selected span is no longer a valid replacement target",
      { cause: error },
    );
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) {
    throw new DagStabilityError(
      "lossless dag commit: the selected span changed during summarization",
    );
  }
  if (
    !isDeepStrictEqual(
      meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1),
      prepared.selectedNodes,
    )
  ) {
    throw new DagStabilityError(
      "lossless dag commit: the selected span was rewritten during summarization",
    );
  }
}

/** Latest bracket and turn state walking the log tailward. Mirrors
 * inspectCompactionEntryState (lib/index.js:705-741). */
function inspectDagEntryState(session: Session): {
  readonly openTurn: number | null;
  readonly unmatchedStart: StartEvent | undefined;
  readonly latestEndSeedSeq: SessionSeq | undefined;
} {
  let openTurn: number | null = null;
  let openTurnStateKnown = false;
  let unmatchedStart: StartEvent | undefined;
  let startKnown = false;
  let latestEndSeedSeq: SessionSeq | undefined;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined)
      throw new Error(`lossless dag commit: session log has no event at seq ${seq}`);
    if (latestEndSeedSeq === undefined && event.type === "session/end-seed") {
      latestEndSeedSeq = event.seq;
    }
    if (!startKnown) {
      if (event.type === "compaction/start") {
        unmatchedStart = event;
        startKnown = true;
      } else if (event.type === "compaction/end") {
        startKnown = true;
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === "turn/start") {
        openTurn = event.data.turn;
        openTurnStateKnown = true;
      } else if (event.type === "turn/end") {
        openTurnStateKnown = true;
      }
    }
    if (openTurnStateKnown && startKnown && latestEndSeedSeq !== undefined) break;
  }
  return { openTurn, unmatchedStart, latestEndSeedSeq };
}
