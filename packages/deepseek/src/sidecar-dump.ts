import { existsSync } from "node:fs";
import { basename } from "node:path";

import {
  describeView,
  expandView,
  grepView,
  historyManifest,
  LcmStore,
  StaleStoreError,
} from "lossless-core";

/** Max bytes one dump prints; callers copy the file when they need more. */
const DUMP_MAX_BYTES = 16_384;
/** Summaries described in full; the header still counts the rest. */
const DUMP_MAX_SUMMARIES = 10;
/** Metric rows kept from the tail of the session's rows. */
const DUMP_MAX_METRIC_ROWS = 20;
/** Top-level summaries the manifest names. */
const DUMP_MAX_HISTORY = 20;
/** Messages read as windows from the first summary. */
const DUMP_MAX_SAMPLE_MESSAGES = 3;
/** Chars one sampled message window holds. */
const DUMP_SAMPLE_CHARS = 400;
/** Bytes kept from each described summary; the tail names the cut. */
const DUMP_MAX_SUMMARY_BYTES = 1_200;

/** Why a sidecar could not be dumped. Each reason is a count the caller
 * reports, never an error it raises. */
export type DumpSkipReason = "missing" | "unreadable" | "older-generation";

export type SidecarDumpResult =
  | { status: "dumped"; text: string }
  | { status: "skipped"; reason: DumpSkipReason; detail: string };

export interface SidecarDumpOptions {
  /** Sidecar file to open read-only. Never created when absent. */
  readonly path: string;
  /** Session id naming the dump and filtering metric rows. */
  readonly sessionId: string;
  /** Masks secret-shaped text on every displayed seam. */
  readonly redact: (text: string) => string;
  /** Include matches from a branch that left the active path. */
  readonly includeRemoved?: boolean;
  /** Metric rows for this sidecar directory, oldest first. */
  readonly metricRows?: readonly Record<string, unknown>[];
  /** Optional FTS5 query sampled through grepView. */
  readonly sampleQuery?: string;
}

/** Read-only dump of one session sidecar plus its metrics. Opens the file
 * with `queryOnly`, so SQLite refuses writes, and closes it before returning.
 * An older generation reports a named skip instead of migrating. */
export function dumpSidecar(options: SidecarDumpOptions): SidecarDumpResult {
  if (!existsSync(options.path)) {
    return {
      status: "skipped",
      reason: "missing",
      detail: `no sidecar at ${basename(options.path)}`,
    };
  }
  let store: LcmStore | undefined;
  try {
    store = new LcmStore(options.path, { queryOnly: true });
  } catch (error) {
    if (error instanceof StaleStoreError) {
      return {
        status: "skipped",
        reason: "older-generation",
        detail:
          `generation ${error.generation} is older than this build. ` +
          `Run migrate first. No rows were changed.`,
      };
    }
    return {
      status: "skipped",
      reason: "unreadable",
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
    };
  }
  try {
    return { status: "dumped", text: buildDump(store, options) };
  } catch (error) {
    return {
      status: "skipped",
      reason: "unreadable",
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
    };
  } finally {
    try {
      store.close();
    } catch {}
  }
}

function buildDump(store: LcmStore, options: SidecarDumpOptions): string {
  const includeRemoved = options.includeRemoved === true;
  const stats = store.stats();
  const removed = stats.removedMessages > 0 ? ` (${stats.removedMessages} removed, retained)` : "";
  const head = [
    `LCM sidecar dump: ${options.sessionId}`,
    `store: ${basename(options.path)}, generation ${store.generation}, ` +
      `${stats.messages} messages${removed}, ${stats.summaries} summaries, ` +
      `${(stats.dbBytes / 1024).toFixed(0)} KB`,
    `history:`,
    historyManifest(store, DUMP_MAX_HISTORY),
  ];
  const allSummaries = store.allSummaries();
  const summaries = allSummaries.slice(0, DUMP_MAX_SUMMARIES);
  const totalSummaries = allSummaries.length;
  const sections: string[] = [...head];
  if (summaries.length > 0) {
    sections.push(`summaries: ${summaries.length} shown of ${totalSummaries}`);
    for (const summary of summaries) {
      const view = describeView(store, options.redact, summary.id);
      sections.push(view.ok ? capSummaryText(view.text) : `Summary #${summary.id}: unreadable.`);
    }
    const first = summaries[0]!;
    const coveredIds = store.coveredMessageIds(first.id);
    const coveredMsgs = store.messagesByIds(coveredIds);
    const coveredIdSet = new Set(coveredMsgs.map((m) => m.entryId));
    const removedIds = new Set(
      coveredMsgs.filter((m) => m.removedAt !== undefined).map((m) => m.entryId),
    );
    const visibleMsgs = includeRemoved
      ? coveredMsgs
      : coveredMsgs.filter((m) => m.removedAt === undefined);
    const list = expandView(store, options.redact, {
      mode: "list",
      id: first.id,
      offset: 0,
      limit: DUMP_MAX_SAMPLE_MESSAGES,
      maxChars: DUMP_SAMPLE_CHARS,
    });
    sections.push(
      `messages (summary #${first.id}):`,
      list.ok
        ? shapeSampleList(
            list.text,
            first.id,
            coveredIdSet,
            removedIds,
            includeRemoved,
            visibleMsgs.length,
          )
        : "No messages.",
    );
    for (const message of visibleMsgs.slice(0, DUMP_MAX_SAMPLE_MESSAGES)) {
      const window = expandView(store, options.redact, {
        mode: "message",
        entryId: message.entryId,
        charOffset: 0,
        maxChars: DUMP_SAMPLE_CHARS,
      });
      sections.push(window.ok ? window.text : `No stored message ${message.entryId}.`);
    }
  } else {
    sections.push("summaries: none stored yet.");
  }
  if (options.sampleQuery !== undefined && options.sampleQuery.length > 0) {
    const found = grepView(store, options.redact, {
      query: options.sampleQuery,
      limit: DUMP_MAX_SAMPLE_MESSAGES,
      includeRemoved,
    });
    sections.push(
      `search ${JSON.stringify(options.sampleQuery)}${includeRemoved ? " (including removed)" : ""}:`,
      found.text,
    );
  }
  const rows = (options.metricRows ?? []).filter((row) => row.session === options.sessionId);
  const shown = rows.slice(Math.max(0, rows.length - DUMP_MAX_METRIC_ROWS));
  sections.push(`metrics: ${rows.length} row(s) for this session, ${shown.length} shown`);
  for (const row of shown) sections.push(`  ${JSON.stringify(sanitizeRow(row, options.redact))}`);
  sections.push(
    `omitted: summary text past ${DUMP_MAX_SUMMARY_BYTES} bytes each, message bodies past ${DUMP_SAMPLE_CHARS} chars per sample, ` +
      `summaries past ${DUMP_MAX_SUMMARIES}, metric rows past ${DUMP_MAX_METRIC_ROWS}. ` +
      `Removed rows carry [removed]. Read them with include_removed.`,
  );
  const text = options.redact(sections.join("\n"));
  if (Buffer.byteLength(text, "utf8") <= DUMP_MAX_BYTES) return text;
  return clipDump(text);
}

