import { createHash, randomUUID } from "node:crypto";

import { ingestEntries } from "lossless-core";
import type { IngestibleEntry, IngestStats, LcmRole, LcmStore } from "lossless-core";

import type { CompactionEvent, CompactionMessage, PromptEvent, ToolAfterPayload } from "./host.ts";

const SKIPPED: IngestStats = {
  inserted: 0,
  skipped: 1,
  piCompactions: [],
  files: [],
  largeInline: [],
};

/** Durable bus events the mirror consumes, reduced to the fields it reads. */
export interface TextEndedEvent {
  readonly type: "session.text.ended";
  readonly sessionID: string;
  readonly assistantMessageID: string;
  readonly ordinal: number;
  readonly text: string;
}

export interface CompactionEndedEvent {
  readonly type: "session.compaction.ended";
  readonly sessionID: string;
  readonly reason: "auto" | "manual";
  readonly text: string;
}

/** A user prompt arrives verbatim, with attached file names so the stored row
 * names what the model saw beyond the text. */
export function userEntry(sessionID: string, event: PromptEvent): IngestibleEntry | undefined {
  const files = (event.prompt.files ?? [])
    .map((file) => file.name ?? file.uri)
    .filter((name) => name.length > 0);
  const text =
    files.length === 0
      ? event.prompt.text
      : `${event.prompt.text}\n[attachments: ${files.join(", ")}]`;
  if (text.trim().length === 0) return undefined;
  return {
    entryId: `${sessionID}:prompt:${event.messageID}`,
    role: "user",
    text,
    timestamp: Date.now(),
  };
}

/** One assistant text block at its replayable boundary: `text.ended` carries
 * the full value, so streaming deltas are never stored. */
export function textEntry(event: TextEndedEvent): IngestibleEntry | undefined {
  if (event.text.trim().length === 0) return undefined;
  return {
    entryId: `${event.sessionID}:text:${event.assistantMessageID}:${event.ordinal}`,
    role: "assistant",
    text: event.text,
    timestamp: Date.now(),
  };
}

/** What a tool call ended with, in the two states the host records. */
export type ToolOutcome =
  | { readonly status: "completed"; readonly result: unknown }
  | { readonly status: "error"; readonly error: unknown };

/** The text one finished tool call stores. The hook that sees the call and the
 * history mapper that replays it both come through here, so the same call
 * renders the same bytes whether it arrives live or from the stored history. */
export function toolText(tool: string, input: unknown, outcome: ToolOutcome): string {
  const head = `tool ${tool} ${stringify(input)}`;
  const body =
    outcome.status === "completed"
      ? renderResult(outcome.result)
      : `error: ${renderError(outcome.error)}`;
  return body === undefined ? head : `${head}\n${body}`;
}

/** A finished tool call with the input that caused it and the result the
 * model saw, so the sidecar replays the exchange without the host log. */
export function toolEntry(event: ToolAfterPayload): IngestibleEntry | undefined {
  const text = toolText(
    event.tool,
    event.input,
    event.status === "completed"
      ? { status: "completed", result: event.result }
      : { status: "error", error: event.error },
  );
  if (text.trim().length === 0) return undefined;
  return {
    entryId: `${event.sessionID}:tool:${String(event.messageID)}:${String(event.id)}`,
    role: "toolResult",
    text,
    timestamp: Date.now(),
  };
}

/** The pre-compaction boundary: the hook fires with the full message set about
 * to be summarized, so the sidecar records what left the window even though
 * every compacted row is already stored. The summary itself arrives through
 * `summaryEntry`. The messages are the host's prepared request, so only their
 * roles are read, and a message without one is left out of the description. */
export function compactionMark(sessionID: string, event: CompactionEvent): IngestibleEntry {
  const firstRole = roleOfMessage(event.messages[0]);
  const lastRole = roleOfMessage(event.messages[event.messages.length - 1]);
  const stable =
    event.messages.length > 0 &&
    event.messages.every((message) => idOfMessage(message) !== undefined);
  return {
    entryId: `${sessionID}:compaction:${
      stable
        ? digest(`${event.messages.map(idOfMessage).join(":")}:${event.messages.length}`)
        : randomUUID()
    }`,
    role: "custom",
    text:
      `compaction checkpoint: ${event.messages.length} messages compacted` +
      (firstRole === undefined ? "" : ` (first ${firstRole}, last ${lastRole ?? firstRole})`) +
      "; the summary arrives as its own entry",
    timestamp: Date.now(),
  };
}

function idOfMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function roleOfMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const role = (value as { readonly role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/** A finished compaction summary, stored beside the rows it replaced so the
 * summary text itself stays searchable. Native checkpoints publish an empty
 * text and are skipped: there is nothing to store. The bus event id is
 * durable and unique, so a redelivery dedupes and a plugin reload never
 * collides with a stored row. */
export function summaryEntry(
  sessionID: string,
  eventId: string,
  event: CompactionEndedEvent,
): IngestibleEntry | undefined {
  if (event.text.trim().length === 0) return undefined;
  return {
    entryId: `${sessionID}:summary:${eventId}`,
    role: "custom",
    text: `compaction summary (${event.reason}):\n${event.text}`,
    timestamp: Date.now(),
  };
}

/** Mirror one bus event into the sidecar. Promise-plugin events arrive
 * enveloped (`{id, type, data}`), so the payload is read off `data` and the
 * durable event id names the row it produces. Unknown event types and
 * malformed payloads are skipped, so the subscription can stay broad while
 * the stored set stays deliberate. */
export function mirrorBusEvent(
  store: LcmStore,
  event: { readonly id?: unknown; readonly type: string; readonly data?: unknown },
): IngestStats {
  if (event.type === "session.text.ended") return mirror(store, textEntryFrom(event));
  if (event.type === "session.compaction.ended") return mirror(store, summaryEntryFrom(event));
  return SKIPPED;
}

export function mirror(store: LcmStore, entry: IngestibleEntry | undefined): IngestStats {
  if (entry === undefined) return SKIPPED;
  return ingestEntries(store, [entry]);
}

/** Render one LLM content part by duck-typed shape. Text passes through
 * verbatim, tool traffic keeps the call plus its payload, and media,
 * reasoning, compaction, and effort parts stay out: the mirror keeps what the
 * model saw as text. */
export function renderPart(part: unknown): string | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const typed = part as { readonly type?: unknown };
  if (typed.type === "text") {
    const text = (part as { readonly text?: unknown }).text;
    return typeof text === "string" && text.trim().length > 0 ? text : undefined;
  }
  if (typed.type === "tool-call") {
    const call = part as { readonly name?: unknown; readonly input?: unknown };
    if (typeof call.name !== "string") return undefined;
    return `tool-call: ${call.name} ${stringify(call.input)}`;
  }
  if (typed.type === "tool-result") {
    return renderResult((part as { readonly result?: unknown }).result);
  }
  return undefined;
}

export function messageRole(role: CompactionMessage["role"]): LcmRole {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "toolResult";
    case "system":
      return "custom";
  }
}

function renderResult(result: unknown): string | undefined {
  if (result === undefined) return undefined;
  if (typeof result === "string") return result.trim().length > 0 ? result : undefined;
  if (typeof result !== "object" || result === null) return stringify(result);
  const content = (result as { readonly content?: unknown }).content;
  if (typeof content === "string") return content.trim().length > 0 ? content : undefined;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const typed = item as { readonly type?: unknown };
      if (typed.type === "text") {
        const text = (item as { readonly text?: unknown }).text;
        if (typeof text === "string" && text.trim().length > 0) parts.push(text);
      } else if (typed.type === "file") {
        const file = item as { readonly uri?: unknown; readonly name?: unknown };
        const label =
          typeof file.name === "string"
            ? file.name
            : typeof file.uri === "string"
              ? file.uri
              : "unnamed";
        parts.push(`[file: ${label}]`);
      }
    }
    const text = parts.join("\n").trim();
    return text.length > 0 ? text : undefined;
  }
  const value = (result as { readonly value?: unknown }).value;
  if (value !== undefined) return stringify(value);
  return stringify(result);
}

function renderError(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return stringify(error);
}

function stringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** The `text.ended` payload read off a raw bus event envelope. Malformed
 * payloads mirror nothing: a partial row is worse than a gap the next
 * boundary fills. */
export function textEntryFrom(event: { readonly data?: unknown }): IngestibleEntry | undefined {
  const data = event.data;
  if (typeof data !== "object" || data === null) return undefined;
  const payload = data as {
    readonly sessionID?: unknown;
    readonly assistantMessageID?: unknown;
    readonly ordinal?: unknown;
    readonly text?: unknown;
  };
  if (
    typeof payload.sessionID !== "string" ||
    typeof payload.assistantMessageID !== "string" ||
    typeof payload.ordinal !== "number" ||
    typeof payload.text !== "string"
  ) {
    return undefined;
  }
  return textEntry({
    type: "session.text.ended",
    sessionID: payload.sessionID,
    assistantMessageID: payload.assistantMessageID,
    ordinal: payload.ordinal,
    text: payload.text,
  });
}

/** The `compaction.ended` payload read off a raw bus event envelope. The event
 * id is required: without it there is no stable address for the row, so a
 * payload missing one mirrors nothing rather than risking a collision. */
export function summaryEntryFrom(event: {
  readonly id?: unknown;
  readonly data?: unknown;
}): IngestibleEntry | undefined {
  if (typeof event.id !== "string" || event.id.length === 0) return undefined;
  const data = event.data;
  if (typeof data !== "object" || data === null) return undefined;
  const payload = data as {
    readonly sessionID?: unknown;
    readonly reason?: unknown;
    readonly text?: unknown;
  };
  if (typeof payload.sessionID !== "string" || typeof payload.text !== "string") return undefined;
  return summaryEntry(payload.sessionID, event.id, {
    type: "session.compaction.ended",
    sessionID: payload.sessionID,
    reason: payload.reason === "manual" ? "manual" : "auto",
    text: payload.text,
  });
}
