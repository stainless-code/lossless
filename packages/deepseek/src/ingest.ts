import type { Context } from "@deepseek-ai/cordis";
import type { Message } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
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
 * production code in this harness, so there is no backfill here. A reopened
 * sidecar is the resume path, and a session that predates the plugin keeps
 * its earlier history out of reach until the async pagination path exists. */
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
