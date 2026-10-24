import type { Context } from "@deepseek-ai/cordis";
import type { Message } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import { ingestEntries } from "lossless-core";
import type { IngestStats, IngestibleEntry, LcmRole, LcmStore } from "lossless-core";

/** Live projection state: derived message id to sidecar entry id. The engine
 * hook resolves its span through this map instead of matching text, so resume
 * without it fails closed rather than guessing rows. */
export class MessageIndex {
  private readonly ids = new Map<string, string>();

  record(messageId: string, entryId: string): void {
    this.ids.set(messageId, entryId);
  }

  entryId(messageId: string): string | undefined {
    return this.ids.get(messageId);
  }
}

/** One sidecar row per message-producing event, keyed by session and sequence.
 * A compaction checkpoint ingests like any other model-visible message, and
 * the entries it shadows stay stored: the log moves on, the sidecar keeps
 * every address the reader can name. */
export function entryFor(session: Session, event: SessionEvent): IngestibleEntry | undefined {
  return projectedEntry(session, event)?.entry;
}

/** Mirror one committed event into the sidecar. Ingest dedups on the entry
 * id, so a re-delivered event inserts nothing. */
export function mirrorEvent(
  session: Session,
  event: SessionEvent,
  store: LcmStore,
  index?: MessageIndex,
): IngestStats {
  const projected = projectedEntry(session, event);
  if (projected === undefined) {
    return { inserted: 0, skipped: 1, piCompactions: [], files: [], largeInline: [] };
  }
  const stats = ingestEntries(store, [projected.entry]);
  if (stats.inserted > 0) index?.record(projected.messageId, projected.entry.entryId);
  return stats;
}

/** Follow one session's live feed into its sidecar. The feed starts at
 * subscription time: synchronous history scans are prohibited for new
 * production code in this harness, so there is no sync backfill here.
 * Pre-mount history arrives through backfillSession over the async
 * observation seam instead, which keeps the sync readers test-only. A
 * reopened sidecar dedups against its stored rows. */
export function observeSession(
  ctx: Context,
  session: Session,
  store: LcmStore,
  index?: MessageIndex,
): () => void {
  return ctx.on("session/event", (live, event) => {
    if (live.id !== session.id) return;
    mirrorEvent(live, event, store, index);
  });
}

/** Mirror slice size for pre-mount backfill. Matches the host history page
 * default (DEFAULT_MAX_MESSAGES in the harness session-controller history
 * module), so one seam means one paging vocabulary. */
export const BACKFILL_PAGE_SIZE = 50;

/** Per-session ceiling on backfilled events. A huge pre-mount log stops here
 * instead of stalling mount; live events keep mirroring past the cap. */
export const BACKFILL_MAX_EVENTS = 500;

/** One frozen pre-mount cut for a session, read through the async observation
 * seam. The harness materializes it behind its own migration waiver, so this
 * package still makes no synchronous history call. */
export interface HistoryObservation {
  readonly events: readonly SessionEvent[];
}

/** Async history seam for pre-mount backfill. Production reads come from the
 * composed query backend; tests fake this interface, never the harness. */
export interface SessionHistorySource {
  observe(sessionId: SessionId): Promise<HistoryObservation>;
}

/** Structural shape of the composed `ctx.sessionQuery` backend. Declared
 * locally so this package takes no dependency on the query backend and adds
 * no required service: when the backend is absent from the composition the
 * mount skips backfill and the live mirror still covers new events. */
interface SessionQueryLike {
  observeSession(
    sessionId: SessionId,
    options?: { signal?: AbortSignal; projectionMode?: "all" | "none" },
  ): Promise<HistoryObservation & { [key: symbol]: unknown }>;
}

/** Well-known dispose without the esnext.disposable lib: the lease drops a
 * cache pin on prepared cuts and is a no-op flag on live cuts. */
const DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose;

function disposeObservation(observation: { [key: symbol]: unknown }): void {
  const dispose = observation[DISPOSE];
  if (typeof dispose === "function") dispose();
}

