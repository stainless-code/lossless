import { renderFrontier, type PlainSummary } from "./assembly.ts";
import { CHARS_PER_TOKEN, estimateTokens } from "./estimate-tokens.ts";
import { filePreviewText } from "./files.ts";
import { ingestEntries, type IngestibleEntry } from "./ingest.ts";
import {
  appendMetric,
  type CompactionNoopReason,
  type CompactionStage,
  type MetricSpan,
  type MetricsSink,
  type SummaryLevel,
  type SummaryStage,
} from "./metrics.ts";
import {
  type PassStore,
  type LcmRole,
  type StoredMessage,
  type SummaryNode,
  type SummaryQuality,
  TRUNCATED_SUMMARY_PREFIX,
  normalizeRole,
} from "./store.ts";
import {
  summarizeTerse,
  summarizeWithEscalation,
  deterministicTruncate,
  LEVEL3_TOKENS,
  type EscalationResult,
  type LlmComplete,
} from "./summarize.ts";
import { isMechanicalToolMessage, normalizeMechanicalTools } from "./util/summarizer-config.ts";

const LEAF_CHUNK_TOKENS = 3000;
/** Deepest condensed node the DAG may grow. With MAX_DAG_FANOUT children this
 * covers 8^8 leaf chunks, so it is a structural assert, not a tuning knob: a
 * pass that cannot meet its budget reports `condensation-stalled` rather than
 * stopping here silently. */
export const MAX_DAG_DEPTH = 8;
export const MAX_DAG_FANOUT = 8;

export interface CompactionSpanEntry {
  entryId: string;
  role: LcmRole;
  text: string;
  payload?: string;
}

export interface CompactionInput {
  span: readonly CompactionSpanEntry[];
  previousSummary?: string;
  targetTokens?: number;
  /** Where the returned summary must reach back to; defaults to the span start. */
  frontierFrom?: string;
  /** Read at compaction time only; ingest stores every message verbatim. */
  mechanicalTools?: readonly string[];
}

export type CompactionOutcome =
  | {
      kind: "stored";
      summaryText: string;
      leafSummaryIds: number[];
      condensedSummaryIds: number[];
      ingested: number;
    }
  /** No text, and why. A span another live run claimed, a span an existing node
   * already covers, and a span the store holds no row for are all states a pass
   * is allowed to find itself in, so the caller decides what to do with the state
   * instead of receiving a throw. A pass in this state stored nothing: every row
   * it writes sits inside the span it renders.
   */
  | {
      kind: "nothing";
      reason: CompactionNoopReason;
      ingested: number;
    };

