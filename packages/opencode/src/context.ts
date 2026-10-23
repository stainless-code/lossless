/** The `session.context` hook: once a session's request grows past the swap
 * point, replace the aged part of the outgoing history with the DAG projection
 * and schedule the pass that fills the missing boundary. The host rebuilds its
 * message array before every request, so the projection is applied to that
 * draft each time and never persisted into the session.
 *
 * The unit mismatch is the whole difficulty of this seam. The core reasons in
 * stored entries (one user or assistant message each), while the outgoing array
 * also carries a separate `tool` message for every result the provider did not
 * execute. The two line up only when each stored entry maps to one outgoing head
 * plus the tool messages that follow it; when they do not, nothing is projected.
 *
 * A checkpoint this adapter wrote is the second seam. The stored history begins
 * with a compaction message, the outgoing draft begins with the host's rendering
 * of it, and the projection adopts that rendering as its pinned synthetic and
 * continues from the messages after it. An unmarked checkpoint (a native window,
 * or a host summary) is not adopted: the projection leaves the request alone.
 *
 * `src/host.ts` is the only host surface this module touches, so the bundle
 * names no SDK. The synthetic message is built as the plain shape
 * `Message.user(text)` produces (role plus a text part), because importing the
 * host's `Message` class here would put the SDK back in the bundle. */

import {
  applyContextPolicy,
  buildSynthetic,
  contextChars,
  cutIndexFor,
  cutMayReplace,
  effectiveThresholds,
  mergeZone,
  nextAction,
  redactSecrets,
  renderableFrontier,
  shouldKickBoundary,
  tailKeyOf,
  tokensFromChars,
  type AlignedEntry,
  type CommitState,
  type ContextPolicyResult,
  type FailedBoundary,
  type LcmStore,
  type SummaryNode,
  type ThresholdConfig,
} from "lossless-core";

import { checkpointNodes, checkpointText } from "./checkpoint.ts";
import type { ModelRef, OpencodeContext, SessionContextEvent } from "./host.ts";
import { storedEntries, type StoredCheckpoint, type StoredEntries } from "./map.ts";
import { appendMetricRow } from "./metrics.ts";
import { modelKey } from "./model-host.ts";
import { runLosslessPass } from "./pass.ts";
import type { Sidecars } from "./sidecars.ts";
import { summarizerConfig, type SummarizerOptions } from "./summarizer.ts";
import type { WindowOf } from "./window.ts";

/** The projection's share of the plugin options, with every default already
 * resolved by `readOptions`. */
export interface ProjectionOptions extends SummarizerOptions {
  readonly smartZone?: number;
  readonly swapAtRatio: number;
  readonly recutAtRatio: number;
  readonly zones?: Readonly<Record<string, ThresholdConfig>>;
  readonly keepRecentTokens: number;
  readonly summaryTokens: number;
  /** Used when the host catalogue cannot name this model's window. */
  readonly contextWindow: number;
}

interface SessionState {
  commitState: CommitState | null;
  pinnedModelKey: string;
  pinnedWindow: number;
  clampNotified: boolean;
  /** The identity of the checkpoint `commitState` was seeded from, so the same
   * checkpoint is adopted once and a later recut of its projection survives. */
  checkpoint: string;
  failedBoundaries: Map<string, FailedBoundary>;
  /** The one pass this session may run at a time. A second kick is dropped. */
  passInFlight: Promise<void> | null;
  /** The span the in-flight pass is filling, kept for the failure latch. */
  pendingSpan: { firstEntryId: string; lastEntryId: string } | null;
}

export interface ProjectorDeps {
  readonly ctx: OpencodeContext;
  readonly options: ProjectionOptions;
  readonly sidecars: Sidecars;
  readonly windowOf: WindowOf;
  /** The pass a kick schedules. Production always uses `runLosslessPass`; a
   * test substitutes it to observe what the pass was asked for. */
  readonly runPass?: typeof runLosslessPass;
}