/** Optional async history source for one composition. Returns undefined when
 * the query backend is not mounted; the caller then skips backfill. This is
 * the same `observeSession` call the host history controller pages from,
 * read optionally so the ctx surface does not widen. */
export function historySourceFrom(ctx: Context): SessionHistorySource | undefined {
  const query = (ctx as unknown as { sessionQuery?: SessionQueryLike }).sessionQuery;
  if (query === undefined) return undefined;
  return {
    observe: async (sessionId) => {
      const observation = await query.observeSession(sessionId, { projectionMode: "none" });
      try {
        return { events: observation.events };
      } finally {
        disposeObservation(observation);
      }
    },
  };
}

/** Options for one session backfill. */
export interface BackfillOptions {
  /** Mirror slice size. Default BACKFILL_PAGE_SIZE. */
  pageSize?: number;
  /** Absolute per-session event ceiling. Default BACKFILL_MAX_EVENTS. */
  maxEvents?: number;
  /** Metrics recorder; receives one `backfill` row per session. */
  record?: (row: Record<string, unknown>) => void;
}

/** Outcome of one session backfill. */
export interface BackfillResult {
  ingested: number;
  skipped: number;
  /** Seq of the first mirrored event, -1 when nothing was mirrored. */
  fromSeq: number;
  /** Seq of the last mirrored event, -1 when nothing was mirrored. */
  throughSeq: number;
  /** True when the observation held more events than the cap allowed. */
  capped: boolean;
}

/** Mirror one session's pre-mount history through the same mirrorEvent path
 * the live feed uses, so backfill plus live mirror cannot double-insert:
 * ingest dedups on the entry id. Pages the frozen observation in bounded
 * slices with an event-loop yield between pages, and stops at the cap. */
export async function backfillSession(
  session: Session,
  store: LcmStore,
  source: SessionHistorySource,
  index?: MessageIndex,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? BACKFILL_PAGE_SIZE));
  const maxEvents = Math.max(0, Math.floor(options.maxEvents ?? BACKFILL_MAX_EVENTS));
  const { events } = await source.observe(session.id);
  let ingested = 0;
  let skipped = 0;
  let mirrored = 0;
  let fromSeq = -1;
  let throughSeq = -1;
  for (let start = 0; start < events.length && mirrored < maxEvents; start += pageSize) {
    for (const event of events.slice(start, start + pageSize)) {
      if (mirrored >= maxEvents) break;
      mirrored += 1;
      const seq = Number(event.seq);
      if (fromSeq === -1) fromSeq = seq;
      throughSeq = seq;
      const stats = mirrorEvent(session, event, store, index);
      ingested += stats.inserted;
      skipped += stats.skipped;
    }
    if (start + pageSize < events.length && mirrored < maxEvents) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const capped = mirrored >= maxEvents && mirrored < events.length;
  options.record?.({
    ts: Date.now(),
    event: "lcm",
    kind: "backfill",
    session: String(session.id),
    ingested,
    skipped,
    fromSeq,
    throughSeq,
    capped,
  });
  return { ingested, skipped, fromSeq, throughSeq, capped };
}

function projectedEntry(
  session: Session,
  event: SessionEvent,
): { entry: IngestibleEntry; messageId: string } | undefined {
  const message = session.deriveEventMessage(event);
  if (message === null) return undefined;
  const text = renderText(message);
  if (text === undefined) return undefined;
  return {
    entry: {
      entryId: `${session.id}:${event.seq}`,
      role: dshRole(message.role),
      text,
      timestamp: event.time,
    },
    messageId: message.id,
  };
}

function dshRole(role: Message["role"]): LcmRole {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "toolResult";
    case "system":
    case "developer":
      return "custom";
    default: {
      const _exhaustive: never = role;
      throw new Error(`unhandled message role: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Verbatim text plus the calls the transcript needs to stay replayable.
 * Reasoning, image, file, and tool-change blocks stay out: the mirror keeps
 * what the model saw as text, not every modality the log can carry. */
function renderText(message: Message): string | undefined {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool-call") parts.push(`tool-call: ${block.name} ${block.arguments}`);
  }
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : undefined;
}