export async function runCompaction(
  store: PassStore,
  input: CompactionInput,
  llm: LlmComplete,
  opts?: {
    leafChunkTokens?: number;
    maxChunks?: number;
    /** Masks stored text on its way to a model: the summarizer input, every
     * recall view, and the summary this pass stores. It never changes what is
     * written to the messages table. */
    redact?: (text: string) => string;
    /** Session tag for every metric this pass writes; without it a
     * fallback event cannot be attributed to a session. */
    session?: string;
    maxDepth?: number;
    stage?: CompactionStage;
    /** Empty keeps the LLM path. */
    mechanicalTools?: readonly string[];
  },
): Promise<CompactionOutcome> {
  const targetTokens = input.targetTokens ?? 1500;
  const maxDepth = opts?.maxDepth ?? MAX_DAG_DEPTH;
  const leafChunkBudget = opts?.leafChunkTokens ?? LEAF_CHUNK_TOKENS;
  const redact = opts?.redact ?? ((t: string) => t);
  const session = opts?.session;
  const emit = llm.metrics ?? appendMetric;

  const ingestible: IngestibleEntry[] = input.span.map((e) => ({
    entryId: e.entryId,
    role: normalizeRole(e.role),
    text: e.text,
    timestamp: Date.now(),
    ...(e.payload === undefined ? {} : { payload: e.payload }),
  }));
  const ingestStats = ingestEntries(store, ingestible);
  const maxChunkChars = leafChunkBudget * CHARS_PER_TOKEN;

  // array can hand the entries in an order no row range expresses, and an empty
  // pair is a span with nothing stored to summarize.
  const bounds = store.spanBounds(input.span.map((e) => e.entryId));
  if (!bounds) return nothing("no-entries", ingestStats.inserted);
  const span: MetricSpan = [bounds.firstEntryId, bounds.lastEntryId];

  const leafIds: number[] = [];
  const claimedLeaves: PlainSummary[] = [];
  const mechanicalTools = normalizeMechanicalTools([
    ...(input.mechanicalTools ?? []),
    ...(opts?.mechanicalTools ?? []),
  ]);
  const uncoveredAll = store.uncoveredMessagesInSpan(bounds.firstEntryId, bounds.lastEntryId);
  const payloadByEntry = new Map(input.span.map((e) => [e.entryId, e.payload]));
  const mechanicalIds = mechanicalMessageIds(uncoveredAll, mechanicalTools, payloadByEntry);
  const maxChunks = opts?.maxChunks ?? 24;
  // The split below multiplies ranges past the cap (alternating noisy and
  // ordinary messages split one chunk into one range each), so the cap applies
  // again after it: over the cap adjacent ranges merge and share one attempt.
  const chunks = mergeToLimit(
    mergeToLimit(chunkContiguous(uncoveredAll, leafChunkBudget), maxChunks).flatMap((chunk) =>
      splitByMechanical(chunk, mechanicalIds),
    ),
    maxChunks,
  );
  // Same redacted source the ladder would fall back to, stored without a call;
  // provenance keeps rows covered for heal.
  async function storeMechanicalLeaf(
    remaining: StoredMessage[],
    chunkHead: StoredMessage,
    chunkTail: StoredMessage,
  ): Promise<void> {
    const started = Date.now();
    const fileRefs = store.filesForMessages(remaining.map((m) => m.id));
    const fileByMessage = new Map(fileRefs.map((r) => [r.messageId, r]));
    const source = remaining.map((m) => {
      const ref = fileByMessage.get(m.id);
      return { role: m.role, text: ref ? redact(filePreviewText(ref)) : redact(m.text) };
    });
    const sourceChars = source.reduce((n, m) => n + m.text.length, 0);
    const plain = source.map((m) => `[${m.role}]\n${m.text}`).join("\n\n");
    const truncated = deterministicTruncate(plain, LEVEL3_TOKENS);
    const stored = `${TRUNCATED_SUMMARY_PREFIX}\n${redact(truncated)}`;
    const tokens = estimateTokens(stored);
    const claimed = store.uncoveredMessagesInSpan(chunkHead.entryId, chunkTail.entryId);
    const ours =
      claimed.length === remaining.length && claimed.every((m, i) => m.id === remaining[i]?.id);
    if (!ours) {
      remaining.length = 0;
      remaining.push(...claimed);
      if (remaining.length === 0) return;
      if (!remaining.every((m) => mechanicalIds.has(m.id))) return;
      await storeMechanicalLeaf(remaining, remaining[0]!, remaining[remaining.length - 1]!);
      return;
    }
    const inserted = store.insertSummary({
      kind: "leaf",
      text: stored,
      tokens,
      depth: 0,
      quality: "mechanical",
      firstEntryId: chunkHead.entryId,
      lastEntryId: chunkTail.entryId,
      messageIds: remaining.map((m) => m.id),
      fileIds: [...new Set(fileRefs.map((r) => r.fileId))],
    });
    const durationMs = Date.now() - started;
    if (!inserted.created) {
      reportSkippedExisting(
        inserted.id,
        inserted.existingTokens,
        session,
        "leaf",
        0,
        [chunkHead.entryId, chunkTail.entryId],
        tokens,
        durationMs,
        emit,
      );
      if (inserted.foreignLive) {
        claimedLeaves.push({
          id: inserted.id,
          depth: 0,
          firstEntryId: chunkHead.entryId,
          lastEntryId: chunkTail.entryId,
          text: inserted.existingText,
        });
      }
      if (
        inserted.own &&
        replaceIfSmaller(
          store,
          inserted.id,
          inserted.existingTokens,
          stored,
          tokens,
          "mechanical",
          session,
          "leaf",
          started,
          emit,
        )
      ) {
        leafIds.push(inserted.id);
        reportFallbackStored(
          "leaf",
          3,
          session,
          [chunkHead.entryId, chunkTail.entryId],
          sourceChars,
          inserted.id,
          emit,
        );
      }
      return;
    }
    reportFallbackStored(
      "leaf",
      3,
      session,
      [chunkHead.entryId, chunkTail.entryId],
      sourceChars,
      inserted.id,
      emit,
    );
    leafIds.push(inserted.id);
    emit({
      event: "lcm",
      kind: "summary-stored",
      stage: "leaf",
      level: 3,
      quality: "mechanical",
      depth: 0,
      tokens,
      summaryId: inserted.id,
      session,
      span: [chunkHead.entryId, chunkTail.entryId],
      durationMs,
    });
  }
  // Another writer can claim part of a chunk between the snapshot above and the
  // insert below, so the range is re-asked after the model answers and checked
  // with no await before the insert, leaving no gap for another claim.
  async function storeLeaf(rangeHead: string, rangeTail: string): Promise<void> {
    let remaining = store.uncoveredMessagesInSpan(rangeHead, rangeTail);
    let paid = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const chunkHead = remaining[0];
      const chunkTail = remaining[remaining.length - 1];
      if (!chunkHead || !chunkTail) break;
      // A body that has a file handle is represented by the handle and its
      // description: the node names the file instead of summarizing the first
      // slice of it. The message row keeps every character, so nothing is lost
      // and the clip metric stays quiet.
      const refs = store.filesForMessages(remaining.map((m) => m.id));
      const refByMessage = new Map(refs.map((r) => [r.messageId, r]));
      if (
        mechanicalTools.length > 0 &&
        remaining.length > 0 &&
        remaining.every((m) => mechanicalIds.has(m.id))
      ) {
        await storeMechanicalLeaf(remaining, chunkHead, chunkTail);
        return;
      }
      let sourceClipped = false;
      let mixedSkipped = false;
      // A post-split re-cap can join noisy and ordinary runs, so a mixed
      // range keeps full provenance but prompts only ordinary messages.
      // Contiguous spans stay intact for the span index and the frontier.
      // Skipped noisy bodies count as clipped source, so the leaf stays
      // healable and never reads as clean.
      const items = remaining.flatMap((m) => {
        if (mechanicalIds.has(m.id)) {
          mixedSkipped = true;
          return [];
        }
        const ref = refByMessage.get(m.id);
        // The summarizer never reads a stored body unmasked. The mask runs on
        // the whole body rather than on the clipped copy, so a value that
        // straddles the clip point cannot leak as a fragment.
        if (ref) return [{ role: m.role, text: redact(filePreviewText(ref)) }];
        const clipped = clipForSummary(redact(m.text), m.entryId, maxChunkChars);
        if (clipped.droppedChars > 0) {
          sourceClipped = true;
          emit({
            event: "lcm",
            kind: "summary-input-clipped",
            session,
            entryId: m.entryId,
            keptChars: clipped.keptChars,
            droppedChars: clipped.droppedChars,
          });
        }
        return [{ role: m.role, text: clipped.text }];
      });
      const sourceChars = items.reduce((n, m) => n + m.text.length, 0);
      const started = Date.now();
      const answer = await summarizeWithEscalation(items, leafChunkBudget / 2, llm, session);
      const { text, level } = answer;
      paid = true;
      const claimed = store.uncoveredMessagesInSpan(chunkHead.entryId, chunkTail.entryId);
      const ours =
        claimed.length === remaining.length && claimed.every((m, i) => m.id === remaining[i]?.id);
      if (!ours) {
        // Part of the range was claimed while the model ran. One more try on
        // the remainder keeps the text honest about the span it covers; a
        // second collision leaves those messages to whoever claimed them.
        remaining = claimed;
        continue;
      }
      const stored = storedSummaryText(text, level, redact);
      const tokens = estimateTokens(stored);
      const quality = leafQuality(level, sourceClipped || mixedSkipped);
      const inserted = store.insertSummary({
        kind: "leaf",
        text: stored,
        tokens,
        depth: 0,
        quality,
        firstEntryId: chunkHead.entryId,
        lastEntryId: chunkTail.entryId,
        messageIds: remaining.map((m) => m.id),
        fileIds: [...new Set(refs.map((r) => r.fileId))],
        ...(answer.thoroughText === undefined ? {} : { thoroughText: answer.thoroughText }),
      });
      const durationMs = Date.now() - started;
      if (!inserted.created) {
        reportSkippedExisting(
          inserted.id,
          inserted.existingTokens,
          session,
          "leaf",
          0,
          [chunkHead.entryId, chunkTail.entryId],
          tokens,
          durationMs,
          emit,
        );
        if (inserted.foreignLive) {
          claimedLeaves.push({
            id: inserted.id,
            depth: 0,
            firstEntryId: chunkHead.entryId,
            lastEntryId: chunkTail.entryId,
            text: inserted.existingText,
          });
        }
        if (
          inserted.own &&
          replaceIfSmaller(
            store,
            inserted.id,
            inserted.existingTokens,
            stored,
            tokens,
            quality,
            session,
            "leaf",
            started,
            emit,
          )
        ) {
          leafIds.push(inserted.id);
          reportFallbackStored(
            "leaf",
            level,
            session,
            [chunkHead.entryId, chunkTail.entryId],
            sourceChars,
            inserted.id,
            emit,
          );
        }
        return;
      }
      reportFallbackStored(
        "leaf",
        level,
        session,
        [chunkHead.entryId, chunkTail.entryId],
        sourceChars,
        inserted.id,
        emit,
      );
      if (tokens > targetTokens || answer.retried) {
        reportOversize(
          "leaf",
          0,
          tokens,
          leafChunkBudget / 2,
          answer,
          [chunkHead.entryId, chunkTail.entryId],
          session,
          inserted.id,
          emit,
        );
      }
      leafIds.push(inserted.id);
      emit({
        event: "lcm",
        kind: "summary-stored",
        stage: "leaf",
        level,
        quality,
        depth: 0,
        tokens,
        summaryId: inserted.id,
        session,
        span: [chunkHead.entryId, chunkTail.entryId],
        durationMs,
      });
      return;
    }
    if (paid) {
      emit({
        event: "lcm",
        kind: "summary-skipped-covered",
        stage: "leaf",
        session,
        span: [rangeHead, rangeTail],
        messages: remaining.length,
      });
    }
  }
  for (const chunk of chunks) {
    const rangeHead = chunk[0];
    const rangeTail = chunk[chunk.length - 1];
    if (!rangeHead || !rangeTail) continue;
    await storeLeaf(rangeHead.entryId, rangeTail.entryId);
  }

  // A frontier is resolved by rows, and a caller's anchor is a claim about Pi's
  // branch that this store may hold no row for: a session the store first saw
  // after Pi compacted it, or a row retention removed. Every comparison in the
  // query is then null and the answer is no nodes, which leaves a pass that just
  // wrote memory rendering nothing. The span start is always a row, and a render
  // that begins there carries `previousSummary` by the rule below, which is the
  // memory the missing row stood for.
  const from =
    input.frontierFrom && store.hasEntry(input.frontierFrom)
      ? input.frontierFrom
      : bounds.firstEntryId;
  let frontier = store.frontier(from, bounds.lastEntryId);
  const condensedIds: number[] = [];
  let frontierTok = frontierTokens(frontier);
  while (frontier.length >= 2 && frontierTok > targetTokens) {
    const group = condensationGroup(frontier, { maxDepth });
    if (!group) break;
    const groupHead = group[0];
    const groupTail = group[group.length - 1];
    if (!groupHead || !groupTail) break;
    const depth = groupHead.depth + 1;
    const started = Date.now();
    const span: [string, string] = [groupHead.firstEntryId, groupTail.lastEntryId];
    const sourceChars = group.reduce((n, s) => n + s.text.length, 0);
    // No clean source in mechanical-only groups, so truncate without a call;
    // heal repairs leaves first, as with any tainted ancestor.
    const mechanicalGroup = mechanicalTools.length > 0 && group.every((n) => isMechanicalNode(n));
    const answer = mechanicalGroup
      ? null
      : await summarizeWithEscalation(
          group.map((n) => ({ role: "summary", text: n.text })),
          targetTokens,
          llm,
          session,
        );
    const { text, level } =
      answer ??
      (() => {
        const plain = group.map((n) => `[summary]\n${n.text}`).join("\n\n");
        return { text: deterministicTruncate(plain, LEVEL3_TOKENS), level: 3 as const };
      })();
    const stored = storedSummaryText(text, level, redact);
    const tokens = estimateTokens(stored);
    const quality = condensedQuality(level, group);
    const inserted = store.insertSummary({
      kind: "condensed",
      text: stored,
      tokens,
      depth,
      quality,
      firstEntryId: groupHead.firstEntryId,
      lastEntryId: groupTail.lastEntryId,
      childSummaryIds: group.map((n) => n.id),
      // A parent inherits its children's handles, which is how a top-level
      // node answers "which files does this cover" without expanding.
      fileIds: store.fileIdsForSummaries(group.map((n) => n.id)),
      ...(answer?.thoroughText === undefined ? {} : { thoroughText: answer.thoroughText }),
    });
    const durationMs = Date.now() - started;
    if (!inserted.created) {
      // A second pass condensed the same group: the span-unique index
      // discarded this row, which otherwise reads as a fresh insert.
      reportSkippedExisting(
        inserted.id,
        inserted.existingTokens,
        session,
        "condensed",
        depth,
        span,
        tokens,
        durationMs,
        emit,
      );
      if (
        inserted.own &&
        replaceIfSmaller(
          store,
          inserted.id,
          inserted.existingTokens,
          stored,
          tokens,
          quality,
          session,
          "condensed",
          started,
          emit,
        )
      ) {
        condensedIds.push(inserted.id);
        reportFallbackStored("condensed", level, session, span, sourceChars, inserted.id, emit);
      }
      frontier = store.frontier(from, bounds.lastEntryId);
      frontierTok = frontierTokens(frontier);
      continue;
    }
    condensedIds.push(inserted.id);
    reportFallbackStored("condensed", level, session, span, sourceChars, inserted.id, emit);
    if (!mechanicalGroup && answer && (tokens > targetTokens || answer.retried)) {
      reportOversize(
        "condensed",
        depth,
        tokens,
        targetTokens,
        answer,
        span,
        session,
        inserted.id,
        emit,
      );
    }
    emit({
      event: "lcm",
      kind: "summary-stored",
      stage: "condensed",
      level,
      quality,
      depth,
      tokens,
      summaryId: inserted.id,
      session,
      span,
      durationMs,
    });
    frontier = store.frontier(from, bounds.lastEntryId);
    frontierTok = frontierTokens(frontier);
  }

  // The loop is out of legal groups: a node covering the whole span has no
  // sibling to pair with, so the only way back under budget without growing the
  // DAG is to make that node smaller. Its text is already a summary, and any
  // overshoot counts, which is the same twice-the-target bar the final render
  // clips at, so the reduction hits exactly the nodes that would be cut.
  const lone = frontier.length === 1 ? frontier[0] : undefined;
  // A lone mechanical node under an opted-in list already stores the
  // truncate, so skip the re-summarize call.
  const loneMechanical = lone !== undefined && mechanicalTools.length > 0 && isMechanicalNode(lone);
  if (lone && frontierTok > targetTokens * 2 && !loneMechanical) {
    const beforeTokens = lone.tokens;
    const started = Date.now();
    const answer = await summarizeTerse(
      [{ role: "summary", text: lone.text }],
      targetTokens,
      llm,
      session,
    );
    const stored = storedSummaryText(answer.text, answer.level, redact);
    const tokens = estimateTokens(stored);
    const quality = reducedQuality(answer.level, lone.quality);
    if (
      replaceIfSmaller(
        store,
        lone.id,
        beforeTokens,
        stored,
        tokens,
        quality,
        session,
        lone.kind,
        started,
        emit,
      )
    ) {
      reportFallbackStored(
        lone.kind,
        answer.level,
        session,
        [lone.firstEntryId, lone.lastEntryId],
        lone.text.length,
        lone.id,
        emit,
      );
      emit({
        event: "lcm",
        kind: "condensation-reduced",
        session,
        summaryId: lone.id,
        depth: lone.depth,
        level: answer.level,
        beforeTokens,
        afterTokens: tokens,
        targetTokens,
        frontierTokens: frontierTok,
      });
      frontier = store.frontier(from, bounds.lastEntryId);
      frontierTok = frontierTokens(frontier);
    }
  }

  // The loop ends without meeting the budget exactly when no legal group is
  // left: one node covers the span, or no two adjacent nodes share a depth
  // (or none may grow past the cap). Silence here is indistinguishable from
  // "the frontier fits", so the stall records its reason.
  if (frontier.length > 0 && frontierTok > targetTokens) {
    emit({
      event: "lcm",
      kind: "condensation-stalled",
      reason: stallReason(frontier),
      session,
      nodes: frontier.length,
      minDepth: Math.min(...frontier.map((n) => n.depth)),
      frontierTokens: frontierTok,
      targetTokens,
      cap: maxDepth,
    });
  }

  // A span another live run claimed is not this run's to store, so it is not in
  // this run's frontier either, and the text that run wrote stands in for it.
  const rendered = frontier.length > 0 ? frontier : claimedLeaves;
  if (rendered.length === 0) {
    // for, so a pass that stored anything renders something: nothing to render
    // means the span's messages were already memory.
    return nothing("covered", ingestStats.inserted);
  }
  let finalText = renderFrontier(rendered);
  // A frontier that starts at the span start represents nothing older;
  // whatever Pi summarized before this span lives only in previousSummary.
  if (input.previousSummary && rendered[0]?.firstEntryId === bounds.firstEntryId) {
    finalText = `${input.previousSummary}\n\n${finalText}`;
  }
  if (estimateTokens(finalText) > targetTokens * 2) {
    const beforeTokens = estimateTokens(finalText);
    finalText = deterministicTruncate(finalText, targetTokens);
    // The blocking and async regimes hand this text to the model as the
    // whole memory of the span, so a clip here is a silent quality loss.
    emit({
      event: "lcm",
      kind: "summary-final-truncated",
      stage: opts?.stage ?? "direct",
      session,
      span,
      beforeTokens,
      afterTokens: estimateTokens(finalText),
    });
  }

  emit({
    event: "lcm",
    kind: "compaction-complete",
    session,
    leaves: leafIds.length,
    condensed: condensedIds.length,
    ingested: ingestStats.inserted,
    span,
  });

  return {
    kind: "stored",
    summaryText: finalText,
    leafSummaryIds: leafIds,
    condensedSummaryIds: condensedIds,
    ingested: ingestStats.inserted,
  };
}

