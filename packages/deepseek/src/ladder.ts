import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import {
  addUsageTally,
  createUsageTally,
  makeLlm,
  runCompaction,
  tokenUsageOfTally,
  type CompactionSpanEntry,
  type CompletionRequest,
  type LcmStore,
  type MetricsSink,
  type ModelAnswer,
  type ModelHost,
  type ModelRef,
  type UsageTally,
} from "lossless-core";

import type { MessageIndex } from "./ingest.ts";
import { dshModelHost } from "./model-host.ts";
import type { DshRoute } from "./model-host.ts";

export interface LosslessEngineDeps {
  readonly store: (sessionId: string) => LcmStore | undefined;
  /** Live message-id to entry-id map, fed by the mirror. Spans resolve through it, never through text matching. */
  readonly index: (sessionId: string) => MessageIndex | undefined;
  /** Last checkpoint text per session, fed back as the next ladder's previous
   * summary. Absent until the engine stores its first checkpoint here. */
  readonly memory?: CheckpointMemory;
  readonly redact: (text: string) => string;
  /** Diagnostic sink: one run row per ladder run plus every engine row the
   * run causes. Optional so scripted tests can observe without a metrics
   * file; production passes the per-composition JSONL writer. */
  readonly record?: (row: Record<string, unknown>) => void;
  readonly summaryTokens?: number;
  readonly leafChunkTokens?: number;
  /** Route automatic pressure compaction through the DAG bracket instead of
   * the seam. Default false: the B path stays the observable auto behavior
   * while the bracket proves itself on the manual path. */
  readonly bracketAuto?: boolean;
}

/** Per-session checkpoint memory: the plugin owns one, the engine reads the
 * previous summary from it and notes every checkpoint it stores. Absent
 * until the session stores its first checkpoint, in memory or in the
 * sidecar. */
export interface CheckpointMemory {
  previous(sessionId: string): string | undefined;
  note(sessionId: string, text: string): void;
}

const DEFAULT_SUMMARY_TOKENS = 1500;
const DEFAULT_LEAF_CHUNK_TOKENS = 3000;

export function checkpointMemory(
  stores?: (sessionId: string) => LcmStore | undefined,
): CheckpointMemory {
  const texts = new Map<string, string>();
  return {
    previous: (sessionId) => {
      const cached = texts.get(sessionId);
      if (cached !== undefined) return cached;
      const hydrated = hydrateCheckpoint(stores?.(sessionId));
      if (hydrated !== undefined) texts.set(sessionId, hydrated);
      return hydrated;
    },
    note: (sessionId, text) => {
      texts.set(sessionId, text);
    },
  };
}

/** Rebuild the last checkpoint from the sidecar: the newest stored summary
 * plus its stored children, cited the same way the ladder cites them. The
 * newest row is the last successful run's final node. Exact when the run
 * stored leaves plus a fresh condensed row; a single-leaf run replaces its
 * row's text on condensation, so the rebuild carries the stored form; with
 * deeper condensation every cited id still resolves. Either way a resumed
 * session compacts with continuity instead of from scratch. */
function hydrateCheckpoint(store: LcmStore | undefined): string | undefined {
  if (store === undefined) return undefined;
  const summaries = store.allSummaries();
  const latest = summaries[summaries.length - 1];
  if (latest === undefined) return undefined;
  return withSummaryRefs(latest.text, [...store.childSummaryIds(latest.id), latest.id]);
}

/** The ladder stored nothing because every row in the span is already covered:
 * the span is memory, not history. Thrown instead of the seam's generic
 * summary failure so the caller hears the true state. */
export class SpanAlreadyMemoryError extends Error {
  constructor(span: string) {
    super(`lossless compaction: span ${span} is already memory; every row is covered`);
    this.name = "SpanAlreadyMemoryError";
  }
}

/** Shared provider/model fallback chain (explicit config, latest routed
 * request, agent options) for the seam path and the DAG bracket alike. Reads
 * only the host session header and agent options beside the host SDK. */
export function resolveSummarizationTarget(
  config: { summarizationProvider: string; summarizationModel: string },
  agent: Agent,
): DshRoute | undefined {
  const configured =
    config.summarizationProvider.length > 0
      ? { provider: config.summarizationProvider, model: config.summarizationModel }
      : undefined;
  const header = agent.session.requestHeader()?.config;
  const latest =
    header && header.provider.length > 0 && header.model.length > 0
      ? { provider: header.provider, model: header.model }
      : undefined;
  const options = agent.options;
  const agentTarget =
    options.provider !== undefined &&
    options.provider.length > 0 &&
    options.model !== undefined &&
    options.model.length > 0
      ? { provider: options.provider, model: options.model }
      : undefined;
  return configured ?? latest ?? agentTarget;
}

/** What one ladder run stored: the condensed text plus the sidecar ids and
 * the model call facts for the checkpoint record. */
export interface LadderOutcome {
  readonly summaryText: string;
  readonly leafSummaryIds: readonly number[];
  readonly condensedSummaryIds: readonly number[];
  readonly provider: string;
  readonly model: string;
  readonly usage?: TokenUsage;
}