/** Reshape the sampled list for the dump: removed rows stay out by default
 * and carry a [removed] label when --include-removed keeps them. Untouched
 * when no covered row left the active path. */
function shapeSampleList(
  text: string,
  summaryId: number,
  coveredIds: ReadonlySet<string>,
  removedIds: ReadonlySet<string>,
  includeRemoved: boolean,
  visibleTotal: number,
): string {
  if (removedIds.size === 0) return text;
  const groups: { id: string | undefined; chunks: string[] }[] = [];
  for (const chunk of text.split("\n\n").slice(1)) {
    const at = chunk.indexOf("\n");
    const first = at === -1 ? chunk : chunk.slice(0, at);
    const id = /^\[([^\]]+)\] \((?:user|assistant|toolResult|custom)\)$/.exec(first)?.[1];
    if (id !== undefined && coveredIds.has(id)) groups.push({ id, chunks: [chunk] });
    else if (groups.length > 0) groups[groups.length - 1]!.chunks.push(chunk);
    else groups.push({ id: undefined, chunks: [chunk] });
  }
  const kept: string[] = [];
  let shown = 0;
  for (const group of groups) {
    const removed = group.id !== undefined && removedIds.has(group.id);
    if (removed && !includeRemoved) continue;
    if (group.id !== undefined) shown++;
    kept.push(
      group.chunks
        .map((chunk, index) => (index === 0 && removed ? labelRemoved(chunk) : chunk))
        .join("\n\n"),
    );
  }
  const head =
    `Summary #${summaryId} → ${visibleTotal} original messages ` +
    `(showing ${shown} from 0)${visibleTotal > shown ? ", use offset to page" : ""}`;
  return [head, ...kept].join("\n\n");
}

function labelRemoved(chunk: string): string {
  const at = chunk.indexOf("\n");
  return at === -1 ? `${chunk} [removed]` : `${chunk.slice(0, at)} [removed]${chunk.slice(at)}`;
}

/** Keep one described summary bounded so large summaries cannot clip the tail. */
function capSummaryText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= DUMP_MAX_SUMMARY_BYTES) return text;
  let used = 0;
  let end = 0;
  for (const chunk of text) {
    const cost = Buffer.byteLength(chunk, "utf8");
    if (used + cost > DUMP_MAX_SUMMARY_BYTES) break;
    used += cost;
    end += chunk.length;
  }
  const more = Buffer.byteLength(text, "utf8") - used;
  return `${text.slice(0, end)}\n[lcm:more ${more} bytes]`;
}

/** Redact string seams in one metric row; keys and stub pointers stay intact. */
function sanitizeRow(
  row: Record<string, unknown>,
  redact: (text: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = sanitizeValue(value, redact);
  return out;
}

function sanitizeValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, redact));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeValue(item, redact);
    }
    return out;
  }
  return value;
}

function clipDump(text: string): string {
  const marker = `... truncated at the ${DUMP_MAX_BYTES} byte limit`;
  const budget = DUMP_MAX_BYTES - Buffer.byteLength(marker, "utf8") - 1;
  let kept = "";
  let used = 0;
  for (const line of text.split("\n")) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > budget) break;
    kept += (kept.length === 0 ? "" : "\n") + line;
    used += cost;
  }
  return `${kept}\n${marker}`;
}