function reportOversize(
  stage: "leaf" | "condensed",
  depth: number,
  tokens: number,
  targetTokens: number,
  answer: EscalationResult,
  span: [string, string],
  session: string | undefined,
  summaryId: number,
  emit: MetricsSink,
): void {
  emit({
    event: "lcm",
    kind: "summary-oversized",
    stage,
    depth,
    session,
    tokens,
    targetTokens,
    sourceTokens: answer.sourceTokens,
    retried: answer.retried,
    level: answer.level,
    span,
    summaryId,
  });
}

/** A discarded attempt much smaller than the stored row wins the span, unless
 * that row has a parent: a parent's text was derived from its children, so
 * rewriting a child under it leaves the parent describing text that is gone.
 * The displaced text is kept as the node's rich tier when there is none. */
const REPLACE_MARGIN = 0.75;
function replaceIfSmaller(
  store: PassStore,
  id: number,
  existingTokens: number,
  text: string,
  tokens: number,
  quality: SummaryQuality,
  session: string | undefined,
  stage: "leaf" | "condensed",
  started: number,
  emit: MetricsSink,
): boolean {
  if (existingTokens <= 0 || tokens > existingTokens * REPLACE_MARGIN) return false;
  if (store.parentSummaryIds(id).length > 0) return false;
  const displaced = store.getSummary(id);
  // A clean node is the best memory this span has, and a mechanical answer is
  // worse than every other verdict. Neither can displace a better row.
  if (displaced?.quality === "clean" && quality !== "clean") return false;
  if (displaced !== undefined && displaced.quality !== "mechanical" && quality === "mechanical") {
    return false;
  }
  store.updateSummaryText(id, text, tokens, quality);
  if (displaced !== undefined && displaced.thoroughText === undefined) {
    store.setThoroughText(id, displaced.text);
  }
  emit({
    event: "lcm",
    kind: "summary-replaced",
    stage,
    session,
    summaryId: id,
    beforeTokens: existingTokens,
    afterTokens: tokens,
    ...(displaced === undefined ? {} : { qualityBefore: displaced.quality }),
    qualityAfter: quality,
    durationMs: Date.now() - started,
  });
  return true;
}

