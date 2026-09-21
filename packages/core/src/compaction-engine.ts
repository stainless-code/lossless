import { renderFrontier, type PlainSummary } from "./assembly.ts";
import { CHARS_PER_TOKEN, estimateTokens } from "./estimate-tokens.ts";
import { filePreviewText } from "./files.ts";
import { ingestEntries, type IngestibleEntry } from "./ingest.ts";
import {
  appendMetric,
  type CompactionNoopReason,
  type MetricSpan,
  type SummaryLevel,
  type SummaryStage,
} from "./metrics.ts";
import {
  type PassStore,
  type LcmRole,
  type StoredMessage,
  type SummaryNode,
  normalizeRole,
} from "./store.ts";
import {
  summarizeTerse,
  summarizeWithEscalation,
  deterministicTruncate,
  type EscalationResult,
  type LlmComplete,
} from "./summarize.ts";

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
    stage?: "blocking" | "async" | "direct";
  },
): Promise<CompactionOutcome> {
  const targetTokens = input.targetTokens ?? 1500;
  const maxDepth = opts?.maxDepth ?? MAX_DAG_DEPTH;
  const leafChunkBudget = opts?.leafChunkTokens ?? LEAF_CHUNK_TOKENS;
  const redact = opts?.redact ?? ((t: string) => t);
  const session = opts?.session;

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
  const chunks = mergeToLimit(
    chunkContiguous(
      store.uncoveredMessagesInSpan(bounds.firstEntryId, bounds.lastEntryId),
      leafChunkBudget,
    ),
    opts?.maxChunks ?? 24,
  );
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
      const items = remaining.flatMap((m) => {
        const ref = refByMessage.get(m.id);
        // The summarizer never reads a stored body unmasked. The mask runs on
        // the whole body rather than on the clipped copy, so a value that
        // straddles the clip point cannot leak as a fragment.
        if (ref) return [{ role: m.role, text: redact(filePreviewText(ref)) }];
        const clipped = clipForSummary(redact(m.text), m.entryId, maxChunkChars);
        if (clipped.droppedChars > 0) {
          appendMetric({
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
      const inserted = store.insertSummary({
        kind: "leaf",
        text: stored,
        tokens,
        depth: 0,
        firstEntryId: chunkHead.entryId,
        lastEntryId: chunkTail.entryId,
        messageIds: remaining.map((m) => m.id),
        fileIds: [...new Set(refs.map((r) => r.fileId))],
        ...(answer.thoroughText === undefined ? {} : { thoroughText: answer.thoroughText }),
      });
      if (!inserted.created) {
        reportSkippedExisting(
          inserted.id,
          inserted.existingTokens,
          session,
          "leaf",
          0,
          [chunkHead.entryId, chunkTail.entryId],
          tokens,
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
            session,
            "leaf",
          )
        ) {
          leafIds.push(inserted.id);
          reportFallbackStored(
            "leaf",
            level,
            session,
            [chunkHead.entryId, chunkTail.entryId],
            sourceChars,
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
        );
      }
      leafIds.push(inserted.id);
      appendMetric({
        event: "lcm",
        kind: "summary-stored",
        stage: "leaf",
        level,
        depth: 0,
        tokens,
        summaryId: inserted.id,
        session,
        span: [chunkHead.entryId, chunkTail.entryId],
      });
      return;
    }
    if (paid) {
      appendMetric({
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
    const answer = await summarizeWithEscalation(
      group.map((n) => ({ role: "summary", text: n.text })),
      targetTokens,
      llm,
      session,
    );
    const { text, level } = answer;
    const span: [string, string] = [groupHead.firstEntryId, groupTail.lastEntryId];
    const sourceChars = group.reduce((n, s) => n + s.text.length, 0);
    const stored = storedSummaryText(text, level, redact);
    const tokens = estimateTokens(stored);
    const inserted = store.insertSummary({
      kind: "condensed",
      text: stored,
      tokens,
      depth,
      firstEntryId: groupHead.firstEntryId,
      lastEntryId: groupTail.lastEntryId,
      childSummaryIds: group.map((n) => n.id),
      // A parent inherits its children's handles, which is how a top-level
      // node answers "which files does this cover" without expanding.
      fileIds: store.fileIdsForSummaries(group.map((n) => n.id)),
      ...(answer.thoroughText === undefined ? {} : { thoroughText: answer.thoroughText }),
    });
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
      );
      if (
        inserted.own &&
        replaceIfSmaller(
          store,
          inserted.id,
          inserted.existingTokens,
          stored,
          tokens,
          session,
          "condensed",
        )
      ) {
        condensedIds.push(inserted.id);
        reportFallbackStored("condensed", level, session, span, sourceChars);
      }
      frontier = store.frontier(from, bounds.lastEntryId);
      frontierTok = frontierTokens(frontier);
      continue;
    }
    condensedIds.push(inserted.id);
    reportFallbackStored("condensed", level, session, span, sourceChars);
    if (tokens > targetTokens || answer.retried) {
      reportOversize("condensed", depth, tokens, targetTokens, answer, span, session);
    }
    appendMetric({
      event: "lcm",
      kind: "summary-stored",
      stage: "condensed",
      level,
      depth,
      tokens,
      summaryId: inserted.id,
      session,
      span,
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
  if (lone && frontierTok > targetTokens * 2) {
    const beforeTokens = lone.tokens;
    const answer = await summarizeTerse(
      [{ role: "summary", text: lone.text }],
      targetTokens,
      llm,
      session,
    );
    const stored = storedSummaryText(answer.text, answer.level, redact);
    const tokens = estimateTokens(stored);
    if (replaceIfSmaller(store, lone.id, beforeTokens, stored, tokens, session, lone.kind)) {
      reportFallbackStored(
        lone.kind,
        answer.level,
        session,
        [lone.firstEntryId, lone.lastEntryId],
        lone.text.length,
      );
      appendMetric({
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
    appendMetric({
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
    appendMetric({
      event: "lcm",
      kind: "summary-final-truncated",
      stage: opts?.stage ?? "direct",
      session,
      span,
      beforeTokens,
      afterTokens: estimateTokens(finalText),
    });
  }

  appendMetric({
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
): void {
  appendMetric({
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
  session: string | undefined,
  stage: "leaf" | "condensed",
): boolean {
  if (existingTokens <= 0 || tokens > existingTokens * REPLACE_MARGIN) return false;
  if (store.parentSummaryIds(id).length > 0) return false;
  const displaced = store.getSummary(id);
  store.updateSummaryText(id, text, tokens);
  if (displaced !== undefined && displaced.thoroughText === undefined) {
    store.setThoroughText(id, displaced.text);
  }
  appendMetric({
    event: "lcm",
    kind: "summary-replaced",
    stage,
    session,
    summaryId: id,
    beforeTokens: existingTokens,
    afterTokens: tokens,
  });
  return true;
}

function storedSummaryText(
  text: string,
  level: SummaryLevel,
  redact: (t: string) => string,
): string {
  return level === 3 ? `[lcm:truncated]\n${redact(text)}` : redact(text);
}

function reportFallbackStored(
  stage: SummaryStage,
  level: SummaryLevel,
  session: string | undefined,
  span: MetricSpan,
  sourceChars: number,
): void {
  if (level !== 3) return;
  appendMetric({
    event: "lcm",
    kind: "summary-fallback-stored",
    stage,
    session,
    span,
    sourceChars,
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
): void {
  appendMetric({
    event: "lcm",
    kind: "summary-skipped-existing",
    stage,
    session,
    summaryId: id,
    depth,
    span,
    attemptedTokens,
    existingTokens,
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