export interface Projector {
  /** Mutates `event.messages` when the policy projects, and appends one metric
   * row per decision. Never throws into the host. */
  project(event: SessionContextEvent): Promise<void>;
}

interface MetricRow {
  readonly action: ContextPolicyResult["outcome"];
  readonly occupancy: number;
  readonly tokens: number;
  readonly tokensEstimated?: true;
  readonly cutCount?: number;
  readonly summaryIds: readonly number[];
  readonly reason?: string;
}

/** One outgoing span the host built: either a stored entry's head (user or
 * assistant) plus the tool messages that follow it, or a system message the
 * stored history emitted outside the conversation. A null `entry` marks the
 * latter: it is carried with whatever group sits after it, never summarized. */
interface OutgoingSegment {
  readonly entry: number | null;
  readonly messages: readonly unknown[];
}

export function createContextProjector(deps: ProjectorDeps): Projector {
  const states = new Map<string, SessionState>();
  const pass = deps.runPass ?? runLosslessPass;

  function stateFor(sessionID: string): SessionState {
    let state = states.get(sessionID);
    if (!state) {
      state = {
        commitState: null,
        pinnedModelKey: "",
        pinnedWindow: 0,
        clampNotified: false,
        checkpoint: "",
        failedBoundaries: new Map(),
        passInFlight: null,
        pendingSpan: null,
      };
      states.set(sessionID, state);
    }
    return state;
  }

  function record(sessionID: string, row: MetricRow): void {
    appendMetricRow(deps.sidecars.dir, {
      ts: Date.now(),
      session: sessionID,
      kind: "projection",
      ...row,
    });
  }

  function applyProjection(
    event: SessionContextEvent,
    state: SessionState,
    segments: readonly OutgoingSegment[],
  ): boolean {
    const commit = state.commitState;
    if (!commit) return false;
    const text = commit.synthetic.content;
    if (typeof text !== "string") return false;
    // Everything from the first kept entry onward survives, including system
    // and host-only messages emitted after that entry. A host-only message
    // immediately before the first kept entry belongs to the tail too: nothing
    // in the summary covers it.
    let start = segments.findIndex((segment) => segment.entry === commit.cutCount);
    if (start < 0) return false;
    while (start > 0 && segments[start - 1]?.entry === null) start--;
    const tail = segments.slice(start).flatMap((segment) => segment.messages);
    // Splice, not assign: `messages` is the host's live draft, and replacing
    // the whole array would leave the request holding the old one.
    event.messages.splice(0, event.messages.length, syntheticMessage(text), ...tail);
    return true;
  }

  function schedulePass(
    sessionID: string,
    state: SessionState,
    model: ModelRef,
    aged: readonly AlignedEntry[],
    span: { firstEntryId: string; lastEntryId: string },
    previousSummary: string | undefined,
  ): void {
    state.pendingSpan = span;
    const passInFlight = pass(
      {
        store: (id) => deps.sidecars.for(id),
        ctx: deps.ctx,
        model,
        record: (row) => appendMetricRow(deps.sidecars.dir, row),
      },
      sessionID,
      aged,
      {
        targetTokens: deps.options.summaryTokens,
        stage: "async",
        ...(previousSummary === undefined ? {} : { previousSummary }),
        summarizer: summarizerConfig(deps.options),
      },
    )
      .then(() => undefined)
      .catch(() => {
        // The pass was abandoned; the boundary keeps its failed latch so a
        // later request backs off instead of paying for the same failure.
        const boundary = state.pendingSpan?.lastEntryId ?? span.lastEntryId;
        const current = state.failedBoundaries.get(boundary);
        state.failedBoundaries.set(boundary, {
          attempts: current?.attempts ?? 1,
          lastAt: Date.now(),
        });
      })
      .finally(() => {
        state.passInFlight = null;
        state.pendingSpan = null;
      });
    state.passInFlight = passInFlight;
  }

  function frontier(
    sessionID: string,
    state: SessionState,
    firstEntryId: string,
    lastEntryId: string,
  ): SummaryNode[] {
    const store = deps.sidecars.peek(sessionID);
    if (!store) return [];
    const nodes = store.frontier(firstEntryId, lastEntryId);
    if (nodes[nodes.length - 1]?.lastEntryId === lastEntryId) {
      state.failedBoundaries.delete(lastEntryId);
    }
    return nodes;
  }

  async function project(event: SessionContextEvent): Promise<void> {
    try {
      await projectUnsafe(event);
    } catch {
      // A projection that cannot be computed is not a reason to refuse the
      // request: the host keeps the raw history it already built.
    }
  }

  async function projectUnsafe(event: SessionContextEvent): Promise<void> {
    const sessionID = event.sessionID;
    const stored = await deps.ctx.session.context({ sessionID });
    const mapped = storedEntries(sessionID, stored);
    if (mapped.entries.length === 0) return;
    const estimated = mapped.tokens === undefined;

    const state = stateFor(sessionID);
    const contextWindow = await deps.windowOf(event.model);
    const tokens = mapped.tokens ?? tokensFromChars(contextChars(mapped.raw));
    const occupancy = tokens / contextWindow;
    const round3 = (value: number): number => Math.round(value * 1000) / 1000;
    const key = modelKey({ key: "", reasoning: false, model: event.model });

    // A host checkpoint changes the outgoing request without adding an entry
    // this map can align. Only a checkpoint this adapter marked is adopted; any
    // other (a native window, an older summary) leaves the request alone.
    const checkpoint = mapped.checkpoint;
    if (mapped.hostCheckpoint && checkpoint === undefined) {
      record(sessionID, {
        action: "bail",
        occupancy: round3(occupancy),
        tokens,
        summaryIds: [],
        reason: "host-checkpoint",
      });
      return;
    }

    let head: string | undefined;
    if (checkpoint !== undefined) {
      head = checkpointText(event.messages, checkpoint);
      if (head === undefined) {
        record(sessionID, {
          action: "bail",
          occupancy: round3(occupancy),
          tokens,
          ...(estimated ? { tokensEstimated: true as const } : {}),
          summaryIds: [],
          reason: "checkpoint-unmapped",
        });
        return;
      }
      // The checkpoint is adopted once, then a recut of its projection owns the
      // state. Re-seeding an unseeded state restores the pin after a mismatch
      // cleared it: the checkpoint still stands for everything before raw[0].
      if (state.checkpoint !== checkpoint.marker || state.commitState === null) {
        seedCheckpoint(
          state,
          checkpoint,
          head,
          deps.sidecars.for(sessionID),
          key,
          contextWindow,
          round3(occupancy),
          deps.options.summaryTokens,
          mapped,
        );
      }
    } else {
      state.checkpoint = "";
    }

    const groups = alignOutgoing(event.messages, mapped, checkpoint?.messageID);
    if (groups === null) {
      record(sessionID, {
        action: "bail",
        occupancy: round3(occupancy),
        tokens,
        summaryIds: [],
        reason: "unaligned-outgoing",
      });
      return;
    }

    const zoneKey = deps.options.zones?.[key] === undefined ? undefined : key;
    const zone = zoneKey === undefined ? undefined : deps.options.zones?.[zoneKey];
    const base: ThresholdConfig = {
      swapAtRatio: deps.options.swapAtRatio,
      recutAtRatio: deps.options.recutAtRatio,
      ...(deps.options.smartZone === undefined ? {} : { smartZone: deps.options.smartZone }),
    };
    const thresholds = zone === undefined ? base : mergeZone(base, zone);

    const result = applyContextPolicy(
      {
        rawMessages: mapped.raw,
        getCtxEntries: () => mapped.entries,
        occupancy,
        tokens,
        ...(mapped.tokens === undefined ? { tokensEstimated: true as const } : {}),
        contextWindow,
        thresholdWindow: contextWindow,
        modelKey: key,
        ...(zoneKey === undefined ? {} : { zone: zoneKey }),
        thresholds,
        keepRecentTokens: deps.options.keepRecentTokens,
        summaryTokens: deps.options.summaryTokens,
        clampNotified: state.clampNotified,
        commitState: state.commitState,
        pinnedModelKey: state.pinnedModelKey,
        pinnedWindow: state.pinnedWindow,
      },
      {
        thresholds: effectiveThresholds,
        nextAction,
        cutIndexFor,
        cutMayReplace,
        frontier: (firstEntryId, lastEntryId) =>
          frontier(sessionID, state, firstEntryId, lastEntryId),
        spanBounds: (aged) =>
          deps.sidecars.peek(sessionID)?.spanBounds(aged.map((entry) => entry.entryId)) ?? null,
        buildSynthetic,
        redact: redactSecrets,
      },
    );

    // A recut replaces the pinned synthetic with the frontier over the newly
    // aged entries. After a checkpoint that frontier stands only for the tail,
    // so the checkpoint's own text stays in front of it: the host's rendering,
    // then the projection, which is what core's `previousSummary` merge does
    // for a pass's returned text.
    if (head !== undefined && result.outcome === "swap" && result.commitState !== null) {
      result.commitState.synthetic = {
        ...result.commitState.synthetic,
        content: `${head}\n\n${result.commitState.synthetic.content}`,
      };
    }

    state.commitState = result.commitState;
    state.pinnedModelKey = result.pinnedModelKey;
    state.pinnedWindow = result.pinnedWindow;
    state.clampNotified = result.clampNotified;

    const summaryIds = result.commitState?.applied.map((summary) => summary.id) ?? [];

    switch (result.outcome) {
      case "quiet":
        record(sessionID, {
          action: "quiet",
          occupancy: round3(occupancy),
          tokens,
          ...(estimated ? { tokensEstimated: true as const } : {}),
          summaryIds,
        });
        return;
      case "swap":
      case "reapply":
        if (!applyProjection(event, state, groups)) {
          record(sessionID, {
            action: "bail",
            occupancy: round3(occupancy),
            tokens,
            ...(estimated ? { tokensEstimated: true as const } : {}),
            summaryIds,
            reason: "projection-unmapped",
          });
          return;
        }
        record(sessionID, {
          action: result.outcome,
          occupancy: round3(occupancy),
          tokens,
          ...(estimated ? { tokensEstimated: true as const } : {}),
          ...(result.commitState ? { cutCount: result.commitState.cutCount } : {}),
          summaryIds,
        });
        return;
      case "bail":
        if (result.messages) applyProjection(event, state, groups);
        record(sessionID, {
          action: "bail",
          occupancy: round3(occupancy),
          tokens,
          ...(estimated ? { tokensEstimated: true as const } : {}),
          ...(result.commitState ? { cutCount: result.commitState.cutCount } : {}),
          summaryIds,
          reason: result.reason,
        });
        return;
      case "kick": {
        if (result.messages) applyProjection(event, state, groups);
        const boundary = result.span.lastEntryId;
        const now = Date.now();
        const reason = state.passInFlight
          ? "kick-in-flight"
          : shouldKickBoundary(state.failedBoundaries.get(boundary), now)
            ? "summary-missing"
            : "kick-backoff";
        record(sessionID, {
          action: "kick",
          occupancy: round3(occupancy),
          tokens,
          ...(estimated ? { tokensEstimated: true as const } : {}),
          summaryIds,
          reason,
        });
        if (reason !== "summary-missing") return;
        const latch = state.failedBoundaries.get(boundary);
        state.failedBoundaries.set(boundary, {
          attempts: (latch?.attempts ?? 0) + 1,
          lastAt: now,
        });
        schedulePass(sessionID, state, event.model, result.aged, result.span, head);
        return;
      }
    }
  }

  return { project };
}