/** A leaf that omitted listed noisy bodies is clipped, like a length clip:
 * the model did not see the full source, but heal reads the full rows. */
function leafQuality(level: SummaryLevel, sourceClipped: boolean): SummaryQuality {
  if (level === 3) return "mechanical";
  return sourceClipped ? "clipped" : "clean";
}

function condensedQuality(level: SummaryLevel, children: readonly SummaryNode[]): SummaryQuality {
  if (level === 3) return "mechanical";
  return children.some((child) => !isClean(child)) ? "derived" : "clean";
}

function reducedQuality(level: SummaryLevel, previous: SummaryQuality): SummaryQuality {
  if (level === 3) return "mechanical";
  return previous === "clean" ? "clean" : "derived";
}

/** A row can be clean by verdict and still carry the mechanical prefix when it
 * was imported or written before quality existed; compaction treats that as a
 * non-clean child. */
function isClean(node: SummaryNode): boolean {
  return node.quality === "clean" && !node.text.startsWith(TRUNCATED_SUMMARY_PREFIX);
}

function storedSummaryText(
  text: string,
  level: SummaryLevel,
  redact: (t: string) => string,
): string {
  return level === 3 ? `${TRUNCATED_SUMMARY_PREFIX}\n${redact(text)}` : redact(text);
}

