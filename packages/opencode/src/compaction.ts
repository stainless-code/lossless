/** The blocking boundary: when the host is about to compact, hand it the DAG
 * frontier as the checkpoint summary instead of letting it call a summarizer.
 * The host stores the summary and the marker on the compaction message, and the
 * next `session.context` hook adopts that checkpoint (see `./context.ts`).
 *
 * Every decision is made from the stored history, the way the projection makes
 * it, so the text the host stores is the text the projection would have sent:
 * the aged prefix is cut with `cutIndexFor` over the same stored entries, and
 * the render goes through the same frontier, redaction, and budget ladder. If
 * the frontier does not cover the aged span the hook runs one pass and waits
 * for it, because a checkpoint that omitted the boundary would silently drop
 * the messages it stands for.
 *
 * Nothing here may throw into the host: a hook that fails must leave `result`
 * unset so the host compacts natively, and record why in the metrics sink. */

import { createHash } from "node:crypto";

import {
  buildSynthetic,
  contextChars,
  cutIndexFor,
  redactSecrets,
  renderableFrontier,
  renderSummaries,
  tokensFromChars,
  type AppliedSummary,
  type SummaryNode,
} from "lossless-core";

import { checkpointText } from "./checkpoint.ts";
import type { ProjectionOptions } from "./context.ts";
import type { OpencodeContext, SessionCompactionEvent } from "./host.ts";
import { storedEntries } from "./map.ts";
import { appendMetricRow } from "./metrics.ts";
import { runLosslessPass } from "./pass.ts";
import type { Sidecars } from "./sidecars.ts";
import { summarizerConfig } from "./summarizer.ts";
import type { WindowOf } from "./window.ts";

export interface CheckpointDeps {
  readonly ctx: OpencodeContext;
  readonly options: ProjectionOptions;
  readonly sidecars: Sidecars;
  readonly windowOf: WindowOf;
}

export interface CheckpointWriter {
  /** Fills `event.result` when the sidecar covers the aged span. */
  apply(event: SessionCompactionEvent): Promise<void>;
}

interface Row {
  readonly action: "checkpoint" | "skip" | "fail";
  readonly occupancy: number;
  readonly tokens: number;
  readonly cutCount?: number;
  readonly summaryIds?: readonly number[];
  /** Chars of the summary text handed to the host. */
  readonly chars?: number;
  readonly source?: "frontier" | "pass";
  readonly reason?: string;
  readonly error?: string;
}