/** Group the outgoing draft so each stored entry owns one head plus the tool
 * messages that follow its assistant head. A `system` message the stored
 * history emitted between turns becomes its own segment: it belongs to no
 * entry, but dropping it from a kept tail would silently change instructions.
 * A checkpoint this adapter wrote owns the first draft message and no stored
 * entry, so it is dropped before alignment and re-applied as the synthetic.
 * Any other unowned message means the two histories do not line up, so the
 * caller leaves the event alone. */
function alignOutgoing(
  messages: readonly unknown[],
  mapped: StoredEntries,
  checkpointID: string | undefined,
): OutgoingSegment[] | null {
  const expected: Array<{ id: string; role: string }> = [];
  for (const wrapper of mapped.raw) {
    const source = mapped.sources.get(wrapper);
    if (!source) return null;
    expected.push({ id: source.id, role: source.type });
  }

  const segments: OutgoingSegment[] = [];
  let index = 0;
  let entry = 0;
  if (checkpointID !== undefined) {
    if (!isMessageOf(messages[0], "user", checkpointID)) return null;
    index = 1;
  }
  while (index < messages.length) {
    const message = messages[index];
    if (roleOf(message) === "system") {
      segments.push({ entry: null, messages: [message] });
      index++;
      continue;
    }
    const hostOnlyId = idOf(message);
    if (hostOnlyId !== undefined && mapped.hostOnly.has(hostOnlyId)) {
      segments.push({ entry: null, messages: [message] });
      index++;
      continue;
    }
    const wanted = expected[entry];
    if (wanted === undefined) return null;
    if (!isMessageOf(message, wanted.role, wanted.id)) return null;
    const group: unknown[] = [message];
    index++;
    // Results the provider did not execute arrive as their own role after the
    // assistant. They belong to that assistant and travel with it at any cut.
    if (wanted.role === "assistant") {
      while (index < messages.length && roleOf(messages[index]) === "tool") {
        group.push(messages[index]);
        index++;
      }
    }
    segments.push({ entry, messages: group });
    entry++;
  }
  return entry === expected.length ? segments : null;
}

