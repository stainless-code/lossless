/** Turning the host's stored history back into the entries the sidecar
 * already holds. Every id below is the id the mirror wrote for that part, so a
 * span built from these entries names rows that exist and re-ingesting it
 * dedupes instead of doubling the history. The map is pure: no store, no host
 * call, and no clock. */

import type { AlignedEntry, AssemblyMsg } from "lossless-core";

import type { SessionMessageInfo } from "./host.ts";
import { toolText } from "./ingest.ts";

/** One aligned entry per user or assistant message, the wrapper messages a
 * context projection can hand to the host, the stored message each wrapper came
 * from, and the two facts the projection reads off the stored history: the
 * input the last assistant request paid for, and whether a host checkpoint sits
 * in the history. */
export interface StoredEntries {
  readonly entries: AlignedEntry[];
  readonly raw: AssemblyMsg[];
  readonly sources: Map<AssemblyMsg, SessionMessageInfo>;
  /** Stored messages the mirror does not turn into an entry (synthetic notes,
   * skill and shell records, location switches, empty prompts). They still
   * appear in the outgoing draft, so alignment skips them by id instead of
   * treating them as a mismatch. */
  readonly hostOnly: ReadonlySet<string>;
  /** For each entry index, the first host-only message id since the previous
   * entry. A checkpoint that keeps from that entry should start at this
   * message instead, or the instruction between them is in neither the summary
   * nor the retained tail. */
  readonly hostOnlyBefore: ReadonlyMap<number, string>;
  /** `tokens.input + tokens.cache.read` of the last assistant message, or
   * undefined when that message carries no readable usage record. */
  readonly tokens?: number;
  /** The history holds a compaction checkpoint, which changes what the outgoing
   * request contains without adding a message this map can align. */
  readonly hostCheckpoint: boolean;
  /** The checkpoint this adapter wrote, when the stored history begins with one
   * and its marker validates. A native or unmarked checkpoint leaves this
   * undefined even though `hostCheckpoint` is true. */
  readonly checkpoint?: StoredCheckpoint;
}

/** The marker a compaction hook leaves on the checkpoint message it wrote. It
 * is how the next context hook tells its own boundary from the host's, without
 * trusting the summary text. */
export interface StoredCheckpoint {
  /** The stored compaction message id: the outgoing checkpoint carries it too. */
  readonly messageID: string;
  /** The frontier nodes the checkpoint rendered, oldest first. */
  readonly summaryIds: readonly number[];
  /** Stored entries the checkpoint replaced. */
  readonly cutCount: number;
  /** Stable identity of this checkpoint: a digest of the summary it stored. */
  readonly marker: string;
}

/** Parts inside one message stay distinct lines, so a message that mixed text
 * and tool calls replays in the order the model saw it. */
const PART_SEPARATOR = "\n\n";

interface Part {
  readonly entryId: string;
  readonly text: string;
}