export function createCheckpointWriter(deps: CheckpointDeps): CheckpointWriter {
  async function apply(event: SessionCompactionEvent): Promise<void> {
    const sessionID = event.sessionID;
    try {
      await write(event);
    } catch (error) {
      appendRow(deps.sidecars.dir, sessionID, {
        action: "fail",
        occupancy: 0,
        tokens: 0,
        reason: "unexpected",
        error: messageOf(error),
      });
    }
  }

  async function write(event: SessionCompactionEvent): Promise<void> {
    const sessionID = event.sessionID;
    const stored = await deps.ctx.session.context({ sessionID });
    const mapped = storedEntries(sessionID, stored);
    const contextWindow = await deps.windowOf(event.model);
    const tokens = mapped.tokens ?? tokensFromChars(contextChars(mapped.raw));
    const occupancy = round3(tokens / contextWindow);
    const fail = (reason: string, error?: unknown): void => {
      appendRow(deps.sidecars.dir, sessionID, {
        action: "fail",
        occupancy,
        tokens,
        reason,
        ...(error === undefined ? {} : { error: messageOf(error) }),
      });
    };

    // Another plugin already supplied this compaction. Its summary is not ours
    // to replace.
    if (event.result !== undefined) {
      appendRow(deps.sidecars.dir, sessionID, {
        action: "skip",
        occupancy,
        tokens,
        reason: "already-claimed",
      });
      return;
    }

    // A checkpoint this adapter did not write (a native window, an older host
    // summary) stands for messages this hook cannot see, so its summary could
    // not replace the host's. Let the host compact natively.
    if (mapped.hostCheckpoint && mapped.checkpoint === undefined) {
      appendRow(deps.sidecars.dir, sessionID, {
        action: "skip",
        occupancy,
        tokens,
        reason: "host-checkpoint",
      });
      return;
    }

    const previous = mapped.checkpoint;
    const previousText =
      previous === undefined ? undefined : checkpointText(event.messages, previous);
    if (previous !== undefined && previousText === undefined) {
      fail("checkpoint-unmapped");
      return;
    }

    const cut = cutIndexFor(mapped.raw, deps.options.keepRecentTokens);
    if (cut === null) {
      appendRow(deps.sidecars.dir, sessionID, {
        action: "skip",
        occupancy,
        tokens,
        reason: "no-boundary",
      });
      return;
    }
    if (cut === 0) {
      appendRow(deps.sidecars.dir, sessionID, {
        action: "skip",
        occupancy,
        tokens,
        reason: "nothing-to-age",
      });
      return;
    }
    const aged = mapped.entries.slice(0, cut);
    const first = aged[0];
    const last = aged[aged.length - 1];
    if (first === undefined || last === undefined) {
      fail("aged-empty");
      return;
    }
    const span = { firstEntryId: first.entryId, lastEntryId: last.entryId };
    const store = deps.sidecars.for(sessionID);

    let nodes = store.frontier(span.firstEntryId, span.lastEntryId);
    let source: "frontier" | "pass" = "frontier";
    if (!covered(nodes, span.lastEntryId)) {
      source = "pass";
      try {
        await runLosslessPass(
          {
            store: () => store,
            ctx: deps.ctx,
            model: event.model,
            record: (row) => appendMetricRow(deps.sidecars.dir, row),
          },
          sessionID,
          aged,
          {
            targetTokens: deps.options.summaryTokens,
            stage: "blocking",
            ...(previousText === undefined ? {} : { previousSummary: previousText }),
            summarizer: summarizerConfig(deps.options),
          },
        );
      } catch (error) {
        fail("pass-failed", error);
        return;
      }
      nodes = store.frontier(span.firstEntryId, span.lastEntryId);
      if (!covered(nodes, span.lastEntryId)) {
        fail("uncovered-after-pass");
        return;
      }
    }

    const { applied } = renderableFrontier(nodes, deps.options.summaryTokens, redactSecrets);
    const text = renderCheckpoint(previousText, applied);
    const kept = mapped.raw[cut];
    const keptSource = kept === undefined ? undefined : mapped.sources.get(kept);
    const keepID = mapped.hostOnlyBefore.get(cut) ?? keptSource?.id;
    event.result = {
      summary: text,
      metadata: {
        lcm: true,
        summaryIds: applied.map((node) => node.id),
        cutCount: aged.length,
        checkpoint: digest(text),
        ...(keepID === undefined ? {} : { keepID }),
      },
    };
    appendRow(deps.sidecars.dir, sessionID, {
      action: "checkpoint",
      occupancy,
      tokens,
      cutCount: aged.length,
      summaryIds: applied.map((node) => node.id),
      chars: text.length,
      source,
    });
  }

  return { apply };
}

/** The text the host stores. Without a previous checkpoint it is the
 * projection's own synthetic. With one, the checkpoint's text stays in front:
 * the host is compacting a history that still contains it, and the aged span
 * this hook could read starts after it. This is the same shape core's
 * `previousSummary` merge produces for a pass's returned summary. */
function renderCheckpoint(
  previous: string | undefined,
  applied: readonly AppliedSummary[],
): string {
  const projection = buildSynthetic(applied).content;
  return previous === undefined ? projection : `${previous}\n\n${renderSummaries(applied)}`;
}

function covered(nodes: readonly SummaryNode[], lastEntryId: string): boolean {
  return nodes[nodes.length - 1]?.lastEntryId === lastEntryId;
}

/** A stable identity for the stored checkpoint text: the next context hook
 * recognizes its own boundary by the marker, not by comparing summaries. */
function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

function appendRow(dir: string, session: string, row: Row): void {
  appendMetricRow(dir, { ts: Date.now(), session, kind: "compaction-checkpoint", ...row });
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300);
}