/** One lossless ladder run against a resolved span: leaf chunking, then
 * condensation, sharing one usage tracker. The seam `summarize()` and the
 * DAG bracket commit through here, so the summarizer cannot drift between
 * the two paths. Throws SpanAlreadyMemoryError when every row in the span
 * is already covered. */
export async function runLadder(
  ctx: Context,
  lossless: LosslessEngineDeps,
  target: DshRoute,
  sessionId: string,
  span: CompactionSpanEntry[],
  signal?: AbortSignal,
): Promise<LadderOutcome> {
  const first = span[0];
  const last = span[span.length - 1];
  if (!first || !last) throw new Error("lossless compaction: span mapping came back empty");
  const host = dshModelHost(ctx, {
    defaultRoute: target,
    ...(signal === undefined ? {} : { signal }),
  });
  const tracker = new UsageTracker();
  const record = lossless.record;
  // Every engine and completer row belongs to this run, so they go through
  // the same record callback as the run row. Without one this stays unset
  // and the rows fall back to the global log, never a half-wired file.
  const sink: MetricsSink | undefined =
    record === undefined ? undefined : (row) => record({ ...row });
  const llm = makeLlm(
    tracker.wrap(host),
    {},
    {
      session: sessionId,
      stage: "blocking",
      span: { firstEntryId: first.entryId, lastEntryId: last.entryId },
      ...(sink === undefined ? {} : { sink }),
    },
  );
  if (!llm) throw new Error("lossless compaction: no summarizer model resolves");
  const store = lossless.store(sessionId);
  if (!store) throw new Error(`lossless compaction: no sidecar store for session ${sessionId}`);
  const { token } = store.openRun({ session: sessionId });
  const started = Date.now();
  const spanPair: [string, string] = [first.entryId, last.entryId];
  try {
    const outcome = await runCompaction(
      store.forRun(token),
      {
        span,
        targetTokens: lossless.summaryTokens ?? DEFAULT_SUMMARY_TOKENS,
        frontierFrom: first.entryId,
        previousSummary: lossless.memory?.previous(sessionId),
      },
      llm,
      {
        leafChunkTokens: lossless.leafChunkTokens ?? DEFAULT_LEAF_CHUNK_TOKENS,
        redact: lossless.redact,
        session: sessionId,
        stage: "blocking",
      },
    );
    store.commitRun(token);
    if (outcome.kind === "nothing") {
      record?.({
        ts: Date.now(),
        event: "lcm",
        kind: "pass",
        session: sessionId,
        stage: "blocking",
        outcome: "nothing",
        reason: outcome.reason,
        ingested: outcome.ingested,
        span: spanPair,
        durationMs: Date.now() - started,
      });
      throw new SpanAlreadyMemoryError(`${first.entryId}..${last.entryId} (${outcome.reason})`);
    }
    const route = tracker.route ?? target;
    const usage = tracker.tokenUsage();
    record?.({
      ts: Date.now(),
      event: "lcm",
      kind: "pass",
      session: sessionId,
      stage: "blocking",
      outcome: "stored",
      leaf: outcome.leafSummaryIds.length,
      condensed: outcome.condensedSummaryIds.length,
      ingested: outcome.ingested,
      ...(usage === undefined ? {} : { usage }),
      span: spanPair,
      durationMs: Date.now() - started,
    });
    return {
      summaryText: outcome.summaryText,
      leafSummaryIds: outcome.leafSummaryIds,
      condensedSummaryIds: outcome.condensedSummaryIds,
      provider: route.provider,
      model: route.model,
      ...(usage === undefined ? {} : { usage }),
    };
  } catch (error) {
    if (error instanceof SpanAlreadyMemoryError) throw error;
    record?.({
      ts: Date.now(),
      event: "lcm",
      kind: "pass",
      session: sessionId,
      stage: "blocking",
      outcome: "failed",
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      span: spanPair,
      durationMs: Date.now() - started,
    });
    throw error;
  } finally {
    store.abandonRun(token);
  }
}

/** Name the stored DAG nodes in the checkpoint using the same refs the
 * recall tools resolve, so a future reader pulls full nodes from a short
 * citation instead of re-deriving them. Shared with the DAG bracket so its
 * checkpoint cites the same nodes. */
export function withSummaryRefs(text: string, ids: readonly number[]): string {
  if (ids.length === 0) return text;
  return `${text}\n\nStored summaries: ${ids.map((id) => `[lcm:summary #${id}]`).join(" ")}`;
}

/** Sums provider counts across every ladder call into one envelope. The route reported is the one that produced the stored text. The accumulation lives in the core usage tally seam; this wrapper keeps only the route beside the host. */
class UsageTracker {
  private tally: UsageTally = createUsageTally();
  route: DshRoute | undefined = undefined;

  wrap(host: ModelHost<DshRoute>): ModelHost<DshRoute> {
    return {
      ...host,
      complete: async (
        model: ModelRef<DshRoute>,
        request: CompletionRequest,
      ): Promise<ModelAnswer> => {
        const answer = await host.complete(model, request);
        this.route = model.model;
        const usage = answer.usage;
        if (usage) {
          addUsageTally(this.tally, usage);
        }
        return answer;
      },
    };
  }

  tokenUsage(): TokenUsage | undefined {
    return tokenUsageOfTally(this.tally);
  }
}