/** Adopt a checkpoint this adapter wrote: the pinned synthetic is the host's own
 * rendering of it, and the state's cut sits before `raw[0]`, so every stored
 * entry after the checkpoint stays in the tail. */
function seedCheckpoint(
  state: SessionState,
  checkpoint: StoredCheckpoint,
  text: string,
  store: LcmStore,
  modelKeyValue: string,
  contextWindow: number,
  occupancy: number,
  summaryTokens: number,
  mapped: StoredEntries,
): void {
  const nodes = checkpointNodes(store, checkpoint);
  const lastId = checkpoint.summaryIds[checkpoint.summaryIds.length - 1] ?? 0;
  state.commitState = {
    cutCount: 0,
    synthetic: { role: "user", content: text, timestamp: Date.now() },
    summaryId: lastId,
    applied: renderableFrontier(nodes, summaryTokens, redactSecrets).applied,
    appliedAtOccupancy: occupancy,
    tailKey: tailKeyOf(mapped.raw[0]),
  };
  state.checkpoint = checkpoint.marker;
  state.pinnedModelKey = modelKeyValue;
  state.pinnedWindow = contextWindow;
}

function isMessageOf(message: unknown, role: string, id: string): boolean {
  return roleOf(message) === role && isRecord(message) && message.id === id;
}

function roleOf(message: unknown): string | undefined {
  return isRecord(message) && typeof message.role === "string" ? message.role : undefined;
}

function idOf(message: unknown): string | undefined {
  return isRecord(message) && typeof message.id === "string" ? message.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The same shape `Message.user(text)` builds: a user role and one text part,
 * with no id, because nothing stores a synthetic projection. */
function syntheticMessage(text: string): unknown {
  return { role: "user", content: [{ type: "text", text }] };
}