export function storedEntries(
  sessionID: string,
  messages: readonly SessionMessageInfo[],
): StoredEntries {
  const entries: AlignedEntry[] = [];
  const raw: AssemblyMsg[] = [];
  const sources = new Map<AssemblyMsg, SessionMessageInfo>();
  const hostOnly = new Set<string>();
  const hostOnlyBefore = new Map<number, string>();
  let pendingHostOnly: string | undefined;
  let hostCheckpoint = false;
  let tokens: number | undefined;
  const first = messages[0];
  const checkpoint = first === undefined ? undefined : checkpointOf(first);
  for (const message of messages) {
    // A running compaction is the boundary the host is about to fill, not one
    // that changes the request yet; a failed one left the history untouched.
    if (
      message.type === "compaction" &&
      message.status !== "running" &&
      message.status !== "failed"
    ) {
      hostCheckpoint = true;
    }
    // Only the newest assistant message speaks for the current context. An
    // older record describes a smaller history and would compact late.
    if (message.type === "assistant") tokens = assistantInputTokens(message);
    const parts = messageParts(sessionID, message);
    const last = parts[parts.length - 1];
    // A message the mirror stored nothing for (an empty prompt, a synthetic
    // note, a skill or shell record) has no span to name. It is still in the
    // outgoing draft, so remember its id and let alignment skip it.
    if (last === undefined) {
      hostOnly.add(message.id);
      pendingHostOnly ??= message.id;
      continue;
    }
    if (pendingHostOnly !== undefined) {
      hostOnlyBefore.set(entries.length, pendingHostOnly);
      pendingHostOnly = undefined;
    }
    const text = parts.map((part) => part.text).join(PART_SEPARATOR);
    const wrapper: AssemblyMsg = { role: message.type, content: text };
    entries.push({ entryId: last.entryId, role: message.type, text });
    raw.push(wrapper);
    sources.set(wrapper, message);
  }
  return {
    entries,
    raw,
    sources,
    hostOnly,
    hostOnlyBefore,
    hostCheckpoint,
    ...(tokens === undefined ? {} : { tokens }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

/** A checkpoint this adapter wrote carries a marker this validates field by
 * field. Anything else (a native window, an older summary, a hand-edited
 * marker) reads as absent, and the projection then fails closed. The history
 * starts at the newest completed compaction, so only the first message can be
 * the one the outgoing request begins with. */
function checkpointOf(message: SessionMessageInfo): StoredCheckpoint | undefined {
  if (message.type !== "compaction") return undefined;
  if (message.status === "running" || message.status === "failed") return undefined;
  const metadata = message.metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  if (metadata.lcm !== true) return undefined;
  const rawIds = metadata.summaryIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) return undefined;
  const summaryIds: number[] = [];
  for (const id of rawIds as readonly unknown[]) {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return undefined;
    summaryIds.push(id);
  }
  const cutCount = metadata.cutCount;
  if (typeof cutCount !== "number" || !Number.isInteger(cutCount) || cutCount < 0) {
    return undefined;
  }
  const marker = metadata.checkpoint;
  if (typeof marker !== "string" || marker.length === 0) return undefined;
  return { messageID: message.id, summaryIds, cutCount, marker };
}

/** What the request behind one assistant message paid to read: its input plus
 * the cache reads that did not count as fresh input. The host stores this in the
 * message's own usage record, and a malformed record reads as absent so the
 * projection falls back to the estimator instead of trusting a NaN. */
function assistantInputTokens(message: SessionMessageInfo): number | undefined {
  const tokens = message.tokens;
  if (typeof tokens !== "object" || tokens === null) return undefined;
  const record = tokens as { readonly input?: unknown; readonly cache?: unknown };
  if (!finiteNonNegative(record.input)) return undefined;
  const cache =
    typeof record.cache === "object" && record.cache !== null
      ? (record.cache as { readonly read?: unknown })
      : undefined;
  if (cache?.read === undefined) return record.input;
  if (!finiteNonNegative(cache.read)) return undefined;
  return record.input + cache.read;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Only raw branch messages: agent and model switches, compaction summaries,
 * system updates, synthetic notes, skill and shell records all sit outside the
 * conversation the summarizer may rewrite. */
function messageParts(sessionID: string, message: SessionMessageInfo): Part[] {
  if (message.type === "user") return userParts(sessionID, message);
  if (message.type === "assistant") return assistantParts(sessionID, message);
  return [];
}

function userParts(sessionID: string, message: SessionMessageInfo): Part[] {
  const text = userText(message);
  if (text.trim().length === 0) return [];
  return [{ entryId: `${sessionID}:prompt:${message.id}`, text }];
}

/** The same rendering `userEntry` stores, attachments included, so the span
 * entry and the mirrored row describe the same prompt. */
function userText(message: SessionMessageInfo): string {
  const text = typeof message.text === "string" ? message.text : "";
  const files = message.files ?? [];
  const names = attachmentNames(files);
  if (names.length > 0) return `${text}\n[attachments: ${names.join(", ")}]`;
  return files.length > 0 ? `${text}\n[attachments: ${files.length}]` : text;
}

function attachmentNames(files: readonly unknown[] | undefined): string[] {
  const names: string[] = [];
  for (const file of files ?? []) {
    if (typeof file !== "object" || file === null) continue;
    const record = file as {
      readonly name?: unknown;
      readonly uri?: unknown;
      readonly source?: unknown;
    };
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.uri === "string"
          ? record.uri
          : uriOfSource(record.source);
    if (name !== undefined && name.length > 0) names.push(name);
  }
  return names;
}

function uriOfSource(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const record = source as { readonly type?: unknown; readonly uri?: unknown };
  return record.type === "uri" && typeof record.uri === "string" ? record.uri : undefined;
}

function assistantParts(sessionID: string, message: SessionMessageInfo): Part[] {
  const parts: Part[] = [];
  // The bus ordinals text parts as they start, so an empty text part still
  // advances the number even though the mirror stored no row for it.
  let textOrdinal = 0;
  for (const part of message.content ?? []) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as { readonly type?: unknown; readonly text?: unknown };
    if (record.type === "text") {
      const ordinal = textOrdinal++;
      if (typeof record.text !== "string" || record.text.trim().length === 0) continue;
      parts.push({ entryId: `${sessionID}:text:${message.id}:${ordinal}`, text: record.text });
      continue;
    }
    if (record.type === "tool") {
      const tool = toolPart(sessionID, message.id, part);
      if (tool !== undefined) parts.push(tool);
    }
  }
  return parts;
}

/** A tool call the host finished. Streaming and running calls have no mirrored
 * row yet, so they stay out until the result lands. */
function toolPart(sessionID: string, messageID: string, part: unknown): Part | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const record = part as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly state?: unknown;
  };
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (typeof record.name !== "string") return undefined;
  if (typeof record.state !== "object" || record.state === null) return undefined;
  const state = record.state as {
    readonly status?: unknown;
    readonly input?: unknown;
    readonly content?: unknown;
    readonly error?: unknown;
  };
  const text =
    state.status === "completed"
      ? toolText(record.name, state.input, {
          status: "completed",
          result: { content: state.content },
        })
      : state.status === "error"
        ? toolText(record.name, state.input, { status: "error", error: state.error })
        : undefined;
  if (text === undefined || text.trim().length === 0) return undefined;
  return { entryId: `${sessionID}:tool:${messageID}:${record.id}`, text };
}
