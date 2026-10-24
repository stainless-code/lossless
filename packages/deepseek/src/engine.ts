import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CommandId } from "@deepseek-ai/dsh-commands/brand";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import type { BasicCompactionConfig } from "@deepseek-ai/dsh-compaction-basic";
import type { ContentBlock, Message, TokenUsage, ToolSchema } from "@deepseek-ai/dsh-llm";
import type { CompactionSpanEntry, LcmStore } from "lossless-core";

import { commitDagTransaction, selectDagRange } from "./dag-commit.ts";
import type { DagCommitResult } from "./dag-commit.ts";
import { MessageIndex } from "./ingest.ts";
import type { CheckpointMemory, LadderOutcome, LosslessEngineDeps } from "./ladder.ts";
import {
  SpanAlreadyMemoryError,
  checkpointMemory,
  resolveSummarizationTarget,
  runLadder,
  withSummaryRefs,
} from "./ladder.ts";

/** Import surface this module keeps stable for the package root. The ladder
 * lives in ladder.ts; these re-exports hold the pre-split import paths so
 * the move changes no consumer. */
export { SpanAlreadyMemoryError, checkpointMemory };
export type { CheckpointMemory, LosslessEngineDeps };

/** The pinned `summarize()` contract, repeated here because the package root
 * does not export these members at this pin. The override check below fails
 * the build on renames and removals; additions need a look when the pin
 * moves. */
interface SpanInput {
  readonly tools?: readonly ToolSchema[];
  readonly messages: readonly Message[];
}

interface SpanSummary {
  summary: ContentBlock[];
  provider: string;
  model: string;
  maxTokens?: number;
  usage?: TokenUsage;
  rawOutput?: ContentBlock[];
}

/** The shipped backend keeps range selection, the transaction,
 * the meter, and the shrink check. Only the summarizer runs through the
 * lossless ladder and the sidecar, and the checkpoint text it returns is
 * what the engine frames and commits. Manual compaction (`compactNow`)
 * commits through the DAG bracket instead; automatic pressure compaction
 * (`compactRegion`) stays on this seam unless `bracketAuto` routes it
 * through the bracket too, so the regression suite keeps pinning it. */
export class LosslessSummarizerEngine extends BasicCompactionEngine {
  constructor(
    ctx: Context,
    config: BasicCompactionConfig = {},
    private readonly lossless: LosslessEngineDeps,
  ) {
    super(ctx, config);
  }

  override async compactRegion(
    ...args: Parameters<BasicCompactionEngine["compactRegion"]>
  ): Promise<Awaited<ReturnType<BasicCompactionEngine["compactRegion"]>>> {
    if (this.lossless.bracketAuto === true) {
      const [start, end, agent, signal] = args;
      return commitDagTransaction(
        {
          ctx: this.ctx,
          summarizationProvider: this.config.summarizationProvider,
          summarizationModel: this.config.summarizationModel,
          ...this.lossless,
        },
        agent,
        { start, end },
        { owner: "current-turn", stability: "whole-surface" },
        signal,
      );
    }
    try {
      return await super.compactRegion(...args);
    } catch (error) {
      // The seam wraps summarize failures in a generic could-not-summarize
      // error; unwrap ours so the caller hears already-memory instead.
      // Matched structurally (name plus code) so a second copy of the root
      // package cannot break the recognition, and without importing it.
      const cause = isManualSummaryError(error) ? error.cause : undefined;
      if (cause instanceof SpanAlreadyMemoryError) throw cause;
      throw error;
    }
  }

