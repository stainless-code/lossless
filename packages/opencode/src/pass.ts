/** One lossless pass over a span the sidecar already holds. The store owns the
 * span, the run token, and the commit; this module only hands the engine the
 * model host and the summarizer chain the plugin configured. */

import {
  makeLlm,
  normalizeRole,
  redactSecrets,
  runCompaction,
  type AlignedEntry,
  type CompactionOutcome,
  type LcmStore,
  type MetricsSink,
  type ModelHost,
} from "lossless-core";

import type { ModelRef, OpencodeContext } from "./host.ts";
import { opencodeModelHost } from "./model-host.ts";
import { summarizerConfig, type SummarizerOptions } from "./summarizer.ts";

export interface PassDeps {
  /** The sidecar that holds this session's history. */
  readonly store: (sessionID: string) => LcmStore;
  /** The host context every summarizer call goes through. */
  readonly ctx: OpencodeContext;
  /** The session model, the chain's `auto` entry. */
  readonly model: ModelRef;
  /** Diagnostic sink. Optional so a pass unit test can run without a metrics
   * directory; production passes `appendMetricRow`. */
  readonly record?: (row: Record<string, unknown>) => void;
}

/** Which regime started this pass: the manual command is `direct`, the context
 * hook schedules `async`, and the blocking compaction boundary is `blocking`. */
export type PassStage = "blocking" | "async" | "direct";

export interface PassOptions {
  readonly targetTokens?: number;
  readonly previousSummary?: string;
  readonly summarizer?: SummarizerOptions;
  /** Which regime started this pass. `blocking` is the default; the manual
   * command passes `direct` and the context hook schedules `async` passes. */
  readonly stage?: PassStage;
  /** Checked before the pass starts. `generate.text` takes no signal, so a call
   * already running cannot be cancelled. */
  readonly signal?: AbortSignal;
}

/** What one pass saw the model answer. The engine's ladder turns a dead or
 * refused summarizer into a deterministic truncate and still reports
 * `stored`, so the tally is how a manual pass tells a written summary from a
 * mechanical one. */
interface ModelTally {
  answers: number;
}

function tallyingHost(host: ModelHost<ModelRef>, tally: ModelTally): ModelHost<ModelRef> {
  return {
    notices: host.notices,
    session: () => host.session(),
    find: (requested) => host.find(requested),
    complete: async (ref, request) => {
      const answer = await host.complete(ref, request);
      if (answer.outcome === "answer" && answer.text.trim().length > 0) tally.answers++;
      return answer;
    },
  };
}

export async function runLosslessPass(
  deps: PassDeps,
  sessionID: string,
  entries: readonly AlignedEntry[],
  opts: PassOptions = {},
): Promise<CompactionOutcome> {
  opts.signal?.throwIfAborted();
  const started = Date.now();
  const stage = opts.stage ?? "blocking";
  // Every engine and completer row belongs to this pass, so they go through the
  // same record callback as the pass row. Without one this is a deliberate
  // no-op, never core's log: an OpenCode pass must not write the Pi metrics
  // file just because its test or caller supplied no sink.
  const sink: MetricsSink = (row) => {
    deps.record?.({ ...row });
  };
  const tally: ModelTally = { answers: 0 };
  const record = (
    row:
      | { outcome: "stored"; leaf: number; condensed: number; answers: number }
      | { outcome: "nothing"; answers: number; reason: string }
      | { outcome: "failed"; answers: number; error: string },
  ): void => {
    deps.record?.({
      ts: Date.now(),
      session: sessionID,
      kind: "pass",
      stage,
      ...row,
      durationMs: Date.now() - started,
    });
  };
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) {
    record({ outcome: "nothing", answers: 0, reason: "no-entries" });
    return { kind: "nothing", reason: "no-entries", ingested: 0 };
  }
  const llm = makeLlm(
    tallyingHost(opencodeModelHost(deps.ctx, deps.model), tally),
    summarizerConfig(opts.summarizer ?? {}),
    {
      session: sessionID,
      stage,
      span: { firstEntryId: first.entryId, lastEntryId: last.entryId },
      sink,
    },
  );
  if (llm === null) throw new Error("lcm: no summarizer model is available for this pass");

  const store = deps.store(sessionID);
  const { token } = store.openRun({ session: sessionID });
  try {
    const outcome = await runCompaction(
      store.forRun(token),
      {
        span: entries.map((entry) => ({
          entryId: entry.entryId,
          role: normalizeRole(entry.role),
          text: entry.text,
        })),
        ...(opts.previousSummary === undefined ? {} : { previousSummary: opts.previousSummary }),
        ...(opts.targetTokens === undefined ? {} : { targetTokens: opts.targetTokens }),
      },
      llm,
      // The pass stage is the engine's own vocabulary, so a direct pass labels
      // its completer rows and its engine rows alike.
      { redact: redactSecrets, session: sessionID, stage },
    );
    if (outcome.kind === "stored") {
      // A stored outcome with no model answer is the ladder's mechanical
      // truncate. Committing it would report success for a summarizer that
      // never worked, so a manual pass abandons it and says so.
      if (tally.answers === 0) {
        throw new Error("lcm: the summarizer did not answer, so nothing was stored");
      }
      store.commitRun(token);
      record({
        outcome: "stored",
        leaf: outcome.leafSummaryIds.length,
        condensed: outcome.condensedSummaryIds.length,
        answers: tally.answers,
      });
    } else {
      record({ outcome: "nothing", answers: tally.answers, reason: outcome.reason });
    }
    return outcome;
  } catch (error) {
    record({ outcome: "failed", answers: tally.answers, error: messageOf(error) });
    const dropped = store.abandonRun(token);
    if (dropped > 0) {
      sink({
        event: "lcm",
        kind: "compaction-abandoned",
        session: sessionID,
        stage,
        dropped,
      });
    }
    throw error;
  } finally {
    store.abandonRun(token);
  }
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
