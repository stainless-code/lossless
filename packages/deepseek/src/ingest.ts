import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock, Message } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import { ingestEntries } from "lossless-core";
import type { IngestStats, IngestibleEntry, LcmRole, LcmStore } from "lossless-core";

/** Live projection state: derived message id to sidecar entry id. The engine
 * hook resolves its span through this map instead of matching text; a cold
 * map re-derives entries from the live log on first miss, and only a message
 * with no live event fails closed rather than guessing rows. */
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

/** Per-session ceiling on backfilled rows. Counts INSERTED rows only, so
 * dedup and non-message skips never burn budget; live events keep mirroring
 * past the cap. */
export const BACKFILL_MAX_EVENTS = 500;

/** Ceiling on total visited events per backfill. Bounds the scan when skips
 * dominate; defaults to four times the effective inserted cap. */
export const BACKFILL_MAX_VISITED = BACKFILL_MAX_EVENTS * 4;

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
  let query: SessionQueryLike | undefined;
  try {
    // Live scopes reject undeclared service reads; treat that exactly like
    // an unmounted backend so the mount degrades to live-mirror-only.
    query = (ctx as unknown as { sessionQuery?: SessionQueryLike }).sessionQuery;
  } catch {
    return undefined;
  }
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
  /** Per-session inserted-row ceiling. Default BACKFILL_MAX_EVENTS. */
  maxEvents?: number;
  /** Per-session visited-event ceiling. Default 4x the effective maxEvents. */
  maxVisited?: number;
  /** Metrics recorder; receives one `backfill` row per session. */
  record?: (row: Record<string, unknown>) => void;
}

/** Outcome of one session backfill. */
export interface BackfillResult {
  ingested: number;
  skipped: number;
  /** Seq of the first visited event, -1 when nothing visited. */
  fromSeq: number;
  /** Seq of the last visited event, -1 when nothing visited. */
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
  const maxVisited = Math.max(0, Math.floor(options.maxVisited ?? maxEvents * 4));
  const { events } = await source.observe(session.id);
  let ingested = 0;
  let skipped = 0;
  let visited = 0;
  let fromSeq = -1;
  let throughSeq = -1;
  for (
    let start = 0;
    start < events.length && ingested < maxEvents && visited < maxVisited;
    start += pageSize
  ) {
    for (const event of events.slice(start, start + pageSize)) {
      if (ingested >= maxEvents || visited >= maxVisited) break;
      visited += 1;
      const seq = Number(event.seq);
      if (fromSeq === -1) fromSeq = seq;
      throughSeq = seq;
      const stats = mirrorEvent(session, event, store, index);
      ingested += stats.inserted;
      skipped += stats.skipped;
    }
    if (start + pageSize < events.length && ingested < maxEvents && visited < maxVisited) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const capped = (ingested >= maxEvents || visited >= maxVisited) && visited < events.length;
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
  const role = dshRole(message.role);
  if (role === undefined) return undefined;
  const text = renderText(message);
  if (text === undefined) return undefined;
  return {
    entry: {
      entryId: `${session.id}:${event.seq}`,
      role,
      text,
      timestamp: event.time,
    },
    messageId: message.id,
  };
}

function dshRole(role: Message["role"]): LcmRole | undefined {
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
    default:
      return undefined;
  }
}

/** Verbatim text plus the calls the transcript needs to stay replayable. A
 * message with blocks but no text keeps a descriptor row instead, and blank
 * text keeps a whitespace marker, so every span message holds a sidecar
 * address for compaction to map. */
function renderText(message: Message): string | undefined {
  if (message.content.length === 0) return undefined;
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool-call") parts.push(`tool-call: ${block.name} ${block.arguments}`);
  }
  const text = parts.join("\n");
  if (text.trim().length > 0) return text;
  if (message.content.some((block) => block.type !== "text")) return describeNonText(message);
  // Blank text still needs an address or spans wedge; the marker keeps it honest.
  return `[lcm:whitespace ${text.length} chars]`;
}

/** Bracketed stand-in mirroring the core file-handle shape: block kinds plus
 * stable identifiers, never bytes, marked so no reader takes it for seen text. */
function describeNonText(message: Message): string {
  const kinds = message.content.map(describeBlock).join(", ");
  return `[lcm:non-text ${kinds}; content not seen, descriptor only]`;
}

function describeBlock(block: ContentBlock): string {
  switch (block.type) {
    case "image": {
      if ((block as { attachment?: unknown }).attachment === undefined) {
        return "image (attachment missing)";
      }
      const ref = block.attachment;
      const details = [
        ref.mediaType,
        `${ref.bytes} bytes`,
        `${ref.width}x${ref.height}px`,
        String(ref.attachmentId),
      ];
      if (block.offloaded === true) details.push("offloaded");
      const name = ref.name === undefined ? "" : ` ${JSON.stringify(ref.name)}`;
      return `image${name} (${details.join(", ")})`;
    }
    case "file": {
      if ((block as { attachment?: unknown }).attachment === undefined) {
        return "file (attachment missing)";
      }
      const ref = block.attachment;
      return `file ${JSON.stringify(ref.name)} (${ref.bytes} bytes, ${String(ref.attachmentId)})`;
    }
    case "tool-addition":
    case "tool-removal":
      return `${block.type} ${JSON.stringify(block.toolName)}`;
    case "reasoning":
    case "text":
      return block.type;
    case "tool-call":
      return `tool-call ${block.name}`;
    default:
      return (block as { type: string }).type;
  }
}