function reportFallbackStored(
  stage: SummaryStage,
  level: SummaryLevel,
  session: string | undefined,
  span: MetricSpan,
  sourceChars: number,
  summaryId: number,
  emit: MetricsSink,
): void {
  if (level !== 3) return;
  emit({
    event: "lcm",
    kind: "summary-fallback-stored",
    stage,
    session,
    span,
    sourceChars,
    summaryId,
  });
}

function reportSkippedExisting(
  id: number,
  existingTokens: number,
  session: string | undefined,
  stage: "leaf" | "condensed",
  depth: number,
  span: [string, string],
  attemptedTokens: number,
  durationMs: number,
  emit: MetricsSink,
): void {
  emit({
    event: "lcm",
    kind: "summary-skipped-existing",
    stage,
    session,
    summaryId: id,
    depth,
    span,
    attemptedTokens,
    existingTokens,
    durationMs,
  });
}

function nothing(reason: CompactionNoopReason, ingested: number): CompactionOutcome {
  return { kind: "nothing", reason, ingested };
}

function clipForSummary(
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

function chunkContiguous(messages: readonly StoredMessage[], budget: number): StoredMessage[][] {
  const chunks: StoredMessage[][] = [];
  let current: StoredMessage[] = [];
  let currentTokens = 0;
  let previousId = Number.NaN;
  for (const m of messages) {
    const t = estimateTokens(m.text);
    const adjacent = m.id === previousId + 1;
    if (current.length > 0 && (!adjacent || currentTokens + t > budget)) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(m);
    currentTokens += t;
    previousId = m.id;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function mergeToLimit<T>(chunks: T[][], maxChunks: number): T[][] {
  if (chunks.length <= maxChunks) return chunks;
  const per = Math.ceil(chunks.length / maxChunks);
  const merged: T[][] = [];
  for (let i = 0; i < chunks.length; i += per) merged.push(chunks.slice(i, i + per).flat());
  return merged;
}

function frontierTokens(frontier: readonly SummaryNode[]): number {
  return estimateTokens(renderFrontier(frontier));
}

/** The next group to condense: the oldest run of adjacent same-depth nodes, at
 * the shallowest depth with a run of two or more, capped at MAX_DAG_FANOUT.
 * Shallowest first keeps the tree balanced and the depth cap unreachable, since
 * a parent mixing depths grows the frontier instead of shrinking it. */
export function condensationGroup(
  frontier: readonly SummaryNode[],
  opts?: { maxDepth?: number },
): SummaryNode[] | undefined {
  const maxDepth = opts?.maxDepth ?? MAX_DAG_DEPTH;
  let best: SummaryNode[] | undefined;
  for (const run of adjacentRuns(frontier)) {
    if (run.length < 2) continue;
    const head = run[0];
    if (!head) continue;
    // The cap filters candidates; it never ends the pass by itself.
    if (head.depth + 1 > maxDepth) continue;
    if (!best || head.depth < (best[0]?.depth ?? Number.POSITIVE_INFINITY)) best = run;
  }
  return best?.slice(0, MAX_DAG_FANOUT);
}

function stallReason(frontier: readonly SummaryNode[]): "depth-cap" | "no-same-depth-run" {
  return condensationGroup(frontier, { maxDepth: Number.POSITIVE_INFINITY })
    ? "depth-cap"
    : "no-same-depth-run";
}

function adjacentRuns(frontier: readonly SummaryNode[]): SummaryNode[][] {
  const runs: SummaryNode[][] = [];
  for (const node of frontier) {
    const current = runs[runs.length - 1];
    if (current && current[0]?.depth === node.depth) current.push(node);
    else runs.push([node]);
  }
  return runs;
}

/** Mechanical by verdict, or by the stored truncate marker old rows keep. */
function isMechanicalNode(node: SummaryNode): boolean {
  return node.quality === "mechanical" || node.text.startsWith(TRUNCATED_SUMMARY_PREFIX);
}

/** A direct tool-name hit, or a toolResult right after a listed call, which is
 * how Pi stores a result whose own text names no tool. Row order keeps a
 * covered call marking its uncovered result. */
function mechanicalMessageIds(
  messages: readonly StoredMessage[],
  tools: readonly string[],
  payloadByEntry?: ReadonlyMap<string, string | undefined>,
): Set<number> {
  const ids = new Set<number>();
  if (tools.length === 0) return ids;
  let prevDirectListed = false;
  for (const m of messages) {
    const payload = payloadByEntry?.get(m.entryId) ?? m.payload;
    const direct = isMechanicalToolMessage({ text: m.text, payload, role: m.role }, tools);
    if (direct) {
      ids.add(m.id);
      prevDirectListed = true;
      continue;
    }
    if (m.role === "toolResult" && prevDirectListed) {
      ids.add(m.id);
      prevDirectListed = false;
      continue;
    }
    prevDirectListed = false;
  }
  return ids;
}

/** Split a chunk so a noisy result isolates from the prose around it. */
function splitByMechanical(
  chunk: StoredMessage[],
  mechanicalIds: ReadonlySet<number>,
): StoredMessage[][] {
  if (chunk.length === 0 || mechanicalIds.size === 0) return chunk.length === 0 ? [] : [chunk];
  const runs: StoredMessage[][] = [];
  let current: StoredMessage[] = [];
  let currentFlag: boolean | undefined;
  for (const m of chunk) {
    const flag = mechanicalIds.has(m.id);
    if (current.length === 0) {
      current = [m];
      currentFlag = flag;
    } else if (flag === currentFlag) {
      current.push(m);
    } else {
      runs.push(current);
      current = [m];
      currentFlag = flag;
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}