  /** Manual compaction through the DAG bracket: idle-agent admission,
   * range selection, and the durability flush mirror the seam's compactNow
   * (dsh-compaction-basic@0.1.7-alpha.2 lib/index.js:974-1009); the
   * transaction itself is commitDagTransaction. Returns null when no safe
   * useful range exists. */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<DagCommitResult | null> {
    signal.throwIfAborted();
    try {
      // Bare return, not await: only a synchronous admission refusal maps
      // to busy here. A task failure rejects the returned promise past this
      // catch, preserving the seam's cancellation precedence.
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        try {
          operationSignal.throwIfAborted();
          // Retain 0, exactly like the seam's compactNow: the manual path
          // forces one useful reduction, so retainTokens prices only the
          // pressure path the seam owns.
          const range = selectDagRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
          );
          if (range === null) return null;
          return await commitDagTransaction(
            {
              ctx: this.ctx,
              summarizationProvider: this.config.summarizationProvider,
              summarizationModel: this.config.summarizationModel,
              ...this.lossless,
            },
            agent,
            range,
            {
              owner: null,
              stability: "selected-span",
              ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
              flush: async () => {
                await this.ctx.sessions.flush(agent.session);
              },
            },
            operationSignal,
          );
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError("cancelled", "manual compaction was cancelled", {
              cause: error,
            });
          }
          operationSignal.throwIfAborted();
          throw error;
        }
      });
    } catch (error) {
      throw new ManualCompactionError(
        "busy",
        "manual compaction requires an idle agent with no waking queued work",
        { cause: error },
      );
    }
  }

  protected override async summarize(
    input: SpanInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SpanSummary> {
    const sessionId = String(agent.session.id);
    const store = this.lossless.store(sessionId);
    if (!store) throw new Error(`lossless compaction: no sidecar store for session ${sessionId}`);
    const index = this.lossless.index(sessionId);
    if (!index) {
      throw new Error(`lossless compaction: session ${sessionId} has no message map`);
    }
    const target = resolveSummarizationTarget(this.config, agent);
    if (!target) {
      throw new Error(
        "lossless compaction: no provider/model available for summarization: set both engine summarization fields, route one request, or set both agent options fields",
      );
    }
    const span = this.spanOf(input, store, index);
    const ladder = await runLadder(this.ctx, this.lossless, target, sessionId, span, signal);
    const checkpoint = withSummaryRefs(ladder.summaryText, [
      ...ladder.leafSummaryIds,
      ...ladder.condensedSummaryIds,
    ]);
    this.lossless.memory?.note(sessionId, checkpoint);
    return toSummaryResult(checkpoint, ladder, this.config.maxTokens);
  }

  private spanOf(input: SpanInput, store: LcmStore, index: MessageIndex): CompactionSpanEntry[] {
    // A leading system message is the retained head, not shadowed content.
    const startAt = input.messages[0]?.role === "system" ? 1 : 0;
    const items: Array<{ rowId: number; entry: CompactionSpanEntry }> = [];
    for (const message of input.messages.slice(startAt)) {
      const entryId = index.entryId(message.id);
      if (entryId === undefined) {
        throw new Error(
          `lossless compaction: message ${message.id} has no sidecar row; the span is not fully mirrored`,
        );
      }
      const row = store.messageByEntryId(entryId);
      if (!row) {
        throw new Error(`lossless compaction: sidecar holds no row for ${entryId}`);
      }
      items.push({ rowId: row.id, entry: { entryId, role: row.role, text: row.text } });
    }
    if (items.length === 0)
      throw new Error("lossless compaction: no mirrorable messages in the span");
    // Core reads a span as a storage range, so frontierFrom must name the
    // storage minimum. Surface order diverges from storage order after a
    // replace (the checkpoint row is newest), so order by rowid here.
    items.sort((a, b) => a.rowId - b.rowId);
    return items.map((item) => item.entry);
  }
}

function toSummaryResult(
  checkpoint: string,
  ladder: Pick<LadderOutcome, "provider" | "model" | "usage">,
  maxTokens: number,
): SpanSummary {
  if (checkpoint.trim().length === 0) {
    throw new Error("lossless compaction: ladder produced no text");
  }
  return {
    summary: [{ type: "text", text: checkpoint }],
    rawOutput: [{ type: "text", text: checkpoint }],
    provider: ladder.provider,
    model: ladder.model,
    maxTokens,
    ...(ladder.usage === undefined ? {} : { usage: ladder.usage }),
  };
}

/** True for the seam's generic summary failure, which wraps whatever
 * `summarize` threw as its cause. */
function isManualSummaryError(error: unknown): error is Error & { cause?: unknown } {
  return (
    error instanceof Error &&
    error.name === "ManualCompactionError" &&
    (error as { code?: unknown }).code === "summary"
  );
}
